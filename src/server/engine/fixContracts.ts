// 수정 작업 계약의 생성·조회·판정(2026-09-15 사용자 결정 "작업 계약을 기록으로", 설계: shared/fixContract.ts).
//
// 계약 행은 DB 표(fix_contracts)다. 여기서는 행을 **만들기만** 하고, 쓰기는 호출자가 상태 전이·진단 기록과 한 transaction 으로 넘긴다 — 수정 작업을 여는
// 전이와 계약, 수락 전이와 회차 소비·반영 보고가 갈라지지 않게. 옛 토픽 이관(ensureOpen)만 스스로 기록한다(전이 없는 기록).
import { AgentResultSchema, type AgentResult, type Finding, type Topic, type WorkflowState } from "../../shared/contracts.js";
import { applyInfo, DIAGNOSIS_ID_PATTERN, type DiagnosisRecord } from "../../shared/diagnoses.js";
import { isOpen, type FixContract } from "../../shared/fixContract.js";
import { mergeAgreedSources, mergeFindingSources, overruleDirectiveIDs } from "../../shared/workflow.js";
import { pendingReviewRequests, type ReviewRequest } from "./reviewRequests.js";
import type { EngineCore } from "./core.js";

// 최종 리뷰의 대조 기준 — 수락된 결과만 보고로 쓰고(반환·정지로 저장된 수정 결과는 아니다), 그 뒤 수정 없이 닫힌 계약의 원본 쟁점도 싣는다.
export interface FinalReviewBase {
  report: AgentResult;
  // 이 타임라인 sequence 뒤에 저장된 최종 리뷰만 이 보고(와 닫힌 계약)를 본 리뷰다.
  reportRevision: number;
  // 수락·종결된 계약들의 원본 쟁점(최신 우선 병합) — 최종 리뷰의 커버리지·되돌림 검사·알려진 쟁점에 더한다.
  sources: Finding[];
  // 그 원본 중 처분 변경이 허용된 id(사용자 판정·닫힌 진단).
  overruled: Set<string>;
  contract: FixContract | null;
}

// 지금 작업의 리뷰 증거 경계(FixContracts.cycle) — 원본·대조 보고·정지 쟁점·진단 판정이 모두 이것만 읽는다.
export interface ReviewCycle {
  // 작업 주기의 시작 = 현재 세대의 최신 구현 결과 revision(타임라인 순번). 계획 개정·구현 재개가 새 주기를 연다.
  start: number;
  // 주기 안(settledAfter > start)에 정산(수락·종결)된 계약, 최신 먼저.
  settled: FixContract[];
  // 계약 도입 전(첫 계약 행 전) 주기 안에 수락된 옛 수정 결과(수락 id·출력 순번).
  legacy: { acceptId: number; sequence: number } | null;
  // 지금 대조 보고가 정해진 시점 = max(start, 정산 시점, 옛 수락 순번). 그 뒤에 저장된 최종 리뷰만 지금 보고를 본 리뷰다.
  reportedAt: number;
  // 현재 세대에서 인도 대기(READY_TO_DELIVER)로 들어간 마지막 전이 순번(주기 안, 없으면 0) — 그보다 앞선 최종 리뷰는 통과로 끝났다.
  readyAt: number;
  // 정지로 인정하는 최종 리뷰 = max(reportedAt, readyAt) 뒤의 최신 최종 리뷰. 뒤 계약이 이미 소비한 정지·통과로 끝난 리뷰는 정지가 아니다.
  stop: { revision: number } | null;
}

export class FixContracts {
  constructor(private readonly core: EngineCore) {}

  private get db() {
    return this.core.dependencies.database;
  }

  // 현재 세대·계획 주기의 계약(각 계약의 현재 행), 처음 기록한 순서.
  list(topicId: string): FixContract[] {
    const topic = this.db.getTopic(topicId);
    return this.db.fixContracts.list(topicId, topic.scopeGeneration, topic.planEpoch);
  }

  open(topicId: string): FixContract | null {
    return this.list(topicId).filter((contract) => isOpen(contract)).at(-1) ?? null;
  }

  current(topicId: string, contractId: string): FixContract | null {
    return this.list(topicId).find((contract) => contract.contractId === contractId) ?? null;
  }

  // 새 계약을 열 때 함께 남길 행 — 같은 세대·주기의 열린 계약은 하나다(끊긴 뒤 다시 리뷰가 연 수정 등).
  abandonOpen(topicId: string, keep?: string): FixContract[] {
    return this.list(topicId).filter((contract) => isOpen(contract) && contract.contractId !== keep)
      .map((contract) => ({ ...contract, status: "abandoned" as const }));
  }

  // 리뷰가 연 수정 작업 — 원본은 그 리뷰 산출물(revision)의 쟁점이다. 회차는 여는 순간 정한다(첫 회차 소비 전이면 first).
  forReview(topic: Topic, review: { kind: "codex-review" | "codex-final-review"; revision: number; findings: readonly Finding[] }): FixContract {
    const flags = this.db.getFlags(topic.id);
    return {
      contractId: this.db.fixContracts.nextId(topic.id), scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, route: "review",
      origin: { stage: review.kind === "codex-review" ? "CODEX_REVIEW" : "CODEX_FINAL_REVIEW", review: { kind: review.kind, revision: review.revision } },
      source: review.findings.map((finding) => ({ ...finding })), diagnosisIds: [], adjudicated: [...this.adjudicatedFinalReviewIDs(topic)],
      decisionFrom: review.revision, pass: flags.fixPassUsed ? "second" : "first", status: "open",
    };
  }

  // 인도 대기·최종 리뷰 정지에서 반환한 진단의 진단 전용 수정 — 열린 진단 전용 계약이 있으면 거기에 덧붙인다(정정·순차 적용은 같은 작업).
  async forDiagnosis(topic: Topic, diagnosisId: string, fromState: WorkflowState, fromResume: string | null): Promise<FixContract> {
    const open = this.open(topic.id);
    if (open?.route === "diagnosis") return { ...open, diagnosisIds: [...open.diagnosisIds, diagnosisId] };
    // 정지로 인정하는 최종 리뷰는 cycle.stop(지금 대조 보고 뒤의 최신 최종 리뷰)뿐이다 — 인도 대기 창을 정정으로 닫은 정지(재개 = 최종 리뷰)·계획 개정 전의
    // 정지·뒤 계약이 이미 소비한 정지·통과로 끝난 리뷰의 쟁점을 원본으로 동결하지 않는다(2026-09-15 감사 4차, 5차 #5).
    const review = fromState !== "READY_TO_DELIVER" && fromResume === "CODEX_FINAL_REVIEW" ? this.cycle(topic).stop : null;
    return {
      contractId: this.db.fixContracts.nextId(topic.id), scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, route: "diagnosis",
      origin: { stage: review ? "CODEX_FINAL_REVIEW" : "READY_TO_DELIVER", review: review ? { kind: "codex-final-review", revision: review.revision } : null },
      source: review ? await this.finalReviewStopFindings(topic, new Set([diagnosisId])) : [],
      diagnosisIds: [diagnosisId], adjudicated: [...this.adjudicatedFinalReviewIDs(topic)],
      decisionFrom: review?.revision ?? this.core.latestSequence(topic.id), pass: "none", status: "open",
    };
  }

  // 멈춘 수정 작업에 수정 지시로 싣는 진단(같은 계약, 같은 세션·누적 기록).
  withDiagnosis(contract: FixContract, diagnosisId: string): FixContract {
    return { ...contract, diagnosisIds: [...contract.diagnosisIds, diagnosisId] };
  }

  accepted(contract: FixContract, acceptId: number, settledAfter: number): FixContract {
    return { ...contract, status: "accepted", acceptId, settledAfter };
  }

  closed(contract: FixContract, settledAfter: number): FixContract {
    return { ...contract, status: "closed", settledAfter };
  }

  // 계약이 싣는 진단 중 열린 것(적용·전달됨 — 처분 보고 전).
  diagnoses(topicId: string, contract: FixContract): DiagnosisRecord[] {
    return this.core.diagnoses.carried(topicId, contract.diagnosisIds);
  }

  // 지금 작업의 원본 — 실은 진단 중 열린 것 + 동결된 원본 중 중재자가 정정으로 닫은 진단이 아닌 것(진단 쟁점이 앞선다). 해결된 진단의 뒤 판정(회귀)은 남긴다.
  source(topicId: string, contract: FixContract): Finding[] {
    const closed = this.core.diagnoses.mediatorClosedIds(topicId);
    return mergeFindingSources(this.core.diagnoses.findings(this.diagnoses(topicId, contract)), contract.source.filter((finding) => !closed.has(finding.id)));
  }

  // 수락 가드의 면제: decisionFrom 뒤 사용자 decision 이 줄 머리 `OVERRULE <id>` 로 지시한 쟁점 ∪ 중재자가 정정으로 닫은 진단. id 를 언급만 한 결정은
  // 면제가 아니다(2026-09-15 사용자 결정 "명시 지시어로 한정" — "F-1 은 반드시 고쳐 주세요" 도 하향을 허용했다). 판정 끝난 id(adjudicated)는 재질문 생략에만 쓴다.
  overruled(topic: Topic, contract: FixContract, findings: readonly Finding[]): Set<string> {
    const overruled = new Set<string>();
    const directed = new Set(this.db.getTimeline(topic.id, contract.decisionFrom)
      .filter((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && event.kind === "decision")
      .flatMap((event) => [...overruleDirectiveIDs(event.body)]));
    for (const finding of findings) if (directed.has(finding.id)) overruled.add(finding.id);
    for (const id of this.core.diagnoses.mediatorClosedIds(topic.id)) overruled.add(id);
    return overruled;
  }

  // 최종 리뷰 신규 쟁점 인터럽트(payload.finalReviewNewFindingIDs) 뒤에 사용자 결정이 도착했으면 그 id 들은 사용자가 판정한 것이다 — 이 작업 주기(cycle.start 뒤)
  // 안에서만 센다. finding id 는 리뷰 세션마다 다시 매겨질 수 있다(계획 개정이 Codex 리뷰 세션을 새로 연다) — 주기 경계 없이 id 로만 모으면 이전 주기에 판정한
  // 다른 쟁점의 면제가 같은 id 의 새 결함에 적용돼 정지 원본·신규 쟁점 검사에서 빠진 채 커밋됐다(2026-09-15 감사 6차 #1).
  adjudicatedFinalReviewIDs(topic: Topic): Set<string> {
    const events = this.db.getTimeline(topic.id, this.cycle(topic).start).filter((event) => event.scopeGeneration === topic.scopeGeneration);
    const adjudicated = new Set<string>();
    for (let index = 0; index < events.length; index += 1) {
      const ids = events[index].payload?.finalReviewNewFindingIDs;
      if (!Array.isArray(ids)) continue;
      if (!events.slice(index + 1).some((later) => later.actor === "user" && later.kind === "decision")) continue;
      for (const id of ids) if (typeof id === "string") adjudicated.add(id);
    }
    return adjudicated;
  }

  // 지금 작업의 리뷰 증거 경계 — 여기서만 정한다(2026-09-15 사용자 결정 "증거 경계를 한 곳으로 통합", 감사 5차). 함수마다 경계를 따로 붙이면 한쪽이
  // 빠졌다: 감사 4차가 원본·정지 리뷰에 작업 주기 경계만 붙이자, 진단 판정(reviewVerdicts)은 이전 주기(계획 개정·구현 재개 전) 리뷰의 확인으로 덮여 사라진
  // 수정을 해결 처리했고(#1), 정지 리뷰는 뒤 계약이 이미 소비한 정지·통과한 리뷰를 새 계약의 정지로 동결했고(#5), 원본은 최신 수락 계약에서 멈춰 앞선 진단
  // 전용 계약의 원본을 버렸다(#2). 원본(finalReviewBase)·대조 보고(legacyReport)·정지 쟁점(forDiagnosis·ensureOpen·finalReviewStopFindings)·진단 판정
  // (reviewVerdicts)은 모두 이 결과만 읽는다 — 새 경로도 경계를 따로 계산하지 말고 이것을 읽는다.
  cycle(topic: Topic): ReviewCycle {
    const start = this.db.latestArtifact(topic.id, "implementation-result", topic.scopeGeneration)?.revision ?? 0;
    const contracts = this.list(topic.id);
    const settled = contracts.filter((contract) => (contract.status === "accepted" || contract.status === "closed") && (contract.settledAfter ?? 0) > start).reverse();
    const before = contracts.length > 0 ? this.db.fixContracts.earliestAt(topic.id, topic.scopeGeneration, topic.planEpoch) : null;
    const legacy = this.legacyAcceptedFix(topic, start, before);
    const reportedAt = Math.max(start, legacy?.sequence ?? 0, ...settled.map((contract) => contract.settledAfter ?? 0));
    // 인도 대기로 넘어간(통과한) 리뷰는 정지가 아니다 — 뒤에 정산된 계약이 없는 경로(옛 엔진의 수정 불필요 종결, 인도 대기에서 적용한 계획 변경의 정정)에서도
    // 통과 리뷰의 참고 쟁점을 새 계약 원본으로 동결하지 않게(2026-09-15 감사 6차 #3·#10).
    let readyAt = 0;
    for (const event of this.db.getTimeline(topic.id, start)) {
      if (event.scopeGeneration === topic.scopeGeneration && (event.payload?.to === "READY_TO_DELIVER" || event.payload?.reviewCodePassed === true)) readyAt = event.sequence;
    }
    const final = this.db.latestArtifact(topic.id, "codex-final-review", topic.scopeGeneration);
    return { start, settled, legacy, reportedAt, readyAt, stop: final && final.revision > Math.max(reportedAt, readyAt) ? { revision: final.revision } : null };
  }

  // 계약 도입 전(옛 엔진)에 수락된 수정 결과 — 수락 경로로 저장한 수정 출력(agent_output, payload.acceptId) 가운데 다음 수락 출력 전에 CLAUDE_FIX → 최종 리뷰
  // 전이가 뒤따른 것의 마지막(수락 id·출력 순번). 가드가 막아 결정 요청으로 멈춘 결과와 반박으로 멈추며 저장한 결과(acceptId 없음)는 수락이 아니다.
  // after 뒤·before(첫 계약 행 시각) 전의 이벤트만 본다 — 첫 계약 뒤의 수락은 계약이 기록한다.
  private legacyAcceptedFix(topic: Topic, after: number, before: string | null): { acceptId: number; sequence: number } | null {
    let accepted: { acceptId: number; sequence: number } | null = null;
    let pending: { acceptId: number; sequence: number } | null = null;
    for (const event of this.db.getTimeline(topic.id, after)) {
      if (event.scopeGeneration !== topic.scopeGeneration) continue;
      if (before !== null && event.createdAt >= before) break;
      const acceptId = event.payload?.acceptId;
      if (event.kind === "agent_output" && event.actor === "claude" && event.payload?.resultKind === "FIX" && typeof acceptId === "number") {
        pending = { acceptId, sequence: event.sequence };
      } else if (pending && event.payload?.from === "CLAUDE_FIX" && event.payload?.to === "CODEX_FINAL_REVIEW") {
        accepted = pending;
        pending = null;
      }
    }
    return accepted;
  }

  // 반영 보고된 진단의 확인 여부를 가르는 리뷰 판정 — 이 작업 주기(cycle.start 뒤)의 리뷰(첫·최종) 산출물이 그 id 에 내린 마지막 처분, 통과한 리뷰의 처분이
  // 가장 앞선다. 주기 안에서 앞선 최종 리뷰가 확인한 뒤 다른 쟁점으로 멈추고, 다음 계약의 결과를 대조한 리뷰가 그 id 를 다시 적지 않아도 확인은 남는다.
  // 이전 주기의 확인은 세지 않는다 — 계획 개정·구현 재개가 그 수정을 덮었을 수 있다(감사 5차 #1: 재구현이 되돌린 수정이 개정 전 최종 리뷰의 확인으로 해결·
  // 커밋됐다). 이번 주기 리뷰가 확인하지 않은 진단은 열린 채 커밋을 막고, 중재자가 정정으로 닫는다. 계약을 어긴 옛 산출물은 건너뛴다.
  async reviewVerdicts(topicId: string, passing: readonly Finding[]): Promise<Map<string, Finding["disposition"]>> {
    const { start } = this.cycle(this.db.getTopic(topicId));
    const stored: Array<{ revision: number; findings: readonly Finding[] }> = [];
    for (const kind of ["codex-review", "codex-final-review"] as const) {
      for (const artifact of this.db.artifactsForScope(topicId, kind)) {
        if (artifact.revision <= start) continue;
        const content = await this.core.dependencies.artifacts.verifiedByRevision(topicId, kind, artifact.revision);
        const parsed = content ? AgentResultSchema.safeParse(JSON.parse(content.content)) : null;
        if (parsed?.success) stored.push({ revision: artifact.revision, findings: parsed.data.findings });
      }
    }
    const verdicts = new Map<string, Finding["disposition"]>();
    for (const review of stored.sort((a, b) => a.revision - b.revision)) for (const finding of review.findings) verdicts.set(finding.id, finding.disposition);
    for (const finding of passing) verdicts.set(finding.id, finding.disposition);
    return verdicts;
  }

  unansweredReviewQuestions(topic: Topic): ReviewRequest[] {
    return pendingReviewRequests(this.db.getTimeline(topic.id), topic.scopeGeneration);
  }

  // 멈춘 최종 리뷰의 쟁점 중 판단이 끝나지 않은 것(수정·결정·증거가 남음). 이 계약이 싣는 진단·이미 판정된 쟁점·닫힌 진단만 뺀다 — 이 계약이 싣지 않은
  // 진단(반영 보고된 DG)의 되돌림 판정은 남긴다(2026-09-15 감사 2차: 모든 DG id 를 걸러 최종 리뷰가 되돌린 판정이 원본에서 사라졌다).
  async finalReviewStopFindings(topic: Topic, carried: ReadonlySet<string>): Promise<Finding[]> {
    if (!this.cycle(topic).stop) return [];
    const review = await this.core.latestResult(topic.id, "codex-final-review");
    const adjudicated = this.adjudicatedFinalReviewIDs(topic);
    const closed = this.core.diagnoses.mediatorClosedIds(topic.id);
    return review.findings.filter((finding) => !carried.has(finding.id) && !adjudicated.has(finding.id) && !closed.has(finding.id)
      && (finding.disposition === undefined || finding.disposition === "AGREED_ACTION" || finding.disposition === "EXTERNAL_EVIDENCE" || finding.requiresUserDecision))
      .map((finding) => ({ ...finding }));
  }

  // 최종 리뷰의 대조 기준(증거 경계는 cycle). 보고 = 주기 안 최신 수락 계약의 수락 결과(acceptId checkpoint 누적본), 없으면 legacyReport. 원본(sources) =
  // 주기 안에 정산된 **모든 진단 전용 계약**의 원본(최신 계약이 앞선다) — 리뷰 수정 계약의 원본은 그 수락 보고가 처분을 담아 보고로 대조되므로, 진단 없는
  // 토픽은 예전 동작 그대로다(2026-09-15 사용자 결정, 감사 3차 #13). 수정 없이 닫힌 진단 전용 계약의 원본(정지 쟁점)도 싣는다. 최신 수락 계약에서 멈추지
  // 않는다 — 멈추면 앞선 진단 전용 계약의 원본(최종 리뷰가 수정 확인 없이 닫아 되돌림 가드로 멈춘 쟁점)이 무관한 진단 하나를 적용하는 것만으로 원본·보고·첫
  // 리뷰 어디에도 남지 않아 OVERRULE 없이 커밋됐다(감사 5차 #2). 합의 원본은 OVERRULE·중재자 종결 전까지 이 주기의 최종 리뷰마다 판정받는다(첫 리뷰의
  // 합의와 같은 규칙).
  async finalReviewBase(topicId: string): Promise<FinalReviewBase> {
    const topic = this.db.getTopic(topicId);
    const cycle = this.cycle(topic);
    const layers: Finding[][] = [];
    // 중재자가 정정으로 닫은 진단은 계약 경로와 무관하게 면제다 — 리뷰 수정 계약 시절에 닫힌 진단의 옛 처분(첫 리뷰의 AGREED_ACTION)이 최종 리뷰의 되돌림으로
    // 잡히지 않게.
    const overruled = new Set<string>(this.core.diagnoses.mediatorClosedIds(topicId));
    for (const contract of cycle.settled) {
      if (contract.route !== "diagnosis") continue;
      const effective = this.source(topicId, contract);
      layers.push(effective);
      for (const id of this.overruled(topic, contract, effective)) overruled.add(id);
    }
    // 합의(AGREED_ACTION)는 뒤 계약의 판정 없는 처분(EXTERNAL_EVIDENCE 등)에 가려지지 않는다(감사 6차 #5).
    const sources = mergeAgreedSources(...layers);
    const accepted = cycle.settled.find((contract) => contract.status === "accepted") ?? null;
    if (!accepted) return { report: await this.legacyReport(topicId, cycle), reportRevision: cycle.reportedAt, sources, overruled, contract: null };
    const checkpoint = accepted.acceptId !== undefined ? await this.core.checkpoints.byRevision(topicId, accepted.acceptId) : null;
    if (!checkpoint) {
      throw new Error(`수정 작업 계약 ${accepted.contractId} 의 수락 기록(checkpoint #${accepted.acceptId ?? "?"})을 찾을 수 없습니다 — 최종 리뷰의 대조 보고를 정할 수 없어 멈춥니다.`);
    }
    return { report: checkpoint.accumulated, reportRevision: cycle.reportedAt, sources, overruled, contract: accepted };
  }

  // 수락 계약이 없을 때의 대조 보고 — 이 작업 주기에 계약 도입 전(옛 엔진) 수락된 수정 결과(cycle.legacy)가 있으면 그 수락 기록(accepting checkpoint 누적본 —
  // 계약 경로의 acceptId 와 같은 기록), 없으면 구현 결과. 수락 판정은 legacyAcceptedFix(수락 출력 뒤 최종 리뷰 전이). 2026-09-15 감사 4차: 최신 claude-fix 를
  // 골라 반박으로 멈추며 저장한 결과(수락된 적 없음)가 보고가 됐다.
  private async legacyReport(topicId: string, cycle: ReviewCycle): Promise<AgentResult> {
    if (cycle.legacy) {
      const checkpoint = await this.core.checkpoints.byRevision(topicId, cycle.legacy.acceptId);
      if (!checkpoint) {
        throw new Error(`계약 도입 전에 수락된 수정 결과의 수락 기록(checkpoint #${cycle.legacy.acceptId})을 찾을 수 없습니다 — 최종 리뷰의 대조 보고를 정할 수 없어 멈춥니다.`);
      }
      return checkpoint.accumulated;
    }
    return await this.core.latestResult(topicId, "implementation-result");
  }

  // 옛 토픽 이관 — CLAUDE_FIX 재개인데 열린 계약이 없으면(계약 도입 전 작업) 옛 기록으로 계약을 한 번 만들어 기록한다. 이후 모든 판단은 이 계약을 읽는다.
  //   진단 전용 수정: 처분 전(적용·전달됨) 진단 전용 수정 진단이 있거나, 같은 세대·주기의 마지막 수정 checkpoint 가 진행 중인 진단 전용 수정(diagnosis#…)이다 —
  //     반박·증거 요청으로 멈춘 작업은 진단이 적용 상태가 아니어도 진단 전용 수정이다(감사 3차: 상태로만 판정해 리뷰 수정으로 이관했다). id 는 그 checkpoint 의
  //     fixSource 라 진행 중이던 누적본을 그대로 잇는다.
  //   단, 그 checkpoint 뒤에 같은 세대의 리뷰가 저장됐으면 그 작업은 끝났다(수락 또는 정정 종결 → 최종 리뷰) — 멈춘 작업은 그 리뷰가 연 수정이다(감사 4차:
  //   옛 엔진이 no_action 으로 닫은 진단 전용 수정의 checkpoint 를 진행 중으로 오인해 최종 리뷰의 확정 결함을 판정 없이 커밋했다). 손상된 checkpoint 는
  //   삼키지 않는다 — 호출자가 멈춘다. 그 checkpoint 의 진단이 모두 중재자가 정정으로 닫은 것(대체·수정 불필요)이고 대기 진단이 있으면 그 작업은 끝났다 —
  //   잇지 않고 대기 진단의 옛 엔진 작업 id(`diagnosis#<대기 id>`)로 연다(그 작업의 진행 기록이 있으면 그것을 잇는다). 이으면 닫힌 진단의 반박 누적본이 새
  //   진단의 작업 바탕과 최종 리뷰 대조 보고에 섞였다(감사 5차 #4). 대기 진단이 없으면 그대로 이어 받는다 — 실린 진단이 모두 닫힌 계약은 수정 턴 없이 닫힌다.
  //   리뷰 수정: 수정 작업을 연 리뷰 = 현재 세대의 codex-review·codex-final-review 중 나중 것(회차 플래그로 고르면 진단 전용 수정 뒤 최종 리뷰가 연 수정을
  //     첫 리뷰 원본으로 이관해 확정 결함이 사라졌다 — 감사 3차).
  //     id 는 그 리뷰의 `${종류}#${revision}` — 옛 엔진의 작업 id(`${1차 회차를 썼으면 최종 리뷰, 아니면 첫 리뷰}#최신 revision`)와 같으면 원본이 같으므로
  //     진행 중 checkpoint 를 잇고, 다르면(옛 엔진이 틀린 원본으로 일했다) 잇지 않고 새 수정 턴을 연다 — 계약 교정 턴은 파일 수정을 금지하므로 틀린
  //     원본의 누적본을 이으면 새 원본 쟁점(예: 최종 리뷰의 F-9)을 실제로 고칠 턴이 없다.
  async ensureOpen(topicId: string): Promise<FixContract> {
    const open = this.open(topicId);
    if (open) return open;
    const topic = this.db.getTopic(topicId);
    const flags = this.db.getFlags(topicId);
    const adjudicated = [...this.adjudicatedFinalReviewIDs(topic)];
    const pending = this.core.diagnoses.forWork(topicId, "CLAUDE_FIX", "diagnosis-fix").map((record) => record.id);
    const last = await this.core.checkpoints.latest(topicId);
    const reviewedAfter = last !== null && (["codex-review", "codex-final-review"] as const)
      .some((kind) => (this.db.latestArtifact(topicId, kind, topic.scopeGeneration)?.revision ?? 0) > last.inputSequence);
    const checkpointWork = last && !reviewedAfter && last.work.kind === "FIX" && last.work.scopeGeneration === topic.scopeGeneration && last.work.planEpoch === topic.planEpoch
      && last.phase !== "accepting" && last.phase !== "accepted" && last.work.fixSource?.startsWith("diagnosis#") ? last.work.fixSource : null;
    const checkpointIds = checkpointWork ? checkpointWork.slice("diagnosis#".length).split("+").filter((id) => DIAGNOSIS_ID_PATTERN.test(id)) : [];
    const closed = this.core.diagnoses.mediatorClosedIds(topicId);
    const finished = pending.length > 0 && checkpointIds.length > 0 && checkpointIds.every((id) => closed.has(id));
    const lastDiagnosisWork = finished ? null : checkpointWork;
    let contract: FixContract;
    if (pending.length > 0 || lastDiagnosisWork) {
      const fromCheckpoint = lastDiagnosisWork ? checkpointIds : [];
      const ids = [...new Set([...fromCheckpoint, ...pending])];
      const records = ids.map((id) => this.db.diagnoses.get(topicId, id)).filter((record): record is DiagnosisRecord => record !== null);
      const review = records.some((record) => applyInfo(record)?.fromResume === "CODEX_FINAL_REVIEW") ? this.cycle(topic).stop : null;
      contract = {
        contractId: lastDiagnosisWork ?? `diagnosis#${ids.join("+")}`, scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, route: "diagnosis",
        origin: { stage: review ? "CODEX_FINAL_REVIEW" : "READY_TO_DELIVER", review: review ? { kind: "codex-final-review", revision: review.revision } : null },
        source: review ? await this.finalReviewStopFindings(topic, new Set(ids)) : [], diagnosisIds: ids,
        adjudicated, decisionFrom: review?.revision ?? this.core.latestSequence(topicId), pass: "none", status: "open",
      };
    } else {
      const firstReview = this.db.latestArtifact(topicId, "codex-review");
      const finalReview = this.db.latestArtifact(topicId, "codex-final-review");
      const kind = finalReview && (!firstReview || finalReview.revision > firstReview.revision) ? "codex-final-review" : "codex-review";
      const artifact = kind === "codex-final-review" ? finalReview : firstReview;
      if (!artifact) throw new Error("수정 작업의 원본 리뷰(codex-review·codex-final-review)가 없습니다.");
      const review = await this.core.latestResult(topicId, kind);
      contract = {
        contractId: `${kind}#${artifact.revision}`, scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, route: "review",
        origin: { stage: kind === "codex-review" ? "CODEX_REVIEW" : "CODEX_FINAL_REVIEW", review: { kind, revision: artifact.revision } },
        source: review.findings.map((finding) => ({ ...finding })),
        diagnosisIds: this.core.diagnoses.forWork(topicId, "CLAUDE_FIX", "work").map((record) => record.id),
        adjudicated, decisionFrom: artifact.revision, pass: flags.fixPassUsed ? "second" : "first", status: "open",
      };
    }
    this.db.recordFixContract(topicId, contract, {
      actor: "system", kind: "system", state: topic.state,
      body: `계약 도입 전의 수정 작업을 수정 작업 계약 ${contract.contractId}(${contract.route === "diagnosis" ? "진단 전용 수정" : "리뷰 수정"})로 이관했습니다 — 이후 원본·가드·최종 리뷰는 이 기록을 읽습니다.`,
      payload: { fixContractMigrated: contract.contractId },
    });
    return contract;
  }
}
