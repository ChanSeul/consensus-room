// 중재자 진단 기록(2026-09-14 PLAN "중재자 진단을 보존하고 계획·구현으로 연결하기").
//
// 등록·적용 API(1898d91)와 진단 엔진(be40f25)은 지웠다 — 중재자의 결정은 relay 의 resume·return-to-planning 결정문으로 전달한다
// (계약 v3.17 (28)(29)). 이 파일은 저장된 진단 이력을 읽는 형과 판정(조회 API·재개 정보·역할 판정)만 남긴다. 기록은 일반 메시지와
// 구분되는 기록이었고 덮어쓰지 않았다 — 정정은 이전 진단을 대체하는 새 기록이었다.
//
// 종류:
//   fix           원인이 확인된 수정 진단 — 수정 지시·검증 기준·계획 변경 여부가 필요하다. 적용하면 구현·수정 단계로 반환된다.
//   investigation 원인 미확정의 추가 조사 기록 — 적용(구현 재개)할 수 없다. 열려 있는 동안 재개·인도를 막는다.
//   no_action     기존 진단을 정정하는 "수정 불필요" 결론 — 근거 참조가 필요하고, 정정 대상(supersedes)이 있어야 한다.
import { z } from "zod";

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
