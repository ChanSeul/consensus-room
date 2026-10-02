import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/server/app";
import { ConsensusDatabase } from "../src/server/database";
import { readMediationAutonomy } from "../src/server/mediationAutonomy";
import type { AgentAdapter, CommandRunner } from "../src/server/types";

const temporaryDirectories: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function makeApp() {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-autonomy-"));
  temporaryDirectories.push(root);
  const runner: CommandRunner = {
    run: async () => { throw new Error("이 테스트에서는 명령을 실행하지 않습니다."); },
  };
  const adapter = (role: "claude" | "codex"): AgentAdapter => ({
    role,
    createSession: async () => { throw new Error("이 테스트에서는 CLI를 실행하지 않습니다."); },
    resumeTurn: async () => { throw new Error("이 테스트에서는 CLI를 실행하지 않습니다."); },
    validateExistingSession: async () => false,
  });
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  const app = await buildApp({
    config: {
      host: "127.0.0.1" as const,
      port: 0,
      launchToken: "launch-token-for-test",
      dataDirectory: root,
      topicsDirectory: join(root, "topics"),
      worktreesDirectory: join(root, "worktrees"),
      databasePath: join(root, "room.sqlite"),
      webDirectory: join(root, "missing-web"),
      repositoryPath: root,
      memoryDirectory: join(root, "memory"),
      claudeSkillDirectories: [],
      codexSkillDirectories: [],
      defaultAgentSettings: {
        claude: { model: "opus", effort: "xhigh" as const },
        codex: { model: "gpt-6-astra", effort: "xhigh" as const },
      },
      figmaMcpUrl: null,
      codexConcurrency: 2,
    },
    database,
    runner,
    claude: adapter("claude"),
    codex: adapter("codex"),
  });
  apps.push(app);
  return { app, root, database };
}

const auth = { "x-consensus-token": "launch-token-for-test" };

describe("항상 ON인 자율중재 정책", () => {
  it.each([undefined, '{"autonomy":"off","history":[]}', '{"autonomy":"on"}', 'invalid legacy JSON'])(
    "기존 파일 %s와 무관하게 상태와 중재 진입점이 ON이며 파일을 변경하지 않는다", async (legacy) => {
      const { app, root } = await makeApp();
      const path = join(root, "mediation-autonomy.json");
      if (legacy !== undefined) writeFileSync(path, legacy);
      const response = await app.inject({ method: "GET", url: "/api/mediation-autonomy", headers: auth });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ autonomy: "on", unset: false, set_by: "policy" });
      const context = await app.inject({ method: "GET", url: "/api/mediation/context", headers: auth });
      expect(context.json().autonomy).toEqual(response.json());
      expect(readMediationAutonomy()).toEqual(response.json());
      if (legacy !== undefined) expect(readFileSync(path, "utf8")).toBe(legacy);
      else expect(existsSync(path)).toBe(false);
    });

  it("OFF와 잘못된 요청은 거부하고 인증과 멱등 키를 계속 요구한다", async () => {
    const { app, root } = await makeApp();
    for (const autonomy of ["off", "maybe", null]) {
      const result = await app.inject({ method: "POST", url: "/api/mediation-autonomy",
        headers: { ...auth, "idempotency-key": `k-${autonomy}` }, payload: { autonomy } });
      expect(result.statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/api/mediation-autonomy", headers: auth, payload: { autonomy: "on" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/mediation-autonomy" })).statusCode).toBe(401);
    expect(existsSync(join(root, "mediation-autonomy.json"))).toBe(false);
  });

  it("기존 on 요청과 재시도는 ON을 반환하며 이전 토글 응답은 재생하지 않는다", async () => {
    const { app, database } = await makeApp();
    database.claimGlobalRequest("mediation-autonomy:set", "k-same", { autonomy: "on" });
    database.finishGlobalRequest("mediation-autonomy:set", "k-same", { autonomy: "on", set_by: "web", note: "old toggle" });
    const request = { method: "POST" as const, url: "/api/mediation-autonomy",
      headers: { ...auth, "idempotency-key": "k-same" }, payload: { autonomy: "on" } };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ autonomy: "on", set_by: "policy" });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });
});
