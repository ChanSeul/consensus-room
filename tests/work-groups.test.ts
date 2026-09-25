import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { WorkGroups } from "../src/server/workGroups";
import { wrapWorkGroupAdapter } from "../src/server/workGroupAdapter";
import type { ConsensusDatabase } from "../src/server/database";
import type { GitService } from "../src/server/git";
import type { AgentAdapter, SessionTurn } from "../src/server/types";
const budget = {
  execution: { inputTokens: 10, outputTokens: 10, durationMs: 100 },
  total: { inputTokens: 100, outputTokens: 100, durationMs: 1000 },
};
const stage = (id: string) => ({
  kind: "integration" as const,
  id,
  title: id,
  goal: "현재 목표",
  acceptance: "검증 통과",
  dependsOn: [],
  budget,
});
it("단계 ID·의존관계·순서와 재시작 후 연결을 보존한다", () => {
  const db = new DatabaseSync(":memory:"),
    groups = new WorkGroups(db);
  const input = {
    title: "작업",
    goal: "전체 목표",
    contracts: "계약",
    stages: [stage("a"), stage("b")],
  };
  expect(() =>
    groups.create(
      "bad",
      { ...input, stages: [stage("a"), stage("a")] },
      "/repo",
      "head",
    ),
  ).toThrow();
  const g = groups.create("g", input, "/repo", "head");
  expect(groups.groupPolicy(g).total.inputTokens).toBe(200);
  expect(() => groups.link("g", "b", "t", "head")).toThrow();
  groups.link("g", "a", "t", "head");
  expect(new WorkGroups(db).forTopic("t")?.id).toBe("g");
  const prompt = groups.prompt("t", []);
  expect(prompt).toContain("현재 단계: a");
  expect(prompt).not.toContain("현재 단계: b");
  expect(() =>
    groups.revise(
      "g",
      { ...input, stages: [stage("a"), stage("b"), stage("c")] },
      1,
    ),
  ).toThrow();
  db.close();
});

it("생성과 개정의 서술 필드는 비밀값을 저장하지 않고 예약된 ID를 거부한다", () => {
  const db = new DatabaseSync(":memory:"),
    groups = new WorkGroups(db),
    secret = "sk-proj-1234567890abcdef";
  const input = {
    title: secret,
    goal: secret,
    contracts: secret,
    stages: [stage("a"), { ...stage("b"), goal: secret }],
  };
  const group = groups.create("safe", input, "/repo", "head");
  expect(JSON.stringify(group)).not.toContain(secret);
  expect(
    JSON.stringify(
      groups.revise("safe", { ...input, contracts: `new ${secret}` }, 1),
    ),
  ).not.toContain(secret);
  expect(() =>
    groups.create(
      "bad",
      { ...input, stages: [stage("constructor"), stage("b")] },
      "/repo",
      "head",
    ),
  ).toThrow();
  db.close();
});

// host-review 전 사전 검증 261622a-09250218(계열) — 과제 프롬프트를 바꾸는 래퍼는 새·교체 세션용 전체 문맥 판(freshSessionPrompt)에도 같은 변환을 적용한다.
// 계획 제어가 감사 세션을 교체하면 새 세션은 freshSessionPrompt 를 과제로 받는다 — 묶음 공통 계약·통합 지시가 빠지면 안 된다.
it("작업 묶음 문맥은 이어 쓰는 판과 새 세션용 전체 문맥 판에 똑같이 붙고, 전체 문맥 판이 없으면 만들지 않는다", async () => {
  const db = new DatabaseSync(":memory:"),
    groups = new WorkGroups(db);
  groups.create("g", { title: "작업", goal: "전체 목표", contracts: "공통계약-표식", stages: [stage("a"), stage("b")] }, "/repo", "head");
  groups.link("g", "a", "t", "head");
  const database = { listTopics: () => [{ id: "t", worktreePath: "/w" }], workGroups: groups } as unknown as ConsensusDatabase;
  const seen: Array<Omit<SessionTurn, "sessionId">> = [];
  const inner: AgentAdapter = {
    role: "codex", validateExistingSession: async () => true,
    createSession: async (turn) => { seen.push(turn); return { sessionId: "s", result: { kind: "AUDIT", summary: "", findings: [], evidenceRefs: [] } }; },
    resumeTurn: async (turn) => { seen.push(turn); return { kind: "AUDIT", summary: "", findings: [], evidenceRefs: [] }; },
  };
  const wrapped = wrapWorkGroupAdapter(inner, database, {} as GitService);
  await wrapped.resumeTurn({ sessionId: "s1", cwd: "/w", prompt: "변경분-과제", freshSessionPrompt: "전체문맥-과제" });
  await wrapped.createSession({ cwd: "/w", prompt: "새-과제" });
  const [resumed, created] = seen;
  expect(resumed.prompt).toContain("공통계약-표식");
  expect(resumed.freshSessionPrompt).toContain("공통계약-표식");
  expect(resumed.freshSessionPrompt).toContain("전체 통합 검증 단계");
  expect(resumed.freshSessionPrompt!.endsWith("전체문맥-과제")).toBe(true);
  expect(resumed.prompt.replace("변경분-과제", "")).toBe(resumed.freshSessionPrompt!.replace("전체문맥-과제", ""));
  expect(created.prompt).toContain("공통계약-표식");
  expect("freshSessionPrompt" in created).toBe(false);
  db.close();
});
