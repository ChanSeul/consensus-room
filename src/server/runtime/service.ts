import type { AgentProvider } from "../../shared/roles.js";
import { turnFlags } from "../../shared/roles.js";
import type { AgentAdapter, SessionTurn } from "../types.js";
import { invokeAdapter } from "./invoke.js";
import { guardRunnerControl } from "../adapters/turnPolicy.js";
import type { RuntimeCheckRequest, RuntimeEventPayload, RuntimeRequest } from "./protocol.js";

// DB·웹 서버·예산 원장 없이 한 턴만 실행한다. 사용량은 합산/차감하지 않고 원 관측을 전달한다.
export async function executeRuntimeRequest(request: RuntimeRequest, adapter: AgentAdapter,
  emit: (event: RuntimeEventPayload) => void, signal?: AbortSignal): Promise<void> {
  if (adapter.role !== request.provider) throw new Error("요청 공급자와 실행 어댑터가 다릅니다.");
  // 엔진은 buildApp에서 이 보호를 적용한다. 독립 CLI도 같은 경계를 한 번 거친다.
  const guarded = guardRunnerControl(adapter);
  let sessionId = request.session.mode === "resume" ? request.session.sessionId : "";
  let reportedSession = "";
  const recordSession = (id: string) => {
    sessionId = id;
    if (id !== reportedSession) { emit({ type: "session", sessionId: id }); reportedSession = id; }
  };
  const flags = turnFlags(request.job);
  const turn: Omit<SessionTurn, "sessionId"> = {
    job: request.job, prompt: request.prompt, freshSessionPrompt: request.freshSessionPrompt, cwd: request.cwd,
    implementation: flags.implementation, protocolOnly: flags.protocolOnly,
    planMode: request.planMode, evidenceManaged: request.evidenceManaged, readablePaths: request.readablePaths,
    isolated: request.isolated, snapshotWorkspace: request.workspace === "snapshot", sessionHome: request.sessionHome,
    writablePaths: request.writablePaths,
    settings: request.settings, providerOptions: request.providerOptions, signal,
    consumer: "runtime-cli",
    onExecutionEnvironment: environment => emit({ type: "environment", environment }),
    onSessionCreated: recordSession, onUsage: usage => emit({ type: "usage", usage }),
    // 실제 공급자 spawn 과 원시 사용량(E2e-2) — 호출자(운영 도구)가 차감·사용량 원장을 이 관측으로 쓴다.
    onProcessSpawn: spawned => emit({ type: "spawn", pid: spawned.pid, at: Date.now() }),
    onProviderUsage: usage => emit({ type: "provider-usage", usage }),
  };
  let result;
  if (request.resultKind === "json") {
    // 소비처 schema 결과 — 스키마 의미 검증은 소비처가 한다(E2e.md 규칙 4).
    const schema = request.outputSchema!;
    if (request.session.mode === "create") {
      const created = await invokeAdapter(guarded, { method: "create-structured", turn, schema });
      recordSession(created.sessionId);
      result = created.value;
    } else {
      result = await invokeAdapter(guarded, { method: "resume-structured", turn: { ...turn, sessionId }, schema });
    }
  } else if (request.session.mode === "create") {
    const created = await invokeAdapter(guarded, { method: "create", turn });
    recordSession(created.sessionId);
    result = created.result;
  } else if (request.resultKind === "plan-repair") {
    result = await invokeAdapter(guarded, { method: "plan-repair", turn: { ...turn, sessionId } });
  } else {
    result = await invokeAdapter(guarded, { method: "resume", turn: { ...turn, sessionId } });
  }
  signal?.throwIfAborted();
  recordSession(sessionId);
  emit({ type: "result", sessionId, result });
}

// 세션 확인(E2e-2) — 모델을 부르지 않는다. 지원하지 않는 어댑터면 확인하지 않고 거부한다.
export async function executeRuntimeCheck(request: RuntimeCheckRequest, adapter: AgentAdapter,
  emit: (event: RuntimeEventPayload) => void): Promise<void> {
  if (adapter.role !== request.provider) throw new Error("요청 공급자와 실행 어댑터가 다릅니다.");
  if (!adapter.inspectSession) throw new Error("이 어댑터는 세션 확인을 지원하지 않습니다.");
  const status = await adapter.inspectSession(request.sessionHome, request.cwd, request.check.sessionId);
  emit({ type: "session-status", sessionId: request.check.sessionId, ...status });
}

export type RuntimeAdapterFactory = (provider: AgentProvider) => AgentAdapter;
