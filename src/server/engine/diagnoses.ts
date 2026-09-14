// 중재자 진단 서비스 — 저장·조회·적용·재개 검사·전달 기록의 책임을 한곳에 모은다(2026-09-14 진단 계획 §1).
//
// 흐름: 중재자가 멈춘 구현·수정(또는 인도 대기)의 실패를 진단해 등록한다(register) → 적용(apply)하면 같은 계획 안의 수정은
// 중단된 구현·수정 단계로 반환되고(공통 재시도 사다리 — 예산·리뷰·개정 한도를 그대로 거친다), 쓰기 턴의 프로세스가 실제로 뜰 때 전달(delivered)이
// 기록되며, 러너의 처분(반영·반박·추가 증거)이 수락된 결과로 기록되고, 수정 결과가 리뷰를 통과해 인도 준비에 이르면 해결(resolved)이다.
// 등록·적용·전달 어느 것도 해결이 아니다. 진단은 덮어쓰지 않는다 — 정정은 supersedes 로 이전 진단을 대체하는 새 기록이다.
import {
  CLOSED_DIAGNOSIS_STATUSES, MEDIATOR_PENDING_STATUSES, applyInfo, diagnosisFinding, toDiagnosisPrompt,
  type DiagnosisApplyMode, type DiagnosisBinding, type DiagnosisInput, type DiagnosisOrigin, type DiagnosisPrompt,
  type DiagnosisRecord, type DiagnosisStatus, type DiagnosisTarget,
} from "../../shared/diagnoses.js";
import type { AgentResult, Finding, Topic } from "../../shared/contracts.js";
import { requestId, workId, type WorkCheckpoint } from "./checkpoint.js";
import type { EngineCore } from "./core.js";

export class DiagnosisConflict extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "DiagnosisConflict";
  }
}

const KIND_LABEL: Record<DiagnosisInput["kind"], string> = { fix: "수정 진단", investigation: "추가 조사", no_action: "수정 불필요 결론" };
const STATUS_LABEL: Record<DiagnosisStatus, string> = {
  registered: "적용 대기", stale: "재확인 필요", applied: "적용됨·전달 전", delivered: "전달됨", fix_reported: "반영 보고됨·리뷰 전",
  refuted: "러너 반박", needs_evidence: "추가 증거 필요", resolved: "해결", superseded: "정정됨", closed_no_action: "수정 불필요",
};
const TARGET_LABEL: Record<DiagnosisTarget, string> = { IMPLEMENTING: "구현 단계", CLAUDE_FIX: "수정 단계", CLAUDE_PLAN: "계획 개정" };
// 등록할 수 있는 정지: 구현·수정 계열 단계에서 멈춘 상태. 계획 단계의 실패는 이 기록의 범위가 아니다.
const STOPPED_STATES = new Set(["USER_DECISION_REQUIRED", "FAILED", "BLOCKED_ON_EVIDENCE"]);
const DELIVERY_RESUME_STATES = new Set(["IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX", "CODEX_FINAL_REVIEW"]);

export function describeDiagnoses(records: readonly DiagnosisRecord[]): string {
  return records.map((record) => `${record.id}(${STATUS_LABEL[record.status]})`).join(", ");
}

export class DiagnosisService {
  constructor(private readonly core: EngineCore) {}

  private get db() {
    return this.core.dependencies.database;
  }

  list(topicId: string): DiagnosisRecord[] {
    this.db.getTopic(topicId);
    return this.db.diagnoses.list(topicId);
  }

  get(topicId: string, id: string): DiagnosisRecord {
    const record = this.db.diagnoses.get(topicId, id);
    if (!record) throw Object.assign(new Error(`진단 ${id} 를 찾을 수 없습니다.`), { statusCode: 404 });
    return record;
  }

  // ---- 등록 ---------------------------------------------------------------------------------------------------------------
  async register(topicId: string, input: DiagnosisInput, requestKey?: string, origin?: DiagnosisOrigin): Promise<DiagnosisRecord> {
    this.core.assertNotShuttingDown();
    this.core.assertNoActiveWork(topicId);
    this.core.diagnosisActive.add(topicId);
    try {
      const topic = this.db.getTopic(topicId);
      const resume = this.db.getFlags(topicId).resumeState;
      this.assertRegistrable(topic, resume);
      if (this.db.unknownDeliveryAction(topicId)) {
        throw new DiagnosisConflict("결과가 불명확한 commit 또는 push 가 있습니다 — 기존 전달 복구(reconcile-delivery)로 결과를 먼저 확정한 뒤 진단을 등록하세요.");
      }
      const binding = await this.captureBinding(topic);
      const unknown = input.relatedRequestIds.filter((id) => !binding.openRequestIds.includes(id));
      if (unknown.length > 0) {
        throw new DiagnosisConflict(`관련 요청 ${unknown.join(", ")} 은 지금 열린 요청이 아닙니다(열린 요청: ${binding.openRequestIds.join(", ") || "없음"}).`);
      }
      if (input.supersedes) {
        const previous = this.db.diagnoses.get(topicId, input.supersedes);
        if (!previous) throw new DiagnosisConflict(`정정 대상 진단 ${input.supersedes} 가 이 주제에 없습니다.`);
        if (CLOSED_DIAGNOSIS_STATUSES.has(previous.status)) throw new DiagnosisConflict(`정정 대상 진단 ${input.supersedes} 는 이미 닫혔습니다(${STATUS_LABEL[previous.status]}).`);
      }
      // 결속을 잡는 await 사이에 주제가 바뀌었으면 등록하지 않는다(낡은 결속으로 기록하지 않음).
      const now = this.db.getTopic(topicId);
      if (now.scopeGeneration !== topic.scopeGeneration || now.state !== topic.state || now.planSHA256 !== topic.planSHA256 || this.core.active.has(topicId)) {
        throw new DiagnosisConflict("진단을 등록하는 동안 주제의 상태·계획·세대가 바뀌었습니다. 다시 시도하세요.");
      }
      const record = this.db.registerDiagnosis({
        topicId, diagnosis: input, binding, origin: origin ?? null,
        initialStatus: input.kind === "no_action" ? "closed_no_action" : "registered",
        event: (id) => ({
          actor: "system", kind: "system", state: topic.state,
          body: `중재자 진단 ${id} 등록(${KIND_LABEL[input.kind]}${input.supersedes ? `, ${input.supersedes} 정정` : ""}): ${input.title}`
            + (input.kind === "fix" ? ` — 계획 변경 ${input.planChange?.required ? "필요" : "없음"}.` : ".")
            + (input.kind === "no_action" ? "" : " 등록은 해결이 아닙니다 — 적용(apply)해야 구현·수정으로 반환됩니다."),
          payload: {
            diagnosis: { id, kind: input.kind, supersedes: input.supersedes ?? null, relatedRequestIds: input.relatedRequestIds },
            ...(origin ? { origin } : {}),
            ...(requestKey ? { requestKey, requestAction: "diagnosis:register" } : {}),
          },
        }),
      });
      // 원문 산출물(러너 읽기용)은 등록 확정 뒤에 쓴다 — 실패해도 기록은 남고 전달 시점에 다시 만든다(내용은 불변 행에서 결정된다).
      await this.artifactPath(record).catch(() => null);
      return record;
    } finally {
      this.core.diagnosisActive.delete(topicId);
    }
  }

  private assertRegistrable(topic: Topic, resume: string | null): void {
    if (topic.state === "READY_TO_DELIVER") return;
    if (STOPPED_STATES.has(topic.state) && resume && DELIVERY_RESUME_STATES.has(resume)) return;
    throw new DiagnosisConflict(`진단은 구현·수정이 멈춘 상태(재개 단계: 구현·리뷰·수정·최종 리뷰)나 인도 대기에서만 등록합니다(현재 ${topic.state}/${resume ?? "-"}).`);
  }

  // 등록 시점의 서버 결속 — 세대·계획·실패(마지막 실행)·체크포인트·작업 트리 HEAD 와 diff 해시·열린 요청.
  private async captureBinding(topic: Topic): Promise<DiagnosisBinding> {
    const flags = this.db.getFlags(topic.id);
    const worktree = await this.core.dependencies.git.snapshot(topic.worktreePath);
    let checkpoint: WorkCheckpoint | null = null;
    try {
      const latest = await this.core.checkpoints.latest(topic.id);
      if (latest && latest.work.scopeGeneration === topic.scopeGeneration) checkpoint = latest;
    } catch {
      checkpoint = null; // 손상 checkpoint 는 결속에 쓰지 않는다(재개가 따로 멈춘다).
    }
    const action = this.db.latestAction(topic.id);
    return {
      scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, planSHA256: topic.planSHA256, approvedPlanSHA256: topic.approvedPlanSHA256,
      state: topic.state, resumeState: flags.resumeState,
      failure: { actionId: action?.id ?? null, actionKind: action?.kind ?? null, actionStatus: action?.status ?? null },
      checkpoint: checkpoint ? { revision: checkpoint.revision, workId: workId(checkpoint.work), phase: checkpoint.phase } : null,
      worktree, inputSequence: this.core.latestSequence(topic.id),
      openRequestIds: await this.openRequestIds(topic, checkpoint),
    };
  }

  // 지금 열린 요청 id — 최신 checkpoint(같은 계획)의 요청, 없으면 옛 산출물의 요청(재개가 쓰는 것과 같은 규칙: 제시 시점 0).
  private async openRequestIds(topic: Topic, checkpoint: WorkCheckpoint | null): Promise<string[]> {
    if (checkpoint && checkpoint.work.planSHA256 === topic.planSHA256) return checkpoint.openRequests.map((request) => request.id);
    const ids: string[] = [];
    for (const kind of ["implementation-result", "claude-fix"]) {
      const artifact = this.db.latestArtifact(topic.id, kind);
      if (!artifact || artifact.scopeGeneration !== topic.scopeGeneration) continue;
      try {
        const result = await this.core.latestResult(topic.id, kind);
        const asked = result.requestedUserDecision?.trim();
        if (asked) ids.push(requestId(asked, 0));
      } catch {
        // 옛 산출물 해석 실패는 요청이 없는 것으로 본다.
      }
    }
    return [...new Set(ids)];
  }

  // ---- 적용 ---------------------------------------------------------------------------------------------------------------
  // resume: 공통 재시도 사다리(WorkflowEngine.retry). 적용 기록(applied + 반환 단계)은 재개 시작 전에 확정된다 — 재개가 한도·예산으로 막혀도
  // 진단과 진행 상태는 보존되고, 기존 추가 승인 절차 뒤의 retry 가 이 진단을 전달한다(초기화·추가 승인 없음).
  async apply(
    topicId: string, diagnosisId: string, request: { requestKey?: string; origin?: DiagnosisOrigin; actionId?: string },
    resume: (topicId: string, actionId?: string) => string,
  ): Promise<string> {
    this.core.assertNotShuttingDown();
    this.core.assertNoActiveWork(topicId);
    this.core.diagnosisActive.add(topicId);
    try {
      const record = this.get(topicId, diagnosisId);
      if (record.input.kind !== "fix") {
        throw new DiagnosisConflict(`${record.id} 는 ${KIND_LABEL[record.input.kind]} 기록이라 적용할 수 없습니다 — 원인 미확정의 조사 기록은 구현 재개를 허용하지 않습니다. 원인이 확인되면 정정(fix, supersedes: ${record.id})을 등록하세요.`);
      }
      if (record.status !== "registered") {
        throw new DiagnosisConflict(`${record.id} 는 ${STATUS_LABEL[record.status]} 상태라 적용할 수 없습니다(등록 상태의 진단만 적용합니다).`);
      }
      const topic = this.db.getTopic(topicId);
      const flags = this.db.getFlags(topicId);
      if (this.db.unknownDeliveryAction(topicId)) {
        throw new DiagnosisConflict("결과가 불명확한 commit 또는 push 가 있습니다 — 기존 전달 복구(reconcile-delivery)를 먼저 따르세요.");
      }
      if (topic.state === "READY_TO_DELIVER" && (flags.committedOID || flags.pushedOID)) {
        throw new DiagnosisConflict("이미 커밋(또는 push)한 결과는 같은 주제에서 이어 고칠 수 없습니다 — 전달 기록을 처분한 뒤 다시 진단하세요.");
      }
      // 낡은 진단: 등록 뒤 계획·코드·세대·실패(마지막 실행)가 바뀌었으면 기록을 보존한 채 재확인을 요구한다.
      const current = await this.captureBinding(topic);
      const drift = bindingDrift(record.binding, current);
      if (drift.length > 0) {
        this.db.recordDiagnosisStatus({
          topicId, entries: [{ diagnosisId: record.id, status: "stale", detail: { drift, at: current.inputSequence } }],
          event: {
            actor: "system", kind: "system", state: topic.state,
            body: `중재자 진단 ${record.id} 는 등록 뒤 ${drift.join("·")} 이(가) 바뀌어 적용하지 않았습니다(기록 보존). 지금 상태를 다시 진단해 정정(supersedes: ${record.id})으로 등록하세요.`,
            payload: { diagnosisStale: { id: record.id, drift } },
          },
        });
        throw new DiagnosisConflict(`진단 ${record.id} 는 등록 뒤 ${drift.join("·")} 이(가) 바뀌었습니다 — 적용하지 않고 재확인을 요구합니다(기록은 보존).`);
      }
      if (record.input.planChange?.required) {
        throw new DiagnosisConflict(`${record.id} 는 계획 변경이 필요한 진단입니다 — 계획 개정 경로로만 적용합니다.`);
      }
      const route = this.routeFor(topicId, topic, flags.resumeState);
      const fromReady = topic.state === "READY_TO_DELIVER";
      this.db.recordDiagnosisStatus({
        topicId,
        entries: [{ diagnosisId: record.id, status: "applied", detail: { mode: route.mode, target: route.target, fromState: topic.state, fromResume: flags.resumeState } }],
        // 인도 대기에서 반환하면 기존 완료 판정(최종 리뷰가 확인한 스냅샷)을 취소한다 — 커밋은 새 수정 결과의 최종 리뷰 뒤에만 열린다.
        changes: { resumeState: route.target, ...(fromReady ? { reviewedHead: null, reviewedDiffSHA256: null } : {}) },
        event: {
          actor: "system", kind: "system", state: topic.state,
          body: `중재자 진단 ${record.id} 적용 — ${TARGET_LABEL[route.target]}(${route.mode === "work" ? "멈춘 작업에 수정 지시로" : "진단 전용 수정 작업 → 최종 리뷰"})로 반환합니다.`
            + (fromReady ? " 인도 대기의 완료 판정을 취소했습니다 — 수정 결과는 다시 최종 리뷰를 거쳐야 커밋할 수 있습니다." : "")
            + " 같은 계획·작업 트리·세션과 누적 기록을 유지하고, 열린 요청은 자동으로 닫지 않습니다.",
          payload: {
            diagnosisApplied: { id: record.id, mode: route.mode, target: route.target },
            ...(request.origin ? { origin: request.origin } : {}),
            ...(request.requestKey ? { requestKey: request.requestKey, requestAction: `diagnosis:apply:${record.id}` } : {}),
          },
        },
      });
    } finally {
      this.core.diagnosisActive.delete(topicId);
    }
    return resume(topicId, request.actionId);
  }

  // 반환 경로: 이미 적용·전달 중인 진단이 있으면 같은 경로(같은 실패의 진단은 같은 작업으로 간다). 없으면 멈춘 단계로 정한다 —
  // 구현·첫 리뷰 정지 → 구현 작업, 수정 정지 → 그 수정 작업, 최종 리뷰 정지·인도 대기 → 진단 전용 수정 작업(→ 최종 리뷰).
  private routeFor(topicId: string, topic: Topic, resume: string | null): { mode: DiagnosisApplyMode; target: DiagnosisTarget } {
    const inflight = this.db.diagnoses.list(topicId)
      .filter((record) => record.status === "applied" || record.status === "delivered")
      .map((record) => applyInfo(record))
      .filter((info): info is NonNullable<ReturnType<typeof applyInfo>> => info !== null && info.mode !== "plan-revision")
      .sort((a, b) => b.seq - a.seq)[0];
    if (inflight) return { mode: inflight.mode, target: inflight.target };
    if (topic.state === "READY_TO_DELIVER") return { mode: "diagnosis-fix", target: "CLAUDE_FIX" };
    if (!STOPPED_STATES.has(topic.state)) throw new DiagnosisConflict(`${topic.state} 상태에서는 진단을 적용할 수 없습니다.`);
    if (resume === "IMPLEMENTING" || resume === "CODEX_REVIEW") return { mode: "work", target: "IMPLEMENTING" };
    if (resume === "CLAUDE_FIX") return { mode: "work", target: "CLAUDE_FIX" };
    if (resume === "CODEX_FINAL_REVIEW") return { mode: "diagnosis-fix", target: "CLAUDE_FIX" };
    throw new DiagnosisConflict(`재개 단계 ${resume ?? "-"} 에서는 진단을 적용할 수 없습니다.`);
  }

  // ---- 공통 진단 상태 검사 -------------------------------------------------------------------------------------------------
  // 재개 진입점(retry·구현 재개·자동 재시도·구현 시작)은 중재자가 처리할 진단(적용 대기·재확인·반박·추가 증거)을 우회하지 못한다.
  assertResumable(topicId: string, entry: string): void {
    const pending = this.db.diagnoses.list(topicId).filter((record) => MEDIATOR_PENDING_STATUSES.has(record.status));
    if (pending.length === 0) return;
    throw new DiagnosisConflict(`${entry} 을(를) 막았습니다 — 중재자가 처리할 진단이 있습니다: ${describeDiagnoses(pending)}. `
      + "적용(apply)하거나 정정(supersedes 로 새 진단)하세요. 진단 등록만으로는 재개·완료되지 않습니다.");
  }

  // 인도 진입점(commit·push·close)은 해결되지 않은 진단이 있으면 막는다.
  assertDeliverable(topicId: string, entry: string): void {
    const open = this.db.diagnoses.list(topicId).filter((record) => !CLOSED_DIAGNOSIS_STATUSES.has(record.status));
    if (open.length === 0) return;
    throw new DiagnosisConflict(`${entry} 을(를) 막았습니다 — 해결되지 않은 진단: ${describeDiagnoses(open)}. `
      + "적용해 수정·리뷰를 거치거나, 정정으로 닫아야 인도할 수 있습니다.");
  }

  // ---- 작업 전달 ----------------------------------------------------------------------------------------------------------
  // 이 작업(반환 단계·경로)에 실을 진단 — 적용·전달됨(처분 보고 전).
  forWork(topicId: string, target: DiagnosisTarget, mode: DiagnosisApplyMode): DiagnosisRecord[] {
    return this.db.diagnoses.list(topicId).filter((record) => {
      if (record.status !== "applied" && record.status !== "delivered") return false;
      const info = applyInfo(record);
      return info !== null && info.target === target && info.mode === mode;
    });
  }

  findings(records: readonly DiagnosisRecord[]): Finding[] {
    return records.map((record) => diagnosisFinding(record));
  }

  // 원문 산출물 경로(sha 검증된 blob) — 없으면 불변 행에서 다시 만든다.
  async artifactPath(record: DiagnosisRecord): Promise<string> {
    const kind = `diagnosis-${record.id}`;
    if (!this.db.latestArtifact(record.topicId, kind)) {
      const { history: _history, status: _status, ...immutable } = record;
      await this.core.dependencies.artifacts.write(record.topicId, kind, 1, JSON.stringify(immutable, null, 2), { scopeGeneration: record.binding.scopeGeneration });
    }
    return this.core.dependencies.artifacts.verifiedPath(record.topicId, kind);
  }

  async prompts(records: readonly DiagnosisRecord[]): Promise<{ prompts: DiagnosisPrompt[]; paths: string[] }> {
    const prompts: DiagnosisPrompt[] = [];
    const paths: string[] = [];
    for (const record of records) {
      const path = await this.artifactPath(record).catch(() => null);
      if (path) paths.push(path);
      prompts.push(toDiagnosisPrompt(record, path));
    }
    return { prompts, paths };
  }

  // 전달 기록 — 이 진단을 실은 쓰기 턴의 프로세스가 **실제로 시작됐을 때**(spawn) 남긴다. 프롬프트 생성·spawn 전 거부는 전달이 아니다.
  markDelivered(topicId: string, records: readonly DiagnosisRecord[], detail: Record<string, unknown>): void {
    const ids = new Set(records.map((record) => record.id));
    const pending = this.db.diagnoses.list(topicId).filter((record) => ids.has(record.id) && record.status === "applied");
    if (pending.length === 0) return;
    this.db.recordDiagnosisStatus({
      topicId, entries: pending.map((record) => ({ diagnosisId: record.id, status: "delivered" as const, detail })),
      event: {
        actor: "system", kind: "system", state: this.db.getTopic(topicId).state,
        body: `중재자 진단 ${pending.map((record) => record.id).join(", ")} 을(를) 실은 쓰기 턴의 프로세스가 시작됐습니다(전달). 해결은 러너의 처분 보고와 리뷰 뒤입니다.`,
        payload: { diagnosisDelivered: pending.map((record) => record.id), ...detail },
      },
    });
  }

  // 수락된 결과의 처분 기록 — 반영(RESOLVED_BY_FIX)만 fix_reported. 같은 수락(acceptId)으로는 한 번만 기록한다(재개 멱등).
  recordAccepted(topicId: string, records: readonly DiagnosisRecord[], accepted: AgentResult, acceptId: number): void {
    const ids = new Set(records.map((record) => record.id));
    const entries: Array<{ diagnosisId: string; status: DiagnosisStatus; detail: Record<string, unknown> }> = [];
    for (const record of this.db.diagnoses.list(topicId)) {
      if (!ids.has(record.id) || (record.status !== "applied" && record.status !== "delivered")) continue;
      const finding = accepted.findings.find((item) => item.id === record.id);
      if (finding?.disposition !== "RESOLVED_BY_FIX") continue;
      entries.push({ diagnosisId: record.id, status: "fix_reported", detail: { acceptId, evidenceRefs: finding.evidenceRefs, rationale: finding.rationale } });
    }
    if (entries.length === 0) return;
    this.db.recordDiagnosisStatus({
      topicId, entries,
      event: {
        actor: "system", kind: "system", state: this.db.getTopic(topicId).state,
        body: `러너가 중재자 진단 ${entries.map((entry) => entry.diagnosisId).join(", ")} 의 반영을 보고했습니다 — 리뷰가 수정과 검증 근거를 확인해야 해결입니다.`,
        payload: { diagnosisFixReported: entries.map((entry) => entry.diagnosisId), acceptId },
      },
    });
  }

  // 인도 준비(최종 리뷰 통과)에 이르면 반영 보고된 진단은 해결이다.
  resolveReported(topicId: string, snapshot: { head: string; diffSHA256: string }): void {
    const reported = this.db.diagnoses.list(topicId).filter((record) => record.status === "fix_reported");
    if (reported.length === 0) return;
    this.db.recordDiagnosisStatus({
      topicId, entries: reported.map((record) => ({ diagnosisId: record.id, status: "resolved" as const, detail: { reviewedHead: snapshot.head, reviewedDiffSHA256: snapshot.diffSHA256 } })),
      event: {
        actor: "system", kind: "system", state: this.db.getTopic(topicId).state,
        body: `중재자 진단 ${reported.map((record) => record.id).join(", ")} 의 수정이 리뷰를 통과했습니다(해결).`,
        payload: { diagnosisResolved: reported.map((record) => record.id) },
      },
    });
  }
}

// 등록 결속과 지금의 차이 — 계획·코드·세대·실패(마지막 실행). 상태·재개 단계는 비교하지 않는다(같은 실패의 다른 진단 적용이 바꾼다).
export function bindingDrift(registered: DiagnosisBinding, current: DiagnosisBinding): string[] {
  const drift: string[] = [];
  if (registered.scopeGeneration !== current.scopeGeneration) drift.push("범위 세대");
  if (registered.planEpoch !== current.planEpoch || registered.planSHA256 !== current.planSHA256) drift.push("계획");
  if (registered.failure.actionId !== current.failure.actionId) drift.push("실패(마지막 실행)");
  if (registered.worktree.head !== current.worktree.head || registered.worktree.diffSHA256 !== current.worktree.diffSHA256) drift.push("코드(작업 트리)");
  return drift;
}
