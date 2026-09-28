import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { decisionDigest, WorkGroups } from "../src/server/workGroups";
import type { StageResult, WorkGroup, WorkGroupInput } from "../src/shared/workGroups";
import { wrapWorkGroupAdapter } from "../src/server/workGroupAdapter";
import type { ConsensusDatabase } from "../src/server/database";
import type { GitService } from "../src/server/git";
import type { AgentAdapter, SessionTurn } from "../src/server/types";
const budget = {
  execution: { inputTokens: 10, outputTokens: 10, durationMs: 100 },
  total: { inputTokens: 100, outputTokens: 100, durationMs: 1000 },
};
// 통합 단계는 마지막 하나뿐이다(host-review F011) — 기본은 작업 단계, 마지막 단계만 integration 으로 만든다.
const stage = (id: string, kind: "work" | "integration" = "work") => ({
  kind,
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
    stages: [stage("a"), stage("b", "integration")],
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
  expect(groups.groupPolicy(g)).toMatchObject({ total: { inputTokens: 200 } });
  expect(() => groups.link("g", "b", "t", "head")).toThrow();
  groups.link("g", "a", "t", "head");
  expect(new WorkGroups(db).forTopic("t")?.id).toBe("g");
  const prompt = groups.prompt("t", []);
  expect(prompt).toContain("현재 단계: a");
  expect(prompt).not.toContain("현재 단계: b");
  expect(() =>
    groups.revise(
      "g",
      { ...input, stages: [stage("a"), stage("c"), stage("b", "integration")] },
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
    stages: [stage("a"), { ...stage("b", "integration"), goal: secret }],
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
      { ...input, stages: [stage("constructor"), stage("b", "integration")] },
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
  groups.create("g", { title: "작업", goal: "전체 목표", contracts: "공통계약-표식", stages: [stage("a"), stage("b", "integration")] }, "/repo", "head");
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
  // 통합 지시는 통합 단계 문맥의 일부다(저장소 검사가 본다). 여기서는 연결된 작업 단계 a 의 문맥이 두 판에 똑같이 붙는지 본다.
  expect(resumed.freshSessionPrompt).toContain("현재 단계: a");
  expect(resumed.freshSessionPrompt!.endsWith("전체문맥-과제")).toBe(true);
  expect(resumed.prompt.replace("변경분-과제", "")).toBe(resumed.freshSessionPrompt!.replace("전체문맥-과제", ""));
  expect(created.prompt).toContain("공통계약-표식");
  expect("freshSessionPrompt" in created).toBe(false);
  db.close();
});

// ---- 엔진 개편 E4 — 저장소 단위: 대략 단계·묶음 예산, 연결 옵션, 단계 문맥·해시·결속, 과거 레코드, 결과 동결 ----
type StageInput = WorkGroupInput["stages"][number];
const work = (id: string, patch: Partial<StageInput> = {}): StageInput => ({
  id, kind: "work", title: `${id} 제목`, goal: `${id} 목표`, acceptance: `${id} 완료 조건`, dependsOn: [], budget, ...patch,
});
const integrationStage = (id: string, dependsOn: string[]): StageInput => ({ ...work(id, { dependsOn }), kind: "integration" });
// s1 → (s2, s3) → int.
const groupInput = (patch: Partial<WorkGroupInput> = {}): WorkGroupInput => ({
  title: "묶음", goal: "전체 목표", contracts: "공통 계약",
  stages: [work("s1"), work("s2", { dependsOn: ["s1"] }), work("s3", { dependsOn: ["s1"] }), integrationStage("int", ["s2", "s3"])],
  ...patch,
});
const frozen = (stageId: string, topicId: string, patch: Partial<StageResult> = {}): StageResult => ({
  stageId, topicId, baseOID: "base", commitOID: `${stageId}-commit-oid`, reviewedTreeOID: `${stageId}-tree-oid`, planSHA256: `${stageId}-plan-sha`,
  evidenceDigest: null, verifications: [{ id: `${stageId}-verification`, status: "passed" }],
  memoryChanges: [{ path: `${stageId}-wiki.md`, sha256: `${stageId}-wiki-sha` }],
  openQuestions: [`${stageId} 미해결 사항`],
  deferredFindings: [{ id: `${stageId}-F1`, title: `${stageId} 보류 지적`, severity: "MEDIUM", rationale: `${stageId} 보류 사유`, source: "review",
    topicId, recordedAt: "2026-09-26T00:00:00.000Z" }],
  decisions: [{ topicId, sequence: 7, scopeGeneration: 1, sha256: `${stageId}-decision-sha`, body: `${stageId} 결정 원문` }],
  closedAt: "2026-09-27T00:00:00.000Z", ...patch,
});
const merge = (targets: Array<[string, string]>, conflicts: string[] = []) => ({
  tree: "merged-tree-oid", conflicts, targets: targets.map(([stageId, commitOID]) => ({ stageId, commitOID })),
});
function openStore() {
  const db = new DatabaseSync(":memory:");
  return { db, groups: new WorkGroups(db) };
}
// 단계 문맥 객체의 모든 문자열 값 — 머리말이 전부 담아야 해시와 실제 전달 내용이 같다.
const stringLeaves = (value: unknown): string[] => typeof value === "string" ? [value]
  : Array.isArray(value) ? value.flatMap(stringLeaves)
  : value && typeof value === "object" ? Object.values(value).flatMap(stringLeaves) : [];

it("E4-1 대략 단계로 만들고 새 필드를 초기화하며, 묶음 예산은 budgetPolicy 우선·없으면 예산을 선언한 단계로만 정한다", () => {
  const { db, groups } = openStore();
  const rough = groupInput({ stages: [work("s1"), work("s2", { dependsOn: ["s1"], acceptance: undefined, budget: undefined }),
    work("s3", { dependsOn: ["s1"], budget: { execution: { inputTokens: 30, outputTokens: 5, durationMs: 50 },
      total: { inputTokens: 300, outputTokens: 50, durationMs: 500 } } }), integrationStage("int", ["s2", "s3"])] });
  const group = groups.create("g", rough, "/repo", "base");
  expect(group).toMatchObject({ version: 1, links: {}, revisions: [], retiredStageIds: [], results: {} });
  expect(group.stages[1]).not.toHaveProperty("acceptance");
  // 예산을 선언한 s1·s3·int 만: total 합, execution 최대.
  expect(groups.groupPolicy(group)).toEqual({
    execution: { inputTokens: 30, outputTokens: 10, durationMs: 100 },
    total: { inputTokens: 500, outputTokens: 250, durationMs: 2500 },
  });
  const policy = { execution: { inputTokens: 1, outputTokens: 2, durationMs: 3 }, total: { inputTokens: 4, outputTokens: 5, durationMs: 6 } };
  expect(groups.groupPolicy(groups.create("p", { ...rough, budgetPolicy: policy }, "/repo", "base"))).toEqual(policy);
  const none = { ...rough, stages: rough.stages.map((stage) => ({ ...stage, budget: undefined })) };
  expect(groups.groupPolicy(groups.create("n", none, "/repo", "base"))).toEqual({ mode: "observe" });
  expect(groups.groupPolicy(none)).toEqual({ mode: "observe" });
  db.close();
});

it("E4-1 새 서술 필드(결과·분리 근거·체크리스트·질문)도 생성과 개정에서 비밀값을 가린다", () => {
  const { db, groups } = openStore();
  const secret = "sk-proj-1234567890abcdef";
  const stages = [work("s1"), work("s2", { dependsOn: ["s1"], outcome: `결과 ${secret}`,
    separation: { basis: "rollback", detail: `근거 ${secret}` }, checklist: [`항목 ${secret}`] }), integrationStage("int", ["s2"])];
  const questions = [{ id: "q1", stageId: "s2", text: `질문 ${secret}`, blocksStart: false, resolution: `해소 ${secret}` }];
  expect(JSON.stringify(groups.create("g", groupInput({ stages, questions }), "/repo", "base"))).not.toContain(secret);
  const added = [...stages.slice(0, 2), work("s3", { dependsOn: ["s1"], outcome: `새 결과 ${secret}`,
    separation: { basis: "independent-verification", detail: `새 근거 ${secret}` }, checklist: [`새 항목 ${secret}`] }), integrationStage("int", ["s2", "s3"])];
  const revised = groups.applyRevision("g", groups.previewRevision("g", groupInput({ stages: added, questions: [
    ...questions, { id: "q2", stageId: null, text: `새 질문 ${secret}`, blocksStart: true }] }), 1), {});
  expect(JSON.stringify(revised)).not.toContain(secret);
  expect(JSON.stringify(groups.get("g"))).not.toContain(secret);
  db.close();
});

it("E4-6 연결: 기본은 앞 단계부터, 선택 착수는 selected, 합류 대상은 의존 폐포 안이고 문맥 해시는 저장소가 기록한다", () => {
  const { db, groups } = openStore();
  groups.create("g", groupInput(), "/repo", "base");
  groups.reserve("g", "s1", { topicId: "t1", worktreePath: "/w1", baseOID: "base" });
  groups.link("g", "s1", "t1", "base");
  expect(groups.get("g").pending).toEqual({});
  expect(() => groups.link("g", "s3", "t3", "base")).toThrow("앞 단계부터 연결하세요.");
  expect(() => groups.link("g", "s3", "t1", "base", { selected: true })).toThrow("단계 연결이 중복되거나 잘못됐습니다.");
  expect(() => groups.link("g", "s3", "t3", "base", { selected: true, mergeTargets: ["s2"] })).toThrow("합류 대상은 이 단계의 의존 단계여야 합니다.");
  groups.freezeResult("g", frozen("s1", "t1"));
  groups.link("g", "s3", "t3", "base", { selected: true, mergeTargets: ["s1"], preparedMerge: merge([["s1", "s1-commit-oid"]]) });
  const group = groups.get("g");
  expect(group.links.s3).toEqual({ topicId: "t3", baseOID: "base", groupVersion: 1, mergeTargets: ["s1"],
    preparedMerge: merge([["s1", "s1-commit-oid"]]), contextDigest: groups.stageContextDigest(group, "s3") });
  expect(groups.stageContextState("t3")).toEqual({ linked: true, groupId: "g", stageId: "s3", current: true });
  // 선택 착수 뒤에도 기본 연결은 연결 안 된 첫 단계(s2)다.
  expect(() => groups.link("g", "int", "t4", "base")).toThrow("앞 단계부터 연결하세요.");
  db.close();
});

it("E4-6 통합 단계는 의존하지 않는 단계도 합류 대상으로 받고, 비통합 단계는 의존 폐포 밖 합류 대상을 거부한다", () => {
  const { db, groups } = openStore();
  // 통합(int)이 s2 에만 의존한다 — s3 는 의존 폐포 밖이지만 통합은 닫을 때 모든 단계 결과를 조상으로 요구받는다.
  groups.create("g", groupInput({ stages: [work("s1"), work("s2", { dependsOn: ["s1"] }), work("s3", { dependsOn: ["s1"] }),
    integrationStage("int", ["s2"])] }), "/repo", "base");
  for (const [stageId, topicId] of [["s1", "t1"], ["s2", "t2"]]) {
    groups.link("g", stageId, topicId, "base");
    groups.freezeResult("g", frozen(stageId, topicId));
  }
  expect(() => groups.link("g", "s3", "t3", "base", { mergeTargets: ["s2"] })).toThrow("합류 대상은 이 단계의 의존 단계여야 합니다.");
  groups.link("g", "s3", "t3", "base");
  groups.freezeResult("g", frozen("s3", "t3"));
  expect(() => groups.link("g", "int", "t4", "s2-commit-oid", { mergeTargets: ["int"] })).toThrow("합류 대상은 이 단계의 의존 단계여야 합니다.");
  groups.link("g", "int", "t4", "s2-commit-oid", { mergeTargets: ["s3"], preparedMerge: merge([["s3", "s3-commit-oid"]]) });
  const group = groups.get("g");
  expect(group.links.int.mergeTargets).toEqual(["s3"]);
  const context = groups.stageContext(group, "int");
  expect(context.mergeTargets).toEqual([{ stageId: "s3", result: expect.objectContaining({ commitOID: "s3-commit-oid" }) }]);
  expect(context.priorResults.map((r) => r.stageId)).toEqual(["s1", "s2", "s3"]);
  expect(groups.renderStageContext(group, "int")).toContain("- s3: commit s3-commit-oid");
  db.close();
});

it("E4-3 단계 문맥은 자기 단계·현재 질문·의존 폐포 결과만 담고, 머리말은 그 객체의 값을 전부 계약 문구와 함께 싣는다", () => {
  const { db, groups } = openStore();
  const questions = [
    { id: "q-own", stageId: "s2", text: "s2 저장 형식", blocksStart: true, resolution: "JSON 으로 한다" },
    { id: "q-all", stageId: null, text: "묶음 전체 배포 시점", blocksStart: false },
    { id: "q-other", stageId: "s3", text: "s3 전용 미정 사항", blocksStart: true },
  ];
  const stages = [work("s0"), work("s1"), work("s2", { dependsOn: ["s1"], outcome: "s2 완결 결과",
    separation: { basis: "prior-result", detail: "s1 결과를 봐야 형식을 정한다", priorStage: "s1" }, checklist: ["s2 체크리스트 항목"] }),
  work("s3", { dependsOn: ["s0"], goal: "s3 미래 서술", checklist: ["s3 체크리스트 항목"] }), integrationStage("int", ["s2", "s3"])];
  groups.create("g", groupInput({ stages, questions }), "/repo", "base");
  groups.link("g", "s0", "t0", "base");
  groups.link("g", "s1", "t1", "base");
  groups.freezeResult("g", frozen("s0", "t0"));
  groups.freezeResult("g", frozen("s1", "t1", { legacy: true }));
  groups.link("g", "s2", "t2", "base", { mergeTargets: ["s1"], preparedMerge: merge([["s1", "s1-commit-oid"]], ["Form.swift", "Model.swift"]) });
  const group = groups.get("g");
  const context = groups.stageContext(group, "s2");
  expect(context.stage).toEqual({ id: "s2", kind: "work", title: "s2 제목", goal: "s2 목표", acceptance: "s2 완료 조건",
    outcome: "s2 완결 결과", separation: { basis: "prior-result", detail: "s1 결과를 봐야 형식을 정한다", priorStage: "s1" },
    checklist: ["s2 체크리스트 항목"] });
  expect(context.questions.map((q) => q.id)).toEqual(["q-own", "q-all"]);
  expect(context.priorResults.map((r) => r.stageId)).toEqual(["s1"]);
  expect(context.priorResults[0]).not.toHaveProperty("closedAt");
  expect(context.mergeTargets.map((m) => m.stageId)).toEqual(["s1"]);
  expect(context.merge).toEqual(merge([["s1", "s1-commit-oid"]], ["Form.swift", "Model.swift"]));
  // 결과 줄은 요약만(E4 2차 보완 F012) — 넘긴 결정은 개수와 요약 해시(정렬한 {topicId, sequence, sha256} 목록의 정본 JSON sha256), 보류 지적은 ID 목록과
  // 개수. 원문은 승계 결정 이벤트(타임라인 참조)와 이연 쟁점 목록(인라인 또는 원문 산출물)으로 간다.
  const expectedDigest = createHash("sha256").update(JSON.stringify([{ sequence: 7, sha256: "s1-decision-sha", topicId: "t1" }])).digest("hex");
  expect(context.priorResults[0].decisions).toEqual({ count: 1, digest: expectedDigest });
  expect(decisionDigest(frozen("s1", "t1").decisions)).toBe(expectedDigest);
  expect(context.priorResults[0].deferredFindings).toEqual({ count: 1, ids: ["s1-F1"] });
  expect(context.integration).toBe(false);
  const header = groups.renderStageContext(group, "s2");
  for (const value of stringLeaves(context)) expect(header).toContain(value);
  for (const hidden of ["s3 미래 서술", "s3 체크리스트 항목", "s3 전용 미정 사항", "s0-commit-oid", "s0 보류 지적", "s1 결정 원문", "2026-09-26T00:00:00.000Z",
    "s1 보류 지적", "s1 보류 사유", "s1-decision-sha"])
    expect(header).not.toContain(hidden);
  expect(header).toContain("이 단계 체크리스트:\n- s2 체크리스트 항목");
  expect(header).toContain("  보류 지적 1건: s1-F1 — 근거 전문은 이 턴의 이연 쟁점 목록(인라인 또는 원문 산출물 참조)에 있습니다.");
  expect(header).toContain(`  넘긴 결정 1건(요약 sha256 ${expectedDigest}) — 원문은 이 토픽 타임라인의 '승계 결정' 이벤트로 읽으세요.`);
  expect(header).toContain("병합 트리: merged-tree-oid");
  expect(header).toContain("충돌 파일(충돌 표식을 해소하세요): Form.swift, Model.swift");
  expect(header).toContain("직접 git merge·git commit 을 하지 마세요.");
  expect(header).toContain("허용 오차는 병합 트리 대비 변경만 셉니다.");
  expect(header).toContain("부모 [기준 커밋, 합류 대상 커밋…] 병합 커밋을 만듭니다(바뀐 경로를 전부 선택하세요)");
  expect(header).not.toContain("이 단계 작업에서 병합해");
  expect(header).toContain("현재 단계: s2 제목");
  expect(header).toContain("현재 단계만 상세 계획하고 구현하세요. 미래 단계의 상세 계획이나 전체 과거 대화를 다시 작성하지 마세요.");
  expect(header).toContain("이 단계 범위 밖(다른 단계)에 속하는 미정 사항은 작업 묶음이 따로 기록·해소합니다. 이 단계 계획이 불완전하다는 근거가 아니므로 그런 사항으로 사용자 결정을 요청하지 말고 계획의 '제외 범위'에 적으세요. 이 단계 착수를 막는 미정 사항은 위 목록에 있습니다.");
  expect(header).toContain("'제외 범위'");
  expect(header).toContain("분리 근거가 성립하지 않으면(파일·함수·역할만 다름)");
  expect(header).toContain("착수 차단");
  expect(header).toContain("E4 전 결과");
  expect(header).not.toContain("전체 통합 검증 단계");
  // 해시는 같은 객체의 정본 JSON(키 정렬)의 sha256 이다 — 레코드의 키 순서가 달라도 같다.
  const reversed = JSON.parse(JSON.stringify(group, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value)) as WorkGroup;
  expect(groups.stageContextDigest(reversed, "s2")).toBe(groups.stageContextDigest(group, "s2"));
  expect(groups.stageContextDigest(group, "s2")).toMatch(/^[a-f0-9]{64}$/);
  db.close();
});

it("E4-5 통합 단계 문맥은 모든 단계 결과와 기록 뒤 바뀐 위키 문서를 싣는다", () => {
  const { db, groups } = openStore();
  groups.create("g", groupInput(), "/repo", "base");
  for (const [stageId, topicId] of [["s1", "t1"], ["s2", "t2"], ["s3", "t3"]]) {
    groups.link("g", stageId, topicId, "base");
    groups.freezeResult("g", frozen(stageId, topicId));
  }
  const memoryDrift = [
    { path: "s1-wiki.md", stageId: "s1", recordedSHA256: "s1-wiki-sha", currentSHA256: "s1-wiki-now" },
    { path: "s2-wiki.md", stageId: "s2", recordedSHA256: "s2-wiki-sha", currentSHA256: "s2-wiki-sha" },
    { path: "s3-wiki.md", stageId: "s3", recordedSHA256: "s3-wiki-sha", currentSHA256: null },
  ];
  groups.link("g", "int", "t4", "s3-commit-oid", { memoryDrift });
  const group = groups.get("g");
  expect(group.links.int.memoryDrift).toEqual(memoryDrift);
  const context = groups.stageContext(group, "int");
  expect(context.integration).toBe(true);
  expect(context.priorResults.map((r) => r.stageId)).toEqual(["s1", "s2", "s3"]);
  expect(context.memoryDrift?.map((d) => d.path)).toEqual(["s1-wiki.md", "s3-wiki.md"]);
  const header = groups.renderStageContext(group, "int");
  for (const value of stringLeaves(context)) expect(header).toContain(value);
  expect(header).toContain("전체 통합 검증 단계입니다. 앞 단계의 개별 성공만으로 완료하지 말고 공통 계약과 전체 변경을 함께 검증하세요.");
  expect(header).not.toContain("s2-wiki-sha → ");
  // 바뀐 위키 목록은 해시에 든다. 기록 버전과 같은 항목은 싣지 않으므로 해시에도 들지 않는다.
  const drifted = (mutate: (entries: typeof memoryDrift) => void) => {
    const copy = structuredClone(group);
    mutate(copy.links.int.memoryDrift!);
    return groups.stageContextDigest(copy, "int");
  };
  const digest = groups.stageContextDigest(group, "int");
  expect(drifted((entries) => { entries[0].currentSHA256 = "s1-wiki-later"; })).not.toBe(digest);
  expect(drifted((entries) => { entries.push({ path: "new.md", stageId: "s2", recordedSHA256: "a", currentSHA256: "b" }); })).not.toBe(digest);
  expect(drifted((entries) => { entries[1].path = "same-but-renamed.md"; })).toBe(digest);
  db.close();
});

it("E4-3 해시 구성요소를 바꾸면 해시가 바뀌고, 미래·다른 단계 서술·순서·다른 단계 체크리스트·예산은 해시에 들지 않는다", () => {
  const { db, groups } = openStore();
  const questions = [{ id: "q1", stageId: "s2", text: "s2 질문", blocksStart: false }, { id: "q2", stageId: "s3", text: "s3 질문", blocksStart: false }];
  groups.create("g", groupInput({ questions }), "/repo", "base");
  groups.link("g", "s1", "t1", "base");
  groups.freezeResult("g", frozen("s1", "t1"));
  groups.link("g", "s2", "t2", "s1-commit-oid");
  groups.link("g", "s3", "t3", "s1-commit-oid");
  groups.freezeResult("g", frozen("s3", "t3"));
  const base = groups.get("g");
  const digest = groups.stageContextDigest(base, "s2");
  const changed = (mutate: (g: WorkGroup) => void) => {
    const copy = structuredClone(base);
    mutate(copy);
    return groups.stageContextDigest(copy, "s2");
  };
  const s2 = (g: WorkGroup) => g.stages.find((s) => s.id === "s2")!;
  const components: Array<[string, (g: WorkGroup) => void]> = [
    ["묶음 목표", (g) => { g.goal = "다른 목표"; }],
    ["공통 계약", (g) => { g.contracts = "다른 계약"; }],
    ["단계 제목", (g) => { s2(g).title = "다른 제목"; }],
    ["단계 목표", (g) => { s2(g).goal = "다른 단계 목표"; }],
    ["완료 조건", (g) => { s2(g).acceptance = "다른 조건"; }],
    ["결과", (g) => { s2(g).outcome = "결과"; }],
    ["분리 근거", (g) => { s2(g).separation = { basis: "rollback", detail: "근거" }; }],
    ["종류", (g) => { s2(g).kind = "integration"; }],
    ["현재 질문", (g) => { g.questions![0].text = "다른 질문"; }],
    ["질문 해소", (g) => { g.questions![0].resolution = "해소"; }],
    ["질문 차단", (g) => { g.questions![0].blocksStart = true; }],
    ["묶음 질문", (g) => { g.questions!.push({ id: "q3", stageId: null, text: "묶음 질문", blocksStart: false }); }],
    ["선행 결과", (g) => { g.results!.s1.commitOID = "other-commit"; }],
    ["선행 검증", (g) => { g.results!.s1.verifications[0].status = "failed"; }],
    ["선행 위키", (g) => { g.results!.s1.memoryChanges = []; }],
    ["합류 대상", (g) => { g.links.s2.mergeTargets = ["s1"]; }],
    ["준비한 병합", (g) => { g.links.s2.preparedMerge = merge([["s1", "s1-commit-oid"]]); }],
    ["자기 체크리스트", (g) => { s2(g).checklist = ["항목"]; }],
    ["넘긴 결정 참조", (g) => { g.results!.s1.decisions[0].sha256 = "other-sha"; }],
    ["넘긴 결정 개수", (g) => { g.results!.s1.decisions.push({ ...g.results!.s1.decisions[0], sequence: 8 }); }],
    ["보류 지적 ID", (g) => { g.results!.s1.deferredFindings[0].id = "other-id"; }],
    ["보류 지적 개수", (g) => { g.results!.s1.deferredFindings.push({ ...g.results!.s1.deferredFindings[0], id: "s1-F2" }); }],
  ];
  for (const [name, mutate] of components) expect(changed(mutate), name).not.toBe(digest);
  const outside: Array<[string, (g: WorkGroup) => void]> = [
    ["다른 단계 서술", (g) => { g.stages[2].goal = "s3 다른 목표"; g.stages[3].title = "다른 통합"; }],
    ["다른 단계 체크리스트", (g) => { g.stages[2].checklist = ["s3 항목"]; }],
    ["결정 원문·세대(참조 밖)", (g) => { g.results!.s1.decisions[0].body = "다른 원문"; g.results!.s1.decisions[0].scopeGeneration = 5; }],
    // 보류 지적은 ID 목록·개수만 해시에 든다 — 근거 전문은 이연 쟁점 목록(원문 산출물)으로 가고, 동결 결과는 바뀌지 않는다.
    ["보류 지적 서술·기록 시각", (g) => { const f = g.results!.s1.deferredFindings[0]; f.title = "다른 보류"; f.rationale = "다른 사유"; f.recordedAt = "later"; }],
    ["예산", (g) => { s2(g).budget = { ...budget, total: { ...budget.total, inputTokens: 1 } }; }],
    ["순서", (g) => { [g.stages[1], g.stages[2]] = [g.stages[2], g.stages[1]]; }],
    ["다른 단계 질문", (g) => { g.questions![1].text = "다른 s3 질문"; }],
    ["폐포 밖 결과", (g) => { g.results!.s3.commitOID = "other"; }],
    ["동결 시각·토픽", (g) => { g.results!.s1.closedAt = "later"; g.results!.s1.topicId = "other"; }],
    ["버전·이력", (g) => { g.version = 9; g.revisions = []; g.links.s2.groupVersion = 9; }],
  ];
  for (const [name, mutate] of outside) expect(changed(mutate), name).toBe(digest);
  db.close();
});

it("E4-3 문맥 결속 상태: 연결 안 됨·현재·해시 변경·E4 전 연결의 버전 변경", () => {
  const { db, groups } = openStore();
  groups.create("g", groupInput(), "/repo", "base");
  expect(groups.stageContextState("t1")).toEqual({ linked: false });
  expect(groups.isStageContextCurrent("t1")).toBe(true);
  expect(() => groups.assertStageContextCurrent("t1")).not.toThrow();
  groups.link("g", "s1", "t1", "base");
  groups.link("g", "s2", "t2", "base");
  expect(groups.isStageContextCurrent("t2")).toBe(true);
  groups.freezeResult("g", frozen("s1", "t1"));
  expect(groups.stageContextState("t2")).toEqual({ linked: true, groupId: "g", stageId: "s2", current: false, reason: "digest-changed" });
  expect(groups.isStageContextCurrent("t2")).toBe(false);
  expect(() => groups.assertStageContextCurrent("t2")).toThrow(/^공통 계약이 바뀌었습니다\. 현재 단계의 계획을 다시 승인해야 합니다\./);
  // E4 전 연결(해시 없음)은 버전으로만 결속한다.
  const record = groups.get("g");
  delete record.links.s2.contextDigest;
  record.version = 2;
  db.prepare("UPDATE work_groups SET record_json=? WHERE id=?").run(JSON.stringify(record), "g");
  expect(groups.stageContextState("t2")).toMatchObject({ current: false, reason: "version-changed" });
  expect(() => groups.assertStageContextCurrent("t2")).toThrow(/^공통 계약이 바뀌었습니다\. 현재 단계의 계획을 다시 승인해야 합니다\./);
  groups.acknowledgeRevision("g", "s2");
  expect(groups.get("g").links.s2).toMatchObject({ groupVersion: 2, contextDigest: groups.stageContextDigest(groups.get("g"), "s2") });
  expect(groups.isStageContextCurrent("t2")).toBe(true);
  db.close();
});

it("E4 과거 레코드(새 필드 없음)를 마이그레이션 없이 읽고 연결·머리말·개정·동결을 그대로 한다", () => {
  const { db, groups } = openStore();
  const stage = (id: string, dependsOn: string[], kind = "work") => ({ kind, id, title: id, goal: `${id} 목표`, acceptance: `${id} 조건`, dependsOn, budget });
  const legacy = { title: "옛 묶음", goal: "옛 목표", contracts: "옛 계약", stages: [stage("a", []), stage("b", ["a"]), stage("int", ["b"], "integration")],
    id: "old", repositoryPath: "/repo", baseOID: "base", version: 1, createdAt: "2026-09-01T00:00:00.000Z", links: { a: { topicId: "ta", baseOID: "base", groupVersion: 1 } } };
  db.prepare("INSERT INTO work_groups VALUES (?,?)").run("old", JSON.stringify(legacy));
  expect(groups.forTopic("ta")?.id).toBe("old");
  expect(groups.get("old")).toEqual(legacy);
  expect(groups.stageContextState("ta")).toEqual({ linked: true, groupId: "old", stageId: "a", current: true });
  expect(groups.prompt("ta", [])).toContain("현재 단계: a");
  groups.link("old", "b", "tb", "base");
  expect(groups.get("old").links.b.contextDigest).toBe(groups.stageContextDigest(groups.get("old"), "b"));
  const preview = groups.previewRevision("old", { title: legacy.title, goal: legacy.goal, contracts: "새 계약",
    stages: legacy.stages as WorkGroupInput["stages"] }, 1, (topicId) => topicId === "ta");
  expect(preview).toMatchObject({ mode: "revise", affected: ["b"], closed: ["a"] });
  const saved = groups.applyRevision("old", preview, { b: 1 });
  expect(saved).toMatchObject({ version: 2, retiredStageIds: [], revisions: [expect.objectContaining({ affectedStages: ["b"] })] });
  expect(saved.links.a).toEqual(legacy.links.a);
  groups.freezeResult("old", frozen("a", "ta", { legacy: true }));
  expect(groups.get("old").results?.a.legacy).toBe(true);
  db.close();
});

it("E4-5 결과 동결: 없으면 쓰고, 같은 내용(동결 시각 제외)은 무시하고, 다르면 거부하며, 아직 닫히지 않은 교체만 허용한다", () => {
  const { db, groups } = openStore();
  groups.create("g", groupInput(), "/repo", "base");
  groups.link("g", "s1", "t1", "base");
  expect(() => groups.freezeResult("g", frozen("s2", "t2"))).toThrow("단계 결과가 단계 연결과 맞지 않습니다.");
  expect(() => groups.freezeResult("g", frozen("s1", "other"))).toThrow("단계 결과가 단계 연결과 맞지 않습니다.");
  groups.freezeResult("g", frozen("s1", "t1"));
  expect(groups.get("g").results?.s1).toEqual(frozen("s1", "t1"));
  groups.freezeResult("g", frozen("s1", "t1", { closedAt: "2026-09-28T00:00:00.000Z" }));
  expect(groups.get("g").results?.s1.closedAt).toBe("2026-09-27T00:00:00.000Z");
  const more = [...frozen("s1", "t1").decisions, { topicId: "t1", sequence: 9, scopeGeneration: 1, sha256: "more-sha", body: "늘어난 결정" }];
  expect(() => groups.freezeResult("g", frozen("s1", "t1", { decisions: more }))).toThrow("동결된 단계 결과는 바꿀 수 없습니다.");
  expect(groups.get("g").results?.s1).toEqual(frozen("s1", "t1"));
  const retried = frozen("s1", "t1", { decisions: more, closedAt: "2026-09-29T00:00:00.000Z" });
  groups.freezeResult("g", retried, { replaceUnclosed: true });
  expect(groups.get("g").results?.s1).toEqual(retried);
  db.close();
});

it("prompt 는 머리말과 호환된다 — 동결 결과가 덮은 prior 는 무시하고, 덮지 않은 prior 만 옛 줄 형식으로 잇는다", () => {
  const { db, groups } = openStore();
  groups.create("g", groupInput(), "/repo", "base");
  groups.link("g", "s1", "t1", "base");
  groups.freezeResult("g", frozen("s1", "t1"));
  groups.link("g", "s2", "t2", "s1-commit-oid");
  const group = groups.get("g");
  const covered = [{ stageId: "s1", commit: "s1-commit-oid", planSHA: "s1-plan-sha", verification: "s1-tree-oid" }];
  expect(groups.prompt("t2", [])).toBe(groups.renderStageContext(group, "s2"));
  expect(groups.prompt("t2", covered)).toBe(groups.renderStageContext(group, "s2"));
  const uncovered = [{ stageId: "legacy", commit: "legacy-commit", planSHA: "legacy-plan", verification: "legacy-tree" }];
  expect(groups.prompt("t2", uncovered)).toContain("legacy: commit legacy-commit, plan SHA legacy-plan, 검증 legacy-tree");
  expect(groups.prompt("nobody", [])).toBe("");
  db.close();
});

it("F011 통합 단계는 마지막 하나뿐이다 — 중간 통합 단계는 그 단계 ID 를 밝혀 거부한다", () => {
  const { db, groups } = openStore();
  const middle = groupInput({ stages: [work("s1"), { ...work("mid", { dependsOn: ["s1"] }), kind: "integration" }, work("s3", { dependsOn: ["s1"] }),
    integrationStage("int", ["mid", "s3"])] });
  expect(() => groups.create("g", middle, "/repo", "base")).toThrow("단계 mid 는 전체 통합 검증 단계입니다 — 통합 단계는 마지막 하나뿐이어야 합니다.");
  expect(() => groups.create("g", groupInput({ stages: [work("s1"), work("s2")] }), "/repo", "base")).toThrow("마지막 단계는 전체 통합 검증이어야 합니다.");
  groups.create("g", groupInput(), "/repo", "base");
  expect(() => groups.previewRevision("g", middle, 1)).toThrow("단계 mid 는 전체 통합 검증 단계입니다");
  db.close();
});

it("F001 합류 대상은 엔진이 준비한 병합과 함께만 연결한다 — 대상 집합·동결 커밋이 같아야 하고, 합류 대상이 없으면 받지 않는다", () => {
  const { db, groups } = openStore();
  groups.create("g", groupInput({ stages: [work("s1"), work("s2"), work("s3", { dependsOn: ["s1", "s2"] }), integrationStage("int", ["s3"])] }),
    "/repo", "base");
  groups.link("g", "s1", "t1", "base");
  groups.freezeResult("g", frozen("s1", "t1"));
  expect(() => groups.link("g", "s2", "t2", "base", { preparedMerge: merge([["s1", "s1-commit-oid"]]) }))
    .toThrow("합류 대상이 없으면 준비한 병합을 받지 않습니다.");
  groups.link("g", "s2", "t2", "base");
  groups.freezeResult("g", frozen("s2", "t2"));
  const link = (options: Parameters<WorkGroups["link"]>[4]) => () => groups.link("g", "s3", "t3", "s2-commit-oid", options);
  expect(link({ mergeTargets: ["s1"] })).toThrow("합류 대상이 있으면 엔진이 준비한 병합(preparedMerge)이 필요합니다.");
  expect(link({ mergeTargets: ["s1"], preparedMerge: merge([["s2", "s2-commit-oid"]]) })).toThrow("준비한 병합의 대상이 합류 대상과 다릅니다.");
  expect(link({ mergeTargets: ["s1"], preparedMerge: merge([["s1", "s1-commit-oid"], ["s2", "s2-commit-oid"]]) }))
    .toThrow("준비한 병합의 대상이 합류 대상과 다릅니다.");
  expect(link({ mergeTargets: ["s1", "s1"], preparedMerge: merge([["s1", "s1-commit-oid"], ["s1", "s1-commit-oid"]]) }))
    .toThrow("준비한 병합의 대상이 합류 대상과 다릅니다.");
  expect(link({ mergeTargets: ["s1"], preparedMerge: merge([["s1", "other-commit"]]) })).toThrow("준비한 병합의 s1 커밋이 동결 결과와 다릅니다.");
  expect(groups.get("g").links.s3).toBeUndefined();
  groups.link("g", "s3", "t3", "s2-commit-oid", { mergeTargets: ["s1"], preparedMerge: merge([["s1", "s1-commit-oid"]]) });
  const group = groups.get("g");
  expect(group.links.s3.preparedMerge).toEqual(merge([["s1", "s1-commit-oid"]]));
  expect(groups.renderStageContext(group, "s3")).toContain("충돌 파일: 충돌 없음");
  // 준비한 병합은 해시에 든다 — 충돌 목록이 달라지면 문맥이 다르다.
  const conflicted = structuredClone(group);
  conflicted.links.s3.preparedMerge!.conflicts = ["a.swift"];
  expect(groups.stageContextDigest(conflicted, "s3")).not.toBe(groups.stageContextDigest(group, "s3"));
  db.close();
});

it("§4 승계 도우미 — 이어받는 단계의 결정·보류 지적을 묶음 단계 순서로 중복 없이 모으고, 승계 결정 이벤트 입력을 만든다", () => {
  const { db, groups } = openStore();
  groups.create("g", groupInput({ stages: [work("s1"), work("s2", { dependsOn: ["s1"] }), work("s3"), work("s4", { dependsOn: ["s2"] }),
    integrationStage("int", ["s4"])] }), "/repo", "base");
  const shared = { id: "SHARED", title: "공통 보류", severity: "LOW" as const, rationale: "두 단계가 같은 원장 항목을 들고 있다", source: "closeout" as const,
    topicId: "t1", recordedAt: "2026-09-26T00:00:00.000Z" };
  const decision = (topicId: string, sequence: number) => ({ topicId, sequence, scopeGeneration: 2, sha256: `${topicId}-${sequence}`, body: `${topicId} 결정 ${sequence}` });
  for (const [stageId, topicId] of [["s1", "t1"], ["s2", "t2"], ["s3", "t3"]]) groups.link("g", stageId, topicId, "base", { selected: true });
  groups.freezeResult("g", frozen("s1", "t1", { decisions: [decision("t1", 3), decision("t1", 5)], deferredFindings: [shared] }));
  // s2 결과가 s1 의 결정·보류 지적 하나를 같은 키로 다시 들고 있어도 한 번만 승계한다.
  groups.freezeResult("g", frozen("s2", "t2", { decisions: [decision("t2", 4), decision("t1", 5)], deferredFindings: [shared,
    { ...shared, id: "S2-ONLY", topicId: "t2" }] }));
  groups.freezeResult("g", frozen("s3", "t3", { decisions: [decision("t3", 1)] }));
  const group = groups.get("g");
  // s4 는 s2·s1 을 이어받는다(의존 폐포, 묶음 순서 s1 → s2). s3 는 폐포 밖이다.
  expect(groups.inheritedDecisions(group, "s4")).toEqual([
    { stageId: "s1", decision: decision("t1", 3) }, { stageId: "s1", decision: decision("t1", 5) }, { stageId: "s2", decision: decision("t2", 4) },
  ]);
  expect(groups.inheritedDeferredFindings(group, "s4").map((f) => `${f.topicId}/${f.id}`)).toEqual(["t1/SHARED", "t2/S2-ONLY"]);
  // 통합 단계는 다른 모든 단계를 이어받는다.
  expect(groups.inheritedDecisions(group, "int").map((entry) => `${entry.stageId}:${entry.decision.topicId}#${entry.decision.sequence}`))
    .toEqual(["s1:t1#3", "s1:t1#5", "s2:t2#4", "s3:t3#1"]);
  expect(groups.inheritedDecisions(group, "s1")).toEqual([]);
  expect(groups.inheritedDecisionEvent("g", { stageId: "s1", decision: decision("t1", 3) })).toEqual({
    actor: "user", kind: "decision",
    body: "승계 결정 — 단계 s1(토픽 t1 #3, 범위 세대 2, sha256 t1-3):\n\nt1 결정 3",
    payload: { inheritedDecision: { groupId: "g", stageId: "s1", topicId: "t1", sequence: 3, scopeGeneration: 2, sha256: "t1-3" } },
  });
  db.close();
});
