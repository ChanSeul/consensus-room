// 중재자 진단 서비스 — 저장·조회·적용·재개 검사·전달 기록의 책임을 한곳에 모은다(2026-09-14 진단 계획 §1).
//
// 흐름: 중재자가 멈춘 구현·수정(또는 인도 대기)의 실패를 진단해 등록한다(register) → 적용(apply)하면 같은 계획 안의 수정은
// 중단된 구현·수정 단계로 반환되고(공통 재시도 사다리 — 예산·리뷰·개정 한도를 그대로 거친다), 쓰기 턴의 프로세스가 실제로 뜰 때 전달(delivered)이
// 기록되며, 러너의 처분(반영·반박·추가 증거)이 수락된 결과로 기록되고, 수정 결과가 리뷰를 통과해 인도 준비에 이르면 해결(resolved)이다.
// 등록·적용·전달 어느 것도 해결이 아니다. 진단은 덮어쓰지 않는다 — 정정은 supersedes 로 이전 진단을 대체하는 새 기록이다.
import {
  CLOSED_DIAGNOSIS_STATUSES, MEDIATOR_PENDING_STATUSES, applyInfo, awaitingDelivery, diagnosisFinding, isPlanRevision, toDiagnosisPrompt,
  type DiagnosisApplyMode, type DiagnosisBinding, type DiagnosisInput, type DiagnosisOrigin, type DiagnosisPrompt,
  type DiagnosisRecord, type DiagnosisStatus, type DiagnosisTarget,
} from "../../shared/diagnoses.js";
import type { AgentResult, Finding, Topic, WorkflowState } from "../../shared/contracts.js";
import { assertTransition, hashPlan } from "../../shared/workflow.js";
import type { FixContract } from "../../shared/fixContract.js";
import { CheckpointCorrupt, checkpointOpenRequests, requestId, workId, type WorkCheckpoint } from "./checkpoint.js";
import { decisionRequestTexts } from "./completion.js";
import type { EngineCore } from "./core.js";

// 통과한 리뷰가 반영 보고된 진단을 확인한 처분(해결로 기록) — 그 밖의 처분은 해결이 아니다(resolveReported).
const REVIEW_CONFIRMS: ReadonlySet<string> = new Set(["RESOLVED_BY_FIX", "AGREED_NO_ACTION"]);

export class DiagnosisConflict extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "DiagnosisConflict";
  }
}

const KIND_LABEL: Record<DiagnosisInput["kind"], string> = { fix: "수정 진단", investigation: "추가 조사", no_action: "수정 불필요 결론" };
const STATUS_LABEL: Record<DiagnosisStatus, string> = {
  registered: "적용 대기", stale: "재확인 필요", applied: "적용됨·전달 전", plan_revised: "개정 계획 저장·승인 대기", delivered: "전달됨", fix_reported: "반영 보고됨·리뷰 전",
  refuted: "러너 반박", needs_evidence: "추가 증거 필요", resolved: "해결", superseded: "정정됨", closed_no_action: "수정 불필요",
};
const TARGET_LABEL: Record<DiagnosisTarget, string> = { IMPLEMENTING: "구현 단계", CLAUDE_FIX: "수정 단계", CLAUDE_PLAN: "계획 개정" };
// 등록할 수 있는 정지: 구현·수정 계열 단계에서 멈춘 상태. 계획 단계의 실패는 이 기록의 범위가 아니다.
const STOPPED_STATES = new Set(["USER_DECISION_REQUIRED", "FAILED", "BLOCKED_ON_EVIDENCE"]);
// 전체 재계획이 재확인(stale)으로 돌리는 진행 중 상태 — 이전 계획에 묶여 적용·전달·반영 보고됐다.
const STALE_ON_REPLAN: ReadonlySet<DiagnosisStatus> = new Set(["applied", "plan_revised", "delivered", "fix_reported"]);
// 계획 수렴 단계의 재개 지점 — 재계획 stale 진단은 이 재시도를 막지 않는다.
const PLANNING_RESUME_STATES: ReadonlySet<string> = new Set(["CLAUDE_PLAN", "CODEX_AUDIT", "CLAUDE_REVISION", "CODEX_CLOSEOUT", "CONSENSUS_ACK"]);

// 마지막 적용 뒤에 개정 계획이 저장됐는가(plan_revised) — 계획 변경 진단이 개정 저장을 지나 구현 단계로 넘어간 뒤의 상태다.
function revisedAfterApply(record: DiagnosisRecord): boolean {
  const applied = applyInfo(record);
  return applied !== null && record.history.some((entry) => entry.status === "plan_revised" && entry.seq > applied.seq);
}

// 전체 재계획이 재확인(stale)으로 돌린 진단인가(staleOnReplan) — 적용 시점 결속 대조가 남긴 stale 과 구분한다.
function isReplanStale(record: DiagnosisRecord): boolean {
  return record.status === "stale" && record.history.at(-1)?.detail.reason === "replan";
}
const DELIVERY_RESUME_STATES = new Set(["IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX", "CODEX_FINAL_REVIEW"]);
// 개정 계획을 아직 저장하지 않은 계획 변경 진단의 상태 — 이 동안 옛 승인 계획으로의 구현 재개·허용 오차 개정·다른 진단 적용을 막는다.
const UNSAVED_REVISION_STATUSES: ReadonlySet<DiagnosisStatus> = new Set(["applied", "refuted", "needs_evidence"]);
const carryKind = (id: string) => `diagnosis-carry-${id}`;

// 계획 변경 진단의 승계 기록(적용 시점, 산출물 diagnosis-carry-<id>) — 기준 계획 전문·남은 작업·열린 요청·검증 원장·바뀐 파일.
export interface PlanRevisionCarry {
  version: 1;
  basePlanSHA256: string;
  basePlan: string;
  checkpoint: { revision: number; workId: string; phase: string } | null;
  remainingSteps: string[];
  openRequests: WorkCheckpoint["openRequests"];
  verifiedLedger: WorkCheckpoint["verifiedLedger"];
  lastSummary: string | null;
  changedPaths: string[];
}

export type ReturnedDiagnosis = { record: DiagnosisRecord; finding: Finding; status: "refuted" | "needs_evidence" };

// 적용 기록의 세부 값(마지막 applied 항목).
function appliedDetail(record: DiagnosisRecord): Record<string, unknown> {
  return [...record.history].reverse().find((entry) => entry.status === "applied")?.detail ?? {};
}

// 러너·개정 턴의 처분이 진단을 중재자에게 돌려보내는가 — 반박(REFUTED·수정 불필요·범위 밖)은 refuted, 증거·결정 요청은 needs_evidence.
export function returnedStatus(finding: Finding): "refuted" | "needs_evidence" | null {
  if (finding.disposition === "EXTERNAL_EVIDENCE" || finding.requiresUserDecision) return "needs_evidence";
  if (finding.disposition === "REFUTED" || finding.disposition === "AGREED_NO_ACTION" || finding.disposition === "DEFERRED_OUT_OF_SCOPE") return "refuted";
  return null;
}

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

  // 지금 범위 세대의 진단 — 재개·인도·전달 검사는 이것만 본다. 범위 변경은 새 세대·새 작업 트리의 새 사건이라 이전 세대의 미해결 진단이
  // 새 구현·인도를 막지 않는다(기록은 조회에 그대로 남는다 — host-review R1).
  private current(topicId: string): DiagnosisRecord[] {
    const generation = this.db.getTopic(topicId).scopeGeneration;
    return this.db.diagnoses.list(topicId).filter((record) => record.binding.scopeGeneration === generation);
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
      // 저장 전 계획 개정(적용됨·반박·추가 증거)이 계획 개정 단계에서 멈춰 있으면 그 진단의 정정만 등록할 수 있다(정정이 막힘을 푸는 길이다).
      const correcting = this.unsavedPlanRevision(topicId);
      const correctingRevision = correcting !== null && input.supersedes === correcting.id && STOPPED_STATES.has(topic.state) && resume === "CLAUDE_PLAN";
      // 전체 재계획이 재확인(stale)으로 돌린 진단은 계획 단계·승인 대기에서도 수정 불필요(no_action)로 닫을 수 있다 — 닫지 못하면 구현 시작이
      // 영영 막힌다(host-review R9). 새 수정 진단은 이 단계에서 적용할 수 없으므로 받지 않는다(구현이 멈춘 뒤 새로 등록한다).
      const supersededTarget = input.supersedes ? this.db.diagnoses.get(topicId, input.supersedes) : null;
      const closingReplanStale = input.kind === "no_action" && supersededTarget !== null && isReplanStale(supersededTarget);
      if (!correctingRevision && !closingReplanStale) this.assertRegistrable(topic, resume, input.kind);
      if (this.db.unknownDeliveryAction(topicId)) {
        throw new DiagnosisConflict("결과가 불명확한 commit 또는 push 가 있습니다 — 기존 전달 복구(reconcile-delivery)로 결과를 먼저 확정한 뒤 진단을 등록하세요.");
      }
      const { binding, corrupt } = await this.captureBinding(topic);
      // 손상 checkpoint 의 열린 요청은 알 수 없다 — 요청에 기대는 등록(관련 요청 지정, 아래의 진단 전용 수정 종결)은 받지 않는다. 요청과 무관한 등록은 받는다 —
      // 인도 대기에서 미확인 반영 보고를 수정 불필요로 닫는 길까지 막으면 커밋이 영구히 막힌다(감사 5차 #3).
      if (corrupt && input.relatedRequestIds.length > 0) {
        throw new DiagnosisConflict(`최신 수정 checkpoint 가 손상돼 열린 요청을 판정할 수 없습니다 — ${corrupt.message}`);
      }
      const unknown = input.relatedRequestIds.filter((id) => !binding.openRequestIds.includes(id));
      if (unknown.length > 0) {
        throw new DiagnosisConflict(`관련 요청 ${unknown.join(", ")} 은 지금 열린 요청이 아닙니다(열린 요청: ${binding.openRequestIds.join(", ") || "없음"}).`);
      }
      if (input.supersedes) {
        const previous = this.db.diagnoses.get(topicId, input.supersedes);
        if (!previous) throw new DiagnosisConflict(`정정 대상 진단 ${input.supersedes} 가 이 주제에 없습니다.`);
        if (CLOSED_DIAGNOSIS_STATUSES.has(previous.status)) throw new DiagnosisConflict(`정정 대상 진단 ${input.supersedes} 는 이미 닫혔습니다(${STATUS_LABEL[previous.status]}).`);
        // 이전 범위 세대의 기록은 현재 세대의 경로·재개 결정에 쓰지 않는다(R1 과 같은 경계, 2026-09-15 감사: 이전 세대 사슬이 현재 수정 정지의 재개 단계를 바꿨다).
        if (previous.binding.scopeGeneration !== topic.scopeGeneration) {
          throw new DiagnosisConflict(`정정 대상 진단 ${input.supersedes} 는 이전 범위 세대(${previous.binding.scopeGeneration})의 기록입니다 — 현재 세대에서는 정정하지 않습니다. `
            + "지금 상태의 문제라면 새 진단으로 등록하세요.");
        }
      }
      // 저장 전 계획 개정을 정정하면 멈췄던 구현·리뷰 단계로 재개 단계를 되돌린다 — 개정 계획이 저장되지 않았으므로 옛 승인 계획이 그대로 유효하다.
      const restoreValue = correctingRevision && correcting ? appliedDetail(correcting).restoreResume : undefined;
      // 진단 전용 수정 작업(계약)의 진단이 이 정정으로 모두 닫히면 그 작업은 수정 없이 끝난다 — 계약을 closed 로 두고 반환 전 단계인 최종 리뷰로 되돌린다.
      // 적용이 인도 대기의 완료 판정을 취소했으므로 지금 작업 트리를 다시 최종 리뷰해야 커밋이 열리고, 계약의 원본(정지 쟁점)은 그 최종 리뷰가 판정한다.
      // 열린 계약이 리뷰 수정이면(일반 수정 작업이 멈춤) 되돌리지 않는다 — 그 작업의 원본 쟁점이 남아 있다(2026-09-15 감사 2차: 정정 사슬로 경로를 추정해
      // 일반 수정 정지를 최종 리뷰로 돌려 확정 결함을 판정 없이 버렸다).
      // 순차 적용 대기(인도 대기 + 재개 CLAUDE_FIX)도 포함한다 — 인도 대기에서 적용만 기록한 진단 전용 계약을 정정으로 닫지 못하면 retry 가 매번 FAILED 였다
      // (2026-09-15 감사 3차).
      const openContract = resume === "CLAUDE_FIX" && (STOPPED_STATES.has(topic.state) || topic.state === "READY_TO_DELIVER")
        ? await this.ensureContract(topicId).catch((error: unknown) => { if (error instanceof DiagnosisConflict) throw error; return null; }) : null;
      const closesDiagnosisFix = input.kind === "no_action" && input.supersedes !== undefined && openContract?.route === "diagnosis"
        && this.relatesToContract(topicId, openContract.diagnosisIds, input.supersedes)
        && openContract.diagnosisIds.every((id) => id === input.supersedes || CLOSED_DIAGNOSIS_STATUSES.has(this.db.diagnoses.get(topicId, id)?.status ?? "superseded"))
        // 등록만 된 정정(적용 대기)이 이 계약의 진단에 닿아 있으면 닫지 않는다 — 그 정정은 적용되면 이 계약에 덧붙는 같은 작업이다. 닫으면 정정 순서에 따라 정지 원본의
        // 수정이 진단 작업에서 떨어져 리뷰 수정 회차로 밀렸다(감사 6차 #11). 이 no_action 이 대체하는 정정 자신은 뺀다(이 등록으로 닫힌다).
        && !this.current(topicId).some((other) => other.status === "registered" && other.id !== input.supersedes && other.input.supersedes !== undefined
          && this.relatesToContract(topicId, openContract.diagnosisIds, other.input.supersedes));
      const restore = typeof restoreValue === "string" ? restoreValue as WorkflowState : closesDiagnosisFix ? "CODEX_FINAL_REVIEW" : null;
      // 인도 대기에서 닫으면 인도 대기 → 최종 리뷰 전이가 없으므로 정지(FAILED, 재개 = 최종 리뷰)로 옮긴다 — 재시도가 지금 작업 트리를 최종 리뷰한다.
      const closingFromReady = closesDiagnosisFix && topic.state === "READY_TO_DELIVER";
      if (closingFromReady) assertTransition(topic.state, "FAILED");
      // 그 작업에 열린 요청이 남았으면 수정 불필요로 닫지 않는다 — 닫으면 요청을 해소할 작업 없이 최종 리뷰·인도로 넘어간다(host-review R10).
      // 요청은 러너가 id 로 해소해야 닫힌다: 요청 해소를 지시하는 정정(fix)이 같은 진단 전용 수정 경로를 잇는다.
      if (closesDiagnosisFix && corrupt) {
        throw new DiagnosisConflict(`최신 수정 checkpoint 가 손상돼 진단 전용 수정 작업의 열린 요청을 판정할 수 없어 수정 불필요로 닫지 않습니다 — ${corrupt.message}`);
      }
      if (closesDiagnosisFix && binding.openRequestIds.length > 0) {
        throw new DiagnosisConflict(`진단 전용 수정 작업에 열린 요청 ${binding.openRequestIds.join(", ")} 이(가) 남아 있습니다 — 수정 불필요로 닫으면 그 요청을 해소할 작업이 `
          + "사라집니다. 요청 해소를 지시하는 정정(kind fix, supersedes)으로 진단 전용 수정을 이어가세요(반박되지 않은 진단이면 결정을 올리고 재시도해도 됩니다).");
      }
      // 결속을 잡는 await 사이에 주제가 바뀌었으면 등록하지 않는다(낡은 결속으로 기록하지 않음).
      const now = this.db.getTopic(topicId);
      if (now.scopeGeneration !== topic.scopeGeneration || now.state !== topic.state || now.planSHA256 !== topic.planSHA256 || this.core.active.has(topicId)) {
        throw new DiagnosisConflict("진단을 등록하는 동안 주제의 상태·계획·세대가 바뀌었습니다. 다시 시도하세요.");
      }
      const record = this.db.registerDiagnosis({
        topicId, diagnosis: input, binding, origin: origin ?? null,
        initialStatus: input.kind === "no_action" ? "closed_no_action" : "registered",
        changes: restore ? {
          resumeState: restore,
          ...(closingFromReady ? { state: "FAILED" as const, lastError: "진단 전용 수정의 진단이 모두 정정으로 닫혔습니다 — 재시도(retry)가 지금 작업 트리를 최종 리뷰합니다." } : {}),
        } : undefined,
        contracts: closesDiagnosisFix && openContract ? [this.core.fixContracts.closed(openContract, this.core.latestSequence(topicId))] : undefined,
        event: (id) => ({
          actor: "system", kind: "system", state: topic.state,
          body: `중재자 진단 ${id} 등록(${KIND_LABEL[input.kind]}${input.supersedes ? `, ${input.supersedes} 정정` : ""}): ${input.title}`
            + (input.kind === "fix" ? ` — 계획 변경 ${input.planChange?.required ? "필요" : "없음"}.` : ".")
            + (input.kind === "no_action" ? "" : " 등록은 해결이 아닙니다 — 적용(apply)해야 구현·수정으로 반환됩니다.")
            + (restore && !closesDiagnosisFix ? ` 저장 전 계획 개정(${input.supersedes})을 정정했습니다 — 재개 단계를 ${restore} 로 되돌립니다(기존 승인 계획 유지).` : "")
            + (closesDiagnosisFix ? ` 진단 전용 수정(${input.supersedes})을 수정 불필요로 닫았습니다 — 재개 단계를 최종 리뷰(CODEX_FINAL_REVIEW)로 되돌립니다(지금 작업 트리를 다시 최종 리뷰해야 커밋할 수 있습니다).` : ""),
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

  private assertRegistrable(topic: Topic, resume: string | null, kind: DiagnosisInput["kind"]): void {
    if (topic.state === "READY_TO_DELIVER") {
      // 커밋(또는 push)한 결과에는 수정·조사 진단을 적용할 수 없다 — 등록만 받으면 적용도 인도도 못 하는 진단이 남아 push·close 가 막혔다(2026-09-15 감사 2차).
      const flags = this.db.getFlags(topic.id);
      if (kind !== "no_action" && (flags.committedOID || flags.pushedOID)) {
        throw new DiagnosisConflict("이미 커밋(또는 push)한 결과에는 수정·조사 진단을 등록하지 않습니다 — 인도를 마친 뒤 새 주제에서 진단하거나, "
          + "범위 변경(scope_change)으로 새 세대를 열어 고치세요. 열린 진단은 수정 불필요(no_action, supersedes)로 닫을 수 있습니다.");
      }
      return;
    }
    if (STOPPED_STATES.has(topic.state) && resume && DELIVERY_RESUME_STATES.has(resume)) return;
    throw new DiagnosisConflict(`진단은 구현·수정이 멈춘 상태(재개 단계: 구현·리뷰·수정·최종 리뷰)나 인도 대기에서만 등록합니다(현재 ${topic.state}/${resume ?? "-"}).`);
  }

  // 등록 시점의 서버 결속 — 세대·계획·실패(마지막 실행)·체크포인트·작업 트리 HEAD 와 diff 해시·열린 요청. 손상 checkpoint 는 결속에 쓰지 않되 삼키지 않고
  // corrupt 로 돌려준다 — 그 checkpoint 에 기대는 판단(열린 요청)은 호출자가 멈춘다(2026-09-15 감사 5차 #3: 결속이 손상을 삼켜, 열린 요청 검사(R10)를 통과한
  // 진단 전용 수정의 수정 불필요 종결이 요청을 해소하지 않은 채 커밋까지 갔다).
  private async captureBinding(topic: Topic): Promise<{ binding: DiagnosisBinding; corrupt: CheckpointCorrupt | null }> {
    const flags = this.db.getFlags(topic.id);
    const worktree = await this.core.dependencies.git.snapshot(topic.worktreePath);
    let checkpoint: WorkCheckpoint | null = null;
    let corrupt: CheckpointCorrupt | null = null;
    try {
      const latest = await this.core.checkpoints.latest(topic.id);
      if (latest && latest.work.scopeGeneration === topic.scopeGeneration) checkpoint = latest;
    } catch (error) {
      if (!(error instanceof CheckpointCorrupt)) throw error;
      corrupt = error;
    }
    const action = this.db.latestAction(topic.id);
    const binding: DiagnosisBinding = {
      scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, planSHA256: topic.planSHA256, approvedPlanSHA256: topic.approvedPlanSHA256,
      state: topic.state, resumeState: flags.resumeState,
      failure: { actionId: action?.id ?? null, actionKind: action?.kind ?? null, actionStatus: action?.status ?? null },
      checkpoint: checkpoint ? { revision: checkpoint.revision, workId: workId(checkpoint.work), phase: checkpoint.phase } : null,
      worktree, inputSequence: this.core.latestSequence(topic.id),
      openRequestIds: await this.openRequestIds(topic, checkpoint),
    };
    return { binding, corrupt };
  }

  // 지금 열린 요청 id — 최신 checkpoint(같은 계획)의 요청, 없으면 옛 산출물의 요청(재개가 쓰는 것과 같은 규칙: 제시 시점 0).
  private async openRequestIds(topic: Topic, checkpoint: WorkCheckpoint | null): Promise<string[]> {
    // 같은 세대·같은 계획 주기의 최신 checkpoint 가 기준이다 — 작업 id·계획 sha(허용 오차 개정)가 바뀌어도 요청은 주제·계획 주기에 속한다(열린 요청 승계와 같은 규칙,
    // 2026-09-15 감사: 계획 sha 로 대조하면 허용 오차 개정 뒤 옛 산출물로 폴백해 열린 요청을 놓쳤다).
    if (checkpoint && checkpoint.work.planEpoch === topic.planEpoch) return checkpointOpenRequests(checkpoint).map((request) => request.id);
    return (await this.legacyOpenRequests(topic)).map((request) => request.id);
  }

  // ---- 적용 ---------------------------------------------------------------------------------------------------------------
  // resume: 공통 재시도 사다리(WorkflowEngine.retry). 적용 기록(applied + 반환 단계)은 재개 시작 전에 확정된다 — 재개가 한도·예산으로 막혀도
  // 진단과 진행 상태는 보존되고, 기존 추가 승인 절차 뒤의 retry 가 이 진단을 전달한다(초기화·추가 승인 없음).
  async apply(
    topicId: string, diagnosisId: string, request: { requestKey?: string; origin?: DiagnosisOrigin; actionId?: string },
    resume: (topicId: string, actionId?: string) => string,
  ): Promise<string | null> {
    this.core.assertNotShuttingDown();
    this.core.assertNoActiveWork(topicId);
    this.core.diagnosisActive.add(topicId);
    let waiting: DiagnosisRecord[] = [];
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
        throw new DiagnosisConflict("이미 커밋(또는 push)한 결과는 같은 주제에서 이어 고칠 수 없습니다 — 이 진단은 수정 불필요(no_action, supersedes)로 닫고, "
          + "고칠 것이 있으면 범위 변경(scope_change)으로 새 세대를 열거나 인도 뒤 새 주제에서 진단하세요.");
      }
      // 낡은 진단: 등록 뒤 계획·코드·세대·실패(마지막 실행)가 바뀌었으면 기록을 보존한 채 재확인을 요구한다.
      // 손상 checkpoint 가 있으면 적용하지 않는다 — 적용은 재개를 부르고 재개는 손상에서 멈추는데, 그 적용을 되돌리는 수정 불필요 종결은 열린 요청을 판정할 수
      // 없어 409 라 커밋할 수 있던 토픽이 영구히 막혔다(2026-09-15 감사 6차 #2). 적용 전 상태(인도 대기 완료 판정·정지)를 그대로 두고 손상 checkpoint 를 먼저
      // 복구하게 한다. 결속 비교(드리프트)는 checkpoint 를 쓰지 않는다.
      const { binding: current, corrupt } = await this.captureBinding(topic);
      if (corrupt) {
        throw new DiagnosisConflict(`최신 수정 checkpoint 가 손상돼 적용하지 않습니다 — 적용 뒤 재개가 손상에서 멈추고 그 적용을 되돌릴 수 없습니다. 손상 checkpoint 를 `
          + `먼저 복구하세요(${corrupt.message}).`);
      }
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
      const unsaved = this.unsavedPlanRevision(topicId);
      if (unsaved) {
        throw new DiagnosisConflict(`계획 변경 진단 ${unsaved.id}(${STATUS_LABEL[unsaved.status]})의 개정 계획이 아직 저장되지 않았습니다 — 그 진단을 정정(supersedes)하거나 개정이 끝난 뒤 적용하세요.`);
      }
      // 적용 뒤 곧바로 여는 재개가 막힐 조건이면 적용을 기록하지 않는다 — 기록 뒤에 재개가 거부되면 반쯤 적용된 상태(인도 대기의 완료 판정 취소·
      // 재개 단계만 바뀜)로 굳어 커밋도 재시도도 할 수 없었다(2026-09-15 감사).
      waiting = this.assertApplyResumable(topicId, record);
      if (record.input.planChange?.required) {
        await this.applyPlanRevision(topic, flags, record, request);
      } else {
        // 멈춘 수정 작업의 계약(계약 도입 전 작업이면 이관)을 먼저 확정한다 — 경로·원본을 그 계약이 정한다.
        if (flags.resumeState === "CLAUDE_FIX" && (STOPPED_STATES.has(topic.state) || topic.state === "READY_TO_DELIVER")) await this.ensureContract(topicId);
        const route = this.routeFor(topicId, topic, flags.resumeState);
        const fromReady = topic.state === "READY_TO_DELIVER";
        // 수정 작업 계약 행(적용과 한 transaction): 진단 전용 수정은 새 계약(또는 열린 진단 전용 계약에 덧붙임), 멈춘 수정 작업은 그 계약에 수정 지시로 덧붙인다.
        let contracts: FixContract[] = [];
        if (route.mode === "diagnosis-fix") {
          const contract = await this.core.fixContracts.forDiagnosis(topic, record.id, topic.state, flags.resumeState);
          contracts = [...this.core.fixContracts.abandonOpen(topicId, contract.contractId), contract];
        } else if (route.target === "CLAUDE_FIX") {
          const open = this.core.fixContracts.open(topicId);
          if (!open) throw new DiagnosisConflict("멈춘 수정 작업의 계약을 찾을 수 없습니다 — 계획·상태를 먼저 확인하세요.");
          contracts = [this.core.fixContracts.withDiagnosis(open, record.id)];
        }
        this.db.recordDiagnosisStatus({
          topicId, contracts,
          entries: [{ diagnosisId: record.id, status: "applied", detail: { mode: route.mode, target: route.target, fromState: topic.state, fromResume: flags.resumeState } }],
          // 인도 대기에서 반환하면 기존 완료 판정(최종 리뷰가 확인한 스냅샷)을 취소한다 — 커밋은 새 수정 결과의 최종 리뷰 뒤에만 열린다.
          changes: { resumeState: route.target, ...(fromReady ? { reviewedHead: null, reviewedDiffSHA256: null } : {}) },
          event: {
            actor: "system", kind: "system", state: topic.state,
            body: `중재자 진단 ${record.id} 적용 — ${TARGET_LABEL[route.target]}(${route.mode === "work" ? "멈춘 작업에 수정 지시로" : "진단 전용 수정 작업 → 최종 리뷰"})로 반환합니다.`
              + (fromReady ? " 인도 대기의 완료 판정을 취소했습니다 — 수정 결과는 다시 최종 리뷰를 거쳐야 커밋할 수 있습니다." : "")
              + " 같은 계획·작업 트리·세션과 누적 기록을 유지하고, 열린 요청은 자동으로 닫지 않습니다."
              + (waiting.length > 0 ? ` 등록된 다른 수정 진단(${waiting.map((item) => item.id).join(", ")})이 적용을 기다려 재개는 하지 않았습니다 — 그 진단도 적용하면 마지막 적용이 함께 재개합니다(닫으려면 수정 불필요로 정정한 뒤 재시도).` : ""),
            payload: {
              diagnosisApplied: { id: record.id, mode: route.mode, target: route.target, ...(contracts.length ? { contract: contracts.at(-1)!.contractId } : {}) },
              ...(waiting.length > 0 ? { diagnosisApplyWaiting: waiting.map((item) => item.id) } : {}),
              ...(request.origin ? { origin: request.origin } : {}),
              ...(request.requestKey ? { requestKey: request.requestKey, requestAction: `diagnosis:apply:${record.id}` } : {}),
            },
          },
        });
      }
    } finally {
      this.core.diagnosisActive.delete(topicId);
    }
    if (waiting.length > 0) return null;
    try {
      return resume(topicId, request.actionId);
    } catch (error) {
      // 사전 검사를 지나고도 재개가 거부되면(경합 등) 인도 대기에 반쯤 적용된 채 두지 않는다 — 반환 단계를 재개 지점으로 둔 정지(FAILED)로 옮긴다.
      // 정지 상태이므로 정정의 복원 규칙(계획 개정 취소·진단 전용 수정 종결)과 재시도가 그대로 통한다.
      this.stopAfterRefusedResume(topicId, diagnosisId, error);
      throw error;
    }
  }

  // 적용 뒤의 재개 관문(retry 와 같은 조건)을 적용 기록 전에 본다: 예산, 이 진단을 뺀 중재자 처리 대기 진단. 등록된 다른 수정 진단(계획 변경 없음)은 막지 않고
  // 돌려준다 — 순차 적용을 기다리는 것이라 적용은 기록하고 재개는 마지막 적용이 한다(서로의 적용을 막아 둘 다 적용할 수 없던 교착, 2026-09-15 감사 2차).
  private assertApplyResumable(topicId: string, record: DiagnosisRecord): DiagnosisRecord[] {
    this.core.assertBudgetAvailable(topicId);
    const others = this.current(topicId).filter((item) => item.id !== record.id && MEDIATOR_PENDING_STATUSES.has(item.status));
    const sequential = !record.input.planChange?.required;
    const waiting = others.filter((item) => sequential && item.status === "registered" && item.input.kind === "fix" && !item.input.planChange?.required);
    const blocking = others.filter((item) => !waiting.includes(item));
    if (blocking.length > 0) {
      throw new DiagnosisConflict(`${record.id} 를 적용하지 않았습니다 — 먼저 처리할 진단이 있습니다: ${describeDiagnoses(blocking)}. 적용 뒤의 재개가 막히므로 `
        + "기록하지 않습니다. 그 진단을 정정(supersedes)하거나 수정 불필요로 닫은 뒤 다시 적용하세요(계획 변경 진단은 다른 진단과 함께 적용하지 않습니다).");
    }
    return waiting;
  }

  private stopAfterRefusedResume(topicId: string, diagnosisId: string, error: unknown): void {
    const topic = this.db.getTopic(topicId);
    if (topic.state !== "READY_TO_DELIVER") return;
    const reason = error instanceof Error ? error.message : String(error);
    const resumeTarget = (this.db.getFlags(topicId).resumeState ?? "CLAUDE_PLAN") as WorkflowState;
    const message = `중재자 진단 ${diagnosisId} 적용 뒤 재개가 거부됐습니다 — ${reason} 인도 대기의 완료 판정은 적용에서 취소됐고, `
      + `재시도가 반환 단계(${resumeTarget})에서 이어갑니다.`;
    // 인도 대기에서 갈 수 있는 정지 상태는 FAILED 뿐이다(전이표) — 재개 단계와 함께 한 transaction 으로 옮긴다.
    assertTransition(topic.state, "FAILED");
    this.db.applyTopicTransition({
      topicId, changes: { state: "FAILED", resumeState: resumeTarget, lastError: message.slice(0, 4_000) },
      events: [{ actor: "system", kind: "system", state: "FAILED", body: message, payload: { resumeState: resumeTarget, diagnosisApplyResumeRefused: diagnosisId } }],
    });
  }

  // ---- 계획 변경 진단의 적용 ---------------------------------------------------------------------------------------------
  // 승인 계획을 고쳐야 하는 진단은 진단 계획 개정 턴으로 보낸다(공통 재시도 사다리의 첫 분기 — 한도·예산 검사를 그대로 거친다). 적용은 계획·승인을
  // 건드리지 않는다: 개정 계획이 저장될 때(markPlanRevised) 한 transaction 으로 승인·ACK 를 무효화하고 새 주기 회차를 초기화한다. 그 전에 정정되면
  // 멈췄던 단계로 돌아가고(restoreResume) 옛 승인 계획이 그대로 유효하다. 작업 트리·브랜치·구현 기준·미커밋 변경·구현 세션은 어느 쪽이든 보존한다.
  private async applyPlanRevision(
    topic: Topic, flags: { implementationBaseOID: string | null; resumeState: string | null; fixPassUsed: boolean },
    record: DiagnosisRecord, request: { requestKey?: string; origin?: DiagnosisOrigin },
  ): Promise<void> {
    if (!topic.branchName || !flags.implementationBaseOID) {
      throw new DiagnosisConflict(`${record.id} 는 계획 변경 진단입니다 — 구현이 시작되지 않은 계획 단계에서는 결정(decision)으로 계획을 고치세요.`);
    }
    if (!topic.planSHA256 || topic.approvedPlanSHA256 !== topic.planSHA256) {
      throw new DiagnosisConflict(`${record.id} 를 적용할 승인 계획이 없습니다 — 승인된 현재 계획이 있을 때만 계획 개정으로 보냅니다.`);
    }
    const resume = flags.resumeState;
    const fromReady = topic.state === "READY_TO_DELIVER";
    if (!fromReady && !(STOPPED_STATES.has(topic.state) && resume && DELIVERY_RESUME_STATES.has(resume))) {
      throw new DiagnosisConflict(`${topic.state}/${resume ?? "-"} 에서는 계획 변경 진단을 적용할 수 없습니다(구현·수정 정지나 인도 대기에서만).`);
    }
    const inflight = this.current(topic.id).filter((item) => item.id !== record.id && ["applied", "plan_revised", "delivered"].includes(item.status));
    if (inflight.length > 0) {
      throw new DiagnosisConflict(`처리 중인 진단이 있습니다: ${describeDiagnoses(inflight)} — 해결되거나 정정된 뒤에 계획 변경을 적용하세요.`);
    }
    const carry = await this.captureCarry(topic);
    // 정정으로 개정이 취소되면 돌아갈 단계. 인도 대기에서 왔으면 리뷰부터 다시 본다(완료 판정은 적용에서 취소했다).
    const restoreResume = resume && DELIVERY_RESUME_STATES.has(resume) ? resume : (flags.fixPassUsed ? "CODEX_FINAL_REVIEW" : "CODEX_REVIEW");
    const artifact = await this.core.dependencies.artifacts.write(topic.id, carryKind(record.id), 1, JSON.stringify(carry, null, 2), { scopeGeneration: topic.scopeGeneration });
    const now = this.db.getTopic(topic.id);
    if (now.scopeGeneration !== topic.scopeGeneration || now.state !== topic.state || now.planSHA256 !== topic.planSHA256 || this.core.active.has(topic.id)) {
      throw new DiagnosisConflict("적용하는 동안 주제의 상태·계획·세대가 바뀌었습니다. 다시 시도하세요.");
    }
    this.db.recordDiagnosisStatus({
      topicId: topic.id,
      entries: [{ diagnosisId: record.id, status: "applied", detail: {
        mode: "plan-revision", target: "CLAUDE_PLAN", fromState: topic.state, fromResume: resume, restoreResume, previousPlanSHA256: topic.planSHA256,
        carry: {
          artifactKind: carryKind(record.id), sha256: artifact.sha256, remainingSteps: carry.remainingSteps.length,
          openRequestIds: carry.openRequests.map((item) => item.id), verifiedLedgerRows: carry.verifiedLedger.length, changedPaths: carry.changedPaths.length,
        },
      } }],
      // 인도 대기에서 반환하면 기존 완료 판정(최종 리뷰가 확인한 스냅샷)을 취소한다.
      changes: fromReady ? { reviewedHead: null, reviewedDiffSHA256: null } : undefined,
      event: {
        actor: "system", kind: "system", state: topic.state,
        body: `중재자 진단 ${record.id} 적용 — 계획 개정으로 반환합니다(작업 트리·브랜치·구현 기준 커밋·미커밋 변경·구현 세션 보존, 범위 변경 아님). `
          + "개정 계획은 감사·종결 확인·두 에이전트 ACK·사용자 승인을 거친 뒤에만 구현으로 돌아갑니다 — 기존 승인은 개정 계획이 저장될 때 무효화됩니다. "
          + `승계: 남은 단계 ${carry.remainingSteps.length}건 · 열린 요청 ${carry.openRequests.length}건 · 검증 원장 ${carry.verifiedLedger.length}행 · 바뀐 파일 ${carry.changedPaths.length}개.`
          + (fromReady ? " 인도 대기의 완료 판정을 취소했습니다." : ""),
        payload: {
          diagnosisApplied: { id: record.id, mode: "plan-revision", target: "CLAUDE_PLAN" },
          ...(request.origin ? { origin: request.origin } : {}),
          ...(request.requestKey ? { requestKey: request.requestKey, requestAction: `diagnosis:apply:${record.id}` } : {}),
        },
      },
    });
  }

  // 계획 변경 진단의 승계 기록 — 같은 계획의 최신 checkpoint(남은 단계·열린 요청·검증 원장·요약), 기준 계획 전문, 구현 기준 이후 바뀐 파일.
  private async captureCarry(topic: Topic): Promise<PlanRevisionCarry> {
    let checkpoint: WorkCheckpoint | null = null;
    try {
      const latest = await this.core.checkpoints.latest(topic.id);
      if (latest && latest.work.scopeGeneration === topic.scopeGeneration && latest.work.planEpoch === topic.planEpoch) checkpoint = latest;
    } catch (error) {
      // 손상 checkpoint 를 건너뛰고 옛 산출물의 요청만 승계하면 그 작업의 남은 단계·열린 요청·검증 원장을 잃은 채 계획을 개정한다 — 적용하지 않는다(감사 5차 #3).
      if (!(error instanceof CheckpointCorrupt)) throw error;
      throw new DiagnosisConflict(`최신 수정 checkpoint 가 손상돼 계획 변경 진단이 승계할 작업 기록(남은 단계·열린 요청·검증 원장)을 만들 수 없습니다 — ${error.message}`);
    }
    // 기준 계획은 현재(승인) 계획 sha 의 산출물이다 — 최신 산출물이 저장만 되고 기록되지 않은 개정본이어도(개정 턴이 저장과 기록 사이에서 끊김) 승인 계획을
    // 기준으로 개정한다. 최신 산출물이 승인 계획과 다르다고 거부하면 그 개정본이 최신으로 남는 동안 계획 변경 진단을 적용할 길이 없었다(2026-09-15 감사 #12 후속).
    const { content: basePlan } = await this.core.requireCurrentPlanArtifact(topic.id).catch((error: unknown) => {
      throw new DiagnosisConflict(`현재 계획 sha 의 계획 산출물을 읽지 못했습니다 — 계획 상태를 먼저 확인하세요(${error instanceof Error ? error.message : String(error)}).`);
    });
    if (hashPlan(basePlan) !== topic.planSHA256) {
      throw new DiagnosisConflict("현재 계획 sha 와 계획 산출물이 맞지 않습니다(계획 산출물 불일치) — 계획 상태를 먼저 확인하세요.");
    }
    return {
      version: 1, basePlanSHA256: topic.planSHA256!, basePlan,
      checkpoint: checkpoint ? { revision: checkpoint.revision, workId: workId(checkpoint.work), phase: checkpoint.phase } : null,
      remainingSteps: checkpoint ? [...checkpoint.next.remainingSteps] : [],
      openRequests: checkpoint ? checkpointOpenRequests(checkpoint) : await this.legacyOpenRequests(topic),
      verifiedLedger: checkpoint ? [...checkpoint.verifiedLedger] : [],
      lastSummary: checkpoint?.accumulated.summary ?? null,
      changedPaths: await this.core.dependencies.git.changedPaths(topic.worktreePath),
    };
  }

  // checkpoint 가 없는 토픽의 열린 요청(옛 산출물의 requestedUserDecision, 제시 시점 0 — 재개와 같은 규칙).
  private async legacyOpenRequests(topic: Topic): Promise<WorkCheckpoint["openRequests"]> {
    const rows: WorkCheckpoint["openRequests"] = [];
    for (const kind of ["implementation-result", "claude-fix"]) {
      const artifact = this.db.latestArtifact(topic.id, kind);
      if (!artifact || artifact.scopeGeneration !== topic.scopeGeneration) continue;
      try {
        for (const asked of decisionRequestTexts(await this.core.latestResult(topic.id, kind))) {
          if (!rows.some((row) => row.text === asked)) rows.push({ id: requestId(asked, 0), text: asked, askedAfterSequence: 0 });
        }
      } catch {
        // 옛 산출물 해석 실패는 요청이 없는 것으로 본다.
      }
    }
    return rows;
  }

  // 반환 경로 — 멈춘 단계로 정한다: 구현·첫 리뷰 정지 → 구현 작업, 수정 정지 → 그 수정 작업의 계약이 정한다(진단 전용 수정이면 그 작업, 리뷰 수정이면
  // 그 작업에 수정 지시로), 최종 리뷰 정지·인도 대기 → 진단 전용 수정 작업(→ 최종 리뷰). 정정 사슬·진단 상태로 경로를 추정하지 않는다 — 추정은 멈춘 작업이
  // 어느 쪽인지 구분하지 못해 일반 수정 정지의 정정을 진단 전용 수정으로 보냈다(2026-09-15 감사 2차).
  private routeFor(topicId: string, topic: Topic, resume: string | null): { mode: DiagnosisApplyMode; target: DiagnosisTarget } {
    // 인도 대기에서는 진단 전용 수정 경로만 연다 — 남은 작업(work) 경로를 물려받으면 READY → IMPLEMENTING 처럼 없는 전이로 재개가 500 으로 굳었다(2026-09-15 감사).
    if (topic.state === "READY_TO_DELIVER") return { mode: "diagnosis-fix", target: "CLAUDE_FIX" };
    if (!STOPPED_STATES.has(topic.state)) throw new DiagnosisConflict(`${topic.state} 상태에서는 진단을 적용할 수 없습니다.`);
    if (resume === "IMPLEMENTING" || resume === "CODEX_REVIEW") return { mode: "work", target: "IMPLEMENTING" };
    if (resume === "CLAUDE_FIX") {
      return this.core.fixContracts.open(topicId)?.route === "diagnosis" ? { mode: "diagnosis-fix", target: "CLAUDE_FIX" } : { mode: "work", target: "CLAUDE_FIX" };
    }
    if (resume === "CODEX_FINAL_REVIEW") return { mode: "diagnosis-fix", target: "CLAUDE_FIX" };
    throw new DiagnosisConflict(`재개 단계 ${resume ?? "-"} 에서는 진단을 적용할 수 없습니다.`);
  }

  // 정정 대상이 계약이 싣는 진단(또는 그 진단을 정정한 사슬)인가 — 현재 세대 안에서 supersedes 를 거슬러 본다.
  private relatesToContract(topicId: string, contractIds: readonly string[], id: string): boolean {
    const generation = this.db.getTopic(topicId).scopeGeneration;
    const seen = new Set<string>();
    for (let cursor: string | undefined = id; cursor !== undefined && !seen.has(cursor);) {
      if (contractIds.includes(cursor)) return true;
      seen.add(cursor);
      const record = this.db.diagnoses.get(topicId, cursor);
      if (!record || record.binding.scopeGeneration !== generation) return false;
      cursor = record.input.supersedes;
    }
    return false;
  }

  // ---- 계획 변경 진단의 진행 ---------------------------------------------------------------------------------------------
  unsavedPlanRevision(topicId: string): DiagnosisRecord | null {
    // 마지막 적용 뒤에 개정 계획이 이미 저장된(plan_revised) 진단은 '저장 전'이 아니다 — 개정 계획의 구현에서 반박되면 반박은 assertResumable 이 막고,
    // 다른 진단 적용·허용 오차 개정을 '미저장'이라는 사실과 다른 사유로 막지 않는다(2026-09-15 감사).
    return this.current(topicId).find((record) => isPlanRevision(record) && UNSAVED_REVISION_STATUSES.has(record.status) && !revisedAfterApply(record)) ?? null;
  }

  // 개정 계획이 저장된(plan_revised) 뒤 감사 전에 멈춘 계획 변경 진단 — 저장 직후 새 입력 인터럽트나 종료가 재개 단계를 계획 턴(CLAUDE_PLAN)으로 남긴 경우.
  savedRevisionAwaitingAudit(topicId: string): DiagnosisRecord | null {
    if (this.db.getTopic(topicId).approvedPlanSHA256 !== null) return null;
    const audit = this.db.latestArtifact(topicId, "audit");
    return this.current(topicId).find((record) => {
      if (!isPlanRevision(record) || record.status !== "plan_revised") return false;
      const saved = [...record.history].reverse().find((entry) => entry.status === "plan_revised");
      return saved !== undefined && (!audit || audit.createdAt < saved.at);
    }) ?? null;
  }

  // 진단 계획 개정 턴을 열 차례 — 적용됐고 반박·증거 요청으로 중재자에게 돌아가지 않은 것.
  pendingPlanRevision(topicId: string): DiagnosisRecord | null {
    return this.current(topicId).find((record) => isPlanRevision(record) && record.status === "applied") ?? null;
  }

  assertNoPlanRevision(topicId: string, entry: string): void {
    const unsaved = this.unsavedPlanRevision(topicId);
    if (!unsaved) return;
    throw new DiagnosisConflict(`${entry} 을(를) 막았습니다 — 계획 변경 진단 ${unsaved.id}(${STATUS_LABEL[unsaved.status]})의 개정 계획이 아직 저장·승인되지 않았습니다. `
      + "재시도(retry)가 진단 계획 개정을 이어가거나, 진단을 정정(supersedes)하세요. 옛 승인 계획으로 구현을 재개하지 않습니다.");
  }

  async planRevisionCarry(record: DiagnosisRecord): Promise<PlanRevisionCarry> {
    const raw = await this.core.dependencies.artifacts.readLatest(record.topicId, carryKind(record.id));
    if (!raw) throw new Error(`계획 변경 진단 ${record.id} 의 승계 기록이 없습니다(손상).`);
    const carry = JSON.parse(raw) as PlanRevisionCarry;
    if (carry.version !== 1 || typeof carry.basePlan !== "string" || !Array.isArray(carry.openRequests) || !Array.isArray(carry.verifiedLedger)) {
      throw new Error(`계획 변경 진단 ${record.id} 의 승계 기록 형식이 다릅니다(손상).`);
    }
    return carry;
  }

  carryPath(record: DiagnosisRecord): Promise<string | null> {
    return this.core.dependencies.artifacts.verifiedPath(record.topicId, carryKind(record.id)).catch(() => null);
  }

  // 개정 계획 저장 — 계획 필드·승인 무효화·ACK 초기화·새 주기 회차 초기화·진단 상태를 한 transaction 으로 확정한다.
  // 초기화: closeoutRevisionUsed(새 수렴 주기의 개정 2회차 자격), fixPassUsed·secondFixPassUsed(새 계획 구현의 자동 수정 회차), 리뷰 스냅샷.
  // 초기화하지 않음: 재작성·리뷰·예산 한도(집계는 계속 누적된다), 구현 세션·프롬프트 sequence, 구현 기준 커밋·브랜치·작업 트리.
  markPlanRevised(topic: Topic, record: DiagnosisRecord, saved: { planRevision: number; sha256: string; previousPlanSHA256: string; artifactRevision: number }): void {
    this.db.recordDiagnosisStatus({
      topicId: topic.id,
      // 개정 계획은 새 승인을 거친다 — 개정 전 계획에서 연 수정 작업 계약(정지 쟁점·판정 기록)은 이어 쓰지 않는다(2026-09-15 감사 3차).
      contracts: this.core.fixContracts.abandonOpen(topic.id),
      entries: [{ diagnosisId: record.id, status: "plan_revised", detail: { planSHA256: saved.sha256, previousPlanSHA256: saved.previousPlanSHA256, planRevision: saved.planRevision } }],
      changes: {
        planRevision: saved.planRevision, planSHA256: saved.sha256, approvedPlanSHA256: null,
        closeoutRevisionUsed: false, fixPassUsed: false, secondFixPassUsed: false, reviewedHead: null, reviewedDiffSHA256: null,
      },
      clearAcknowledgements: true,
      event: {
        actor: "claude", kind: "agent_output", state: topic.state,
        body: `계획 ${saved.planRevision}판을 저장했습니다(중재자 진단 ${record.id} 의 계획 개정). 기존 승인과 두 에이전트의 계획 확인(ACK)을 무효화했습니다 — `
          + "감사·종결 확인·ACK·사용자 승인 뒤에만 구현이 재개됩니다. 작업 트리·브랜치·구현 기준 커밋은 그대로이고 한도 집계는 초기화하지 않습니다.",
        payload: {
          artifactKind: "plan", revision: saved.planRevision, artifactRevision: saved.artifactRevision, sha256: saved.sha256,
          diagnosisPlanRevised: { id: record.id, previousPlanSHA256: saved.previousPlanSHA256 },
        },
      },
    });
  }

  // 진단 계획 개정 뒤의 감사에 실을 맥락(개정 계획 저장됨·아직 구현 전).
  async revisionAuditContext(topicId: string): Promise<{ context: { diagnoses: DiagnosisPrompt[]; previousPlanSHA256: string; changedPaths: string[] }; paths: string[] } | null> {
    const record = this.current(topicId).find((item) => isPlanRevision(item) && item.status === "plan_revised");
    if (!record) return null;
    const carry = await this.planRevisionCarry(record);
    const delivered = await this.prompts([record]);
    return { context: { diagnoses: delivered.prompts, previousPlanSHA256: carry.basePlanSHA256, changedPaths: carry.changedPaths }, paths: delivered.paths };
  }

  // 개정 계획 승인 뒤의 구현에 넘길 승계 — 계획 변경 진단이 저장·전달됨(처분 보고 전)인 동안. firstDelivery 면 이어받은 세션에도 개정 계획 전문을 싣는다.
  async planRevisionForImplementation(topicId: string): Promise<{ records: DiagnosisRecord[]; firstDelivery: boolean; carry: PlanRevisionCarry } | null> {
    const records = this.current(topicId).filter((record) => isPlanRevision(record) && (record.status === "plan_revised" || record.status === "delivered"));
    if (records.length === 0) return null;
    return { records, firstDelivery: records.some((record) => record.status === "plan_revised"), carry: await this.planRevisionCarry(records[0]) };
  }

  // 구현 작업에 실을 진단 — 같은 계획의 구현 반환(work) + 개정 계획까지 승인된 계획 변경 진단(저장·전달됨).
  forImplementation(topicId: string): DiagnosisRecord[] {
    return [
      ...this.forWork(topicId, "IMPLEMENTING", "work"),
      ...this.current(topicId).filter((record) => isPlanRevision(record) && (record.status === "plan_revised" || record.status === "delivered")),
    ];
  }

  // 리뷰에 실을 진단 원문 — 이 구현·수정 결과가 처분을 보고한(전달·반영 보고) 진단. 리뷰어가 원본 지시·검증 기준과 반영 보고를 대조한다(host-review R4).
  forReview(topicId: string): DiagnosisRecord[] {
    return this.current(topicId).filter((record) => record.status === "delivered" || record.status === "fix_reported");
  }

  // 복구 지름길(수락 이어가기·확인 턴·저장 결과 재사용)을 막아야 하는 진단 — 전달할 차례이거나(awaitingDelivery), 전달됐지만 그 처분을 담은 결과가
  // 아직 저장되지 않은 것(spawn 뒤 응답 전에 죽은 턴 — host-review R5). 저장 여부는 복구한 누적본에 그 진단 id 의 쟁점이 있는가로 본다.
  pendingFor(records: readonly DiagnosisRecord[], saved: AgentResult | null): DiagnosisRecord[] {
    const reported = new Set((saved?.findings ?? []).map((finding) => finding.id));
    return records.filter((record) => awaitingDelivery(record) || (record.status === "delivered" && !reported.has(record.id)));
  }

  // 처분이 진단을 중재자에게 돌려보내는가(반박·증거 요청). 닫힌 진단은 보지 않는다.
  returnedBy(records: readonly DiagnosisRecord[], result: AgentResult): ReturnedDiagnosis[] {
    const returned: ReturnedDiagnosis[] = [];
    for (const record of records) {
      if (CLOSED_DIAGNOSIS_STATUSES.has(record.status)) continue;
      const finding = result.findings.find((item) => item.id === record.id);
      const status = finding ? returnedStatus(finding) : null;
      if (finding && status) returned.push({ record, finding, status });
    }
    return returned;
  }

  // 반박·증거 요청의 기록(refuted·needs_evidence) — 적용 대기 검사(MEDIATOR_PENDING)가 정정 전의 재개를 막는다(host-review R3). 호출자가 정지시킨다.
  recordReturned(topicId: string, returned: readonly ReturnedDiagnosis[], stage: string): string {
    this.db.recordDiagnosisStatus({
      topicId,
      entries: returned.map(({ record, finding, status }) => ({
        diagnosisId: record.id, status,
        detail: { stage, disposition: finding.disposition, requiresUserDecision: finding.requiresUserDecision, rationale: finding.rationale, evidenceRefs: finding.evidenceRefs },
      })),
    });
    return `${stage}이(가) 중재자 진단을 돌려보냈습니다 — ${returned.map(({ record, finding, status }) => `${record.id} ${status === "refuted" ? "반박" : "추가 증거 필요"}: ${finding.rationale}`).join(" / ")}. `
      + "같은 지시를 자동으로 반복하지 않습니다 — 진단을 정정(supersedes)하세요.";
  }

  // 전체 재계획(계획 주기 +1) — 이전 계획에 묶여 진행 중이던 진단(적용·개정 계획 저장·전달·반영 보고)은 새 계획에 싣지 않고 재확인(stale)으로 돌린다.
  // 그대로 두면 개정한 적 없는 새 계획의 구현에 옛 개정 알림·지시가 전달되고 해결까지 됐다(2026-09-14 감사). 등록 상태는 적용 시점의 결속 대조가 막고,
  // 반박·추가 증거는 이미 중재자 몫이다. stale 은 재개를 막으므로 중재자가 새 계획 기준으로 정정하거나 수정 불필요로 닫아야 구현이 열린다.
  staleOnReplan(topic: Topic): void {
    const affected = this.current(topic.id).filter((record) => STALE_ON_REPLAN.has(record.status));
    if (affected.length === 0) return;
    const ids = affected.map((record) => record.id);
    this.db.recordDiagnosisStatus({
      topicId: topic.id,
      entries: affected.map((record) => ({
        diagnosisId: record.id, status: "stale" as const, detail: { reason: "replan", fromPlanEpoch: topic.planEpoch, toPlanEpoch: topic.planEpoch + 1 },
      })),
      event: {
        actor: "system", kind: "system", state: topic.state,
        body: `전체 재계획(계획 주기 ${topic.planEpoch} → ${topic.planEpoch + 1})으로 이전 계획에 묶인 진단 ${ids.join(", ")} 을(를) 재확인 대상으로 돌렸습니다 — `
          + "새 계획에 적용·전달하지 않고, 닫기 전에는 구현 시작이 막힙니다(계획 수렴 재시도는 막지 않습니다). 계획 단계·승인 대기에서도 수정 불필요(no_action, "
          + "supersedes)로 닫을 수 있고, 여전히 필요한 진단은 구현이 멈춘 뒤 새로 등록하세요.",
        payload: { diagnosisStaleOnReplan: ids },
      },
    });
  }

  // ---- 공통 진단 상태 검사 -------------------------------------------------------------------------------------------------
  // 재개 진입점(retry·구현 재개·자동 재시도·구현 시작)은 중재자가 처리할 진단(적용 대기·재확인·반박·추가 증거)을 우회하지 못한다.
  assertResumable(topicId: string, entry: string, resume?: string | null): void {
    // 계획 단계 재시도는 전체 재계획이 재확인으로 돌린 진단에 막히지 않는다 — 그 진단이 막는 것은 구현 전달이지 새 계획 수렴이 아니다(host-review R9).
    const planning = typeof resume === "string" && PLANNING_RESUME_STATES.has(resume);
    const pending = this.current(topicId).filter((record) => MEDIATOR_PENDING_STATUSES.has(record.status) && !(planning && isReplanStale(record)));
    if (pending.length === 0) return;
    const replanHint = pending.some(isReplanStale)
      ? " 전체 재계획으로 재확인 대상이 된 진단은 계획 단계·승인 대기에서도 수정 불필요(no_action, supersedes)로 닫을 수 있습니다." : "";
    throw new DiagnosisConflict(`${entry} 을(를) 막았습니다 — 중재자가 처리할 진단이 있습니다: ${describeDiagnoses(pending)}. `
      + "적용(apply)하거나 정정(supersedes 로 새 진단)하세요. 진단 등록만으로는 재개·완료되지 않습니다." + replanHint);
  }

  // 인도 진입점(commit·push·close)은 해결되지 않은 진단이 있으면 막는다.
  assertDeliverable(topicId: string, entry: string): void {
    const open = this.current(topicId).filter((record) => !CLOSED_DIAGNOSIS_STATUSES.has(record.status));
    if (open.length === 0) return;
    throw new DiagnosisConflict(`${entry} 을(를) 막았습니다 — 해결되지 않은 진단: ${describeDiagnoses(open)}. `
      + "적용해 수정·리뷰를 거치거나, 정정으로 닫아야 인도할 수 있습니다.");
  }

  // ---- 작업 전달 ----------------------------------------------------------------------------------------------------------
  // 이 작업(반환 단계·경로)에 실을 진단 — 적용·전달됨(처분 보고 전).
  forWork(topicId: string, target: DiagnosisTarget, mode: DiagnosisApplyMode): DiagnosisRecord[] {
    return this.current(topicId).filter((record) => {
      if (record.status !== "applied" && record.status !== "delivered") return false;
      const info = applyInfo(record);
      return info !== null && info.target === target && info.mode === mode;
    });
  }

  // 중재자가 정정으로 닫은 현재 세대 진단 id(대체·수정 불필요) — 해결(resolved)은 빼는다. 해결된 진단을 뒤 리뷰가 다시 판정하면(회귀) 그 판정은 원본·가드에
  // 남아야 한다(2026-09-15 감사 3차: 해결까지 닫힘으로 걸러 회귀 판정이 원본에서 빠졌다). 원본 필터·면제·누적본 정리는 이것을 쓴다.
  mediatorClosedIds(topicId: string): Set<string> {
    return new Set(this.current(topicId).filter((record) => record.status === "superseded" || record.status === "closed_no_action").map((record) => record.id));
  }

  // 정정·해결로 닫힌 현재 세대 진단 id.
  closedIds(topicId: string): Set<string> {
    return new Set(this.current(topicId).filter((record) => CLOSED_DIAGNOSIS_STATUSES.has(record.status)).map((record) => record.id));
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
    const pending = this.current(topicId).filter((record) => ids.has(record.id) && awaitingDelivery(record));
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

  // 계약이 싣는 진단 중 열린 것(적용·전달됨 — 처분 보고 전), 싣은 순서.
  carried(topicId: string, ids: readonly string[]): DiagnosisRecord[] {
    const records = this.current(topicId);
    return ids.map((id) => records.find((record) => record.id === id))
      .filter((record): record is DiagnosisRecord => record !== undefined && (record.status === "applied" || record.status === "delivered"));
  }

  // 수락된 결과의 처분 기록 항목 — 반영(RESOLVED_BY_FIX)만 fix_reported. 호출자가 **수락 전이와 한 transaction** 으로 쓴다(전이와 기록 사이에서 끊기면
  // 반영 보고를 잃은 채 리뷰·인도에 이르렀다, 2026-09-15 감사 2차). 가드가 전이를 거부하면 쓰지 않는다 — 채택되지 않은 결과다.
  acceptedEntries(topicId: string, records: readonly DiagnosisRecord[], accepted: AgentResult, acceptId: number): {
    entries: Array<{ diagnosisId: string; status: DiagnosisStatus; detail: Record<string, unknown> }>; body: string; payload: Record<string, unknown>;
  } | null {
    const ids = new Set(records.map((record) => record.id));
    const entries: Array<{ diagnosisId: string; status: DiagnosisStatus; detail: Record<string, unknown> }> = [];
    for (const record of this.current(topicId)) {
      if (!ids.has(record.id) || (record.status !== "applied" && record.status !== "delivered")) continue;
      const finding = accepted.findings.find((item) => item.id === record.id);
      if (finding?.disposition !== "RESOLVED_BY_FIX") continue;
      entries.push({ diagnosisId: record.id, status: "fix_reported", detail: { acceptId, evidenceRefs: finding.evidenceRefs, rationale: finding.rationale } });
    }
    if (entries.length === 0) return null;
    return {
      entries,
      body: `러너가 중재자 진단 ${entries.map((entry) => entry.diagnosisId).join(", ")} 의 반영을 보고했습니다 — 리뷰가 수정과 검증 근거를 확인해야 해결입니다.`,
      payload: { diagnosisFixReported: entries.map((entry) => entry.diagnosisId), acceptId },
    };
  }

  // 인도 준비(최종 리뷰 통과)에 이르면 반영 보고된 진단 중 **리뷰가 반영을 확인한 것**(현재 세대 리뷰가 그 id 에 내린 마지막 처분 — 통과 리뷰가 앞선다 — 이
  // RESOLVED_BY_FIX·AGREED_NO_ACTION, FixContracts.reviewVerdicts)만 해결이다.
  // 리뷰가 범위 밖·반박 등으로 판정했거나 판정하지 않았으면 해결로 기록하지 않고 열린 채(fix_reported) 둔다 — 커밋이 막히고 중재자가 정정으로 닫는다
  // (2026-09-15 감사 4차: 리뷰가 DEFERRED_OUT_OF_SCOPE 로 판정한 진단이 해결로 기록되고 커밋이 열렸다).
  resolveReported(topicId: string, snapshot: { head: string; diffSHA256: string }, verdicts: ReadonlyMap<string, Finding["disposition"]>): void {
    const reported = this.current(topicId).filter((record) => record.status === "fix_reported");
    if (reported.length === 0) return;
    const confirmed = reported.filter((record) => REVIEW_CONFIRMS.has(verdicts.get(record.id) ?? ""));
    const unconfirmed = reported.filter((record) => !confirmed.includes(record));
    if (confirmed.length > 0) {
      this.db.recordDiagnosisStatus({
        topicId, entries: confirmed.map((record) => ({ diagnosisId: record.id, status: "resolved" as const, detail: { reviewedHead: snapshot.head, reviewedDiffSHA256: snapshot.diffSHA256 } })),
        event: {
          actor: "system", kind: "system", state: this.db.getTopic(topicId).state,
          body: `중재자 진단 ${confirmed.map((record) => record.id).join(", ")} 의 수정이 리뷰를 통과했습니다(해결).`,
          payload: { diagnosisResolved: confirmed.map((record) => record.id) },
        },
      });
    }
    if (unconfirmed.length > 0) {
      this.core.event(topicId, "system", "system",
        `통과한 리뷰가 중재자 진단 ${unconfirmed.map((record) => `${record.id}(${verdicts.get(record.id) ?? "판정 없음"})`).join(", ")} 의 반영을 확인하지 않았습니다 — `
        + "해결로 기록하지 않았습니다. 열린 진단이라 커밋이 막힙니다: 정정(fix 또는 no_action, supersedes)으로 닫으세요.",
        { diagnosisUnconfirmed: unconfirmed.map((record) => record.id) });
    }
  }

  // 열린 수정 작업 계약(옛 토픽은 이관). 최신 checkpoint 가 손상됐으면 계약을 판정할 수 없으므로 409 로 거부한다 — 삼키면 계약을 모른 채 기록한다(2026-09-15
  // 감사 4차).
  private async ensureContract(topicId: string): Promise<FixContract> {
    try {
      return await this.core.fixContracts.ensureOpen(topicId);
    } catch (error) {
      if (error instanceof CheckpointCorrupt) throw new DiagnosisConflict(`최신 수정 checkpoint 가 손상돼 열린 수정 작업을 판정할 수 없습니다 — ${error.message}`);
      throw error;
    }
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
