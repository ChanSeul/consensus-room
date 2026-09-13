import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { WorkGroups } from "../src/server/workGroups";
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
