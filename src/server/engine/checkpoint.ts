// 논리 작업(구현 세대·수정 회차)별 **누적 checkpoint** — 결과 복구의 정본(2026-09-14 PLAN §2 "결과 복구").
//
// 왜: 교정·계속 진행이 실패하거나 서버가 재시작되면 지금까지의 보고(쟁점·증거·미해결 요청 결정·검증된 원장)를 다음 턴이 이어받아야
// 하는데, 종류가 다른 산출물(tolerance-correction-source·contract-repair-source·implementation-progress·fix-progress) 중 "최신 하나" 를
// 고르는 복구는 앞선 원본에만 있던 것을 놓쳤다(Codex 3차 R3-02). 여기서는 호출을 열기 **전에** 누적본을 한 종류의 기록으로 남기고,
// 재개는 그 기록 하나에서 이어간다. 기존 산출물은 그대로 쓴다(삭제·대체하지 않음 — 사람과 옛 토픽의 참고).
//
// 결속: 토픽 세대·계획 epoch·계획 sha·재개 상태. 하나라도 다르면 이 checkpoint 는 지금 작업의 것이 아니다(복구 안 함).
// 손상(파싱 실패·필드 누락)은 보존한 채 자동 전이를 멈추는 사유다 — 조용히 새로 시작하지 않는다.
import { createHash } from "node:crypto";

import { AgentResultSchema, type AgentResult, type Topic } from "../../shared/contracts.js";
import type { ToleranceLedgerEntry } from "../../shared/tolerance.js";
import { mergeCorrectionResult } from "../../shared/workflow.js";
import { redactAgentResult, redactUnverifiedResult } from "../security.js";
import { renderOpenRequests, type OpenRequest } from "./completion.js";
import type { EngineCore } from "./core.js";

export const WORK_CHECKPOINT_KIND = "work-checkpoint";

export type WorkKind = "IMPLEMENTATION" | "FIX";
export type WorkResumeState = "IMPLEMENTING" | "CLAUDE_FIX";

export interface WorkBinding {
  kind: WorkKind;
  resumeState: WorkResumeState;
  scopeGeneration: number;
  planEpoch: number;
  planSHA256: string | null;
  sessionId: string | null;
  // 수정 작업의 원본 리뷰(종류#산출물 revision) — 리뷰마다 새 논리 작업이다. 회차 번호(1·2)로는 사용자 승인으로 연 3차 수정이 2차와 같은 작업이 됐다(CF-03).
  fixSource?: string;
}

export type CheckpointPhase =
  | "turn-result"                 // 턴 응답을 받았다(계약 검사 전) — raw 보존
  | "before-contract-correction"  // 계약 교정 호출 직전
  | "before-tolerance-correction" // 허용 오차 교정 호출 직전
  | "before-continuation"         // 계속 진행 호출 직전
  | "before-confirmation"         // 완료 상태 읽기 전용 확인 호출 직전(최대 1회)
  | "verified"                    // 계약·허용 오차 검사를 통과한 누적본(원장 검증됨)
  | "paused"                      // 입력·증거 대기 또는 상태 확인 실패로 보존한 채 멈춤
  | "accepting"                   // 수락 절차 시작(acceptId = 이 revision) — 산출물·메모리·이벤트 전
  | "accepted";                   // 서버가 받아들여 산출물로 확정(메모리 반영 포함) — 재소비는 멱등

export interface WorkCheckpoint {
  kind: typeof WORK_CHECKPOINT_KIND;
  version: 1;
  revision: number;
  previous: number | null;
  work: WorkBinding;
  phase: CheckpointPhase;
  // 이번 응답 원본(검증 없이 가림). 계약 교정 실패 뒤 사람이 볼 수 있게 남긴다.
  raw?: unknown;
  // 지금까지의 누적 결과(검증된 필드만).
  accumulated: AgentResult;
  // 마지막으로 검증을 통과한 누적 원장 — 다음 턴이 승계한다.
  verifiedLedger: ToleranceLedgerEntry[];
  next: { remainingSteps: string[]; pendingCorrection: "tolerance" | "contract" | null };
  // 지금 열려 있는 요청 결정들(id·원문·제시 시점). 결정이 왔다는 이유로 지우지 않고, 새 질문이 앞 질문을 덮지도 않는다 — 러너가
  // resolvesRequestedDecision + resolvedRequestId(요청 id 일치)로 해소를 확인하거나 읽기 전용 확인 턴이 확인해야 그 요청만 닫힌다.
  openRequests: OpenRequest[];
  // 이 논리 작업에서 완료 상태 확인 턴을 몇 번 썼는가(최대 1회).
  confirmations: number;
  // 이 누적본이 반영한 마지막 타임라인 sequence — 그 뒤 결정·증거가 있으면 재개 턴이 실어야 한다.
  inputSequence: number;
  acceptedSHA256?: string;
  // 수락 절차 id(= accepting checkpoint 의 revision). 강제 종료 뒤 재개는 이 id 로 어디까지 했는지 판단한다(내용 해시가 아니다).
  acceptId?: number;
  // 수락 시점의 워킹트리(HEAD·diff sha) — 재개 때 현재 변경분과 대조한다(다르면 수락을 이어가지 않고 다시 대조·판정, CF-01).
  worktree?: { head: string; diffSHA256: string };
  at: string;
}

// 요청 id — 문구 + 제시 시점. 같은 문구를 같은 시점에 다시 내면 같은 요청(열린 채 재요청), 나중에 다시 내면 새 요청.
export function requestId(text: string, askedAfterSequence: number): string {
  return `Q-${createHash("sha256").update(`${text.trim()}#${askedAfterSequence}`, "utf8").digest("hex").slice(0, 8)}`;
}

// 논리 작업 id — 구현 세대(계획 epoch·sha 포함) 또는 수정 회차. 복구·확인 횟수·중복 재소비의 공통 기준.
export function workId(binding: WorkBinding): string {
  const base = `${binding.kind}:g${binding.scopeGeneration}:e${binding.planEpoch}:${(binding.planSHA256 ?? "-").slice(0, 12)}:${binding.resumeState}`;
  return binding.kind === "FIX" ? `${base}:${binding.fixSource ?? "fix?"}` : base;
}

export interface Accumulation {
  result: AgentResult;
  openRequests: OpenRequest[];
  preserved: string[];
  resolvedRequests: OpenRequest[];
  // 해소 표식은 있었지만 요청 id 가 없거나 열린 요청과 맞지 않아 지우지 않은 경우(진단용).
  unmatchedResolution: string | null;
}

// 누적 규칙(한 곳): 새 응답을 누적본 위에 병합한다. 요청 결정은 요청별로 보존한다 —
//   (1) 새 응답의 requestedUserDecision 은 열린 요청 목록에 **추가**된다(같은 문구가 아직 열려 있으면 같은 요청).
//   (2) 해소는 resolvesRequestedDecision + resolvedRequestId 가 열린 요청의 id 와 **일치할 때만** 그 요청 하나를 닫는다. id 없는 표식은 해소가 아니다.
//   (3) 그 밖의 열린 요청은 그대로 남는다. "결정이 도착했다" 는 여기서 요청을 지우는 사유가 아니다.
export function accumulate(
  base: AgentResult | null, next: AgentResult, open: readonly OpenRequest[], askedAfterSequence: number,
): Accumulation {
  const merged = base ? mergeCorrectionResult(base, next) : { result: next, preserved: [] as string[] };
  let openRequests = [...open];
  const resolvedRequests: OpenRequest[] = [];
  let unmatchedResolution: string | null = null;
  const asked = next.requestedUserDecision?.trim();
  if (asked) {
    const existing = openRequests.find((request) => request.text === asked);
    if (!existing) openRequests.push({ id: requestId(asked, askedAfterSequence), text: asked, askedAfterSequence });
  }
  if (next.resolvesRequestedDecision === true) {
    const id = next.resolvedRequestId?.trim();
    const target = id ? openRequests.find((request) => request.id === id) : undefined;
    if (target) {
      resolvedRequests.push(target);
      openRequests = openRequests.filter((request) => request.id !== target.id);
    } else {
      unmatchedResolution = id ? `resolvedRequestId ${id} 는 열린 요청이 아닙니다(열린 요청: ${openRequests.map((request) => request.id).join(", ") || "없음"})`
        : "resolvesRequestedDecision 에 resolvedRequestId 가 없어 어느 요청도 닫지 않았습니다";
    }
  }
  const { requestedUserDecision: _decision, resolvesRequestedDecision: _flag, resolvedRequestId: _rid, ...rest } = merged.result;
  const result: AgentResult = openRequests.length > 0 ? { ...rest, requestedUserDecision: renderOpenRequests(openRequests) } : rest;
  return { result, openRequests, preserved: merged.preserved, resolvedRequests, unmatchedResolution };
}

export class CheckpointCorrupt extends Error {
  constructor(readonly revision: number, detail: string) {
    super(`누적 checkpoint #${revision} 을 읽을 수 없습니다(${detail}) — 보존한 채 자동 전이를 멈춥니다. 산출물 work-checkpoint 를 확인하세요.`);
  }
}

export interface RecoveredWork {
  checkpoint: WorkCheckpoint;
  accumulated: AgentResult;
  verifiedLedger: ToleranceLedgerEntry[];
}

export class WorkCheckpoints {
  constructor(private readonly core: EngineCore) {}

  binding(topic: Topic, kind: WorkKind, sessionId: string | null, fixSource?: string): WorkBinding {
    return {
      kind, resumeState: kind === "IMPLEMENTATION" ? "IMPLEMENTING" : "CLAUDE_FIX", scopeGeneration: topic.scopeGeneration,
      planEpoch: topic.planEpoch, planSHA256: topic.planSHA256, sessionId, ...(fixSource !== undefined ? { fixSource } : {}),
    };
  }

  // 호출을 열기 **전에** 부른다(교정·계속 진행) — 호출이 죽어도 이 기록에서 이어간다. 실행(action) 밖에서는 쓰지 않는다.
  async record(topic: Topic, input: {
    work: WorkBinding; phase: CheckpointPhase; raw?: unknown; accumulated: AgentResult; verifiedLedger: readonly ToleranceLedgerEntry[];
    inputSequence: number; pendingCorrection?: "tolerance" | "contract" | null; openRequests: readonly OpenRequest[]; confirmations: number;
    acceptId?: number; worktree?: { head: string; diffSHA256: string };
  }, signal: AbortSignal): Promise<WorkCheckpoint> {
    const db = this.core.dependencies.database;
    const latest = db.latestArtifact(topic.id, WORK_CHECKPOINT_KIND);
    const revision = (latest?.revision ?? 0) + 1;
    const accumulated = redactAgentResult(input.accumulated);
    const checkpoint: WorkCheckpoint = {
      kind: WORK_CHECKPOINT_KIND, version: 1, revision, previous: latest?.revision ?? null, work: input.work, phase: input.phase,
      ...(input.raw !== undefined ? { raw: redactUnverifiedResult(input.raw) } : {}),
      accumulated, verifiedLedger: [...input.verifiedLedger],
      next: { remainingSteps: accumulated.remainingSteps ?? [], pendingCorrection: input.pendingCorrection ?? null },
      openRequests: [...input.openRequests], confirmations: input.confirmations,
      inputSequence: input.inputSequence,
      ...(input.phase === "accepted" ? { acceptedSHA256: resultSHA256(accumulated) } : {}),
      ...(input.acceptId !== undefined ? { acceptId: input.acceptId } : {}),
      ...(input.worktree ? { worktree: input.worktree } : {}),
      at: new Date().toISOString(),
    };
    await this.core.writeArtifact(topic, WORK_CHECKPOINT_KIND, revision, JSON.stringify(checkpoint, null, 2), signal);
    return checkpoint;
  }

  // 최신 checkpoint(세대 무관 최신 하나) — 없으면 null, 손상이면 CheckpointCorrupt.
  async latest(topicId: string): Promise<WorkCheckpoint | null> {
    const db = this.core.dependencies.database;
    const artifact = db.latestArtifact(topicId, WORK_CHECKPOINT_KIND);
    if (!artifact) return null;
    const raw = await this.core.dependencies.artifacts.readLatest(topicId, WORK_CHECKPOINT_KIND);
    if (!raw) throw new CheckpointCorrupt(artifact.revision, "본문 없음");
    let record: Partial<WorkCheckpoint>;
    try { record = JSON.parse(raw) as Partial<WorkCheckpoint>; } catch { throw new CheckpointCorrupt(artifact.revision, "JSON 아님"); }
    if (record.kind !== WORK_CHECKPOINT_KIND || record.version !== 1 || !record.work || !record.phase || !record.accumulated || !Array.isArray(record.verifiedLedger)
      || !Array.isArray(record.openRequests) || typeof record.confirmations !== "number") {
      throw new CheckpointCorrupt(artifact.revision, "필드 누락");
    }
    const accumulated = AgentResultSchema.safeParse(record.accumulated);
    if (!accumulated.success) throw new CheckpointCorrupt(artifact.revision, "누적 결과가 계약을 어김");
    return { ...(record as WorkCheckpoint), accumulated: accumulated.data, revision: artifact.revision };
  }

  // 지금 논리 작업(workId: 세대·epoch·계획 sha·재개 상태·수정 회차)의 최신 checkpoint 를 복구 바탕으로 돌려준다. 다른 작업의 기록이면 null.
  async recoverFor(topicId: string, work: WorkBinding): Promise<RecoveredWork | null> {
    const checkpoint = await this.latest(topicId);
    return checkpoint && workId(checkpoint.work) === workId(work)
      ? { checkpoint, accumulated: checkpoint.accumulated, verifiedLedger: checkpoint.verifiedLedger } : null;
  }
}

export function resultSHA256(result: AgentResult): string {
  return createHash("sha256").update(JSON.stringify(result), "utf8").digest("hex");
}
