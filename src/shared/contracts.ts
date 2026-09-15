import {ReviewAllowanceSchema,ReviewScopeSchema} from "./reviews.js";
import { type BudgetAccount } from "./budgets.js";
import { RevisionAllowanceSchema } from "./revisions.js";
import { z } from "zod";
import { ToleranceLedgerEntrySchema } from "./tolerance";

export const WORKFLOW_STATES = [
  "DRAFT",
  "CLAUDE_PLAN",
  "CODEX_AUDIT",
  "CLAUDE_REVISION",
  "CODEX_CLOSEOUT",
  "CONSENSUS_ACK",
  "AWAITING_USER_APPROVAL",
  "IMPLEMENTING",
  "CODEX_REVIEW",
  "CLAUDE_FIX",
  "CODEX_FINAL_REVIEW",
  "READY_TO_DELIVER",
  "CLOSED",
  "BLOCKED_ON_EVIDENCE",
  "USER_DECISION_REQUIRED",
  "FAILED",
] as const;

export const WorkflowStateSchema = z.enum(WORKFLOW_STATES);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export const AGENT_ROLES = ["claude", "codex", "system", "user"] as const;
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const AgentEffortSchema = z.enum(AGENT_EFFORTS);
export type AgentEffort = z.infer<typeof AgentEffortSchema>;

const AgentModelSchema = z.string().trim().min(1).max(120).regex(
  /^[A-Za-z0-9._:-]+$/,
  "모델 이름에는 영문, 숫자, 마침표, 밑줄, 콜론, 하이픈만 사용할 수 있습니다.",
);

export const AgentExecutionSettingsSchema = z.object({
  model: AgentModelSchema,
  effort: AgentEffortSchema,
  // 단계별 분리: 계획 수렴(adversarial 왕복)과 구현이 다른 모델을 쓸 수 있다 — 사용자 관행이
  // 플랜/설계=Fable, 구현=Opus라서다(2026-08-31). 없으면 모든 단계가 위 model/effort를 쓴다.
  implementation: z.object({ model: AgentModelSchema, effort: AgentEffortSchema }).optional(),
});
export type AgentExecutionSettings = z.infer<typeof AgentExecutionSettingsSchema>;

export const AgentSettingsSchema = z.object({
  claude: AgentExecutionSettingsSchema,
  codex: AgentExecutionSettingsSchema,
});
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  claude: { model: "fable", effort: "xhigh", implementation: { model: "opus", effort: "xhigh" } },
  // 2026-09-07 사용자 지시: codex 감사 모델 gpt-6-astra · 추론 xhigh. 속도 티어는 붙이지 않는다
  // (2026-09-06 에 priority 를 뺐다 — 사용량이 더 빨리 소모된다).
  codex: { model: "gpt-6-astra", effort: "xhigh" },
};

export const MESSAGE_KINDS = [
  "note",
  "scope_change",
  "evidence",
  "decision",
  "agent_output",
  "system",
] as const;
export const MessageKindSchema = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const DISPOSITIONS = [
  "AGREED_ACTION",
  "AGREED_NO_ACTION",
  "REFUTED",
  "EXTERNAL_EVIDENCE",
  "DEFERRED_OUT_OF_SCOPE",
  "RESOLVED_BY_FIX",
] as const;
export const DispositionSchema = z.enum(DISPOSITIONS);
export type Disposition = z.infer<typeof DispositionSchema>;

// 수정이 실제로 일어나는 단계 — 이 kind에서만 RESOLVED_BY_FIX 처분이 허용된다.
// 검사기(assertFixDispositionAllowed)와 프롬프트(dispositionContract)가 같은 정본을 읽어
// 짝 드리프트를 구조적으로 차단한다(2026-09-01 S1.1: 프롬프트 누락으로 정상 구현 턴 거부).
export const FIX_AWARE_KINDS: ReadonlySet<string> = new Set(["IMPLEMENTATION", "FIX", "FINAL_REVIEW"]);

export const FindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(["BLOCKER", "HIGH", "MEDIUM", "LOW", "INFO"]),
  disposition: DispositionSchema.optional(),
  rationale: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
  requiresUserDecision: z.boolean().default(false),
});
export type Finding = z.infer<typeof FindingSchema>;

export const MemoryUpdateSchema = z.object({
  path: z.string().trim().min(1).max(240),
  expectedSHA256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  content: z.string().min(1).max(200_000),
  reason: z.string().trim().min(1).max(1_000),
});
export type MemoryUpdate = z.infer<typeof MemoryUpdateSchema>;

// 개정 턴의 패치 출력. find는 직전 저장 계획(프롬프트에 실린 '기존 계획' 본문)에서 정확히 1회
// 일치해야 하고, 순서대로 적용된다. 매 개정이 53KB 계획 전문을 재출력해 출력 상한(64K)에 닿던
// 병목(2026-08-31 실측 62,066)을 없애기 위한 계약 — 전문은 서버가 적용해 저장·해시한다.
export const PlanEditSchema = z.object({
  find: z.string().min(1),
  replace: z.string(),
});
export type PlanEdit = z.infer<typeof PlanEditSchema>;

export const PlanLineEditsSchema = z.object({
  baseSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  edits: z.array(z.object({
    startLine: z.number().int().min(1),
    endLineExclusive: z.number().int().min(1),
    replacement: z.string(),
  }).strict()).max(200),
}).strict();
export type PlanLineEdits = z.infer<typeof PlanLineEditsSchema>;

export const PlanRepairSchema = z.object({
  baseSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  edits: z.array(PlanEditSchema.strict()).min(1).max(200),
}).strict();
export type PlanRepair = z.infer<typeof PlanRepairSchema>;
export const PlanRepairJsonSchema = {
  type: "object", additionalProperties: false, required: ["baseSHA256", "edits"],
  properties: {
    baseSHA256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    edits: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["find", "replace"],
      properties: { find: { type: "string" }, replace: { type: "string" } },
    } },
  },
} as const;

export const AgentResultSchema = z.object({
  kind: z.enum([
    "PLAN",
    "AUDIT",
    "REVISION",
    "CLOSEOUT",
    "IMPLEMENTATION",
    "REVIEW",
    "FIX",
    "FINAL_REVIEW",
    "ACK",
  ]),
  summary: z.string().min(1),
  planMarkdown: z.string().min(1).optional(),
  planEdits: z.array(PlanEditSchema).max(200).optional(),
  planLineEdits: PlanLineEditsSchema.optional(),
  planSHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  findings: z.array(FindingSchema).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  requestedUserDecision: z.string().min(1).optional(),
  // 2026-09-14 Codex 감사 D01: 완료 판단을 요청 필드 유무(프롬프트 해석)에만 맡기지 않는다. 구현·수정 결과가 명시하는 진행 상태 —
  // completed(계획의 모든 단계 끝) · in_progress(단계가 남았고 같은 세션에서 계속) · blocked(사람·중재자 입력 필요). 없으면 종전 규칙.
  status: z.enum(["completed", "in_progress", "blocked"]).optional(),
  remainingSteps: z.array(z.string().max(500)).max(50).optional(),
  // 허용 오차 교정 재제출이 본 턴의 요청 결정을 **해소**했음을 명시한다(예: 범위 밖 변경을 전부 되돌려 질문이 사라짐, Codex 감사 R07).
  resolvesRequestedDecision: z.boolean().optional(),
  // 해소 표식이 가리키는 요청 id(서버가 정지 메시지·재개 프롬프트에 적어 준 `Q-xxxxxxxx`). **id 가 없거나 열린 요청과 다르면 서버는 어떤
  // 요청도 닫지 않는다**(PLAN §2: 해소 표식은 해당 요청에 결속 — 요청 하나씩 명시).
  resolvedRequestId: z.string().min(1).optional(),
  // 읽기 전용 리뷰 답변 확인 결과. 요청별로 실제 답변인 사용자 decision 순번을 인용한다.
  reviewDecisionAnswers: z.array(z.object({ requestId: z.string().min(1), decisionSequence: z.number().int().positive() }).strict()).max(100).optional(),
  memoryUpdates: z.array(MemoryUpdateSchema).max(10).optional(),
  // 허용 오차 원장 — 승인 범위 밖 변경마다 {ruleId, file, note}. 서버가 git diff 와 대조한다(shared/tolerance.ts).
  // 서버 누적 원장(승계 포함)의 저장 계약엔 상한이 없다 — 상한은 정책(규칙 수×파일 수)이 정하고, 모델 한 번 응답의 상한(500행)은
  // 어댑터 결과 파서가 따로 검사한다(F10: 응답 한도와 누적 저장 계약의 분리).
  toleranceLedger: z.array(ToleranceLedgerEntrySchema).optional(),
 }).superRefine((result, context) => {
  if (result.planLineEdits && (result.kind !== "REVISION" || result.planEdits !== undefined || result.planMarkdown !== undefined)) {
    context.addIssue({ code: "custom", message: "planLineEdits는 REVISION에서 단독으로 사용해야 합니다." });
  }
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

export const ParticipantSchema = z.object({
  role: z.enum(["claude", "codex"]),
  sessionId: z.string().min(1),
  mode: z.enum(["created", "attached"]),
  acknowledgedPlanSHA256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const TopicSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  repositoryPath: z.string().min(1),
  baseRef: z.string().min(1),
  worktreePath: z.string().min(1),
  branchPrefix: z.string().min(1).default("consensus"),
  // 사용자가 지정한 이름. branchName과 달리 "만들어졌다"는 뜻이 아니다.
  requestedBranchName: z.string().nullable().default(null),
  predecessorTopicId: z.string().nullable().default(null),
  // 선행 토픽 — 그 토픽이 이연한 쟁점(deferred-findings)을 이 토픽의 첫 계획·감사 프롬프트가 자동으로 받는다(2026-09-07).
  branchName: z.string().nullable(),
  state: WorkflowStateSchema,
  scopeGeneration: z.number().int().positive(),
  planEpoch: z.number().int().positive().default(1),
  planRevision: z.number().int().nonnegative(),
  planSHA256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  approvedPlanSHA256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  agentSettings: AgentSettingsSchema,
  participants: z.array(ParticipantSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastError: z.string().nullable(),
});
export type Topic = z.infer<typeof TopicSchema>;

export const TimelineEventSchema = z.object({
  id: z.number().int().positive(),
  topicId: z.string().min(1),
  sequence: z.number().int().positive(),
  scopeGeneration: z.number().int().positive().default(1),
  actor: AgentRoleSchema,
  kind: MessageKindSchema,
  state: WorkflowStateSchema,
  body: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const TopicDetailSchema = z.object({
  topic: TopicSchema,
  timeline: z.array(TimelineEventSchema),
  currentPlan: z.string().nullable(),
  previousPlan: z.string().nullable(),
  consensus: z.record(z.string(), z.unknown()).nullable(),
  implementationReport: z.string().nullable(),
  codexReview: z.string().nullable(),
  changedPaths: z.array(z.string()),
  orphanCommitOID: z.string().nullable(),
  deliveryRecovery: z.object({
    action: z.enum(["commit", "push"]),
    idempotencyKey: z.string().min(1),
    createdAt: z.string().datetime(),
    requestedPaths: z.array(z.string()),
  }).nullable(),
});
export type TopicDetail = z.infer<typeof TopicDetailSchema>;

// git ref 한 구간으로 안전한 문자만 받는다. 슬래시를 허용하지 않는 이유는 서버가 접두사와 slug 사이에
// 슬래시를 하나만 넣어 `<prefix>/<slug>-<id>-g<generation>` 형태를 보장하기 위해서다.
export const BranchPrefixSchema = z.string().trim().min(1).max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "브랜치 접두사에는 영문, 숫자, 마침표, 밑줄, 하이픈만 쓸 수 있습니다.")
  .refine((value) => !value.endsWith(".lock") && !value.includes(".."), "git이 거부하는 ref 이름입니다.");

// 브랜치 이름을 통째로 지정할 때 쓴다. 접두사와 달리 슬래시를 허용하되 git이 거부하는 형태는 막는다.
export const BranchNameSchema = z.string().trim().min(1).max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/, "브랜치 이름에는 영문, 숫자, 마침표, 밑줄, 하이픈, 슬래시만 쓸 수 있습니다.")
  .refine((value) => !value.includes("..") && !value.includes("//")
    && !value.endsWith("/") && !value.endsWith("."), "git이 거부하는 ref 이름입니다.")
  // git은 세그먼트 단위로도 거부한다: '.'로 시작하는 세그먼트(feature/.hidden), '.lock'으로 끝나는
  // 세그먼트(중간 포함). 끝만 검사하면 승인 단계까지 통과한 뒤 브랜치 생성에서 터진다(감사 부차 지적).
  .refine((value) => value.split("/").every(
    (segment) => segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".lock"),
  ), "git이 거부하는 ref 세그먼트가 있습니다.");

export const CreateTopicInputSchema = z.object({
  title: z.string().trim().min(2).max(120),
  // '-'로 시작하면 git worktree add에서 옵션으로 해석될 수 있다(감사 부차 지적).
  baseRef: z.string().trim().min(1).refine((value) => !value.startsWith("-"), "기준 리비전은 '-'로 시작할 수 없습니다.").default("HEAD"),
  branchPrefix: BranchPrefixSchema.default("consensus"),
  // 지정하면 이 이름을 그대로 쓴다. 생략하면 branchPrefix로 `<접두사>/<slug>-<id>-g<세대>`를 만든다.
  requestedBranchName: BranchNameSchema.nullable().default(null),
  predecessorTopicId: z.string().uuid().nullable().default(null),
});
export type CreateTopicInput = z.infer<typeof CreateTopicInputSchema>;

// 이연 쟁점 — 종결 확인·최종 리뷰가 "이번 범위 밖" 으로 처분한 새 쟁점. 산출물 `deferred-findings` 에 누적되고
// 같은 토픽의 재시작 계획과 후속 토픽(predecessorTopicId)의 첫 계획·감사 프롬프트에 자동으로 실린다.
export const DeferredFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: FindingSchema.shape.severity,
  rationale: z.string(),
  // implementation/fix = 러너가 구현 중 범위 밖으로 판정해 to-do 로 남긴 것(DEFERRED_OUT_OF_SCOPE 처분, 2026-09-08).
  source: z.enum(["closeout", "final-review", "implementation", "fix"]),
  topicId: z.string().min(1),
  recordedAt: z.string(),
});
export type DeferredFinding = z.infer<typeof DeferredFindingSchema>;
export const DeferredFindingsSchema = z.object({ findings: z.array(DeferredFindingSchema) });

// 개정 없이 구현 단계로 넘긴 경미 지적(2026-09-13 사용자 규칙 "사소한 finding 은 개정하지 말고 러너에게 따로 알려라").
// 감사·종결의 MEDIUM 이하 AGREED_ACTION 은 계획 개정 턴을 사지 않고 여기 기록돼 구현 프롬프트에 실리며, 러너는 id 별 처분을 보고한다.
export const ImplementationNoteSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: FindingSchema.shape.severity,
  rationale: z.string(),
  source: z.enum(["audit", "closeout"]),
  topicId: z.string().min(1),
  recordedAt: z.string(),
});
export type ImplementationNote = z.infer<typeof ImplementationNoteSchema>;
export const ImplementationNotesSchema = z.object({ notes: z.array(ImplementationNoteSchema) });

export const UpdateAgentSettingsInputSchema = AgentExecutionSettingsSchema;
export type UpdateAgentSettingsInput = z.infer<typeof UpdateAgentSettingsInputSchema>;

export const ClientConfigSchema = z.object({
  repositoryPath: z.string().min(1),
  memoryDirectory: z.string().min(1),
  defaultAgentSettings: AgentSettingsSchema,
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

export const AttachParticipantInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("new") }),
  z.object({ mode: z.literal("attach"), sessionId: z.string().trim().min(1) }),
]);
export type AttachParticipantInput = z.infer<typeof AttachParticipantInputSchema>;

// 구현 도중 허용 오차 개정(넓히기만): tolerance = 새 블록 JSON 객체 전체, reason = 결정 근거(타임라인 decision 본문).
// 구현 계속 재개(공식 복구 API, Codex 감사 D01): 러너가 완료 형식으로 리뷰에 들어가 멈췄거나 실패한 토픽을 같은 세션·같은 계획으로
// IMPLEMENTING 재개 상태로 되돌린다. 기대 상태·세대를 결속해 낡은 요청이 다른 상황에 적용되지 않게 한다(sqlite 직접 수정 대체).
export const ResumeImplementationInputSchema = z.object({
  expectedState: z.enum(["USER_DECISION_REQUIRED", "FAILED"]),
  expectedScopeGeneration: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4000),
});
export type ResumeImplementationInput = z.infer<typeof ResumeImplementationInputSchema>;

// 도구 트리 기준 재설정(중재자, 재동기화 뒤) — 감지된 변경을 "복구했다" 고 선언하는 유일한 경로(F04).
export const ReasonInputSchema = z.object({ reason: z.string().trim().min(1).max(4000) });
// 도구 트리 기준 갱신 — 유지보수 잠금을 쥔 스크립트가 종료 절차로 부를 때 잠금 파일의 pid·at 을 그대로 제시한다(소유 증명, R3-06).
export const ToolTreeRebaselineInputSchema = ReasonInputSchema.extend({
  maintenanceLock: z.object({ pid: z.number().int().positive(), at: z.string().min(1) }).optional(),
});
export type ToolTreeRebaselineInput = z.infer<typeof ToolTreeRebaselineInputSchema>;
export const RESPONSE_LEDGER_LIMIT = 500;

export const AmendToleranceInputSchema = z.object({
  tolerance: z.unknown(),
  reason: z.string().trim().min(1).max(20_000),
});
export type AmendToleranceInput = z.infer<typeof AmendToleranceInputSchema>;

export const PostMessageInputSchema = z.object({
  kind: z.enum(["note", "scope_change", "evidence", "decision"]),
  body: z.string().trim().min(1).max(50_000),
});
export type PostMessageInput = z.infer<typeof PostMessageInputSchema>;

export const ApprovalInputSchema = z.object({
  planSHA256: z.string().regex(/^[a-f0-9]{64}$/),
});

// implement 와 함께 올리는 시작 결정문(선택). 승인 대기 상태에서는 메시지가 계획을 무효화하므로
// "implement → stop → decision → retry" 왕복이 필요했다(2026-09-08 S10 실측: 즉시 stop 은 세션 파일도 못 남긴다).
// 이 필드는 구현 턴이 시작되기 **전에** user/decision 이벤트로 붙어 첫 프롬프트에 실린다.
export const ImplementInputSchema = z.object({
  kickoffDecision: z.string().trim().min(1).max(20000).optional(),
});
export type ImplementInput = z.infer<typeof ImplementInputSchema>;

export const DeliveryInputSchema = z.object({
  message: z.string().trim().min(1).max(500),
  paths: z.array(z.string().min(1)).min(1).max(200),
});

export const ReconcileDeliveryInputSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  outcome: z.enum(["succeeded", "failed"]),
  oid: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
}).superRefine((value, context) => {
  if (value.outcome === "succeeded" && !value.oid) {
    context.addIssue({ code: "custom", path: ["oid"], message: "성공 확인에는 Git OID가 필요합니다." });
  }
});

export const ActionResponseSchema = z.object({
  accepted: z.boolean(),
  actionId: z.string(),
  topic: TopicSchema,
});
export type ActionResponse = z.infer<typeof ActionResponseSchema>;

// OpenAI 구조화 출력은 모든 객체에서 required가 properties의 전 키를 포함할 것을 요구한다. 빠지면
// 모델 호출 전에 400 invalid_json_schema로 죽고, Codex는 그 오류를 stdout에만 쓰고 stderr는 비운 채
// exit 1이라 "Codex 실행 실패(1): "만 남는다(2026-08-29 실측). 그래서 선택 필드도 required에 넣고
// 선택성은 null 허용으로 표현한다. Claude(--json-schema)는 이 규칙을 강제하지 않아 이전까지 통과했다.
export const AgentResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind", "summary", "planMarkdown", "planEdits", "planLineEdits", "planSHA256",
    "findings", "evidenceRefs", "requestedUserDecision", "memoryUpdates", "toleranceLedger",
    "status", "remainingSteps", "resolvesRequestedDecision", "resolvedRequestId", "reviewDecisionAnswers",
  ],
  properties: {
    kind: { enum: AgentResultSchema.shape.kind.options },
    summary: { type: "string" },
    planMarkdown: { anyOf: [{ type: "string" }, { type: "null" }] },
    planEdits: {
      anyOf: [
        {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["find", "replace"],
            properties: {
              find: { type: "string" },
              replace: { type: "string" },
            },
          },
        },
        { type: "null" },
      ],
    },
    planLineEdits: { anyOf: [{
      type: "object", additionalProperties: false, required: ["baseSHA256", "edits"],
      properties: {
        baseSHA256: { type: "string" },
        edits: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["startLine", "endLineExclusive", "replacement"],
          properties: { startLine: { type: "integer" }, endLineExclusive: { type: "integer" }, replacement: { type: "string" } },
        } },
      },
    }, { type: "null" }] },
    planSHA256: { anyOf: [{ type: "string" }, { type: "null" }] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "severity", "disposition", "rationale", "evidenceRefs", "requiresUserDecision"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          severity: { enum: ["BLOCKER", "HIGH", "MEDIUM", "LOW", "INFO"] },
          disposition: { anyOf: [{ enum: [...DISPOSITIONS] }, { type: "null" }] },
          rationale: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
          requiresUserDecision: { type: "boolean" },
        },
      },
    },
    evidenceRefs: { type: "array", items: { type: "string" } },
    requestedUserDecision: { anyOf: [{ type: "string" }, { type: "null" }] },
    status: { anyOf: [{ enum: ["completed", "in_progress", "blocked"] }, { type: "null" }] },
    remainingSteps: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
    resolvesRequestedDecision: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    resolvedRequestId: { anyOf: [{ type: "string" }, { type: "null" }] },
    reviewDecisionAnswers: { anyOf: [{ type: "array", maxItems: 100, items: {
      type: "object", additionalProperties: false, required: ["requestId", "decisionSequence"],
      properties: { requestId: { type: "string" }, decisionSequence: { type: "integer", minimum: 1 } },
    } }, { type: "null" }] },
    toleranceLedger: {
      anyOf: [
        {
          type: "array",
          // 한 번 응답의 원장 상한(파서 RESPONSE_LEDGER_LIMIT 과 같은 값) — 앞 턴에서 받아들인 행은 서버가 승계하므로 이번 턴 변경분만 적는다(R3-11).
          maxItems: RESPONSE_LEDGER_LIMIT,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ruleId", "file", "note"],
            properties: {
              ruleId: { type: "string" },
              file: { type: "string" },
              note: { type: "string" },
            },
          },
        },
        { type: "null" },
      ],
    },
    memoryUpdates: {
      anyOf: [
        {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "expectedSHA256", "content", "reason"],
            properties: {
              path: { type: "string" },
              expectedSHA256: { anyOf: [{ type: "string" }, { type: "null" }] },
              content: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
        { type: "null" },
      ],
    },
  },
} as const;

export const REQUIRED_PLAN_HEADINGS = [
  "목표와 완료 기준",
  "기준 리비전",
  "확정된 계약",
  "구현 변경",
  "인터페이스와 데이터 흐름",
  "실패·취소·복구",
  "테스트",
  "제외 범위",
  "허용 오차",
  "외부 증거",
  "작업 소유자",
] as const;

export function validatePlanHeadings(markdown: string): string[] {
  return REQUIRED_PLAN_HEADINGS.filter((heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "m").test(markdown);
  });
}

// ---- 자율 중재 위임 스위치 (2026-09-08) --------------------------------------------------------
// 정본은 데이터 디렉터리의 `mediation-autonomy.json` 하나다. 셸 스크립트(mediation_autonomy.sh)와
// 웹 토글이 같은 파일을 읽고 쓴다. 파일이 없으면 off 로 취급한다(fail-closed).
export const MEDIATION_AUTONOMY_VALUES = ["on", "off"] as const;
export const MediationAutonomyValueSchema = z.enum(MEDIATION_AUTONOMY_VALUES);
export type MediationAutonomyValue = z.infer<typeof MediationAutonomyValueSchema>;

export const MediationAutonomyHistoryEntrySchema = z.object({
  autonomy: MediationAutonomyValueSchema,
  set_at: z.string().nullable(),
  set_by: z.string().nullable(),
  note: z.string().nullable(),
});

export const MediationAutonomySchema = z.object({
  autonomy: MediationAutonomyValueSchema,
  set_at: z.string().nullable(),
  set_by: z.string().nullable(),
  note: z.string().nullable(),
  history: z.array(MediationAutonomyHistoryEntrySchema),
  // 파일이 없어서 off 로 취급한 상태인지(명시적 off 와 구분해 화면에 보여 준다).
  unset: z.boolean(),
});
export type MediationAutonomy = z.infer<typeof MediationAutonomySchema>;

export const UpdateMediationAutonomyInputSchema = z.object({
  autonomy: MediationAutonomyValueSchema,
  note: z.string().trim().max(500).optional(),
});
export type UpdateMediationAutonomyInput = z.infer<typeof UpdateMediationAutonomyInputSchema>;

// 러너 생존 표시 — GET /api/topics/:id/activity (2026-09-08).
export const TopicActivitySchema = z.object({
  state: WorkflowStateSchema,
  runningAction: z.boolean(),
  budget: z.custom<BudgetAccount>().nullable().optional(),
  revisionAllowance: RevisionAllowanceSchema.optional(),
  revisionPaused: z.boolean().optional(),
  reviewAllowances: z.array(ReviewAllowanceSchema).optional(),
  reviewPaused: ReviewScopeSchema.nullable().optional(),
  executionUsage: z.array(z.object({
    executionId: z.string(), role: z.enum(["claude", "codex"]), phase: z.string(), observedAt: z.string(),
    usage: z.object({
      executionId: z.string(), recordKind: z.enum(["progress", "final"]),
      completeness: z.enum(["complete", "partial"]).optional(),
      inputTokens: z.number().optional(), cachedInputTokens: z.number().optional(), outputTokens: z.number().optional(),
      durationMs: z.number().optional(),
    }).passthrough(),
  })).optional(),
  lastChangeAt: z.string().nullable(),
  lastChangedPath: z.string().nullable(),
  scanned: z.number().int(),
  truncated: z.boolean(),
  // 사용 한도(429)로 FAILED 인 주제에 예약된 자동 재시도 시각(ISO). 없으면 null.
  autoRetryAt: z.string().nullable().default(null),
  checkedAt: z.string(),
});
export type TopicActivity = z.infer<typeof TopicActivitySchema>;
