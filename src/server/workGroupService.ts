import { WorkGroupInputSchema } from "../shared/workGroups.js";
import { BudgetPolicySchema } from "../shared/budgets.js";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ConsensusDatabase } from "./database.js";
import type { GitService } from "./git.js";
import type { WorkGroup, WorkGroupInput } from "../shared/workGroups.js";
import type { AgentSettings } from "../shared/contracts.js";

// Each stage is an ordinary topic: approval, review and delivery remain the existing engine's responsibility.
export class WorkGroupService {
  private readonly active = new Set<string>();
  constructor(
    private readonly database: ConsensusDatabase,
    private readonly git: GitService,
    private readonly repositoryPath: string,
    private readonly worktreesDirectory: string,
    private readonly settings: AgentSettings,
  ) {}

  async create(
    input: WorkGroupInput,
    prepared?: (id: string) => void,
  ): Promise<WorkGroup> {
    const id = randomUUID();
    const base = await this.git.head(this.repositoryPath);
    const parsed = WorkGroupInputSchema.parse(input);
    BudgetPolicySchema.parse(
      this.database.workGroups.groupPolicy({
        ...parsed,
        id,
        repositoryPath: this.repositoryPath,
        baseOID: base,
        version: 1,
        createdAt: "",
        links: {},
      }),
    );
    prepared?.(id);
    return this.database.workGroups.atomic(() => {
      const group = this.database.workGroups.create(
        id,
        parsed,
        this.repositoryPath,
        base,
      );
      this.database.budgets.configure(
        id,
        this.database.workGroups.groupPolicy(group),
        "explicit-stage-budgets",
      );
      return group;
    });
  }

  async evidence(group: WorkGroup, beforeStage: string) {
    return stageEvidence(this.database, this.git, group, beforeStage);
  }

  async next(
    id: string,
    prepared?: (topicId: string, worktreePath: string) => void,
  ) {
    if (this.active.has(id)) throw new Error("다음 단계를 여는 중입니다.");
    this.active.add(id);
    try {
      return await this.createNext(id, prepared);
    } finally {
      this.active.delete(id);
    }
  }
  private async createNext(
    id: string,
    prepared?: (topicId: string, worktreePath: string) => void,
  ) {
    const group = this.database.workGroups.get(id);
    const stage = group.stages.find((stage) => !group.links[stage.id]);
    if (!stage) throw new Error("모든 단계가 연결됐습니다.");
    this.database.budgets.assertAvailable([id]);
    const proof = await this.evidence(group, stage.id);
    const baseOID = proof.at(-1)?.commit ?? group.baseOID;
    const candidateId = randomUUID(),
      slug = `stage-${stage.id}`;
    const reservation = this.database.workGroups.reserve(id, stage.id, {
      topicId: candidateId,
      worktreePath: resolve(
        this.worktreesDirectory,
        `${slug}-${candidateId.slice(0, 8)}`,
      ),
      baseOID,
    });
    const { topicId, worktreePath } = reservation;
    prepared?.(topicId, worktreePath);
    if (reservation.baseOID !== baseOID)
      throw new Error("준비 중인 단계의 기준 커밋이 변경됐습니다.");
    if (existsSync(worktreePath)) {
      if ((await this.git.head(worktreePath)) !== baseOID)
        throw new Error("준비 중인 작업 트리의 커밋이 변경됐습니다.");
    } else
      await this.git.createDetachedWorktree(
        group.repositoryPath,
        worktreePath,
        baseOID,
      );
    // Recheck after the asynchronous Git boundary; never link against a changed common contract.
    if (this.database.workGroups.get(id).version !== group.version)
      throw new Error(
        "작업 묶음이 변경됐습니다. 생성한 작업 트리는 보존했습니다.",
      );
    const created = this.database.workGroups.atomic(() => {
      const timestamp = new Date().toISOString();
      const topic =
        this.database.listTopics().find((topic) => topic.id === topicId) ??
        this.database.createTopic({
          id: topicId,
          slug,
          title: `${group.title} · ${stage.title}`,
          repositoryPath: group.repositoryPath,
          worktreePath,
          baseRef: baseOID,
          branchPrefix: "consensus",
          requestedBranchName: null,
          predecessorTopicId: null,
          branchName: null,
          state: "DRAFT",
          scopeGeneration: 1,
          planRevision: 0,
          planSHA256: null,
          approvedPlanSHA256: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastError: null,
          agentSettings: this.settings,
        });
      if (!this.database.budgets.account(topicId))
        this.database.budgets.configure(
          topicId,
          stage.budget,
          "explicit-stage-budget",
        );
      this.database.workGroups.link(id, stage.id, topicId, baseOID);
      for (const role of ["claude", "codex"] as const)
        this.database.upsertParticipant(topicId, {
          role,
          sessionId: `pending:${randomUUID()}`,
          mode: "created",
          acknowledgedPlanSHA256: null,
        });
      return this.database.getTopic(topicId);
    });
    this.database.appendEvent({
      topicId,
      actor: "system",
      kind: "system",
      state: "DRAFT",
      body: this.database.workGroups.prompt(topicId, proof),
      payload: { workGroupId: id, stageId: stage.id, baseOID },
    });
    return created;
  }
}

export async function stageEvidence(
  database: ConsensusDatabase,
  git: GitService,
  group: WorkGroup,
  beforeStage: string,
) {
  const index = group.stages.findIndex((stage) => stage.id === beforeStage);
  if (index < 0) throw new Error("단계를 찾을 수 없습니다.");
  const proof = [];
  for (const stage of group.stages.slice(0, index)) {
    const link = group.links[stage.id];
    if (!link) throw new Error("앞 단계의 계약과 검증을 먼저 확정하세요.");
    const topic = database.getTopic(link.topicId),
      flags = database.getFlags(topic.id);
    if (
      topic.state !== "CLOSED" ||
      !flags.pushedOID ||
      flags.pushedOID !== flags.committedOID ||
      !topic.approvedPlanSHA256 ||
      !flags.reviewedTreeOID
    )
      throw new Error("앞 단계의 승인·리뷰·푸시가 끝나야 합니다.");
    if (
      (await git.head(topic.worktreePath)) !== flags.pushedOID ||
      (await git.changedPaths(topic.worktreePath)).length
    )
      throw new Error("앞 단계의 전달 커밋이 변경됐습니다.");
    proof.push({
      stageId: stage.id,
      commit: flags.pushedOID,
      planSHA: topic.approvedPlanSHA256,
      verification: flags.reviewedTreeOID,
    });
  }
  return proof;
}
