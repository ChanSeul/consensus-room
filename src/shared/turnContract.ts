import { AgentResultJsonSchema, type AgentResult } from "./contracts.js";
import type { TurnJob } from "./roles.js";

// One operation contract drives generation, injected instructions and acceptance.
// Reading memory does not confer permission to propose updates to that memory.
export function turnContract(job: TurnJob) {
  const assessment = job.operation === "evidence-assessment";
  const discussion = job.operation === "brainstorm";
  return {
    memoryUpdates: !assessment && !discussion,
    kinds: assessment ? ["EVIDENCE_NO_IMPACT", "EVIDENCE_REPLAN", "EVIDENCE_NEEDS_DECISION"]
      : discussion ? ["BRAINSTORM"] : null,
    forbidden: assessment || discussion
      ? ["planMarkdown", "planEdits", "planLineEdits", "planSHA256", "memoryUpdates", "toleranceLedger", ...(discussion ? ["findings"] : [])] : [],
    interactivePlan: !assessment && !discussion,
  };
}

export function turnOutputSchema(job: TurnJob) {
  const contract = turnContract(job);
  if (!contract.kinds) return AgentResultJsonSchema;
  const schema = structuredClone(AgentResultJsonSchema) as unknown as { properties: Record<string, unknown> };
  schema.properties.kind = { enum: contract.kinds };
  for (const field of contract.forbidden) {
    schema.properties[field] = ["planEdits", "memoryUpdates", "toleranceLedger", "findings"].includes(field)
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
