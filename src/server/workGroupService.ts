import { dependencyClosure, stageReady, WorkGroupCreateOptionsSchema, WorkGroupInputSchema } from "../shared/workGroups.js";
import { BudgetPolicySchema, OBSERVE_USAGE } from "../shared/budgets.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ConsensusDatabase } from "./database.js";
import type { GitService } from "./git.js";
import type { ExternalPredecessor, PreparedMerge, StageLink, StageResult, WorkGroup, WorkGroupCreateOptions, WorkGroupInput, WorkStage } from "../shared/workGroups.js";
import type { AgentSettings, DeferredFinding } from "../shared/contracts.js";

export interface WorkGroupServiceOptions {
  // 열린 단계가 외부 결정(사용자 결정·외부 근거)에 막혔는가 — 엔진의 정지 분류(workflow.stageBlockedExternally)를 그대로 쓴다.
  // 없으면 어떤 단계도 막힘으로 보지 않는다(선택 착수는 열린 단계가 없을 때만 된다).
  blockedExternally?: (topicId: string) => boolean;
  // 공용 위키(메모리) 루트 — 통합 단계를 열 때 단계 결과가 기록한 위키 문서의 지금 버전을 잰다.
  memoryDirectory?: string;
  // 토픽의 보류 원장(deferred-findings 산출물) — 묶음 밖 선행 토픽의 원장을 생성 때 동결한다. 없으면 선행 토픽을 받지 않는다.
  deferredFindingsOf?: (topicId: string) => Promise<DeferredFinding[]>;
}

// 단계 결과의 승계 근거 — 어댑터·생성 이벤트·과거 호출이 쓰는 기존 반환 형식.
export interface StageProof {
  stageId: string;
  commit: string;
  planSHA: string;
  verification: string;
}

// 선행 결과 해석(host-review F005·F009) — proof 는 이 단계가 요구하는 선행 결과 전부(묶음 단계 순서)의 검증 증거, unfrozen 은 그 가운데 동결 결과가
// 없는 E4 전 닫힌 단계의 증거(동결하지 않았거나 동결하지 않기로 한 것), group 은 해석 뒤 묶음 레코드다.
export interface PriorResolution {
  group: WorkGroup;
  proof: StageProof[];
  unfrozen: StageProof[];
}

// Each stage is an ordinary topic: approval, review and delivery remain the existing engine's responsibility.
// 엔진 개편 E4: 착수는 "기본(한 번에 한 단계, 첫 준비 단계)"과 "선택(막힌 단계 옆 독립 준비 단계)"으로 나뉘고, 다음 단계는 앞 단계의 push 가 아니라
// 닫힐 때 동결된 결과(검증된 로컬 커밋)를 승계한다(plan §3.1·§3.3, E4-5·E4-6).
export class WorkGroupService {
  private readonly active = new Set<string>();
  constructor(
    private readonly database: ConsensusDatabase,
    private readonly git: GitService,
    private readonly repositoryPath: string,
    private readonly worktreesDirectory: string,
    private readonly settings: AgentSettings,
    private readonly options: WorkGroupServiceOptions = {},
  ) {}

  // options 는 생성 전용 입력(WorkGroupCreateOptionsSchema) — 명시 기준 커밋·단계 브랜치 접두사·묶음 밖 선행 토픽. 없으면 기존 동작이다.
  async create(
    input: WorkGroupInput,
    prepared?: (id: string) => void,
    options: WorkGroupCreateOptions = {},
  ): Promise<WorkGroup> {
    const id = randomUUID();
    const creation = WorkGroupCreateOptionsSchema.parse(options);
    const parsed = WorkGroupInputSchema.parse(input);
    let base: string;
    if (creation.baseRef === undefined) base = await this.git.head(this.repositoryPath);
    else {
      try {
        base = await this.git.resolveCommit(this.repositoryPath, creation.baseRef);
      } catch (error) {
        throw new Error(`작업 묶음 기준 커밋을 찾을 수 없습니다: ${creation.baseRef} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    const predecessor = creation.predecessorTopicId === undefined ? undefined : await this.freezePredecessor(creation.predecessorTopicId, base);
    // 대략 단계(완료 조건·예산 없음)를 허용한다 — 묶음 예산은 묶음 정책이 있으면 그것, 없으면 예산을 선언한 단계들로 정한다(저장소 groupPolicy).
    // 계정 출처는 어느 쪽이든 "explicit-stage-budgets" 다: 예산 화면이 이 값으로 묶음 계정(작업 묶음 누적 상한)을 알아본다. 정책이 어디서 왔는지는
    // 묶음 레코드의 budgetPolicy 유무에 남는다.
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
        { branchPrefix: creation.branchPrefix, predecessor },
      );
      this.database.budgets.configure(
        id,
        this.database.workGroups.groupPolicy(group),
        "explicit-stage-budgets",
      );
      return group;
    });
  }

  // 묶음 밖 선행 토픽(생성 전용 입력)을 확인하고 동결한다 — 같은 저장소의 토픽이고 그 전달 커밋(committedOID)이 묶음 기준 커밋이거나 그
  // 조상이어야 한다(기준에 들어 있지 않은 토픽의 원장은 싣지 않는다). 확인한 범위 세대·전달 커밋과 그때의 보류 원장을 함께 기록해, 뒤에 선행
  // 토픽이 범위를 바꾸거나 다시 커밋해도 승계 근거가 바뀌지 않게 한다. 원장을 읽는 사이 선행 토픽이 바뀌었으면 동결하지 않는다.
  private async freezePredecessor(topicId: string, baseOID: string): Promise<ExternalPredecessor> {
    const topic = this.database.listTopics().find((candidate) => candidate.id === topicId);
    if (!topic) throw new Error(`선행 토픽을 찾을 수 없습니다: ${topicId}`);
    if (resolve(topic.repositoryPath) !== resolve(this.repositoryPath))
      throw new Error(`선행 토픽이 이 작업 묶음과 다른 저장소의 토픽입니다: ${topicId}`);
    const committed = this.database.getFlags(topicId).committedOID;
    if (!committed) throw new Error(`선행 토픽에 전달(커밋)한 결과가 없습니다: ${topicId}`);
    if (committed !== baseOID && !(await this.git.isAncestor(this.repositoryPath, committed, baseOID)))
      throw new Error(`선행 토픽의 전달 커밋 ${committed} 가 작업 묶음 기준 커밋 ${baseOID} 에 포함되지 않았습니다.`);
    if (!this.options.deferredFindingsOf) throw new Error("선행 토픽의 보류 원장을 읽을 수 없어 묶음 밖 선행 토픽을 받지 않습니다.");
    const deferredFindings = await this.options.deferredFindingsOf(topicId);
    if (this.database.getTopic(topicId).scopeGeneration !== topic.scopeGeneration || this.database.getFlags(topicId).committedOID !== committed)
      throw new Error(`선행 토픽 ${topicId} 이(가) 확인하는 동안 바뀌었습니다. 묶음을 다시 만들어 주세요.`);
    return { topicId, scopeGeneration: topic.scopeGeneration, committedOID: committed, deferredFindings: structuredClone(deferredFindings),
      frozenAt: new Date().toISOString() };
  }

  // 골라 열 수 있는 단계(목록 뷰) — next(id, _, stageId) 가 받아들일 조건 중 DB 로 정해지는 전부다. next 와 같은 판정 함수(admit)를 그대로 부른다
  // (준비 중 예약이 있으면 그 단계만). git 이 필요한 확인(E4 전 닫힌 단계의 과거 결과 동결·승계 검사·기준 커밋)은 next 가 열 때 한다.
  selectableStages(group: WorkGroup): string[] {
    const reserved = reservation(group)?.stageId;
    return group.stages
      .filter((stage) => {
        try {
          this.admit(group, stage.id, reserved);
          return true;
        } catch {
          return false;
        }
      })
      .map((stage) => stage.id);
  }

  async next(
    id: string,
    prepared?: (topicId: string, worktreePath: string) => void,
    stageId?: string,
  ) {
    if (this.active.has(id)) throw new Error("다음 단계를 여는 중입니다.");
    this.active.add(id);
    try {
      return await this.createNext(id, prepared, stageId);
    } finally {
      this.active.delete(id);
    }
  }
  private async createNext(
    id: string,
    prepared: ((topicId: string, worktreePath: string) => void) | undefined,
    requested: string | undefined,
  ) {
    const group = this.database.workGroups.get(id);
    this.database.budgets.assertAvailable([id]);
    const reserved = reservation(group);
    const { stage, selected } = this.admit(group, requested, reserved?.stageId);
    const needed = inheritedStages(group, stage);
    // 선행 결과 확보 → 승계 검사 → 기준 커밋. 모두 동결 결과만 쓴다 — 작업 트리는 기준이 되지 않는다.
    const secured = await this.freezeLegacyResults(group, needed);
    const proof: StageProof[] = [];
    for (const stageId of needed)
      proof.push(await verifySuccession(this.database, this.git, secured, stageId));
    const { baseOID, mergeTargets } = await this.chooseBase(
      secured,
      needed,
      reserved?.value.baseOID,
    );
    const candidateId = randomUUID(),
      slug = `stage-${stage.id}`;
    const reservationValue = this.database.workGroups.reserve(id, stage.id, {
      topicId: candidateId,
      worktreePath: resolve(
        this.worktreesDirectory,
        `${slug}-${candidateId.slice(0, 8)}`,
      ),
      baseOID,
    });
    const { topicId, worktreePath } = reservationValue;
    prepared?.(topicId, worktreePath);
    if (reservationValue.baseOID !== baseOID)
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
    // 합류 대상이 있으면 엔진이 기준 커밋 위로 합류 대상 결과 커밋들(묶음 단계 순서)을 작업 트리에 커밋 없이 병합해 둔다(host-review F001). 단계 러너는
    // 병합을 직접 만들지 않고 충돌 표식만 해소하며, 인도 커밋이 부모 [기준, 합류 대상…] 병합 커밋이 된다. 예약한 작업 트리를 다시 쓸 때도 같은 호출이다 —
    // 이미 그 트리이면 git 이 아무것도 바꾸지 않는다.
    const preparedMerge = mergeTargets.length
      ? await this.prepareMerge(secured, worktreePath, baseOID, mergeTargets)
      : undefined;
    // 통합 단계는 연결 때 위키 기록 버전과 지금 버전을 잰다(단계 문맥·해시에 실린다).
    const memoryDrift =
      stage.kind === "integration" ? await this.measureMemory(secured) : undefined;
    // Recheck after the asynchronous Git boundary; never link against a changed common contract.
    // 착수 조건도 다시 본다 — 기다리는 사이 막혔던 단계가 재개됐으면 선택 착수는 성립하지 않는다(예약은 남아 다음 호출이 이어 연다).
    const current = this.database.workGroups.get(id);
    if (current.version !== group.version)
      throw new Error(
        "작업 묶음이 변경됐습니다. 생성한 작업 트리는 보존했습니다.",
      );
    this.admit(current, requested, stage.id);
    const budget = stage.budget ?? OBSERVE_USAGE;
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
          // 묶음 생성 전용 입력(없으면 기존 값). 묶음 밖 선행 작업은 토픽 참조로 잇지 않는다 — 묶음이 생성 때 동결한 원장을 모든 단계가
          // 이어받는다(inheritedDeferredFindings → deferredFindingsFor).
          branchPrefix: group.branchPrefix ?? "consensus",
          requestedBranchName: stage.branchName ?? null,
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
          budget,
          "explicit-stage-budget",
        );
      // 새 단계 토픽은 계획 제어 v2 로 시작한다(E4 2차 보완 F012) — 승계 결정·보류 지적 원문이 참조로 실려 끝까지 읽혀야 하고, 참조 전달은 계획 제어가
      // 적용되는 턴에만 켜진다. 이력 없는 DRAFT 라 enable 이 v2 를 고르고, 이미 정책이 있으면(예약 재사용·기존 토픽) 바꾸지 않는다. 토픽 생성·링크와
      // 같은 transaction 이라 링크가 실패하면 정책도 남지 않는다. 일반 토픽의 기본값(config.guardedPlanning)과는 무관하다.
      this.database.planning.enable(topicId);
      // 착수 규칙은 이 서비스가 판정했다(기본 착수도 대략 단계를 건너뛰어 첫 미연결 단계가 아닐 수 있다) — 저장소의 "앞 단계부터" 규칙 대신
      // 선택 연결로 부른다. 착수 방식(기본·선택)은 생성 이벤트 payload 의 selected 로 남긴다.
      this.database.workGroups.link(id, stage.id, topicId, baseOID, {
        selected: true,
        mergeTargets,
        ...(preparedMerge ? { preparedMerge } : {}),
        ...(memoryDrift ? { memoryDrift } : {}),
      });
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
      payload: { workGroupId: id, stageId: stage.id, baseOID, selected, mergeTargets },
    });
    return created;
  }

  // 착수 판정(DB 만, git 없음). 준비 중 예약이 있으면 그 단계만 이어서 연다 — 예약에는 착수 방식이 없으므로, 기본 규칙이 그 단계를 고르면 기본,
  // 아니면 선택 규칙으로 다시 판정한다(예약 뒤 막혔던 단계가 닫혀도 예약을 이어 열 수 있다).
  private admit(
    group: WorkGroup,
    requested: string | undefined,
    reserved: string | undefined,
  ): { stage: WorkStage; selected: boolean } {
    const find = (stageId: string) => {
      const stage = group.stages.find((candidate) => candidate.id === stageId);
      if (!stage) throw new Error(`단계 ${stageId} 를 찾을 수 없습니다.`);
      return stage;
    };
    if (requested !== undefined) find(requested);
    if (reserved !== undefined) {
      if (requested !== undefined && requested !== reserved)
        throw new Error(`준비 중인 단계 ${reserved} 를 먼저 연결하세요.`);
      const stage = find(reserved);
      if (!this.openStages(group).length && this.defaultCandidate(group).stage?.id === reserved)
        return { stage, selected: false };
      const blocker = this.selectionBlocker(group, stage);
      if (blocker) throw new Error(`준비 중인 단계를 열 수 없습니다 — ${blocker}`);
      return { stage, selected: true };
    }
    if (requested !== undefined) {
      const stage = find(requested);
      const blocker = this.selectionBlocker(group, stage);
      if (blocker) throw new Error(`단계를 골라 열 수 없습니다 — ${blocker}`);
      return { stage, selected: true };
    }
    const open = this.openStages(group);
    if (open.length)
      throw new Error(
        `열린 단계(${open.join(", ")})가 끝난 뒤 다음 단계를 여세요. 열린 단계가 모두 외부 결정으로 막혀 있으면 준비된 독립 단계를 골라 열 수 있습니다.`,
      );
    if (group.stages.every((stage) => group.links[stage.id]))
      throw new Error("모든 단계가 연결됐습니다.");
    const { stage, reasons } = this.defaultCandidate(group);
    if (!stage)
      throw new Error(`열 수 있는 준비된 단계가 없습니다 — ${reasons.join("; ")}`);
    return { stage, selected: false };
  }

  // 기본 착수: 연결 안 된 단계 중 앞에서부터 준비됐고 의존 폐포가 모두 닫힌 첫 단계. 통합 단계는 다른 모든 단계가 닫힌 뒤에만.
  private defaultCandidate(group: WorkGroup): { stage: WorkStage | null; reasons: string[] } {
    const reasons: string[] = [];
    for (const stage of group.stages) {
      if (group.links[stage.id]) continue;
      if (stage.kind === "integration") {
        const unfinished = group.stages
          .filter((other) => other.id !== stage.id && !this.closed(group, other.id))
          .map((other) => other.id);
        if (unfinished.length) {
          reasons.push(`${stage.id}: 통합 단계는 다른 모든 단계가 닫힌 뒤에 엽니다(남은 단계 ${unfinished.join(", ")})`);
          continue;
        }
      }
      const blocker = this.readinessBlocker(group, stage);
      if (!blocker) return { stage, reasons };
      reasons.push(blocker);
    }
    return { stage: null, reasons };
  }

  // 선택 착수의 DB 판정 전부 — (a) 열린 연결 단계가 모두 외부 결정으로 막힘 (b) 준비됨 (c) 의존 폐포가 모두 닫힘(동결 결과 또는 E4 전 닫힘)
  // (d) 통합 단계가 아님, 그리고 미연결. next 와 목록 뷰(selectableStages)가 이 함수 하나를 쓴다.
  private selectionBlocker(group: WorkGroup, stage: WorkStage): string | null {
    if (group.links[stage.id]) return `${stage.id}: 이미 연결된 단계입니다.`;
    if (stage.kind === "integration")
      return `${stage.id}: 통합 단계는 골라 열 수 없습니다 — 다른 모든 단계가 닫힌 뒤 기본 착수로 엽니다.`;
    const blocked = this.options.blockedExternally ?? (() => false);
    const running = this.openStages(group).filter((stageId) => !blocked(group.links[stageId].topicId));
    if (running.length)
      return `열린 단계 ${running.join(", ")} 가 외부 결정으로 막혀 있지 않습니다(진행 중이거나 자원 정지). 막힌 단계 옆에서만 다른 단계를 골라 엽니다.`;
    const blocker = this.readinessBlocker(group, stage);
    if (blocker) return blocker;
    // E4 전에 닫힌 의존 단계의 결과를 지금 동결하면 그 결과를 문맥에 싣는 열린 단계의 해시가 바뀌어 그 단계가 멈춘다 — 그 단계가 닫힌 뒤에 연다.
    const bound = this.boundContexts(group);
    for (const stageId of inheritedStages(group, stage)) {
      const holders = group.results?.[stageId] ? undefined : bound.get(stageId);
      if (holders?.length)
        return `${stage.id}: E4 전에 닫힌 의존 단계 ${stageId} 의 결과를 동결하면 열린 단계 ${holders.join(", ")} 의 단계 문맥이 바뀝니다 — 그 단계가 닫힌 뒤 여세요`;
    }
    return null;
  }

  // (b) 준비됨 (c) 의존 폐포가 모두 닫힘 — 기본·선택 착수가 같은 판정을 쓴다. 닫힘은 토픽 CLOSED 다: 묶음 단계는 결과를 동결한 뒤에만 닫히므로
  // 결과가 없는 닫힌 단계는 E4 전에 닫힌 것이고, next 가 이전 계약 증거로 동결한다.
  private readinessBlocker(group: WorkGroup, stage: WorkStage): string | null {
    if (!stageReady(group, stage.id)) {
      if (!stage.acceptance)
        return `${stage.id}: 완료 조건이 정해지지 않은 대략 단계입니다`;
      const questions = (group.questions ?? [])
        .filter((question) => question.blocksStart && !question.resolution && (question.stageId === null || question.stageId === stage.id))
        .map((question) => question.id);
      return `${stage.id}: 착수를 막는 미정 질문 ${questions.join(", ")} 이 해소되지 않았습니다`;
    }
    const closure = dependencyClosure(group, stage.id);
    const open = closure.filter((stageId) => group.links[stageId] && !this.closed(group, stageId));
    if (open.length) return `${stage.id}: 의존 단계 ${open.join(", ")} 가 아직 닫히지 않았습니다`;
    const unstarted = closure.filter((stageId) => !group.links[stageId]);
    if (unstarted.length) return `${stage.id}: 의존 단계 ${unstarted.join(", ")} 가 아직 착수되지 않았습니다`;
    return null;
  }

  private openStages(group: WorkGroup): string[] {
    return group.stages
      .filter((stage) => group.links[stage.id] && !this.closed(group, stage.id))
      .map((stage) => stage.id);
  }

  private closed(group: WorkGroup, stageId: string): boolean {
    return stageClosed(this.database, group, stageId);
  }

  private boundContexts(group: WorkGroup): Map<string, string[]> {
    return boundContexts(this.database, group);
  }

  // 합류 병합 준비 — 합류 대상 결과 커밋을 묶음 단계 순서로 기준 위에 병합한다(git.prepareMerge). 링크는 같은 대상·커밋만 받는다.
  private async prepareMerge(group: WorkGroup, worktreePath: string, baseOID: string, mergeTargets: string[]): Promise<PreparedMerge> {
    const targets = group.stages
      .filter((stage) => mergeTargets.includes(stage.id))
      .map((stage) => ({ stageId: stage.id, commitOID: group.results![stage.id].commitOID }));
    const merged = await this.git.prepareMerge(worktreePath, baseOID, targets.map((target) => target.commitOID));
    return { tree: merged.tree, conflicts: merged.conflicts, targets };
  }

  // 선행 결과 확보(E4-5) — E4 전에 닫힌 단계는 동결 결과가 없다. 이전 계약의 증거(승인 계획·리뷰 트리·push 된 커밋이 그 토픽 HEAD 이고 깨끗함)로
  // legacy 결과를 한 번, 이 단계를 연결하기 전에 동결한다. 기준 커밋 후보(heads)는 닫힌 결과 전부에서 고르므로 필요 없는 닫힌 단계도 동결을 시도한다 —
  // 이전 증거가 없거나 동결하면 열린 단계의 문맥이 바뀌는 단계는 기준 후보에서만 빠지고, 필요한 단계(의존 폐포, 통합이면 다른 모든 단계)면 거부한다.
  private async freezeLegacyResults(group: WorkGroup, needed: string[]): Promise<WorkGroup> {
    const refuse = (stageId: string, holders: string[] | undefined) => {
      if (!holders?.length) return false;
      if (needed.includes(stageId))
        throw new Error(`E4 전에 닫힌 의존 단계 ${stageId} 의 결과를 동결하면 열린 단계 ${holders.join(", ")} 의 단계 문맥이 바뀝니다 — 그 단계가 닫힌 뒤 여세요.`);
      return true;
    };
    for (const stage of group.stages) {
      const link = group.links[stage.id];
      if (!link || group.results?.[stage.id] || !this.closed(group, stage.id)) continue;
      if (refuse(stage.id, this.boundContexts(group).get(stage.id))) continue;
      let evidence: StageProof;
      try {
        evidence = await legacyEvidence(this.database, this.git, stage.id, link);
      } catch (error) {
        if (needed.includes(stage.id)) throw error;
        continue;
      }
      // git 경계 사이에 다른 단계가 결속(재계획 완료)됐을 수 있다 — 동결 직전(동기)에 다시 본다.
      const current = this.database.workGroups.get(group.id);
      if (current.results?.[stage.id] || refuse(stage.id, this.boundContexts(current).get(stage.id))) continue;
      this.database.workGroups.freezeResult(group.id, legacyResult(this.database, stage.id, link, evidence));
    }
    return this.database.workGroups.get(group.id);
  }

  // 기준 커밋(E4-6) — 닫힌 결과 커밋 중 다른 결과의 조상이 아닌 것(heads). 필요한 결과를 모두 포함하는 head 가 있으면 그중 가장 최근(closedAt),
  // 없으면 가장 최근 head 를 기준으로 하고 포함되지 않은 필요한 결과를 합류 대상으로 둔다(서버는 병합 커밋을 만들지 않는다 — 단계가 작업 안에서
  // 병합하고 리뷰받는다). 준비 중 예약이 있으면 그 기준을 이어 쓰되, 동결 결과(또는 묶음 기준) 커밋인지 확인하고 합류 대상을 그 기준으로 다시 잰다.
  private async chooseBase(
    group: WorkGroup,
    needed: string[],
    fixed: string | undefined,
  ): Promise<{ baseOID: string; mergeTargets: string[] }> {
    const cwd = group.repositoryPath;
    const contains = async (ancestor: string, descendant: string) =>
      ancestor === descendant || (await this.git.isAncestor(cwd, ancestor, descendant));
    const results = group.stages
      .map((stage) => group.results?.[stage.id])
      .filter((result) => result !== undefined && this.closed(group, result.stageId))
      .map((result) => result!);
    let baseOID: string;
    if (fixed !== undefined) {
      if (fixed !== group.baseOID && !results.some((result) => result.commitOID === fixed))
        throw new Error("준비 중인 단계의 기준 커밋이 동결된 단계 결과가 아닙니다.");
      baseOID = fixed;
    } else if (!results.length) baseOID = group.baseOID;
    else {
      const closedAt = new Map<string, string>();
      for (const result of results) {
        const known = closedAt.get(result.commitOID);
        if (known === undefined || known < result.closedAt) closedAt.set(result.commitOID, result.closedAt);
      }
      const commits = [...closedAt.keys()];
      const heads: string[] = [];
      for (const commit of commits) {
        let covered = false;
        for (const other of commits)
          if (other !== commit && (await contains(commit, other))) {
            covered = true;
            break;
          }
        if (!covered) heads.push(commit);
      }
      const complete: string[] = [];
      for (const head of heads) {
        let all = true;
        for (const stageId of needed)
          if (!(await contains(group.results![stageId].commitOID, head))) {
            all = false;
            break;
          }
        if (all) complete.push(head);
      }
      const latest = (list: string[]) =>
        [...list].sort((a, b) => closedAt.get(b)!.localeCompare(closedAt.get(a)!) || a.localeCompare(b))[0];
      baseOID = latest(complete.length ? complete : heads);
    }
    const mergeTargets: string[] = [];
    for (const stageId of needed)
      if (!(await contains(group.results![stageId].commitOID, baseOID))) mergeTargets.push(stageId);
    return { baseOID, mergeTargets };
  }

  // 통합 단계 문맥의 위키 대조 — 모든 단계 결과가 기록한 위키 문서(path, sha256)마다 지금 버전(없으면 null)을 재고, 기록 버전과 다른 것만 싣는다
  // (저장소 문맥도 다른 것만 싣는다 — 같은 문서는 알릴 것이 없다).
  private async measureMemory(group: WorkGroup): Promise<NonNullable<StageLink["memoryDrift"]>> {
    const drift: NonNullable<StageLink["memoryDrift"]> = [];
    for (const stage of group.stages) {
      const result = group.results?.[stage.id];
      if (!result || !this.closed(group, stage.id)) continue;
      for (const change of result.memoryChanges) {
        if (!this.options.memoryDirectory)
          throw new Error("공용 위키 경로가 없어 통합 단계의 위키 기록 버전을 잴 수 없습니다.");
        const currentSHA256 = await memorySHA256(this.options.memoryDirectory, change.path);
        if (currentSHA256 !== change.sha256)
          drift.push({ path: change.path, stageId: stage.id, recordedSHA256: change.sha256, currentSHA256 });
      }
    }
    return drift;
  }
}

function stageClosed(database: ConsensusDatabase, group: WorkGroup, stageId: string): boolean {
  const link = group.links[stageId];
  return Boolean(link) && database.getTopic(link.topicId).state === "CLOSED";
}

// 결과를 새로 동결하면 문맥(해시)이 바뀌는 열린 단계 — 단계 id → 그 결과를 문맥에 싣는 열린 단계들. 연결·재계획 때 기록한 해시로 결속된 열린 단계의
// 문맥에는 의존 폐포(통합이면 다른 모든 단계)의 동결 결과가 든다. 재계획 대기 단계는 대기를 풀 때 해시를 다시 기록하므로 제외한다.
function boundContexts(database: ConsensusDatabase, group: WorkGroup): Map<string, string[]> {
  const bound = new Map<string, string[]>();
  for (const stage of group.stages) {
    const link = group.links[stage.id];
    if (!link?.contextDigest || link.replanPending || stageClosed(database, group, stage.id)) continue;
    for (const stageId of inheritedStages(group, stage)) bound.set(stageId, [...(bound.get(stageId) ?? []), stage.id]);
  }
  return bound;
}

// E4 전에 닫힌 단계를 이전 계약 증거로 동결한 결과 — 결정·보류 지적 원장은 이전 계약에 없어 빈 목록이다. 닫힌 시각은 그 토픽의 마지막 갱신 시각이다.
function legacyResult(database: ConsensusDatabase, stageId: string, link: StageLink, evidence: StageProof): StageResult {
  return {
    stageId,
    topicId: link.topicId,
    baseOID: link.baseOID,
    commitOID: evidence.commit,
    reviewedTreeOID: evidence.verification,
    planSHA256: evidence.planSHA,
    evidenceDigest: null,
    verifications: [],
    memoryChanges: [],
    openQuestions: [],
    deferredFindings: [],
    decisions: [],
    closedAt: database.getTopic(link.topicId).updatedAt,
    legacy: true,
  };
}

// 준비 중 예약(연결 전 작업 트리) — 있으면 그 단계만 이어서 연다(기존 멱등).
function reservation(group: WorkGroup) {
  for (const stage of group.stages) {
    const value = group.pending?.[stage.id];
    if (value) return { stageId: stage.id, value };
  }
  return undefined;
}

// 이 단계가 이어받는 결과 — 의존 폐포. 통합 단계는 다른 모든 단계다(닫기 때 모든 단계 결과를 조상으로 요구하므로 기준·합류 대상도 그 기준으로 잰다).
function inheritedStages(group: WorkGroup, stage: WorkStage): string[] {
  return stage.kind === "integration"
    ? group.stages.filter((other) => other.id !== stage.id).map((other) => other.id)
    : dependencyClosure(group, stage.id);
}

// 이전 계약(E4 전)의 승계 증거 — 승인 계획·리뷰 트리·push 된 커밋(=커밋)이 있고, 그 토픽 HEAD 가 그 커밋이며 작업 트리가 깨끗하다.
async function legacyEvidence(
  database: ConsensusDatabase,
  git: GitService,
  stageId: string,
  link: StageLink,
): Promise<StageProof> {
  const topic = database.getTopic(link.topicId),
    flags = database.getFlags(topic.id);
  if (
    topic.state !== "CLOSED" ||
    !flags.pushedOID ||
    flags.pushedOID !== flags.committedOID ||
    !topic.approvedPlanSHA256 ||
    !flags.reviewedTreeOID
  )
    throw new Error(`E4 전에 닫힌 단계 ${stageId} 의 승인·리뷰·푸시 기록이 없어 결과를 승계할 수 없습니다.`);
  if (
    (await git.head(topic.worktreePath)) !== flags.pushedOID ||
    (await git.changedPaths(topic.worktreePath)).length
  )
    throw new Error(`단계 ${stageId} 의 전달 커밋이 변경됐습니다.`);
  return {
    stageId,
    commit: flags.pushedOID,
    planSHA: topic.approvedPlanSHA256,
    verification: flags.reviewedTreeOID,
  };
}

// 승계 검사(E4-5) — 동결 결과마다 ① 결과 커밋 트리 == 리뷰한 트리 ② 결과 커밋이 그 단계 기준 커밋의 후손(다른 계보 거부) ③ 그 토픽 HEAD 가
// 결과 커밋이고 작업 트리가 깨끗함. legacy 결과는 이전 검사(③)만, 동결 결과가 없는 E4 전 닫힌 단계는 이전 계약 증거로 판정한다.
async function verifySuccession(
  database: ConsensusDatabase,
  git: GitService,
  group: WorkGroup,
  stageId: string,
): Promise<StageProof> {
  const link = group.links[stageId];
  if (!link) throw new Error(`의존 단계 ${stageId} 가 아직 착수되지 않았습니다.`);
  const topic = database.getTopic(link.topicId);
  if (topic.state !== "CLOSED") throw new Error(`의존 단계 ${stageId} 가 아직 닫히지 않았습니다.`);
  const result = group.results?.[stageId];
  if (!result) return legacyEvidence(database, git, stageId, link);
  if (!result.legacy) {
    if ((await git.diffTrees(topic.worktreePath, result.commitOID, result.reviewedTreeOID)).files.length)
      throw new Error(`단계 ${stageId} 의 결과 커밋 트리가 리뷰한 트리와 다릅니다.`);
    if (!(await git.isAncestor(topic.worktreePath, link.baseOID, result.commitOID)))
      throw new Error(`단계 ${stageId} 의 결과 커밋이 그 단계 기준 커밋의 후손이 아닙니다.`);
  }
  if (
    (await git.head(topic.worktreePath)) !== result.commitOID ||
    (await git.changedPaths(topic.worktreePath)).length
  )
    throw new Error(`단계 ${stageId} 의 결과 커밋이 변경됐습니다(작업 트리 HEAD 가 다르거나 커밋하지 않은 변경이 있습니다).`);
  return {
    stageId,
    commit: result.commitOID,
    planSHA: result.planSHA256,
    verification: result.reviewedTreeOID,
  };
}

// 단계가 턴마다 다시 확인하는 선행 결과 — 의존 폐포와 합류 대상 결과의 승계 검사(단계 순서). 반환 형식은 기존과 같다.
export async function stageEvidence(
  database: ConsensusDatabase,
  git: GitService,
  group: WorkGroup,
  stageId: string,
): Promise<StageProof[]> {
  const stage = group.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error("단계를 찾을 수 없습니다.");
  const required = new Set([
    ...dependencyClosure(group, stageId),
    ...(group.links[stageId]?.mergeTargets ?? []),
  ]);
  const proof: StageProof[] = [];
  for (const candidate of group.stages)
    if (required.has(candidate.id))
      proof.push(await verifySuccession(database, git, group, candidate.id));
  return proof;
}

// 선행 결과 해석(host-review F005·F009) — 이 단계가 요구하는 선행 결과(의존 폐포, 통합이면 다른 모든 단계, 그리고 합류 대상)마다 묶음 단계 순서로:
//  - 동결 결과면 승계 검사(verifySuccession: 트리==리뷰 트리·기준의 후손·HEAD·clean, legacy 결과는 HEAD·clean).
//  - 동결 결과가 없는 E4 전 닫힌 단계면 이전 계약 증거(legacyEvidence)로 검증한다. freeze(기본)이면 동결해도 결속된 열린 단계의 문맥이 바뀌지 않을 때
//    legacy 결과로 동결하고(동결 직전 동기 재확인), 바뀌면 동결하지 않고 unfrozen 에 둔다. freeze:false 면 DB 를 쓰지 않고 증거를 unfrozen 에 둔다
//    (재개 정보처럼 부작용 없이 판정하는 호출자).
//  - 착수되지 않았거나 닫히지 않은 선행 단계, 검증 실패는 던진다.
// 이미 열린 E4 전 단계(통합 포함)의 턴·닫기가 새 next 없이 이 함수로 선행 결과를 확보한다 — 어댑터와 closeStage 가 같은 함수를 쓴다.
export async function resolvePriorResults(
  database: ConsensusDatabase,
  git: GitService,
  groupId: string,
  stageId: string,
  options: { freeze?: boolean } = {},
): Promise<PriorResolution> {
  const freeze = options.freeze ?? true;
  const group = database.workGroups.get(groupId);
  const stage = group.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error("단계를 찾을 수 없습니다.");
  const required = new Set([...inheritedStages(group, stage), ...(group.links[stageId]?.mergeTargets ?? [])]);
  const proof: StageProof[] = [];
  const unfrozen: StageProof[] = [];
  for (const candidate of group.stages) {
    if (!required.has(candidate.id)) continue;
    const current = database.workGroups.get(groupId);
    if (current.results?.[candidate.id]) {
      proof.push(await verifySuccession(database, git, current, candidate.id));
      continue;
    }
    const link = current.links[candidate.id];
    if (!link) throw new Error(`의존 단계 ${candidate.id} 가 아직 착수되지 않았습니다.`);
    if (!stageClosed(database, current, candidate.id)) throw new Error(`의존 단계 ${candidate.id} 가 아직 닫히지 않았습니다.`);
    const evidence = await legacyEvidence(database, git, candidate.id, link);
    proof.push(evidence);
    if (!freeze) {
      unfrozen.push(evidence);
      continue;
    }
    // git 경계 사이에 다른 호출이 같은 결과를 동결했거나 다른 단계가 해시로 결속됐을 수 있다 — 동결 직전(동기)에 다시 본다. 같은 증거로 이미 동결됐으면
    // 저장소가 같은 내용의 재동결을 무시한다(내용이 다르면 던진다).
    const latest = database.workGroups.get(groupId);
    if (!latest.results?.[candidate.id] && boundContexts(database, latest).get(candidate.id)?.length) {
      unfrozen.push(evidence);
      continue;
    }
    database.workGroups.freezeResult(groupId, legacyResult(database, candidate.id, link, evidence));
  }
  return { group: database.workGroups.get(groupId), proof, unfrozen };
}

// 위키 문서의 지금 버전(sha256, 쓰기 때와 같은 utf8 기준). 결과에 기록된 경로는 쓰기 때 메모리 루트 안으로 검증됐다 — 루트 밖을 가리키면 읽지 않고
// "지금 없음"으로 잰다.
async function memorySHA256(root: string, path: string): Promise<string | null> {
  const base = resolve(root),
    target = resolve(base, path),
    inside = relative(base, target);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  try {
    return createHash("sha256").update(await readFile(target, "utf8"), "utf8").digest("hex");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
}
