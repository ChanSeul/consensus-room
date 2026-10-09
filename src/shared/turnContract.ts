import { z } from "zod";
import { AgentResultJsonSchema, AgentResultSchema, type AgentResult } from "./contracts.js";
import type { TurnJob } from "./roles.js";

// One operation contract drives generation, injected instructions and acceptance.
// Reading memory does not confer permission to propose updates to that memory.
export function turnContract(job: TurnJob) {
  const discussion = job.operation === "brainstorm";
  return {
    memoryUpdates: !discussion,
    kinds: discussion ? ["BRAINSTORM"] : null,
    forbidden: discussion ? ["planMarkdown", "planEdits", "planLineEdits", "planSHA256", "memoryUpdates", "findings"] : [],
    interactivePlan: !discussion,
  };
}

// 결과 봉투(CR 흐름 단순화 D3) — 작업 턴의 결과는 상대에게 그대로 전달할 원문(message)과 역할별 outcome 하나다. 엔진은 outcome 만 읽고 message 를
// 해석·요약·재작성하지 않는다. outcome 은 다음 기계적 동작을 고르는 값일 뿐이고, 지적의 중요도·합의 여부 같은 업무 판단은 작업자·중재자가 message 로 한다.
export const TURN_OUTCOMES = {
  planner: ["ready", "needs-mediator"],
  "plan-reviewer": ["changes", "agree", "needs-mediator"],
  implementer: ["done", "continue", "needs-mediator"],
  "code-reviewer": ["changes", "approve", "needs-mediator"],
} as const;
export type EnvelopeRole = keyof typeof TURN_OUTCOMES;
export type TurnOutcome = (typeof TURN_OUTCOMES)[EnvelopeRole][number];
const ALL_TURN_OUTCOMES = ["ready", "changes", "agree", "done", "continue", "approve", "needs-mediator"] as const satisfies readonly TurnOutcome[];

// 봉투를 쓰는 작업 — 계획 왕복(작성·같은 계획 수정·검토)과 구현 왕복(구현·리뷰 응답 수정·계속·리뷰). 그 밖의 작업(브레인스토밍, 삭제 예정인
// 종결·최종 리뷰·ACK·확인·읽기 턴 등)은 봉투가 없다.
export function envelopeRole(job: TurnJob): EnvelopeRole | null {
  switch (job.role) {
    case "planner": return job.operation === "plan" || job.operation === "revision" ? "planner" : null;
    case "reviewer": return job.operation === "audit" ? "plan-reviewer" : job.operation === "review" ? "code-reviewer" : null;
    case "implementer": return job.operation === "implement" || job.operation === "fix" || job.operation === "continue" ? "implementer" : null;
  }
}

// 원문은 바꾸지 않는다 — zod 의 .trim() 은 값을 잘라 내므로 공백만인지 검사만 한다.
const RawText = z.string().refine(text => text.trim().length > 0, { message: "공백이 아닌 내용이 있어야 합니다." });

// 봉투 턴의 역할 — 봉투가 없는 작업이면 실행 전에 거부한다.
export function requireEnvelopeRole(job: TurnJob): EnvelopeRole {
  const role = envelopeRole(job);
  if (!role) throw new Error(`${job.role}/${job.operation} 작업에는 결과 봉투가 없습니다.`);
  return role;
}

// memoryUpdates·engineDefects 는 기존 결과 계약의 항목 스키마와 한도를 그대로 쓴다(R4 — CLI 스키마와 서버 한도의 일치는 기존 parity 검사가 지킨다).
function envelopeSchema<const O extends readonly [TurnOutcome, ...TurnOutcome[]]>(outcomes: O) {
  return z.object({
    message: RawText,
    outcome: z.enum(outcomes),
    // 중재자에게 묻는 내용 — needs-mediator 일 때만 읽는다.
    mediatorRequest: RawText.optional(),
    memoryUpdates: AgentResultSchema.shape.memoryUpdates,
    engineDefects: AgentResultSchema.shape.engineDefects,
  }).superRefine((envelope, context) => {
    if (envelope.outcome === "needs-mediator" && !envelope.mediatorRequest) {
      context.addIssue({ code: "custom", path: ["mediatorRequest"], message: "outcome 이 needs-mediator 이면 mediatorRequest 에 중재자에게 물을 내용을 적어야 합니다." });
    }
  });
}

// 저장·전달용 봉투(모든 역할의 outcome) — 받은 턴의 역할 대조는 turnEnvelopeSchema(role) 가 한다.
export const TurnEnvelopeSchema = envelopeSchema(ALL_TURN_OUTCOMES);
export type TurnEnvelope = z.infer<typeof TurnEnvelopeSchema>;

export function turnEnvelopeSchema(role: EnvelopeRole) {
  return envelopeSchema(TURN_OUTCOMES[role]);
}

// 이 역할의 봉투 계약 위반 목록(없으면 빈 배열) — 파서와 실행기의 같은 세션 교정이 같은 판정을 쓴다.
export function envelopeIssues(role: EnvelopeRole, value: unknown): string[] {
  const parsed = turnEnvelopeSchema(role).safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join(".") || "(전체)"}: ${issue.message}`);
}

// 작업자에게 전할 새 사실(system 이벤트의 payload.workerFact) — 엔진이 기록하는 사실 표식 7종이다. 영향 판단은 받는 세션과 중재자가 한다.
const SourceVersionSchema = z.object({ revision: z.string().nullable(), contentHash: z.string().nullable() });
export const CHECK_STATUSES = ["passed", "failed", "not-run"] as const;
export const WorkerFactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan-version"), version: z.string().min(1), snapshotPath: z.string().min(1), diffPath: z.string().nullable(), previous: z.string().nullable() }),
  z.object({ kind: z.literal("source-change"), sourceId: z.string().min(1), before: SourceVersionSchema.nullable(), after: SourceVersionSchema.nullable(), diffPath: z.string().nullable().optional() }),
  z.object({ kind: z.literal("source-error"), sourceId: z.string().min(1), error: z.string().min(1) }),
  z.object({ kind: z.literal("workflow-mode"), from: z.string().min(1), to: z.string().min(1), resumeState: z.string().nullable(), reason: z.string() }),
  z.object({ kind: z.literal("check-result"), checks: z.array(z.object({ id: z.string().min(1), status: z.enum(CHECK_STATUSES), summary: z.string(), logPath: z.string().nullable().optional() })) }),
  // 작업 묶음 개정(v3.18 (33')) — context 는 개정 시점의 그 단계 문맥 본문 전체다. 무엇이 바뀌었는지 따로 분류하지 않는다.
  z.object({ kind: z.literal("work-group-revision"), groupId: z.string().min(1), stageId: z.string().min(1), version: z.number().int().positive(), context: z.string().min(1) }),
  // 근거 선택 변경(79fc4fc5 F011) — 바뀐 뒤의 근거 목록 버전, 작업 그룹 근거 연결이면 그 그룹 id(해제는 null)만 싣는다. 재계획·세션 지시가 아니다.
  z.object({ kind: z.literal("evidence-selection"), catalogVersion: z.string().min(1), groupId: z.string().min(1).nullable().optional() }),
]);
export type WorkerFact = z.infer<typeof WorkerFactSchema>;

// .trim().min(1) 의 CLI 표현 — 공백이 아닌 문자 하나 이상.
const NON_BLANK = "\\S";

// 봉투의 CLI 출력 스키마. OpenAI 구조화 출력 규칙대로 모든 키를 required 에 두고 선택성은 null 허용으로 표현한다(contracts.ts AgentResultJsonSchema 주석).
export function envelopeOutputSchema(role: EnvelopeRole) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["message", "outcome", "mediatorRequest", "memoryUpdates", "engineDefects"],
    properties: {
      message: { type: "string", minLength: 1, pattern: NON_BLANK },
      outcome: { enum: [...TURN_OUTCOMES[role]] },
      mediatorRequest: { anyOf: [{ type: "string", minLength: 1, pattern: NON_BLANK }, { type: "null" }] },
      memoryUpdates: AgentResultJsonSchema.properties.memoryUpdates,
      engineDefects: AgentResultJsonSchema.properties.engineDefects,
    },
  } as const;
}

// AgentResult 턴의 CLI 출력 스키마. 봉투 턴은 어댑터가 envelopeOutputSchema 를 직접 쓴다.
export function turnOutputSchema(job: TurnJob) {
  const contract = turnContract(job);
  if (!contract.kinds) return AgentResultJsonSchema;
  const schema = structuredClone(AgentResultJsonSchema) as unknown as { properties: Record<string, unknown> };
  schema.properties.kind = { enum: contract.kinds };
  for (const field of contract.forbidden) {
    schema.properties[field] = ["planEdits", "memoryUpdates", "findings"].includes(field)
      ? { anyOf: [{ type: "array", maxItems: 0, items: { type: "string" } }, { type: "null" }] }
      : { type: "null" };
  }
  return schema;
}

export function assertTurnResult(job: TurnJob, result: AgentResult): void {
  const contract = turnContract(job);
  if (contract.kinds && !contract.kinds.includes(result.kind)) throw new Error(`${job.operation}: 허용 결과는 ${contract.kinds.join(", ")}입니다.`);
  const forbidden = contract.forbidden.filter(field => {
    const value = result[field as keyof AgentResult];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
  });
  if (forbidden.length) throw new Error(`${job.operation}: 이 읽기 작업에서 반환할 수 없는 변경 필드: ${forbidden.join(", ")}. 판단·근거는 보존하고 해당 필드만 비워 다시 제출하세요.`);
}
