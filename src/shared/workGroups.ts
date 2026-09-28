import { z } from "zod";
import { BudgetPolicySchema, type BudgetAccount } from "./budgets.js";
import { BranchNameSchema, BranchPrefixSchema, type DeferredFinding } from "./contracts.js";

// 작업 묶음(큰 그림) 계약 — 엔진 개편 E4(plan.md §3.1–3.3, v4 단계 분할 기준).
// 미착수 단계는 대략으로 둘 수 있다: 완료 조건(acceptance)이 없으면 "준비되지 않은" 단계이고, 완료 조건이 있고 그 단계에 걸린
// 미해소 차단 질문이 없을 때만 연다(준비된 단계). 과거 레코드(모든 필드 있음)는 그대로 읽힌다 — 새 필드는 전부 선택 필드다.

const StageIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine((id) => !Object.hasOwn(Object.prototype, id), "예약된 단계 이름입니다.");

// v4 분리 근거 — 개정으로 새로 생기는(추가·분할) 단계에 필수다. 파일·함수·역할 차이는 basis 값에 없다(그런 분할은 체크리스트로 둔다).
//  - prior-result: priorStage 결과를 봐야 이 단계 설계를 정할 수 있다. priorStage 는 이 단계 dependsOn 의 추이 폐포 안에 있어야 한다.
//  - independent-verification: 이 단계만의 완료 조건으로 따로 검증하는 이득이 있다(열려면 acceptance 가 있어야 한다 — 준비 조건과 같다).
//  - rollback: 이 단계만 되돌릴 수 있어 구체적인 위험이 줄어든다.
export const StageSeparationSchema = z
  .object({
    basis: z.enum(["prior-result", "independent-verification", "rollback"]),
    detail: z.string().trim().min(1),
    priorStage: StageIdSchema.optional(),
  })
  .strict();
export type StageSeparation = z.infer<typeof StageSeparationSchema>;

export const WorkStageSchema = z
  .object({
    kind: z.enum(["work", "integration"]).default("work"),
    id: StageIdSchema,
    title: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    acceptance: z.string().trim().min(1).optional(),
    dependsOn: z.array(z.string()).default([]),
    budget: BudgetPolicySchema.optional(),
    // 이 단계가 끝나면 쓸 수 있게 되는 완결 결과(v4). 개정으로 새로 생기는 단계에는 필수다.
    outcome: z.string().trim().min(1).optional(),
    separation: StageSeparationSchema.optional(),
    // 같은 결과를 위한 파일·역할별 항목. 미착수 단계에서만 바꿀 수 있고, 체크리스트만 바뀐 개정은 어떤 단계도 다시 계획하게 하지 않는다.
    checklist: z.array(z.string().trim().min(1)).max(50).optional(),
    // 단계 토픽의 요청 브랜치 이름(토픽 생성 입력의 requestedBranchName). 없으면 묶음 접두사로 엔진이 만든다. 연결 뒤에는 바꿀 수 없고,
    // 계획 입력이 아니라 전달 위치라 단계 문맥·해시에는 넣지 않는다.
    branchName: BranchNameSchema.optional(),
  })
  .strict();
export type WorkStage = z.infer<typeof WorkStageSchema>;

// 묶음 미정 사항(D1=b) — 큰 그림 입력(revise)으로 추가·해소한다. stageId 가 null 이면 묶음 전체(모든 단계 문맥에 실린다).
// blocksStart 인 미해소 질문만 그 단계(또는 null 이면 모든 단계)의 착수를 막는다. 에이전트 결과 스키마는 바꾸지 않는다.
export const WorkQuestionSchema = z
  .object({
    id: StageIdSchema,
    stageId: z.string().nullable().default(null),
    text: z.string().trim().min(1),
    blocksStart: z.boolean().default(false),
    resolution: z.string().trim().min(1).optional(),
  })
  .strict();
export type WorkQuestion = z.infer<typeof WorkQuestionSchema>;

export const WorkGroupInputSchema = z
  .object({
    title: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    contracts: z.string().trim().min(1),
    stages: z.array(WorkStageSchema).min(2).max(20),
    // 선택적 묶음 예산. 선언된 예산이 없으면 사용량만 기록한다.
    // 목록 뷰의 budget(묶음 예산 계정)과 이름이 겹치지 않게 budgetPolicy 로 둔다.
    budgetPolicy: BudgetPolicySchema.optional(),
    // 선택 필드다(과거 레코드·기존 호출의 입력 형식 유지). 없으면 빈 목록으로 읽는다.
    questions: z.array(WorkQuestionSchema).max(100).optional(),
  })
  .strict()
  .superRefine((g, ctx) => {
    if (g.stages.at(-1)?.kind !== "integration")
      ctx.addIssue({ code: "custom", message: "마지막 단계는 전체 통합 검증이어야 합니다." });
    // 통합 단계는 정확히 하나, 마지막이다(host-review F011) — 통합은 다른 모든 단계가 닫힌 뒤에만 열리므로 중간 통합이 있으면 두 통합이 서로의
    // 종료를 기다려 어느 쪽도 열 수 없다.
    for (const s of g.stages.slice(0, -1))
      if (s.kind === "integration")
        ctx.addIssue({ code: "custom", message: `단계 ${s.id} 는 전체 통합 검증 단계입니다 — 통합 단계는 마지막 하나뿐이어야 합니다.` });
    const seen = new Set<string>();
    const closure = new Map<string, Set<string>>();
    for (const s of g.stages) {
      if (seen.has(s.id) || s.dependsOn.some((id) => !seen.has(id)))
        ctx.addIssue({ code: "custom", message: "단계 ID는 고유해야 하고 의존 단계는 앞에 있어야 합니다." });
      const reach = new Set<string>();
      for (const dep of s.dependsOn) {
        reach.add(dep);
        for (const inherited of closure.get(dep) ?? []) reach.add(inherited);
      }
      closure.set(s.id, reach);
      if (s.separation?.basis === "prior-result" && (!s.separation.priorStage || !reach.has(s.separation.priorStage)))
        ctx.addIssue({ code: "custom", message: `단계 ${s.id} 의 선행 결과 근거는 의존 관계 안의 단계를 가리켜야 합니다.` });
      seen.add(s.id);
    }
    // 단계마다 자기 브랜치에 전달한다. 실제 ref 는 요청 이름 뒤에 범위 세대 접미사 `-g<세대>` 를 붙인 것이다(shared/workflow resolveBranchName).
    // 이름이 같거나, 한 단계의 `<이름>-g<n>` 아래 경로에 다른 단계 이름이 놓이면 git 이 두 ref 를 함께 둘 수 없어 뒤 단계의 브랜치 생성이
    // 계획·승인을 마친 뒤에 실패한다(연결 뒤에는 이름을 바꿀 수 없다) — 입력에서 거부한다.
    const named = g.stages.filter((s): s is typeof s & { branchName: string } => s.branchName !== undefined);
    const nests = (outer: string, inner: string) => inner.startsWith(`${outer}-g`) && /^\d+\//.test(inner.slice(outer.length + 2));
    for (const [index, s] of named.entries())
      for (const other of named.slice(index + 1))
        if (s.branchName === other.branchName || nests(s.branchName, other.branchName) || nests(other.branchName, s.branchName))
          ctx.addIssue({ code: "custom", message: `단계 브랜치 이름이 겹칩니다: ${s.id}(${s.branchName}) ↔ ${other.id}(${other.branchName})` });
    const questionIds = new Set<string>();
    for (const q of g.questions ?? []) {
      if (questionIds.has(q.id)) ctx.addIssue({ code: "custom", message: "질문 ID는 고유해야 합니다." });
      if (q.stageId !== null && !seen.has(q.stageId))
        ctx.addIssue({ code: "custom", message: `질문 ${q.id} 가 없는 단계를 가리킵니다.` });
      questionIds.add(q.id);
    }
  });
export type WorkGroupInput = z.infer<typeof WorkGroupInputSchema>;

// 묶음 생성 전용 입력 — 개정(revise) 입력에는 없다(WorkGroupInputSchema 가 strict 라 개정 본문에 실으면 거부된다). 토픽 생성 입력
// (CreateTopicInputSchema)과 같은 검증을 쓴다.
//  - baseRef: 묶음 기준 커밋. 없으면 저장소 HEAD(기존 동작). 서비스가 커밋 OID 로 해석해 baseOID 로 저장한다.
//  - branchPrefix: 단계 토픽의 브랜치 접두사. 없으면 "consensus"(기존 동작).
//  - predecessorTopicId: 묶음 밖 선행 토픽. 같은 저장소이고 전달 커밋이 묶음 기준에 포함돼야 한다(서비스가 검증). 생성 때 그 토픽의
//    범위 세대·전달 커밋·보류 원장을 묶음 레코드(predecessor)에 동결한다 — 뒤에 선행 토픽이 바뀌어도 승계 근거가 바뀌지 않고, 모든 단계가
//    같은 기준 위에서 시작하므로 모든 단계가 그 원장을 이어받는다(inheritedDeferredFindings → deferredFindingsFor).
export const WorkGroupCreateOptionsSchema = z
  .object({
    baseRef: z.string().trim().min(1).refine((value) => !value.startsWith("-"), "기준 리비전은 '-'로 시작할 수 없습니다.").optional(),
    branchPrefix: BranchPrefixSchema.optional(),
    predecessorTopicId: z.string().uuid().optional(),
  })
  .strict();
export type WorkGroupCreateOptions = z.infer<typeof WorkGroupCreateOptionsSchema>;
const CREATE_OPTION_KEYS = ["baseRef", "branchPrefix", "predecessorTopicId"] as const;
// 생성 요청 본문을 묶음 입력과 생성 전용 입력으로 나눠 각각 검증한다.
export function parseWorkGroupCreateBody(body: unknown): { input: WorkGroupInput; options: WorkGroupCreateOptions } {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const input = Object.fromEntries(Object.entries(record).filter(([key]) => !(CREATE_OPTION_KEYS as readonly string[]).includes(key)));
  const options = Object.fromEntries(Object.entries(record).filter(([key]) => (CREATE_OPTION_KEYS as readonly string[]).includes(key)));
  return { input: WorkGroupInputSchema.parse(body === record ? input : body), options: WorkGroupCreateOptionsSchema.parse(options) };
}

// 재계획 대기(D2) — 개정 저장과 같은 transaction 에서 켜지고, 그 단계 토픽의 범위 세대가 fromGeneration 보다 오른 뒤에만 꺼진다.
export interface ReplanPending {
  version: number;
  fromGeneration: number;
}
export interface StageLink {
  topicId: string;
  baseOID: string;
  // 이 단계 문맥을 마지막으로 반영한 묶음 버전(과거 레코드 호환 결속).
  groupVersion: number;
  // 연결·재계획 완료 때 기록한 단계 문맥 해시(stageContext 의 digest). 없으면 E4 전 연결 — groupVersion 으로만 결속한다.
  contextDigest?: string;
  replanPending?: ReplanPending;
  // 기준 커밋에 모이지 않은 선행 결과(합류 대상) — 이 단계 결과 커밋이 모두 조상으로 가져야 닫을 수 있다.
  mergeTargets?: string[];
  // 통합 단계: 연결 때 잰, 단계 결과가 기록한 위키 문서의 기록 버전과 그때 버전.
  memoryDrift?: Array<{ path: string; stageId: string; recordedSHA256: string; currentSHA256: string | null }>;
  // 합류 대상이 있으면 엔진이 연결 전에 기준 커밋 위로 합류 대상 커밋들을 작업 트리에 커밋 없이 병합해 둔 결과(host-review F001). 단계 문맥·해시에 들고,
  // 인도 커밋은 이 대상들을 부모로 하는 병합 커밋이 된다.
  preparedMerge?: PreparedMerge;
}
// 합류 병합 준비 결과 — tree 는 병합(충돌 표식 포함) 트리 OID, targets 는 묶음 단계 순서의 합류 대상과 그 동결 결과 커밋이다.
export interface PreparedMerge {
  tree: string;
  conflicts: string[];
  targets: Array<{ stageId: string; commitOID: string }>;
}
// 단계 결과에 동결하는 사용자 결정 — 그 토픽 현재 범위 세대의 결정 원문 전부(잘라내지 않는다, F012·F013). sha256 은 원문(utf8)의 해시다.
export interface StageDecision {
  topicId: string;
  sequence: number;
  scopeGeneration: number;
  sha256: string;
  body: string;
}
// 단계 결과 동결 기록(close 때 한 번 — 이후 토픽이 바뀌어도 덮어쓰지 않는다). legacy 는 E4 전에 닫힌 단계를 이전 계약(push) 증거로 동결한 것이다.
export interface StageResult {
  stageId: string;
  topicId: string;
  baseOID: string;
  commitOID: string;
  reviewedTreeOID: string;
  planSHA256: string;
  evidenceDigest: string | null;
  verifications: Array<{ id: string; status: string }>;
  memoryChanges: Array<{ path: string; sha256: string }>;
  openQuestions: string[];
  // 그 단계 토픽의 보류 지적 원장(deferred-findings, 닫을 때) — 잘라내지 않는다(host-review F007). legacy 결과는 빈 목록.
  deferredFindings: DeferredFinding[];
  // 그 단계 현재 범위 세대의 사용자 결정 원문 전부(§4.1) — legacy 결과는 빈 목록.
  decisions: StageDecision[];
  closedAt: string;
  legacy?: boolean;
}
// 묶음 밖 선행 작업의 동결 기록(생성 때 한 번) — 검증한 범위 세대·전달 커밋과 그때의 보류 원장. 뒤에 선행 토픽이 범위를 바꾸거나 다시 커밋해도
// 이 기록은 바뀌지 않는다(묶음 기준 커밋이 그대로이므로 승계 근거도 그대로다).
export interface ExternalPredecessor {
  topicId: string;
  scopeGeneration: number;
  committedOID: string;
  deferredFindings: DeferredFinding[];
  frozenAt: string;
}
export interface WorkGroupRevision {
  version: number;
  at: string;
  origin: string | null;
  added: string[];
  removed: string[];
  reordered: boolean;
  changedStages: string[];
  checklistOnly: string[];
  affectedStages: string[];
  separation: Record<string, StageSeparation>;
  // 공통 계약(contracts) 문구가 바뀐 개정인가 — 재계획 범위 변경의 본문("공통 계약 변경: …")을 재적용 때도 같게 만든다.
  contractsChanged?: boolean;
}
export interface WorkGroup extends WorkGroupInput {
  id: string;
  repositoryPath: string;
  baseOID: string;
  // 생성 전용 입력(WorkGroupCreateOptionsSchema) — 없으면 기존 동작(접두사 consensus, 선행 토픽 없음). 개정으로 바뀌지 않는다.
  branchPrefix?: string;
  predecessor?: ExternalPredecessor;
  version: number;
  createdAt: string;
  pending?: Record<string, { topicId: string; worktreePath: string; baseOID: string }>;
  links: Record<string, StageLink>;
  revisions?: WorkGroupRevision[];
  retiredStageIds?: string[];
  results?: Record<string, StageResult>;
}
// 목록 API 가 붙이는 파생 상태(저장하지 않는다).
export interface WorkGroupView extends WorkGroup {
  budget: BudgetAccount | null;
  stageStates: Record<string, string | null>;
  delivery: Record<string, { committedOID: string | null; pushedOID: string | null }>;
  delivered: boolean;
  readyStages: string[];
  selectableStages: string[];
  replanPending: string[];
}

// 준비된 단계: 완료 조건이 있고, 그 단계(또는 묶음 전체)에 걸린 미해소 차단 질문이 없다. 비용 상한은 선택 사항이다.
export function stageReady(group: Pick<WorkGroupInput, "stages" | "questions">, stageId: string): boolean {
  const stage = group.stages.find((s) => s.id === stageId);
  if (!stage || !stage.acceptance) return false;
  return !(group.questions ?? []).some((q) => q.blocksStart && !q.resolution && (q.stageId === null || q.stageId === stageId));
}
// 의존 추이 폐포(자기 제외).
export function dependencyClosure(group: Pick<WorkGroupInput, "stages">, stageId: string): string[] {
  const byId = new Map(group.stages.map((s) => [s.id, s]));
  const out = new Set<string>();
  const walk = (id: string) => {
    for (const dep of byId.get(id)?.dependsOn ?? []) if (!out.has(dep)) { out.add(dep); walk(dep); }
  };
  walk(stageId);
  return group.stages.map((s) => s.id).filter((id) => out.has(id));
}
