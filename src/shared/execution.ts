import type { AgentExecutionSettings, WorkflowState } from "./contracts";

// 구현 전용 모델·ultracode 로 도는 턴의 상태. delivery 의 implementation=true 호출부와 짝이다
// (runImplementation=IMPLEMENTING, runFix=CLAUDE_FIX). Codex 턴은 전부 implementation=false 다.
export const IMPLEMENTATION_TURN_STATES: ReadonlySet<WorkflowState> = new Set(["IMPLEMENTING", "CLAUDE_FIX"]);

export function runsImplementationTurn(role: "claude" | "codex", state: WorkflowState): boolean {
  return role === "claude" && IMPLEMENTATION_TURN_STATES.has(state);
}

// 한 단계에 실제로 적용되는 실행 설정. 구현 전용 오버라이드가 있으면 구현 턴에서만 그것을 쓴다.
// 서버(EngineCore.executionSettings)와 화면이 같은 함수를 쓴다 — 규칙이 갈라지면 화면이 실제와 다른
// 모델을 보여 준다(2026-09-07: 구현 중에도 계획용 fable 이 노출됐다).
export function appliedExecutionSettings(
  settings: AgentExecutionSettings,
  implementation: boolean,
): AgentExecutionSettings {
  return implementation && settings.implementation
    ? { model: settings.implementation.model, effort: settings.implementation.effort }
    : { model: settings.model, effort: settings.effort };
}
