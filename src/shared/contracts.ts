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
  planSHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  findings: z.array(FindingSchema).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  requestedUserDecision: z.string().min(1).optional(),
  memoryUpdates: z.array(MemoryUpdateSchema).max(10).optional(),
  // 허용 오차 원장 — 승인 범위 밖 변경마다 {ruleId, file, note}. 서버가 git diff 와 대조한다(shared/tolerance.ts).
  toleranceLedger: z.array(ToleranceLedgerEntrySchema).max(500).optional(),
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
    "kind", "summary", "planMarkdown", "planEdits", "planSHA256",
    "findings", "evidenceRefs", "requestedUserDecision", "memoryUpdates", "toleranceLedger",
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
    toleranceLedger: {
      anyOf: [
        {
          type: "array",
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
