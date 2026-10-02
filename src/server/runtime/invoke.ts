import type { AgentResult, PlanRepair } from "../../shared/contracts.js";
import type { AgentAdapter, CreatedSession, OutputSchema, SessionTurn } from "../types.js";

type CreateCall = { method: "create"; turn: Omit<SessionTurn, "sessionId"> };
type ResumeCall = { method: "resume"; turn: SessionTurn };
type RepairCall = { method: "plan-repair"; turn: SessionTurn };
// 소비처 schema 의 결과(E2e) — 구조화 메서드가 없는 어댑터는 실행 전에 거부한다.
type CreateStructuredCall = { method: "create-structured"; turn: Omit<SessionTurn, "sessionId">; schema: OutputSchema };
type ResumeStructuredCall = { method: "resume-structured"; turn: SessionTurn; schema: OutputSchema };
type StructuredCreated = { sessionId: string; value: Record<string, unknown> };

// 엔진과 서버 없는 CLI의 공통 호출 경계. 정책·예산·세션 교체·결과 채택은 호출자 책임이다.
// 콜백과 signal을 그대로 넘겨 어댑터 준비/재시도 뒤의 spawn 직전 검사도 유지한다.
export function invokeAdapter(adapter: AgentAdapter, call: CreateCall): Promise<CreatedSession>;
export function invokeAdapter(adapter: AgentAdapter, call: ResumeCall): Promise<AgentResult>;
export function invokeAdapter(adapter: AgentAdapter, call: RepairCall): Promise<PlanRepair>;
export function invokeAdapter(adapter: AgentAdapter, call: CreateStructuredCall): Promise<StructuredCreated>;
export function invokeAdapter(adapter: AgentAdapter, call: ResumeStructuredCall): Promise<Record<string, unknown>>;
export function invokeAdapter(adapter: AgentAdapter, call: CreateCall | ResumeCall | RepairCall | CreateStructuredCall | ResumeStructuredCall):
  Promise<CreatedSession | AgentResult | PlanRepair | StructuredCreated | Record<string, unknown>> {
  call.turn.signal?.throwIfAborted();
  const original = call.turn;
  let sessionId = "sessionId" in original ? original.sessionId : null;
  let latest: import("../../shared/sessionSettings.js").SessionEnvironment | undefined;
  if (original.onExecutionEnvironment) call = { ...call, turn: { ...original,
    onSessionCreated: (id: string, phase?: "allocated" | "confirmed") => {
      // The caller validates paired recovery/identity first. A rejected SID must never rewrite observed ownership.
      original.onSessionCreated?.(id, phase);
      sessionId = id;
      // Allocation belongs to the next spawn, never to a failed execution from an earlier recovery round.
      if (phase === "allocated") latest = undefined;
      if (latest && latest.sessionId !== id) { latest = { ...latest, sessionId: id }; original.onExecutionEnvironment?.(latest); }
    },
    onExecutionEnvironment: (record: import("../../shared/sessionSettings.js").SessionEnvironment, mode?: "create" | "resume") => {
      // A recovered Codex create has no SID until its thread.started is accepted.
      if (mode === "create" && record.provider === "codex") sessionId = null;
      latest = { ...record, sessionId }; original.onExecutionEnvironment?.(latest, mode);
    },
  } } as typeof call;
  switch (call.method) {
    case "create": return adapter.createSession(call.turn);
    case "resume": return adapter.resumeTurn(call.turn);
    case "plan-repair": {
      if (!adapter.resumePlanRepair) throw new Error("이 어댑터는 계획 교정을 지원하지 않습니다.");
      if (call.turn.job?.operation !== "plan-repair") throw new Error("계획 교정은 plan-repair 작업으로만 엽니다.");
      return adapter.resumePlanRepair(call.turn);
    }
    case "create-structured": {
      if (!adapter.createStructuredSession) throw new Error("이 어댑터는 소비처 schema 결과를 지원하지 않습니다.");
      return adapter.createStructuredSession(call.turn, call.schema);
    }
    case "resume-structured": {
      if (!adapter.resumeStructuredTurn) throw new Error("이 어댑터는 소비처 schema 결과를 지원하지 않습니다.");
      return adapter.resumeStructuredTurn(call.turn, call.schema);
    }
  }
}
