import { redactSecrets } from "../shared/workflow.js";
import type { DatabaseSync } from "node:sqlite";
import {
  WorkGroupInputSchema,
  type WorkGroup,
  type WorkGroupInput,
} from "../shared/workGroups.js";
import { BUDGET_KEYS, type BudgetPolicy } from "../shared/budgets.js";
export class WorkGroups {
  constructor(private readonly db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS work_groups(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)",
    );
  }
  atomic<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  list(): WorkGroup[] {
    return this.db
      .prepare("SELECT record_json FROM work_groups ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(String(r.record_json)));
  }
  get(id: string): WorkGroup {
    const g = this.list().find((g) => g.id === id);
    if (!g) throw new Error("작업 묶음이 없습니다.");
    return g;
  }
  forTopic(topicId: string): WorkGroup | null {
    return (
      this.list().find((g) =>
        Object.values(g.links).some((l) => l.topicId === topicId),
      ) ?? null
    );
  }
  create(
    id: string,
    input: WorkGroupInput,
    repositoryPath: string,
    baseOID: string,
  ): WorkGroup {
    const group: WorkGroup = {
      ...sanitizeInput(input),
      id,
      repositoryPath,
      baseOID,
      version: 1,
      createdAt: new Date().toISOString(),
      links: {},
    };
    this.db
      .prepare("INSERT INTO work_groups VALUES (?,?)")
      .run(id, JSON.stringify(group));
    return group;
  }
  groupPolicy(group: WorkGroup): BudgetPolicy {
    return Object.fromEntries(
      ["execution", "total"].map((scope) => [
        scope,
        Object.fromEntries(
          BUDGET_KEYS.map((key) => [
            key,
            scope === "execution"
              ? Math.max(...group.stages.map((s) => s.budget.execution[key]))
              : group.stages.reduce((sum, s) => sum + s.budget.total[key], 0),
          ]),
        ),
      ]),
    ) as BudgetPolicy;
  }
  link(id: string, stageId: string, topicId: string, baseOID: string): void {
    const g = this.get(id);
    if (
      !g.stages.some((s) => s.id === stageId) ||
      g.links[stageId] ||
      this.forTopic(topicId)
    )
      throw new Error("단계 연결이 중복되거나 잘못됐습니다.");
    const firstUnlinked = g.stages.find((s) => !g.links[s.id]);
    if (firstUnlinked?.id !== stageId)
      throw new Error("앞 단계부터 연결하세요.");
    g.links[stageId] = { topicId, baseOID, groupVersion: g.version };
    delete g.pending?.[stageId];
    this.save(g);
  }
  reserve(
    id: string,
    stageId: string,
    value: { topicId: string; worktreePath: string; baseOID: string },
  ) {
    const group = this.get(id);
    group.pending ??= {};
    if (group.pending[stageId]) return group.pending[stageId];
    group.pending[stageId] = value;
    this.save(group);
    return value;
  }
  previewRevision(
    id: string,
    input: WorkGroupInput,
    expectedVersion: number,
  ): WorkGroup {
    const old = this.get(id);
    if (old.version !== expectedVersion)
      throw new Error("작업 묶음이 변경됐습니다.");
    const parsed = sanitizeInput(input);
    // Stage identities/order/budgets are fixed after creation; revision only changes contracts and unstarted descriptions.
    if (
      JSON.stringify(
        parsed.stages.map((s) => [s.id, s.kind, s.dependsOn, s.budget]),
      ) !==
      JSON.stringify(
        old.stages.map((s) => [s.id, s.kind, s.dependsOn, s.budget]),
      )
    )
      throw new Error("단계 순서·예산 변경은 기존 묶음에서 지원하지 않습니다.");
    const updated = { ...old, ...parsed, version: old.version + 1 };
    return updated;
  }
  revise(
    id: string,
    input: WorkGroupInput,
    expectedVersion: number,
  ): WorkGroup {
    const updated = this.previewRevision(id, input, expectedVersion);
    this.save(updated);
    return updated;
  }
  acknowledgeRevision(id: string, stageId: string): void {
    const g = this.get(id);
    g.links[stageId].groupVersion = g.version;
    this.save(g);
  }
  prompt(
    topicId: string,
    prior: Array<{
      stageId: string;
      commit: string;
      planSHA: string;
      verification: string;
    }>,
  ): string {
    const g = this.forTopic(topicId);
    if (!g) return "";
    const stage = g.stages.find((s) => g.links[s.id]?.topicId === topicId)!;
    return `전체 목표: ${g.goal}\n공통 계약: ${g.contracts}\n현재 단계: ${stage.title}\n이번 목표: ${stage.goal}\n완료 조건: ${stage.acceptance}\n선행 단계의 확정 근거:\n${prior.map((p) => `${p.stageId}: commit ${p.commit}, plan SHA ${p.planSHA}, 검증 ${p.verification}`).join("\n")}\n현재 단계만 상세 계획하고 구현하세요. 미래 단계의 상세 계획이나 전체 과거 대화를 다시 작성하지 마세요.`;
  }
  private save(g: WorkGroup) {
    this.db
      .prepare("UPDATE work_groups SET record_json=? WHERE id=?")
      .run(JSON.stringify(g), g.id);
  }
}

function sanitizeInput(input: WorkGroupInput): WorkGroupInput {
  const parsed = WorkGroupInputSchema.parse(input);
  return {
    ...parsed,
    title: redactSecrets(parsed.title),
    goal: redactSecrets(parsed.goal),
    contracts: redactSecrets(parsed.contracts),
    stages: parsed.stages.map((stage) => ({
      ...stage,
      title: redactSecrets(stage.title),
      goal: redactSecrets(stage.goal),
      acceptance: redactSecrets(stage.acceptance),
    })),
  };
}
