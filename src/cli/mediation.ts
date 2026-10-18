import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { RoomConfig } from "./config.js";
import { roomEnvironment } from "./config.js";
import { readLaunchConnection } from "./lifecycle.js";
import { type RoomAPI, type MediatorBinding, readBinding } from "./client.js";
import { AgentProfileInputSchema, type AgentProfileInput, type RoleAssignment } from "../shared/roles.js";

export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const part = (value: string) => encodeURIComponent(value);
function profile(input: Omit<AgentProfileInput, "id">, label: string): AgentProfileInput {
  const id = `cr-${label}-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16)}`;
  return AgentProfileInputSchema.parse({ id, ...input });
}
async function assign(api: RoomAPI, input: Omit<RoleAssignment, "version" | "assignedAt">,
  replace: boolean): Promise<RoleAssignment> {
  const rows = await api.request<RoleAssignment[]>("GET", `/api/role-assignments?scope=${part(input.scope)}&role=${input.role}`);
  const current = rows.find(row => row.operation === input.operation);
  if (current && current.participant === input.participant && current.profileId === input.profileId && current.sessionId === input.sessionId) return current;
  if (current && !replace) throw new Error(`${input.scope}의 ${input.role} 배정이 이미 있습니다. 기존 배정을 확인한 뒤 변경하려면 --replace를 명시하세요.`);
  return api.request<RoleAssignment>("POST", "/api/role-assignments", { ...input, expectedVersion: current?.version ?? 0 });
}

export async function configureWorkers(api: RoomAPI, config: RoomConfig, replace = false): Promise<RoleAssignment[]> {
  const claude = config.agents.claude;
  const desired = [
    { role: "planner" as const, participant: "claude", profile: profile({ provider: "claude", model: claude.model, effort: claude.effort,
      options: { advisorModel: claude.advisorModel, ultracode: claude.ultracode } }, "planner") },
    { role: "implementer" as const, participant: "claude", profile: profile({ provider: "claude", ...claude.implementation,
      options: { ultracode: claude.ultracode } }, "implementer") },
    { role: "reviewer" as const, participant: "codex", profile: profile({ provider: "codex", ...config.agents.codex, options: {} }, "reviewer") },
  ];
  // Reject a conflicting setup before mutating any assignment. API version checks still
  // handle a concurrent change; an interrupted setup can safely be repeated.
  const current = await api.request<RoleAssignment[]>("GET", "/api/role-assignments?scope=global");
  for (const item of desired) {
    const existing = current.find(row => row.role === item.role && row.operation === "");
    if (existing && !replace && (existing.participant !== item.participant || existing.profileId !== item.profile.id || existing.sessionId !== null)) {
      throw new Error(`${item.role}의 기존 배정을 보존했습니다. 설정을 적용하려면 --replace를 명시하세요.`);
    }
  }
  const result: RoleAssignment[] = [];
  for (const item of desired) {
    await api.request("POST", "/api/agent-profiles", item.profile);
    result.push(await assign(api, { scope: "global", role: item.role, operation: "", participant: item.participant,
      profileId: item.profile.id, sessionId: null, note: "공개 CLI의 로컬 설정" }, replace));
  }
  return result;
}

export interface ConnectInput {
  provider: "claude" | "codex"; participant: string; sessionId: string; model: string; effort: string;
  topicId?: string; replace?: boolean;
}
export async function connectMediator(api: RoomAPI, config: RoomConfig, input: ConnectInput): Promise<MediatorBinding> {
  if (!input.sessionId.trim()) throw new Error("이미 열린 중재 대화의 실제 session ID가 필요합니다.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(input.participant)) throw new Error("participant는 영문·숫자로 시작하는 120자 이내 식별자여야 합니다.");
  const selected = profile({ provider: input.provider, model: input.model, effort: input.effort, options: {} }, "mediator");
  await api.request("POST", "/api/agent-profiles", selected);
  const assignment = await assign(api, { scope: input.topicId ? `topic:${input.topicId}` : "global", role: "mediator", operation: "",
    participant: input.participant, profileId: selected.id, sessionId: input.sessionId, note: "사용자가 지정한 실제 중재 세션" }, input.replace ?? false);
  const binding: MediatorBinding = { provider: input.provider, participant: assignment.participant, sessionId: input.sessionId,
    profileId: selected.id, scope: assignment.scope, version: assignment.version };
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(config.dataDirectory, "mediator.json"), temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(binding, null, 2), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  return binding;
}

export async function prepareParticipants(api: RoomAPI, topicId: string): Promise<void> {
  const detail = await api.request<{ topic: { participants: Array<{ role: string }> } }>("GET", `/api/topics/${part(topicId)}`);
  for (const role of ["claude", "codex"]) {
    if (!detail.topic.participants.some(item => item.role === role)) {
      await api.request("POST", `/api/topics/${part(topicId)}/participants/${role}`, { mode: "new" }, { actor: "mediator" });
    }
  }
}
export async function createTopic(api: RoomAPI, input: { title: string; goal?: string; mode: "ticket" | "planned";
  parentTopicId?: string; group?: boolean; requestId?: string }): Promise<{ id: string; workflowMode: string; nextCommand: string }> {
  const topic = await api.request<{ id: string; workflowMode: string }>("POST", "/api/topics", {
    title: input.title, workflowMode: input.mode, topicKind: input.group ? "group" : "task",
    ...(input.parentTopicId ? { parentTopicId: input.parentTopicId } : {}), entry: { mode: "goal", goal: input.goal ?? input.title },
  }, { actor: "mediator", requestId: input.requestId });
  if (!input.group && input.mode === "planned") {
    try { await prepareParticipants(api, topic.id); }
    catch (error) { throw new Error(`토픽 ${topic.id}는 생성됐습니다. 참여자 준비를 완료하지 못했습니다. participants --topic ${topic.id}로 이어가세요. ${error instanceof Error ? error.message : ""}`); }
  }
  return { id: topic.id, workflowMode: topic.workflowMode, nextCommand: input.group ? `api GET /api/topics/${topic.id}/resume`
    : `api POST /api/topics/${topic.id}/actions/${input.mode === "planned" ? "plan" : "implement"} --body '{}'` };
}

export async function verifyMediator(api: RoomAPI, config: RoomConfig, topicId: string): Promise<MediatorBinding> {
  const saved = readBinding(config);
  const context = await api.request<{ assignment: RoleAssignment | null; profile: { provider: string } | null }>("GET", `/api/mediation/context?topic=${part(topicId)}`);
  const current = context.assignment;
  if (!current || current.participant !== saved.participant || current.version !== saved.version || current.sessionId !== saved.sessionId
    || current.profileId !== saved.profileId || context.profile?.provider !== saved.provider) {
    throw new Error("중재자 배정이 저장된 연결과 다릅니다. 다른 세션으로 자동 변경하지 않습니다. 현재 배정을 확인하고 connect로 다시 연결하세요.");
  }
  return saved;
}

export async function runBridge(api: RoomAPI, config: RoomConfig, topicId: string): Promise<void> {
  const binding = await verifyMediator(api, config, topicId);
  const connection = readLaunchConnection(config);
  const env = { ...roomEnvironment(config), CONSENSUS_ROOM_URL: connection.baseURL, CONSENSUS_ROOM_TOKEN: connection.token,
    CONSENSUS_ROOM_TOPIC_ID: topicId, CONSENSUS_MEDIATOR: `${binding.participant}@${binding.version}`,
    CONSENSUS_MEDIATOR_SESSION_ID: binding.sessionId };
  const child = spawn(process.execPath, ["--import", "tsx", join(sourceRoot, "src/server/mediation/interruptBridge.ts"), binding.provider],
    { cwd: sourceRoot, env, stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => { if (child.exitCode === null) child.kill(signal); };
  const onTerm = () => forward("SIGTERM"), onInt = () => forward("SIGINT");
  process.once("SIGTERM", onTerm); process.once("SIGINT", onInt);
  try {
    await new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 || signal === "SIGTERM" || signal === "SIGINT"
        ? resolvePromise() : reject(new Error(`중재 연결 프로세스가 종료됐습니다(code=${code}, signal=${signal}).`)));
    });
  } finally { process.removeListener("SIGTERM", onTerm); process.removeListener("SIGINT", onInt); }
}

export function claudeMcpConfig(configFile: string, topicId: string): Record<string, unknown> {
  return { mcpServers: { "consensus-room": { command: process.execPath,
    args: ["--import", fileURLToPath(import.meta.resolve("tsx")), join(sourceRoot, "src/cli/room.ts"), "bridge", "--config", resolve(configFile), "--topic", topicId] } } };
}
