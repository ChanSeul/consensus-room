import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { redactSecrets } from "../shared/workflow.js";
import type { DeferredFinding } from "../shared/contracts.js";
import {
  WorkGroupInputSchema,
  workQuestionResultText,
  dependencyClosure,
  type PreparedMerge,
  type StageDecision,
  type StageLink,
  type StageResult,
  type StageSeparation,
  type WorkGroup,
  type WorkGroupInput,
  type WorkGroupRevision,
  type WorkStage,
} from "../shared/workGroups.js";
import { BUDGET_KEYS, hasBudgetLimits, OBSERVE_USAGE, type BudgetPolicy } from "../shared/budgets.js";

// 단계 문맥(엔진 개편 E4-3) — 단계 토픽의 턴 머리말과 결속 해시의 유일한 원천이다. 머리말(renderContext)과 해시(digestContext)를 같은
// 객체에서 만들어, 해시가 구성상 실제로 전달한 내용과 같게 한다. 담는 것: 묶음 목표·공통 계약, 자기 단계 서술(분리 근거·체크리스트 포함), 이
// 단계와 묶음 전체 질문, 이어받는 단계의 동결 결과(통합 단계는 모든 단계 결과), 합류 대상과 엔진이 준비한 병합, 통합이면 기록 뒤 바뀐 위키 문서.
// 미래·다른 단계 서술·체크리스트, 순서, 예산은 담지 않는다 — 그런 개정은 이 단계를 다시 계획하게 하지 않는다.
export interface StageContextResult {
  stageId: string;
  commitOID: string;
  planSHA256: string;
  reviewedTreeOID: string;
  verifications: Array<{ id: string; status: string }>;
  memoryChanges: Array<{ path: string; sha256: string }>;
  openQuestions: string[];
  // 머리말은 결과를 요약만 한다(E4 2차 보완 F012) — 결과 줄에 전문을 실으면 결과 수에 비례해 커져 계획 제어 패킷 상한(계획 64KB·감사 96KB)을 넘는다.
  // 보류 지적은 ID 목록과 개수만 싣고 근거 전문은 그 턴의 이연 쟁점 목록(인라인 예산 또는 원문 산출물 참조)이 싣는다. 넘긴 결정은 개수와 요약 해시
  // (정렬한 {topicId, sequence, sha256} 목록의 정본 JSON sha256)만 싣고 원문은 받는 토픽 타임라인의 '승계 결정' 이벤트(참조)로 간다. 없으면 필드도 없다.
  deferredFindings?: { count: number; ids: string[] };
  decisions?: { count: number; digest: string };
  legacy?: boolean;
}
export interface StageContext {
  goal: string;
  contracts: string;
  stage: { id: string; kind: WorkStage["kind"]; title: string; goal: string; acceptance?: string; outcome?: string; separation?: StageSeparation;
    checklist?: string[]; evidenceRootIds?: string[] };
  questions: Array<{ id: string; text: string; blocksStart: boolean; resolution?: string; deferredReason?: string }>;
  priorResults: StageContextResult[];
  mergeTargets: Array<{ stageId: string; result?: StageContextResult }>;
  merge?: PreparedMerge;
  integration: boolean;
  memoryDrift?: NonNullable<StageLink["memoryDrift"]>;
}
export type StageContextState =
  | { linked: false }
  | { linked: true; groupId: string; stageId: string; current: boolean; reason?: "replan-pending" | "digest-changed" | "version-changed" };
// 개정 미리 보기(D2). closed 는 미리 보기가 닫혔다고 판정한 연결 단계다 — 적용도 같은 판정으로 그 링크를 바이트 그대로 둔다.
export interface RevisionPreview {
  mode: "revise" | "reapply";
  group: WorkGroup;
  revision: WorkGroupRevision | null;
  affected: string[];
  closed: string[];
}
export interface LinkOptions {
  selected?: boolean;
  mergeTargets?: string[];
  memoryDrift?: StageLink["memoryDrift"];
  // 합류 대상이 있으면 필수 — 엔진(서비스)이 연결 전에 준비한 병합(§5.1).
  preparedMerge?: PreparedMerge;
}
// prompt() 호환 — 동결 결과가 없는 E4 전 선행 단계의 검증 증거 한 줄.
export type PriorLine = { stageId: string; commit: string; planSHA: string; verification: string };

const CONTEXT_CHANGED = "공통 계약이 바뀌었습니다. 현재 단계의 계획을 다시 승인해야 합니다.";
const REPLAN_PENDING = "작업 묶음 개정으로 이 단계의 재계획을 기다립니다. 같은 개정을 다시 적용한 뒤 진행하세요.";
const GROUP_CHANGED = "작업 묶음이 변경됐습니다.";

export class WorkGroups {
  constructor(private readonly db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS work_groups(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)",
    );
  }
  // 이미 열린 transaction 안(호출자가 atomic 이나 DB transaction 으로 묶은 경우)이면 그 transaction 에 합류한다 — 개정 적용·재계획 해제·
  // 결과 동결은 스스로 한 transaction 이어야 하지만, 호출자의 더 큰 transaction 안에서 불려도 중첩 BEGIN 으로 실패하면 안 된다.
  atomic<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
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
  // 과거 레코드(E4 전)는 새 필드(questions·revisions·retiredStageIds·results, 연결의 contextDigest)가 없다. 읽을 때 채우지 않고 쓰는 곳에서
  // `?? 빈 값` 으로 읽는다(마이그레이션 없음) — 읽기만으로 레코드 모양이 바뀌지 않는다.
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
    const row = this.db.prepare(`SELECT record_json FROM work_groups
      WHERE EXISTS (SELECT 1 FROM json_each(work_groups.record_json, '$.links')
        WHERE json_extract(value, '$.topicId')=?) ORDER BY rowid LIMIT 1`).get(topicId);
    return row ? JSON.parse(String(row.record_json)) as WorkGroup : null;
  }
  // options 는 생성 전용 입력(검증은 서비스가 끝냈다) — 없으면 레코드에 필드를 두지 않아 기존 동작과 같다.
  create(
    id: string,
    input: WorkGroupInput,
    repositoryPath: string,
    baseOID: string,
    options: Pick<WorkGroup, "branchPrefix" | "predecessor" | "parentTopicId"> = {},
  ): WorkGroup {
    const group: WorkGroup = {
      ...sanitizeInput(input),
      id,
      repositoryPath,
      baseOID,
      ...compact({ parentTopicId: options.parentTopicId, branchPrefix: options.branchPrefix, predecessor: options.predecessor ? structuredClone(options.predecessor) : undefined }),
      version: 1,
      createdAt: new Date().toISOString(),
      links: {},
      revisions: [],
      retiredStageIds: [],
      results: {},
    };
    this.db
      .prepare("INSERT INTO work_groups VALUES (?,?)")
      .run(id, JSON.stringify(group));
    return group;
  }
  // 묶음 예산 정책: 묶음 입력의 budgetPolicy 가 있으면 그것, 없으면 예산을 선언한 단계들만으로(total 합·execution 최대) 정한다. 대략 단계
  // (예산 없음)는 합에 들지 않는다. 개정은 이 값으로 묶음 계정을 다시 설정하지 않는다(증액은 예산 승인 경로).
  groupPolicy(group: WorkGroup | WorkGroupInput): BudgetPolicy {
    if (group.budgetPolicy) return group.budgetPolicy;
    const declared = group.stages.flatMap((s) => (s.budget ? [s.budget] : []));
    if (!declared.length || group.stages.some(stage => stage.acceptance && !stage.budget) || declared.some(policy => !hasBudgetLimits(policy))) return OBSERVE_USAGE;
    const bounded = declared.filter(hasBudgetLimits);
    return {
      execution: Object.fromEntries(BUDGET_KEYS.map((key) => [key, Math.max(...bounded.map((b) => b.execution[key]))])),
      total: Object.fromEntries(BUDGET_KEYS.map((key) => [key, bounded.reduce((sum, b) => sum + b.total[key], 0)])),
    } as BudgetPolicy;
  }
  // selected 가 없으면 기존 규칙("앞 단계부터" = 연결 안 된 첫 단계)이다 — 기존 호출·검사 호환. 착수 선택 규칙(외부 결정 막힘·준비·의존 폐포·
  // integration 제외)은 서비스가 검증하고 selected: true 로 부른다. 문맥 해시는 호출자가 넘기지 않고 저장소가 연결 뒤 레코드로 계산한다 —
  // 합류 대상·위키 변동도 문맥에 들기 때문이다.
  link(id: string, stageId: string, topicId: string, baseOID: string, options: LinkOptions = {}): void {
    const g = this.get(id);
    if (
      !g.stages.some((s) => s.id === stageId) ||
      g.links[stageId] ||
      this.forTopic(topicId)
    )
      throw new Error("단계 연결이 중복되거나 잘못됐습니다.");
    if (!options.selected && g.stages.find((s) => !g.links[s.id])?.id !== stageId)
      throw new Error("앞 단계부터 연결하세요.");
    // 합류 대상은 기준 커밋에 모이지 않은 선행 결과다 — 이 단계가 이어받는 범위(의존 폐포, 통합이면 다른 모든 단계) 밖은 병합할 이유가 없다.
    const inherited = new Set(inheritedStages(g, stageId));
    if (options.mergeTargets?.some((target) => !inherited.has(target)))
      throw new Error("합류 대상은 이 단계의 의존 단계여야 합니다.");
    // 합류 대상은 엔진이 병합을 준비해야만 받는다 — 단계 러너는 병합을 직접 만들 수 없다(F001). 준비한 병합은 합류 대상과 같은 단계 집합이고, 각
    // 커밋은 지금 동결 결과의 커밋이어야 한다(다른 커밋을 병합해 두고 연결하지 않게).
    const targets = options.mergeTargets ?? [];
    if (targets.length) {
      const merge = options.preparedMerge;
      if (!merge) throw new Error("합류 대상이 있으면 엔진이 준비한 병합(preparedMerge)이 필요합니다.");
      const prepared = merge.targets.map((target) => target.stageId);
      if (new Set(targets).size !== targets.length || prepared.length !== targets.length || !targets.every((id) => prepared.includes(id)))
        throw new Error("준비한 병합의 대상이 합류 대상과 다릅니다.");
      for (const target of merge.targets)
        if (g.results?.[target.stageId]?.commitOID !== target.commitOID)
          throw new Error(`준비한 병합의 ${target.stageId} 커밋이 동결 결과와 다릅니다.`);
    } else if (options.preparedMerge) throw new Error("합류 대상이 없으면 준비한 병합을 받지 않습니다.");
    const link: StageLink = { topicId, baseOID, groupVersion: g.version };
    if (targets.length) {
      link.mergeTargets = [...targets];
      link.preparedMerge = structuredClone(options.preparedMerge!);
    }
    if (options.memoryDrift) link.memoryDrift = options.memoryDrift.map((entry) => ({ ...entry }));
    g.links[stageId] = link;
    link.contextDigest = digestContext(buildStageContext(g, stageId));
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

  stageContext(group: WorkGroup, stageId: string): StageContext {
    return buildStageContext(group, stageId);
  }
  renderStageContext(group: WorkGroup, stageId: string): string {
    return renderContext(buildStageContext(group, stageId));
  }
  stageContextDigest(group: WorkGroup, stageId: string): string {
    return digestContext(buildStageContext(group, stageId));
  }
  // 승계 도우미(§4) — database.workGroups.X(...) 로도 부를 수 있게 같은 export 함수를 잇는다.
  inheritedDecisions(group: WorkGroup, stageId: string): Array<{ stageId: string; decision: StageDecision }> {
    return inheritedDecisions(group, stageId);
  }
  inheritedDeferredFindings(group: WorkGroup, stageId: string): DeferredFinding[] {
    return inheritedDeferredFindings(group, stageId);
  }
  inheritedDecisionEvent(groupId: string, entry: { stageId: string; decision: StageDecision }): ReturnType<typeof inheritedDecisionEvent> {
    return inheritedDecisionEvent(groupId, entry);
  }
  // 연결 단계의 문맥 결속. 재계획 대기면 현재가 아니다. 연결·재계획 완료 때 기록한 해시가 있으면 지금 해시와 대조하고, 없으면(E4 전 연결)
  // 묶음 버전으로만 대조한다.
  stageContextState(topicId: string): StageContextState {
    const g = this.forTopic(topicId);
    if (!g) return { linked: false };
    const [stageId, link] = Object.entries(g.links).find(([, l]) => l.topicId === topicId)!;
    const base = { linked: true as const, groupId: g.id, stageId };
    if (link.replanPending) return { ...base, current: false, reason: "replan-pending" };
    if (link.contextDigest !== undefined)
      return digestContext(buildStageContext(g, stageId)) === link.contextDigest
        ? { ...base, current: true } : { ...base, current: false, reason: "digest-changed" };
    return link.groupVersion === g.version ? { ...base, current: true } : { ...base, current: false, reason: "version-changed" };
  }
  assertStageContextCurrent(topicId: string): void {
    const state = this.stageContextState(topicId);
    if (!state.linked || state.current) return;
    if (state.reason === "replan-pending") throw new Error(REPLAN_PENDING);
    throw new Error(`${CONTEXT_CHANGED} ${state.reason === "digest-changed"
      ? "(단계 문맥이 연결·재계획 때와 다릅니다.)" : "(작업 묶음 버전이 연결 때와 다릅니다.)"}`);
  }
  // 코어 응답 채택 경계용 — 동기, DB 만 본다.
  isStageContextCurrent(topicId: string): boolean {
    const state = this.stageContextState(topicId);
    return !state.linked || state.current;
  }

  // 개정 미리 보기(D2 — 저장하지 않는다). closed(topicId) 는 호출자가 판정한 닫힌 단계다(app: 토픽이 CLOSED).
  previewRevision(
    id: string,
    input: WorkGroupInput,
    expectedVersion: number,
    closed?: (topicId: string) => boolean,
  ): RevisionPreview {
    const old = this.get(id);
    const closedIds = new Set(Object.entries(old.links).filter(([, link]) => closed?.(link.topicId)).map(([stageId]) => stageId));
    return planRevision(old, sanitizeInput(input), expectedVersion, closedIds);
  }
  // 개정 적용(한 transaction). 미리 보기 결과를 믿지 않고 같은 입력·같은 닫힌 단계 판정으로 지금 레코드에서 다시 계산한다 — 미리 보기 뒤
  // 연결이 바뀌어 영향 단계가 달라졌으면 거부한다. 같은 개정이 이미 저장됐으면(재적용) 레코드를 바꾸지 않는다.
  //  - 닫힌 단계: 링크를 바이트 그대로 둔다(버전·해시·대기 모두 없음).
  //  - 영향 단계: 재계획 대기 {version, fromGeneration}. 이미 대기면 처음 대기를 유지한다(그 세대가 오른 뒤에만 풀린다).
  //  - 영향 없는 열린 단계: groupVersion 을 새 버전으로, 해시는 다시 계산한다(정의상 같은 값). E4 전 연결은 해시를 새로 붙이지 않는다.
  applyRevision(
    id: string,
    preview: RevisionPreview,
    generations: Record<string, number>,
    origin?: string | null,
  ): WorkGroup {
    return this.atomic(() => {
      const current = this.get(id);
      if (preview.mode === "reapply") return current;
      const closedIds = new Set(preview.closed);
      const again = planRevision(current, sanitizeInput(inputFields(preview.group)), preview.group.version - 1, closedIds);
      if (again.mode === "reapply") return current;
      if (canonical(again.affected) !== canonical(preview.affected)) throw new Error(GROUP_CHANGED);
      const next = again.group;
      const links: Record<string, StageLink> = {};
      for (const [stageId, link] of Object.entries(current.links)) {
        if (closedIds.has(stageId)) links[stageId] = link;
        else if (again.affected.includes(stageId)) {
          if (link.replanPending) { links[stageId] = link; continue; }
          const generation = generations[stageId];
          if (!Number.isInteger(generation)) throw new Error(`재계획을 기다릴 단계의 범위 세대가 필요합니다: ${stageId}`);
          links[stageId] = { ...link, replanPending: { version: next.version, fromGeneration: generation } };
        } else
          links[stageId] = { ...link, groupVersion: next.version,
            ...(link.contextDigest !== undefined ? { contextDigest: digestContext(buildStageContext(next, stageId)) } : {}) };
      }
      next.links = links;
      next.revisions = [...(current.revisions ?? []), { ...again.revision!, origin: origin ?? null }];
      this.save(next);
      return next;
    });
  }
  // 기존 호출 호환: 미리 보기 + 적용. 범위 세대를 모르므로 재계획 대기를 만들 수 없다 — 영향 단계가 있으면 공개 API(app)로 하게 한다.
  revise(
    id: string,
    input: WorkGroupInput,
    expectedVersion: number,
  ): WorkGroup {
    const preview = this.previewRevision(id, input, expectedVersion);
    if (preview.mode === "reapply") return preview.group;
    if (preview.affected.length) throw new Error("연결 단계가 있는 개정은 API 로 하세요");
    return this.applyRevision(id, preview, {});
  }
  // 재계획 완료: 대기 중이고 그 단계 토픽의 범위 세대가 대기를 켤 때보다 올랐으면 대기를 풀고 지금 문맥으로 다시 결속한다. 조건이 안 맞으면
  // 던지지 않고 false — 재적용이 여러 번 불려도 해제는 한 번뿐이다.
  completeReplan(id: string, stageId: string, currentGeneration: number): boolean {
    return this.atomic(() => {
      const g = this.get(id);
      const link = g.links[stageId];
      if (!link?.replanPending || !(currentGeneration > link.replanPending.fromGeneration)) return false;
      delete link.replanPending;
      link.groupVersion = g.version;
      link.contextDigest = digestContext(buildStageContext(g, stageId));
      this.save(g);
      return true;
    });
  }
  // 기존 호출 호환: 대기와 무관하게 지금 버전·문맥으로 다시 결속한다. 재계획 대기는 풀지 않는다(해제는 completeReplan 의 세대 비교뿐).
  acknowledgeRevision(id: string, stageId: string): void {
    const g = this.get(id);
    g.links[stageId].groupVersion = g.version;
    g.links[stageId].contextDigest = digestContext(buildStageContext(g, stageId));
    this.save(g);
  }
  // 단계 결과 동결(E4-5). 한 번 쓴 결과는 덮어쓰지 않는다 — 같은 내용(동결 시각 제외)의 재호출은 무시하고 다른 내용은 거부한다. 예외는
  // close 가 결과를 먼저 쓰고 CLOSED 전이에 실패해 재시도하는 경우다: 호출자가 토픽이 아직 닫히지 않았을 때만 replaceUnclosed 로 교체한다.
  freezeResult(id: string, result: StageResult, options: { replaceUnclosed?: boolean } = {}): void {
    this.atomic(() => {
      const g = this.get(id);
      const link = g.links[result.stageId];
      if (!link || link.topicId !== result.topicId) throw new Error("단계 결과가 단계 연결과 맞지 않습니다.");
      const existing = g.results?.[result.stageId];
      if (existing && !options.replaceUnclosed) {
        const { closedAt: _before, ...kept } = existing;
        const { closedAt: _after, ...offered } = result;
        if (canonical(kept) === canonical(offered)) return;
        throw new Error("동결된 단계 결과는 바꿀 수 없습니다.");
      }
      g.results = { ...(g.results ?? {}), [result.stageId]: structuredClone(result) };
      this.save(g);
    });
  }
  // 기존 호출 호환 머리말. 연결 단계면 단계 문맥 머리말이다. prior 는 동결 결과가 없는 E4 전 흐름의 증거다 — 동결 결과(선행·합류)가 이미 덮은
  // 단계는 무시하고, 덮지 않은 단계만 옛 줄 형식으로 잇는다. 과거 결과가 동결된 뒤에는 renderStageContext 와 같다.
  prompt(
    topicId: string,
    prior: PriorLine[],
  ): string {
    const g = this.forTopic(topicId);
    if (!g) return "";
    const stageId = Object.entries(g.links).find(([, link]) => link.topicId === topicId)![0];
    const context = buildStageContext(g, stageId);
    const covered = new Set([...context.priorResults.map((r) => r.stageId),
      ...context.mergeTargets.filter((m) => m.result).map((m) => m.stageId)]);
    return renderContext(context, prior.filter((p) => !covered.has(p.stageId)));
  }
  // 계층 연결은 단계 계약을 개정하거나 동결 결과를 무효화하지 않는다.
  attachParent(id: string, parentTopicId: string): void {
    const group = this.get(id);
    if (group.parentTopicId && group.parentTopicId !== parentTopicId)
      throw new Error("작업 묶음에는 이미 부모 주제가 있습니다.");
    if (Object.keys(group.pending ?? {}).length) throw new Error("준비 중인 단계가 있어 계층을 변경할 수 없습니다.");
    if (group.parentTopicId !== parentTopicId) this.save({ ...group, parentTopicId });
  }
  private save(g: WorkGroup) {
    this.db
      .prepare("UPDATE work_groups SET record_json=? WHERE id=?")
      .run(JSON.stringify(g), g.id);
  }
}

// ---- 단계 문맥 ----------------------------------------------------------------------------------------------------------

// 이 단계가 결과를 이어받는 단계 — 통합 단계는 다른 모든 단계(닫을 때 모든 결과를 조상으로 요구받는다), 그 밖은 의존 폐포다. 문맥의 선행 결과와
// 연결의 합류 대상 허용 범위가 이 한 기준을 쓴다 — 둘이 갈리면 통합이 의존하지 않는 단계를 합류 대상으로 받지 못해 통합을 열 수 없다.
function inheritedStages(group: Pick<WorkGroupInput, "stages">, stageId: string): string[] {
  return group.stages.find((s) => s.id === stageId)?.kind === "integration"
    ? group.stages.map((s) => s.id).filter((id) => id !== stageId) : dependencyClosure(group, stageId);
}

// ---- 승계(결정·보류 지적) 도우미(§4) — 이어받는 단계의 동결 결과에서 묶음 단계 순서대로 모으고 중복을 뺀다 --------------------------------------

// 넘긴 결정 — 원문은 받는 토픽 타임라인의 '승계 결정' 이벤트로 싣는다(생성: 서비스, 범위 변경: workflow). 중복 키는 토픽+순번이다.
export function inheritedDecisions(group: WorkGroup, stageId: string): Array<{ stageId: string; decision: StageDecision }> {
  const seen = new Set<string>();
  const out: Array<{ stageId: string; decision: StageDecision }> = [];
  for (const id of inheritedStages(group, stageId))
    for (const decision of group.results?.[id]?.decisions ?? []) {
      const key = `${decision.topicId}\u0000${decision.sequence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ stageId: id, decision: { ...decision } });
    }
  return out;
}
// 보류 지적 원장 — 계획·감사 프롬프트의 기존 이연 목록 경로(core.deferredFindingsFor)가 싣는다. 중복 키는 토픽+지적 ID 다.
export function inheritedDeferredFindings(group: WorkGroup, stageId: string): DeferredFinding[] {
  const seen = new Set<string>();
  const out: DeferredFinding[] = [];
  const add = (finding: DeferredFinding) => {
    const key = `${finding.topicId}\u0000${finding.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...finding });
  };
  // 묶음 밖 선행 작업의 보류 원장(생성 때 동결) — 모든 단계가 그 결과를 담은 묶음 기준 위에서 시작하므로 모든 단계가 이어받는다.
  for (const finding of group.predecessor?.deferredFindings ?? []) add(finding);
  for (const id of inheritedStages(group, stageId))
    for (const finding of group.results?.[id]?.deferredFindings ?? []) add(finding);
  return out;
}
// 승계 결정을 받는 토픽 타임라인에 넣을 이벤트 입력 — 생성(서비스)과 범위 변경(workflow)이 같은 함수를 써서 같은 본문·표식을 만든다.
export function inheritedDecisionEvent(groupId: string, entry: { stageId: string; decision: StageDecision }): {
  actor: "user"; kind: "decision"; body: string;
  payload: { inheritedDecision: { groupId: string; stageId: string; topicId: string; sequence: number; scopeGeneration: number; sha256: string } };
} {
  const { stageId, decision } = entry;
  return {
    actor: "user", kind: "decision",
    body: `승계 결정 — 단계 ${stageId}(토픽 ${decision.topicId} #${decision.sequence}, 범위 세대 ${decision.scopeGeneration}, sha256 ${decision.sha256}):\n\n${decision.body}`,
    payload: { inheritedDecision: { groupId, stageId, topicId: decision.topicId, sequence: decision.sequence,
      scopeGeneration: decision.scopeGeneration, sha256: decision.sha256 } },
  };
}

const resultView = (r: StageResult, seenDeferred?: Set<string>): StageContextResult => ({
  stageId: r.stageId, commitOID: r.commitOID, planSHA256: r.planSHA256, reviewedTreeOID: r.reviewedTreeOID,
  verifications: r.verifications.map((v) => ({ id: v.id, status: v.status })),
  memoryChanges: r.memoryChanges.map((m) => ({ path: m.path, sha256: m.sha256 })),
  openQuestions: [...r.openQuestions, ...(r.deferredQuestions ?? []).map(workQuestionResultText).filter(text => {
    if (!seenDeferred) return true;
    if (seenDeferred.has(text)) return false;
    seenDeferred.add(text);
    return true;
  })],
  ...(r.deferredFindings.length ? { deferredFindings: { count: r.deferredFindings.length, ids: r.deferredFindings.map((f) => f.id) } } : {}),
  ...(r.decisions.length ? { decisions: { count: r.decisions.length, digest: decisionDigest(r.decisions) } } : {}),
  ...(r.legacy ? { legacy: true } : {}),
});
// 넘긴 결정 요약 해시 — 토픽·순번 순으로 정렬한 {topicId, sequence, sha256} 목록의 정본 JSON sha256. 결정 원문은 각 sha256 이 결속한다.
export function decisionDigest(decisions: ReadonlyArray<Pick<StageDecision, "topicId" | "sequence" | "sha256">>): string {
  const sortedRefs = [...decisions].map((d) => ({ topicId: d.topicId, sequence: d.sequence, sha256: d.sha256 }))
    .sort((left, right) => left.topicId < right.topicId ? -1 : left.topicId > right.topicId ? 1 : left.sequence - right.sequence);
  return createHash("sha256").update(canonical(sortedRefs)).digest("hex");
}

export function buildStageContext(group: WorkGroup, stageId: string): StageContext {
  const stage = group.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error("단계를 찾을 수 없습니다.");
  const results = group.results ?? {};
  const link = group.links[stageId];
  const integration = stage.kind === "integration";
  const priorIds = inheritedStages(group, stageId);
  const questions = (group.questions ?? []).filter((q) => q.stageId === null || q.stageId === stageId);
  // Only the new exclusion format is deduplicated. Legacy result arrays retain their exact approved context hash.
  const seenDeferred = new Set(questions.filter(q => !q.resolution && q.deferredReason).map(workQuestionResultText));
  const priorResults = priorIds.filter(id => results[id]).map(id => resultView(results[id], seenDeferred));
  return {
    goal: group.goal,
    contracts: group.contracts,
    // 자기 단계 체크리스트는 계획 입력이다(F008) — 연결 뒤에는 개정으로 바꿀 수 없으므로(shapeOf) 연결 단계의 해시를 흔들지 않는다.
    stage: compact({ id: stage.id, kind: stage.kind, title: stage.title, goal: stage.goal, acceptance: stage.acceptance, outcome: stage.outcome,
      evidenceRootIds: stage.evidenceRootIds ? [...stage.evidenceRootIds] : undefined,
      separation: stage.separation ? compact({ ...stage.separation }) as StageSeparation : undefined,
      checklist: stage.checklist?.length ? [...stage.checklist] : undefined }) as StageContext["stage"],
    questions: questions
      .map((q) => compact({ id: q.id, text: q.text, blocksStart: q.blocksStart, resolution: q.resolution, deferredReason: q.deferredReason }) as StageContext["questions"][number]),
    priorResults,
    mergeTargets: (link?.mergeTargets ?? []).map((target) => ({ stageId: target, ...(results[target] ? { result: resultView(results[target]) } : {}) })),
    ...(link?.preparedMerge ? { merge: structuredClone(link.preparedMerge) } : {}),
    integration,
    // 통합 단계에는 결과가 기록한 위키 문서 가운데 연결 때 버전이 기록 버전과 다른 것만 싣는다 — 같은 문서는 알릴 것이 없고, 싣지 않는 값은
    // 해시에도 넣지 않는다(해시 = 전달 내용).
    ...(integration ? { memoryDrift: (link?.memoryDrift ?? []).filter((d) => d.recordedSHA256 !== d.currentSHA256).map((d) => ({ ...d })) } : {}),
  };
}

const BASIS_LABEL: Record<StageSeparation["basis"], string> = {
  "prior-result": "선행 결과를 봐야 설계를 정할 수 있음",
  "independent-verification": "이 단계만의 완료 조건으로 따로 검증함",
  rollback: "이 단계만 되돌려 위험을 줄임",
};
const resultLines = (r: StageContextResult): string[] => [
  `${r.stageId}: commit ${r.commitOID}, plan SHA ${r.planSHA256}, 리뷰 트리 ${r.reviewedTreeOID}, 검증 ${r.verifications.length
    ? r.verifications.map((v) => `${v.id}=${v.status}`).join(", ") : "기록 없음"}${r.legacy ? " (E4 전 결과 — 이전 계약 증거로 동결)" : ""}`,
  ...(r.memoryChanges.length ? [`  위키 변경: ${r.memoryChanges.map((m) => `${m.path}@${m.sha256}`).join(", ")}`] : []),
  ...(r.openQuestions.length ? [`  미해결 사항: ${r.openQuestions.join(" / ")}`] : []),
  ...(r.deferredFindings ? [`  보류 지적 ${r.deferredFindings.count}건: ${r.deferredFindings.ids.join(", ")} — 근거 전문은 이 턴의 이연 쟁점 목록(인라인 또는 원문 산출물 참조)에 있습니다.`] : []),
  ...(r.decisions ? [`  넘긴 결정 ${r.decisions.count}건(요약 sha256 ${r.decisions.digest}) — 원문은 이 토픽 타임라인의 '승계 결정' 이벤트로 읽으세요.`] : []),
];

// 머리말은 문맥 객체의 값을 전부 싣는다 — 싣지 않는 값이 해시에 있으면 해시가 전달 내용과 달라진다(검사: 모든 문자열 값이 머리말에 있다).
// legacyPrior 는 prompt() 호환(E4 전 흐름의 동결되지 않은 선행 증거)에서만 붙는다.
export function renderContext(context: StageContext, legacyPrior: PriorLine[] = []): string {
  const { stage } = context;
  const lines = [
    `전체 목표: ${context.goal}`,
    `공통 계약: ${context.contracts}`,
    `현재 단계: ${stage.title} (단계 ID ${stage.id}, 종류 ${stage.kind})`,
    `이번 목표: ${stage.goal}`,
    `완료 조건: ${stage.acceptance ?? "(정하지 않음)"}`,
  ];
  if (stage.evidenceRootIds) lines.push(`이 단계의 근거 루트: ${stage.evidenceRootIds.join(", ")}`);
  if (stage.outcome !== undefined) lines.push(`단계 결과(outcome): ${stage.outcome}`);
  if (stage.separation)
    lines.push(`분리 근거(${stage.separation.basis} — ${BASIS_LABEL[stage.separation.basis]}): ${stage.separation.detail}${
      stage.separation.priorStage ? ` (선행 결과 단계 ${stage.separation.priorStage})` : ""}`);
  if (stage.outcome !== undefined || stage.separation)
    lines.push("분리 근거가 성립하지 않으면(파일·함수·역할만 다름) 그 판단을 계획에 적고 단계 병합을 제안하세요. 병합은 사용자 결정 요청으로 올리면 작업 묶음 개정으로 반영됩니다.");
  if (stage.checklist?.length) {
    lines.push("이 단계 체크리스트:");
    for (const item of stage.checklist) lines.push(`- ${item}`);
  }
  if (context.questions.length) {
    lines.push("이 단계에 걸린 미정 사항:");
    for (const q of context.questions)
      lines.push(`- ${q.id}${q.blocksStart && !q.resolution && !q.deferredReason ? " (착수 차단)" : ""}: ${q.text}${q.resolution !== undefined ? ` — 해소: ${q.resolution}` : " — 미해소"}${q.deferredReason !== undefined ? ` — 후속 확인(To-do): ${q.deferredReason}` : ""}`);
    if (context.questions.some((q) => q.deferredReason && !q.resolution))
      lines.push("후속 확인으로 넘긴 질문은 해결된 계약이 아닙니다. 그 질문에 의존하는 동작은 이번 구현에서 제외하고 To-do에 보존하세요. 확인된 근거로 가능한 나머지 작업을 진행하세요. 오래된 접근 실패·자료 부족 판단은 원문과 직접 연결된 구현/명세를 다시 확인하고, 현재 버전·확인 결과를 기록하세요. 접근 불가를 제품 미결정으로 바꾸거나 계약을 추정하지 마세요.");
  }
  lines.push("선행 단계의 확정 근거:");
  for (const result of context.priorResults) lines.push(...resultLines(result));
  for (const p of legacyPrior) lines.push(`${p.stageId}: commit ${p.commit}, plan SHA ${p.planSHA}, 검증 ${p.verification}`);
  if (!context.priorResults.length && !legacyPrior.length) lines.push("(없음)");
  if (context.mergeTargets.length) {
    lines.push("합류 대상 — 기준 커밋에 들지 않은 선행 결과:");
    for (const target of context.mergeTargets)
      lines.push(target.result ? `- ${target.stageId}: commit ${target.result.commitOID}` : `- ${target.stageId}: 동결 결과 없음`);
  }
  // 합류 병합은 엔진이 준비하고 엔진이 커밋한다(F001) — 러너가 직접 병합·커밋하면 구현 기준 커밋 검사와 경로 지정 커밋이 병합을 만들 수 없다.
  if (context.merge) {
    lines.push(`엔진이 합류 대상(${context.merge.targets.map((t) => `${t.stageId} ${t.commitOID}`).join(", ")})을 기준 커밋 위에 이 작업 트리로 커밋 없이 병합해 두었습니다.`);
    lines.push(`병합 트리: ${context.merge.tree}`);
    lines.push(context.merge.conflicts.length
      ? `충돌 파일(충돌 표식을 해소하세요): ${context.merge.conflicts.join(", ")}` : "충돌 파일: 충돌 없음");
    lines.push("직접 git merge·git commit 을 하지 마세요. 허용 오차는 병합 트리 대비 변경만 셉니다. 인도 커밋은 엔진이 리뷰한 작업 트리 전체로 부모 [기준 커밋, 합류 대상 커밋…] 병합 커밋을 만듭니다(바뀐 경로를 전부 선택하세요).");
  }
  if (context.integration) {
    lines.push("전체 통합 검증 단계입니다. 앞 단계의 개별 성공만으로 완료하지 말고 공통 계약과 전체 변경을 함께 검증하세요.");
    if (context.memoryDrift?.length) {
      lines.push("단계 결과에 기록된 뒤 바뀐 위키 문서(기록 버전 → 연결 때 버전):");
      for (const d of context.memoryDrift) lines.push(`- ${d.path} (단계 ${d.stageId}): ${d.recordedSHA256} → ${d.currentSHA256 ?? "없음"}`);
    }
  }
  lines.push("현재 단계만 상세 계획하고 구현하세요. 미래 단계의 상세 계획이나 전체 과거 대화를 다시 작성하지 마세요.");
  lines.push("이 단계 범위 밖(다른 단계)에 속하는 미정 사항은 작업 묶음이 따로 기록·해소합니다. 이 단계 계획이 불완전하다는 근거가 아니므로 그런 사항으로 사용자 결정을 요청하지 말고 계획의 '제외 범위'에 적으세요. 이 단계 착수를 막는 미정 사항은 위 목록에 있습니다.");
  return lines.join("\n");
}

// 정본 JSON(키 정렬, undefined 제외)의 sha256 — 레코드의 키 순서나 선택 필드 표기 차이가 해시를 바꾸지 않는다.
export function digestContext(context: StageContext): string {
  return createHash("sha256").update(canonical(context)).digest("hex");
}

// ---- 개정 규칙(E4-2) -----------------------------------------------------------------------------------------------------

// 연결된 단계에서 고정하는 구조 — 토픽의 계획·예산이 이 값을 전제로 만들어졌다. 체크리스트는 그 토픽 계획이 소유한다.
const shapeOf = (s: WorkStage) => ({ kind: s.kind, dependsOn: s.dependsOn, budget: s.budget ?? null, checklist: s.checklist ?? [] });
const fullStage = (s: WorkStage) => ({ ...s, checklist: s.checklist ?? [] });
const withoutChecklist = ({ checklist: _checklist, ...rest }: WorkStage) => rest;
// 재적용 판정용 입력 비교 — 과거 레코드의 빠진 선택 필드는 빈 값과 같다.
const comparableInput = (g: WorkGroupInput) => ({ title: g.title, goal: g.goal, contracts: g.contracts, stages: g.stages.map(fullStage),
  budgetPolicy: g.budgetPolicy ?? null, questions: g.questions ?? [] });
// 레코드에서 입력 필드만 되돌린다(적용 때 같은 입력으로 다시 계산하려고).
const inputFields = (g: WorkGroup): WorkGroupInput => ({ title: g.title, goal: g.goal, contracts: g.contracts, stages: g.stages,
  ...(g.budgetPolicy ? { budgetPolicy: g.budgetPolicy } : {}), ...(g.questions ? { questions: g.questions } : {}) });

function planRevision(old: WorkGroup, parsed: WorkGroupInput, expectedVersion: number, closedIds: ReadonlySet<string>): RevisionPreview {
  const closed = old.stages.map((s) => s.id).filter((id) => closedIds.has(id));
  const integration = old.stages.find(stage => stage.kind === "integration");
  if (integration && (old.links[integration.id] || old.pending?.[integration.id]) &&
      parsed.stages.some(stage => stage.kind === "work" && !old.stages.some(previous => previous.id === stage.id)))
    throw Object.assign(new Error("통합 검증이 시작된 뒤에는 새 작업을 추가할 수 없습니다."), { statusCode: 409 });
  // 재적용: 입력이 지금 레코드와 같고 기대 버전이 지금 버전이거나, 직전 버전이면서 마지막 개정이 지금 버전을 만든 것이다(그 개정의 입력이 곧
  // 지금 레코드다). 버전을 올리지 않고 재계획 대기 단계만 돌려준다 — 호출자가 대기 단계마다 세대를 비교해 처리한다.
  if (canonical(comparableInput(parsed)) === canonical(comparableInput(old)) && (expectedVersion === old.version ||
      (expectedVersion === old.version - 1 && (old.revisions ?? []).at(-1)?.version === old.version)))
    return { mode: "reapply", group: old, revision: null, closed,
      affected: old.stages.filter((s) => old.links[s.id]?.replanPending).map((s) => s.id) };
  if (expectedVersion !== old.version) throw new Error(GROUP_CHANGED);
  if (canonical(old.budgetPolicy ?? null) !== canonical(parsed.budgetPolicy ?? null))
    throw new Error("묶음 예산은 개정으로 바꿀 수 없습니다. 증액은 예산 승인으로 하세요.");
  const before = new Map(old.stages.map((s) => [s.id, s]));
  const after = new Map(parsed.stages.map((s) => [s.id, s]));
  for (const stage of old.stages) {
    if (!old.links[stage.id]) continue;
    const next = after.get(stage.id);
    if (!next) throw new Error(`연결된 단계는 없앨 수 없습니다: ${stage.id}`);
    if (canonical(shapeOf(stage)) !== canonical(shapeOf(next)))
      throw new Error(`연결된 단계의 ID·종류·의존·예산·체크리스트는 바꿀 수 없습니다: ${stage.id}`);
    // 연결된 단계 토픽은 요청 브랜치 이름을 이미 받았다 — 묶음에서만 바꾸면 기록과 실제 전달 브랜치가 갈라진다.
    if ((stage.branchName ?? null) !== (next.branchName ?? null))
      throw new Error(`연결된 단계의 브랜치 이름은 바꿀 수 없습니다: ${stage.id}`);
    // 닫힌 단계는 결과가 확정됐다 — 서술까지 그대로여야 한다(E4 전 app 검사를 옮겼다).
    if (closedIds.has(stage.id) && canonical(fullStage(stage)) !== canonical(fullStage(next)))
      throw new Error("완료한 단계의 목표와 조건은 바꿀 수 없습니다.");
  }
  const linkedOrder = (stages: readonly WorkStage[]) => stages.filter((s) => old.links[s.id]).map((s) => s.id);
  if (canonical(linkedOrder(old.stages)) !== canonical(linkedOrder(parsed.stages)))
    throw new Error("연결된 단계끼리의 순서는 바꿀 수 없습니다.");
  // 미착수 단계는 추가·삭제(통합)·분할·재정렬이 자유다. 끊긴 의존·순환·마지막 통합은 입력 스키마가 막는다. 없어진 ID 는 이력에 남기고
  // 다시 쓰지 못한다. 새로 생기는 단계는 v4 분리 근거(결과·근거)가 있어야 한다 — 근거의 의미 검토는 그 단계 문맥을 받는 계획 경로가 한다.
  const retired = new Set(old.retiredStageIds ?? []);
  const added = parsed.stages.filter((s) => !before.has(s.id)).map((s) => s.id);
  for (const id of added) {
    if (retired.has(id)) throw new Error(`없앤 단계 ID는 다시 쓸 수 없습니다: ${id}`);
    const stage = after.get(id)!;
    if (!stage.outcome || !stage.separation)
      throw new Error(`새로 만드는 단계 ${id} 에는 결과(outcome)와 분리 근거(separation)가 필요합니다.`);
  }
  const removed = old.stages.filter((s) => !after.has(s.id)).map((s) => s.id);
  // 질문은 기록이다 — 기존 질문은 없애거나 문구·단계·차단 여부를 바꿀 수 없고, 해소(한 번)와 새 질문 추가만 된다.
  const nextQuestions = new Map((parsed.questions ?? []).map((q) => [q.id, q]));
  for (const question of old.questions ?? []) {
    const next = nextQuestions.get(question.id);
    if (!next) throw new Error(`기록한 질문은 없앨 수 없습니다: ${question.id}`);
    if (next.text !== question.text || next.stageId !== question.stageId || next.blocksStart !== question.blocksStart)
      throw new Error(`기록한 질문의 내용·단계·차단 여부는 바꿀 수 없습니다: ${question.id}`);
    if (question.resolution !== undefined && next.resolution !== question.resolution)
      throw new Error(`해소한 질문의 해소 내용은 바꿀 수 없습니다: ${question.id}`);
  }
  const survived = parsed.stages.map((s) => s.id).filter((id) => before.has(id));
  const reordered = canonical(survived) !== canonical(old.stages.map((s) => s.id).filter((id) => after.has(id)));
  const changedStages: string[] = [];
  const checklistOnly: string[] = [];
  for (const id of survived) {
    const was = before.get(id)!, now = after.get(id)!;
    if (canonical(withoutChecklist(was)) !== canonical(withoutChecklist(now))) changedStages.push(id);
    else if (canonical(was.checklist ?? []) !== canonical(now.checklist ?? [])) checklistOnly.push(id);
  }
  const group: WorkGroup = {
    ...old, ...parsed, version: old.version + 1, retiredStageIds: [...(old.retiredStageIds ?? []), ...removed],
  };
  if (parsed.budgetPolicy === undefined) delete group.budgetPolicy;
  if (parsed.questions === undefined) delete group.questions;
  // 영향 단계: 닫히지 않은 연결 단계 가운데 새 레코드의 단계 문맥 해시가 기록 해시와 다른 것. E4 전 연결(해시 없음)은 개정 전후 단계 문맥의
  // 해시를 비교한다(F006) — 목표·계약·자기 서술·체크리스트·현재 질문(추가·해소)·선행 결과·합류처럼 실제 전달 문맥이 바뀐 것이다. 이미 재계획
  // 대기인 단계는 그대로 대기에 둔다 — 되돌리는 개정이어도 세대 비교 없이는 풀지 않는다.
  const affected = parsed.stages.filter((stage) => {
    const link = old.links[stage.id];
    if (!link || closedIds.has(stage.id)) return false;
    if (link.replanPending) return true;
    if (link.contextDigest !== undefined) return digestContext(buildStageContext(group, stage.id)) !== link.contextDigest;
    return digestContext(buildStageContext(old, stage.id)) !== digestContext(buildStageContext(group, stage.id));
  }).map((stage) => stage.id);
  const revision: WorkGroupRevision = {
    version: group.version, at: new Date().toISOString(), origin: null, added, removed, reordered, changedStages, checklistOnly,
    affectedStages: affected, separation: Object.fromEntries(added.map((id) => [id, after.get(id)!.separation!])),
    contractsChanged: old.contracts !== group.contracts,
  };
  group.revisions = [...(old.revisions ?? []), revision];
  return { mode: "revise", group, revision, affected, closed };
}

// ---- 공통 --------------------------------------------------------------------------------------------------------------

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  return value;
}
function canonical(value: unknown): string {
  return JSON.stringify(sorted(value));
}
// 선택 필드가 undefined 로 남지 않게 한다 — 저장 레코드와 메모리 객체의 모양을 같게 둔다.
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// 서술 필드의 비밀값을 저장 전에 가린다 — 새 서술 필드(결과·분리 근거·체크리스트·질문 문구·해소값)도 같다.
function sanitizeInput(input: WorkGroupInput): WorkGroupInput {
  const parsed = WorkGroupInputSchema.parse(input);
  return compact({
    ...parsed,
    title: redactSecrets(parsed.title),
    goal: redactSecrets(parsed.goal),
    contracts: redactSecrets(parsed.contracts),
    stages: parsed.stages.map((stage) => compact({
      ...stage,
      title: redactSecrets(stage.title),
      goal: redactSecrets(stage.goal),
      acceptance: stage.acceptance === undefined ? undefined : redactSecrets(stage.acceptance),
      outcome: stage.outcome === undefined ? undefined : redactSecrets(stage.outcome),
      separation: stage.separation ? compact({ ...stage.separation, detail: redactSecrets(stage.separation.detail) }) : undefined,
      checklist: stage.checklist?.map(redactSecrets),
    }) as WorkStage),
    questions: parsed.questions?.map((q) => compact({
      ...q, text: redactSecrets(q.text), resolution: q.resolution === undefined ? undefined : redactSecrets(q.resolution),
      deferredReason: q.deferredReason === undefined ? undefined : redactSecrets(q.deferredReason),
    })),
  }) as WorkGroupInput;
}
