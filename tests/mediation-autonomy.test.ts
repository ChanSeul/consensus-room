import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/server/app";
import { ConsensusDatabase } from "../src/server/database";
import { mediationAutonomyPath, readMediationAutonomy } from "../src/server/mediationAutonomy";
import type { AgentAdapter, CommandRunner } from "../src/server/types";

const temporaryDirectories: string[] = [];

afterEach(() => {
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
  return { app, root };
}

const auth = { "x-consensus-token": "launch-token-for-test" };

describe("자율 중재 위임 스위치 API", () => {
  it("파일이 없으면 off(unset)로 읽힌다", async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/mediation-autonomy", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ autonomy: "off", unset: true, history: [] });
  });

  it("on → off 로 바꾸면 이전 값이 history 에 남고 파일은 셸 스크립트와 같은 필드를 가진다", async () => {
    const { app, root } = await makeApp();
    const on = await app.inject({
      method: "POST", url: "/api/mediation-autonomy", headers: { ...auth, "idempotency-key": "k-on" },
      payload: { autonomy: "on", note: "웹 토글" },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ autonomy: "on", set_by: "web", note: "웹 토글", unset: false, history: [] });

    const off = await app.inject({
      method: "POST", url: "/api/mediation-autonomy", headers: { ...auth, "idempotency-key": "k-off" },
      payload: { autonomy: "off" },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().autonomy).toBe("off");
    expect(off.json().history).toHaveLength(1);
    expect(off.json().history[0]).toMatchObject({ autonomy: "on", set_by: "web", note: "웹 토글" });

    const document = JSON.parse(readFileSync(mediationAutonomyPath(root), "utf8"));
    expect(Object.keys(document).sort()).toEqual(["autonomy", "history", "note", "set_at", "set_by"]);
    expect(document.autonomy).toBe("off");

    const read = await app.inject({ method: "GET", url: "/api/mediation-autonomy", headers: auth });
    expect(read.json()).toMatchObject({ autonomy: "off", unset: false });
  });

  it("셸 스크립트가 쓴 파일(note 빈 문자열·history 포함)을 그대로 읽는다", async () => {
    const { app, root } = await makeApp();
    writeFileSync(mediationAutonomyPath(root), JSON.stringify({
      autonomy: "on", set_at: "2026-09-08T01:41:01Z", set_by: "example-user", note: "",
      history: [{ autonomy: "off", set_at: "2026-09-08T01:00:00Z", set_by: "example-user", note: "test" }],
    }));
    const response = await app.inject({ method: "GET", url: "/api/mediation-autonomy", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ autonomy: "on", set_by: "example-user", note: "", unset: false });
    expect(response.json().history).toHaveLength(1);
    expect(readMediationAutonomy(root).autonomy).toBe("on");
  });

  it("잘못된 값은 400, Idempotency-Key 가 없으면 400, 인증 없으면 401", async () => {
    const { app } = await makeApp();
    const bad = await app.inject({
      method: "POST", url: "/api/mediation-autonomy", headers: { ...auth, "idempotency-key": "k-bad" },
      payload: { autonomy: "maybe" },
    });
    expect(bad.statusCode).toBe(400);
    const noKey = await app.inject({ method: "POST", url: "/api/mediation-autonomy", headers: auth, payload: { autonomy: "on" } });
    expect(noKey.statusCode).toBe(400);
    const noAuth = await app.inject({ method: "GET", url: "/api/mediation-autonomy" });
    expect(noAuth.statusCode).toBe(401);
  });

  it("같은 Idempotency-Key 재요청은 저장된 응답을 재생하고 history 를 늘리지 않는다", async () => {
    const { app } = await makeApp();
    const headers = { ...auth, "idempotency-key": "k-same" };
    const first = await app.inject({ method: "POST", url: "/api/mediation-autonomy", headers, payload: { autonomy: "on" } });
    const second = await app.inject({ method: "POST", url: "/api/mediation-autonomy", headers, payload: { autonomy: "on" } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const read = await app.inject({ method: "GET", url: "/api/mediation-autonomy", headers: auth });
    expect(read.json().history).toHaveLength(0);
  });
});

describe("스위치 파일 쓰기의 임시 파일", () => {
  it("호출마다 고유한 임시 이름을 쓰고 끝나면 남기지 않는다(Codex 지적 3)", async () => {
    const { app, root } = await makeApp();
    for (const value of ["on", "off", "on"]) {
      const response = await app.inject({
        method: "POST", url: "/api/mediation-autonomy", headers: { ...auth, "idempotency-key": `k-${value}-${Math.random()}` },
        payload: { autonomy: value },
      });
      expect(response.statusCode).toBe(200);
    }
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual([]);
    expect(readMediationAutonomy(root)).toMatchObject({ autonomy: "on" });
    expect(readMediationAutonomy(root).history).toHaveLength(2);
  });
});
