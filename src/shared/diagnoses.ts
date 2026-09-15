// 중재자 진단(2026-09-14 PLAN "중재자 진단을 보존하고 계획·구현으로 연결하기").
//
// 중재자는 원인이 불명확한 실패를 분석해 수정 방향을 정한다. 엔진은 그 진단을 **일반 메시지와 구분되는 기록**으로 보존하고(덮어쓰지 않음 —
// 정정은 이전 진단을 대체하는 새 기록), 적용될 때 구현·수정 러너에게 전달한다. 진단 등록·전달은 해결이 아니다: 러너의 처분 보고와 코드 리뷰를
// 거쳐 인도 준비(READY_TO_DELIVER)에 이르러야 해결(resolved)이다.
//
// 종류:
//   fix           원인이 확인된 수정 진단 — 수정 지시·검증 기준·계획 변경 여부가 필요하다. 적용하면 구현·수정 단계로 반환된다.
//   investigation 원인 미확정의 추가 조사 기록 — 적용(구현 재개)할 수 없다. 열려 있는 동안 재개·인도를 막는다.
//   no_action     기존 진단을 정정하는 "수정 불필요" 결론 — 근거 참조가 필요하고, 정정 대상(supersedes)이 있어야 한다.
import { z } from "zod";

import type { Finding } from "./contracts.js";

export const DIAGNOSIS_ID_PATTERN = /^DG-\d{1,6}$/;
export const DIAGNOSIS_KINDS = ["fix", "investigation", "no_action"] as const;
export type DiagnosisKind = (typeof DIAGNOSIS_KINDS)[number];

const text = (max: number) => z.string().trim().min(1).max(max);

export const DiagnosisInputSchema = z.object({
  kind: z.enum(DIAGNOSIS_KINDS),
  title: text(200),
  // 관찰한 실패(무엇이 어떻게 실패했나) — 로그·게이트 결과·재현 조건.
  observedFailure: text(20_000),
  // 근거 참조(파일 경로·로그·크래시 리포트·산출물). 서버는 존재를 검사하지 않는다(중재자의 판단 영역).
  evidenceRefs: z.array(text(2_000)).max(100).default([]),
  // 원인 판단과 남은 불확실성.
  cause: text(20_000),
  uncertainty: z.string().trim().max(10_000).default(""),
  // 수정 지시와 검증 기준(fix 필수).
  instructions: z.string().trim().max(50_000).default(""),
  verificationCriteria: z.array(text(2_000)).max(50).default([]),
  // 계획 변경 여부와 이유(fix 필수). 의미 판단은 중재자 몫이다 — 서버는 선언된 분기·승인·실제 변경 범위를 검사한다.
  planChange: z.object({ required: z.boolean(), reason: text(10_000) }).strict().optional(),
  severity: z.enum(["BLOCKER", "HIGH", "MEDIUM", "LOW"]).default("HIGH"),
  // 이 진단과 관련된 **현재 열린** 요청 결정 id(서버가 등록 시점에 열린 요청인지 검사한다). 진단이 적용돼도 요청은 자동으로 닫히지 않는다.
  relatedRequestIds: z.array(z.string().regex(/^Q-[0-9a-f]{8}$/)).max(50).default([]),
  // 정정: 이 기록이 대체하는 이전 진단 id(같은 토픽).
  supersedes: z.string().regex(DIAGNOSIS_ID_PATTERN).optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "fix") {
    if (!value.instructions) context.addIssue({ code: "custom", path: ["instructions"], message: "수정 진단(fix)에는 수정 지시가 필요합니다." });
    if (value.verificationCriteria.length === 0) {
      context.addIssue({ code: "custom", path: ["verificationCriteria"], message: "수정 진단(fix)에는 검증 기준이 1개 이상 필요합니다." });
    }
    if (!value.planChange) context.addIssue({ code: "custom", path: ["planChange"], message: "수정 진단(fix)에는 계획 변경 여부와 이유(planChange)가 필요합니다." });
  }
  if (value.kind === "no_action") {
    if (!value.supersedes) {
      context.addIssue({ code: "custom", path: ["supersedes"], message: "수정 불필요 결론(no_action)은 기존 진단을 정정하는 기록으로만 남깁니다(supersedes)." });
    }
    if (value.evidenceRefs.length === 0) context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "수정 불필요 결론(no_action)에는 근거 참조가 필요합니다." });
  }
});
export type DiagnosisInput = z.infer<typeof DiagnosisInputSchema>;

// 상태(추가 전용 기록의 마지막 값):
//   registered       등록됨 — 중재자가 적용하거나 정정해야 한다(재개를 막는다)
//   stale            적용 시점에 계획·코드·세대·실패가 달라 적용하지 않음 — 정정(새 진단)으로만 넘어간다(재개를 막는다)
//   applied          적용됨 — 다음 쓰기 턴이 전달한다(계획 변경 진단은 먼저 진단 계획 개정 턴이 승인 계획을 고친다)
//   plan_revised     계획 변경 진단의 개정 계획이 저장됐다 — 감사·종결·ACK·사용자 승인을 거친 뒤 첫 구현 턴이 전달한다
//   delivered        그 쓰기 턴의 프로세스가 실제로 시작됐다(프롬프트 생성만으로는 기록하지 않는다)
//   fix_reported     러너가 반영(RESOLVED_BY_FIX)을 보고했고 그 결과가 수락됐다 — 리뷰가 확인해야 해결이다
//   refuted          러너가 반박했다 — 중재자에게 돌아간다(같은 지시를 자동으로 반복하지 않는다)
//   needs_evidence   러너가 추가 증거를 요구했다 — 중재자에게 돌아간다
//   resolved         수정 결과가 리뷰를 통과해 인도 준비에 이르렀다
//   superseded       정정 기록이 대체했다
//   closed_no_action 수정 불필요 결론(no_action 기록 자신)
export const DIAGNOSIS_STATUSES = [
  "registered", "stale", "applied", "plan_revised", "delivered", "fix_reported", "refuted", "needs_evidence", "resolved", "superseded", "closed_no_action",
] as const;
export type DiagnosisStatus = (typeof DIAGNOSIS_STATUSES)[number];

// 닫힌 상태 — 재개·인도를 막지 않는다.
export const CLOSED_DIAGNOSIS_STATUSES: ReadonlySet<DiagnosisStatus> = new Set(["superseded", "resolved", "closed_no_action"]);
// 중재자가 움직여야 하는 상태 — 재개(retry·구현 재개·자동 재시도·구현 시작)를 막는다.
export const MEDIATOR_PENDING_STATUSES: ReadonlySet<DiagnosisStatus> = new Set(["registered", "stale", "refuted", "needs_evidence"]);

// 적용 경로:
//   work           멈춘 구현·수정 작업에 수정 지시로 전달(같은 계획·작업 트리·세션·누적 기록)
//   diagnosis-fix  수정 단계(CLAUDE_FIX)의 진단 전용 작업 → 최종 리뷰(인도 대기·최종 리뷰 정지에서 반환)
//   plan-revision  계획 개정(검토·승인) 뒤 구현 반환
export type DiagnosisApplyMode = "work" | "diagnosis-fix" | "plan-revision";
export type DiagnosisTarget = "IMPLEMENTING" | "CLAUDE_FIX" | "CLAUDE_PLAN";

export interface DiagnosisBinding {
  scopeGeneration: number;
  planEpoch: number;
  planSHA256: string | null;
  approvedPlanSHA256: string | null;
  state: string;
  resumeState: string | null;
  // 진단 대상 실패 — 마지막으로 끝난 실행(action). 새 실행이 끝나면 다른 실패다(최신 진단을 다른 실패에 적용하지 않는다).
  failure: { actionId: string | null; actionKind: string | null; actionStatus: string | null };
  checkpoint: { revision: number; workId: string; phase: string } | null;
  worktree: { head: string; diffSHA256: string };
  inputSequence: number;
  openRequestIds: string[];
}

export interface DiagnosisOrigin { actor: "mediator"; delegationSetAt: string | null }

export interface DiagnosisHistoryEntry { seq: number; status: DiagnosisStatus; detail: Record<string, unknown>; at: string }

export interface DiagnosisRecord {
  id: string;
  topicId: string;
  number: number;
  input: DiagnosisInput;
  binding: DiagnosisBinding;
  origin: DiagnosisOrigin | null;
  createdAt: string;
  status: DiagnosisStatus;
  history: DiagnosisHistoryEntry[];
}

// 마지막 적용 기록(경로·반환 단계·반환 전 재개 단계). 적용 전이면 null.
export function applyInfo(record: DiagnosisRecord): { mode: DiagnosisApplyMode; target: DiagnosisTarget; seq: number; fromResume: string | null } | null {
  const entry = [...record.history].reverse().find((item) => item.status === "applied");
  if (!entry) return null;
  const mode = entry.detail.mode as DiagnosisApplyMode | undefined;
  const target = entry.detail.target as DiagnosisTarget | undefined;
  const fromResume = typeof entry.detail.fromResume === "string" ? entry.detail.fromResume : null;
  return mode && target ? { mode, target, seq: entry.seq, fromResume } : null;
}

// 계획 변경 진단(적용 경로 plan-revision)인가.
export function isPlanRevision(record: DiagnosisRecord): boolean {
  return applyInfo(record)?.mode === "plan-revision";
}

// 쓰기 턴이 전달할 차례인가 — 같은 계획 안의 진단은 적용 직후(applied), 계획 변경 진단은 개정 계획이 저장된 뒤(plan_revised).
// 계획 변경 진단의 applied 는 아직 계획을 고치기 전이라 구현 턴에 싣지 않는다.
export function awaitingDelivery(record: DiagnosisRecord): boolean {
  return isPlanRevision(record) ? record.status === "plan_revised" : record.status === "applied";
}

// 진단을 기존 findings 계약에 싣는다 — id 가 곧 진단 id 이고, 러너는 이 id 로 반영(RESOLVED_BY_FIX)·반박(REFUTED)·추가 증거 필요(EXTERNAL_EVIDENCE)를
// 보고한다(서버의 쟁점 커버리지 검사가 누락을 막는다). 리뷰어는 구현 보고의 이 쟁점을 판정한다(RESOLVED_BY_FIX 주장은 승계되지 않는다).
export function diagnosisFinding(record: DiagnosisRecord): Finding {
  const criteria = record.input.verificationCriteria.map((item, index) => `${index + 1}) ${item}`).join(" ");
  return {
    id: record.id,
    title: `중재자 진단: ${record.input.title}`,
    severity: record.input.severity,
    disposition: "AGREED_ACTION",
    rationale: `수정 지시: ${record.input.instructions} / 검증 기준: ${criteria || "(없음)"}`,
    evidenceRefs: [...record.input.evidenceRefs],
    requiresUserDecision: false,
  };
}

// 프롬프트에 싣는 형태(원문은 path 의 산출물 — 러너 읽기 허용).
export interface DiagnosisPrompt {
  id: string;
  title: string;
  severity: string;
  observedFailure: string;
  cause: string;
  uncertainty: string;
  instructions: string;
  verificationCriteria: string[];
  evidenceRefs: string[];
  relatedRequestIds: string[];
  supersedes: string | null;
  planChange: { required: boolean; reason: string } | null;
  path: string | null;
}

export function toDiagnosisPrompt(record: DiagnosisRecord, path: string | null): DiagnosisPrompt {
  return {
    id: record.id, title: record.input.title, severity: record.input.severity, observedFailure: record.input.observedFailure,
    cause: record.input.cause, uncertainty: record.input.uncertainty, instructions: record.input.instructions,
    verificationCriteria: [...record.input.verificationCriteria], evidenceRefs: [...record.input.evidenceRefs],
    relatedRequestIds: [...record.input.relatedRequestIds], supersedes: record.input.supersedes ?? null,
    planChange: record.input.planChange ? { ...record.input.planChange } : null, path,
  };
}
