import { AgentExecutionSettingsSchema, type AgentExecutionSettings, type RoutingView, type Topic, type WorkflowState } from "../shared/contracts.js";
import { isPlanRevision } from "../shared/diagnoses.js";
import { appliedExecutionSettings } from "../shared/execution.js";
import { providerOptionsProblem, TURN_OPERATIONS, turnFlags, type AgentProfile, type RoleAssignment, type TurnJob, type TurnRole } from "../shared/roles.js";
import { providerRoleOptionsProblem, providerSupport, turnPolicy } from "./adapters/turnPolicy.js";
import type { ConsensusDatabase } from "./database.js";
import type { ParticipantRole } from "./types.js";

// 역할 배정에 따른 공급자 선택(엔진 개편 E2b). 논리 턴마다 경로를 한 번 정하고, 어댑터·설정·세션 대조가 모두 그 경로를 쓴다.
// 별도 라우팅 엔진·세션 테이블을 두지 않는다 — E1 의 역할 배정·프로필(RoleRegistry)과 기존 세션 저장소를 그대로 쓴다.

export type Provider = "claude" | "codex";

// 호환 좌석 — E1 이전 참여자 슬롯 이름을 세션 저장 키로 재사용한다(plan §2.5 "기존 claude·codex 참여자는 호환 계층에서 해석").
// 새 역할 이름이 아니다: 'claude' 좌석은 작성자(계획자·구현자 — plan §2.1 "설계자와 구현자는 기본적으로 같은 참여자"),
// 'codex' 좌석은 검토자다. 좌석이 역할마다 따로라서 같은 공급자가 계획자와 검토자를 맡아도 세션·ACK 가 덮어쓰이지 않는다.
// 이벤트 actor·산출물 kind·execution_usage.role 도 이 좌석 이름으로 남는다(과거 기록과 같은 키).
export const SEAT_OF_ROLE: Readonly<Record<TurnRole, ParticipantRole>> = { planner: "claude", implementer: "claude", reviewer: "codex" };
// 배정이 없을 때의 공급자 — E2b 이전의 고정 대응 그대로다.
const DEFAULT_PROVIDER: Readonly<Record<TurnRole, Provider>> = { planner: "claude", implementer: "claude", reviewer: "codex" };

export type RouteBasis =
  | { kind: "default" }
  | { kind: "assignment"; scope: string; role: TurnRole; operation: string; version: number };

// 세션 바인딩(plan §2.1 SessionBinding) — 세션을 만든 공급자·참여자와 그때의 프로필·선택 근거. 세션의 정체는 공급자·참여자다(sameBinding).
export interface SessionBinding { provider: Provider; participant: string; profileId: string | null; basis: RouteBasis }

export interface TurnRoute extends SessionBinding {
  job: TurnJob;
  seat: ParticipantRole;
  // 이 경로의 실행 설정(효과 강도 덮어쓰기 전). 공급자와 같은 결정에서 나온다 — 다른 공급자의 모델 이름이 CLI 로 가지 않게.
  settings: AgentExecutionSettings;
  // 프로필의 공급자 옵션(E2c) — 이 공급자의 스펙으로 검증한 값. 기본 배정은 {}(어댑터 기본값).
  options: Readonly<Record<string, unknown>>;
  // 코드 리뷰 원장 ID(E3-4c) — delivery 가 연 논리 리뷰 한 번의 호스트 소유 ID. 리뷰 좌석의 읽기 호출(review-read)·최종 판정 호출(review·final-review)이
  // 이 경로로 core.turn·실행기를 지나 SessionTurn.reviewLedger 로 예산 래퍼에 닿는다(core.turn 의 턴 요청은 호출자 필드를 받지 않아 경로가 유일한 통로다).
  // 예산 래퍼는 읽기·판정·그 판정의 계약 교정에서 이 ID 로 리뷰를 예약한다. 원장 없는 교정은 호출마다 예약하며 경로 판정·바인딩과는 무관하다.
  reviewLedger?: string;
}

export class UnsupportedRoute extends Error {
  constructor(message: string, readonly detail: { job: TurnJob; provider?: Provider; basis?: RouteBasis }) {
    super(message);
    this.name = "UnsupportedRoute";
  }
}

export function bindingOf(route: SessionBinding): SessionBinding {
  return { provider: route.provider, participant: route.participant, profileId: route.profileId, basis: route.basis };
}

// 같은 세션을 이어 쓸 수 있는가 — 공급자(실행 도구)와 참여자가 같을 때. 프로필(모델·강도)이 달라도 이어 쓴다: plan §2.1 "작업별 모델 설정이 달라도
// 같은 실행 도구에서 세션 유지가 지원되면 기존 세션을 이어간다" — 기본 배정도 계획(주제 모델)과 구현(구현 모델)이 한 Claude 세션이다. 프로필 옵션
// (E2c, shared/roles.ts PROVIDER_OPTION_SCHEMAS) 중 세션 저장소를 가르는 것은 없어 같은 공급자의 프로필은 같은 CLI 세션 저장소를 쓴다 — 그런 옵션을 더하면 이 판정에
// 넣는다. 배정 버전만 다시 발급된 경우도 같은 세션이다.
export function sameBinding(a: SessionBinding, b: SessionBinding): boolean {
  return a.provider === b.provider && a.participant === b.participant;
}

// 공급자·바인딩이 기록되지 않은 옛 세션의 해석 — 그 저장소의 기본 좌석·공급자(E2b 이전에는 이것만 가능했다).
export function legacyBinding(provider: Provider): SessionBinding {
  return { provider, participant: provider, profileId: null, basis: { kind: "default" } };
}

export function parseBinding(json: string | null | undefined, legacyProvider: Provider, provider?: string | null): SessionBinding {
  if (json) {
    const parsed = JSON.parse(json) as SessionBinding;
    if ((parsed.provider === "claude" || parsed.provider === "codex") && typeof parsed.participant === "string") return parsed;
    throw new Error("세션 바인딩 기록이 올바르지 않습니다.");
  }
  return legacyBinding(provider === "claude" || provider === "codex" ? provider : legacyProvider);
}

// 배정 조회 순서: 토픽의 작업별 → 토픽의 역할 전체('') → 전역의 작업별 → 전역의 역할 전체. 토픽 배정은 그 토픽에 대한 사용자의 명시 선택이라
// 전역의 더 구체적인 작업 배정보다 앞선다. 없으면 기본 배정.
function assignmentFor(database: ConsensusDatabase, topicId: string, job: TurnJob): RoleAssignment | null {
  for (const scope of [`topic:${topicId}`, "global"]) {
    for (const operation of [job.operation, ""]) {
      const found = database.roles.assignment(scope, job.role, operation);
      if (found) return found;
    }
  }
  return null;
}

export function resolveRoute(database: ConsensusDatabase, topic: Topic, job: TurnJob): TurnRoute {
  const seat = SEAT_OF_ROLE[job.role];
  const assignment = assignmentFor(database, topic.id, job);
  if (!assignment) {
    const provider = DEFAULT_PROVIDER[job.role];
    return { job, seat, provider, participant: seat, profileId: null, basis: { kind: "default" },
      settings: appliedExecutionSettings(topic.agentSettings[provider], turnFlags(job).implementationModel), options: {} };
  }
  const basis: RouteBasis = { kind: "assignment", scope: assignment.scope, role: job.role, operation: assignment.operation, version: assignment.version };
  const label = `${job.role}${assignment.operation ? `/${assignment.operation}` : ""} 배정(${assignment.scope} v${assignment.version})`;
  // 러너 배정의 공급자·모델은 프로필에만 있다 — 없으면 추측하지 않고 거부한다.
  if (!assignment.profileId) throw new UnsupportedRoute(`${label}에 실행 프로필이 없어 공급자를 정할 수 없습니다.`, { job, basis });
  // 배정의 세션 지정은 러너 역할에서 쓰지 않는다 — 러너 세션은 엔진이 좌석별 바인딩으로 만들고 이어 쓴다(기존 세션은 참여자 연결로 붙인다). 조용히 무시하지 않는다.
  if (assignment.sessionId) {
    throw new UnsupportedRoute(`${label}이 세션 ${assignment.sessionId} 을(를) 지정했지만 러너 세션은 엔진이 관리합니다 — 기존 세션은 참여자 연결로 붙이고 배정에서는 세션을 비우세요.`,
      { job, basis });
  }
  const profile = database.roles.profile(assignment.profileId);
  if (!profile) throw new UnsupportedRoute(`${label}의 프로필 ${assignment.profileId} 이(가) 없습니다.`, { job, basis });
  const settings = AgentExecutionSettingsSchema.safeParse({ model: profile.model, effort: profile.effort });
  if (!settings.success) {
    // 다른 모델·강도로 대체하지 않는다(plan §2.3).
    throw new UnsupportedRoute(`${label}의 프로필 ${profile.id} 설정을 실행할 수 없습니다: ${profileSettingsProblem(profile)}.`,
      { job, provider: profile.provider, basis });
  }
  // 공급자 옵션(E2c) — 이 공급자가 해석하지 않는 키·잘못된 값은 조용히 무시하지 않는다. 생성 API 가 막기 전에 저장된 프로필도 여기서 멈춘다.
  const optionProblem = providerOptionsProblem(profile.provider, profile.options);
  if (optionProblem) {
    throw new UnsupportedRoute(`${label}의 프로필 ${profile.id} 옵션을 실행할 수 없습니다: ${optionProblem}.`, { job, provider: profile.provider, basis });
  }
  return { job, seat, provider: profile.provider, participant: assignment.participant, profileId: profile.id, basis, settings: settings.data,
    options: profile.options ?? {} };
}

function profileSettingsProblem(profile: AgentProfile): string | null {
  const settings = AgentExecutionSettingsSchema.safeParse({ model: profile.model, effort: profile.effort });
  if (settings.success) return null;
  const issue = settings.error.issues[0];
  return issue ? `${issue.path.join(".")} ${issue.message}` : "형식 오류";
}

// 구현 턴이 Figma 관측을 요구하는가 — 증거 관리 래퍼(evidence/service.ts withEvidence)가 턴에 Figma 읽기를 여는 식과 같다(구현 job + 토픽의 Figma
// 소스). 실행 전 판정(EngineCore.route·TurnExecutor.assertRouteSupported)이 같이 쓴다 — 래퍼가 붙이기 전에 정책에 넣어야 부수효과 전에 멈춘다.
export function designReadRequested(database: ConsensusDatabase, topicId: string, job: TurnJob): boolean {
  return turnFlags(job).implementation && database.evidence.list(topicId).some(source => source.provider === "figma");
}

// 지원 판정 — 공급자 이름 목록이 아니라 job 의 역할 정책(turnPolicy)과 공급자 표현 가능 여부로 정한다. 도구가 닫히는 턴(프로토콜 확인·계획 제어)은
// 팬아웃이 없어 검토자 턴도 Claude 로 표현할 수 있다. planningControl 은 호출자가 래퍼와 같은 식(guardedPlanning.planningControlApplies)으로 계산해 넘긴다.
export function routeSupport(route: TurnRoute, planningControl: boolean, figmaRequested = false): string | null {
  const flags = turnFlags(route.job);
  return providerRoleOptionsProblem(route.provider, route.job, route.options) ?? providerSupport(route.provider, turnPolicy(route.job, { protocolOnly: flags.protocolOnly, planningControl, figmaRequested }));
}

// 프로필 역할 적합성(plan §2.5 "프로필 조회·검증", E2c) — 이 프로필을 배정하면 역할·작업마다 실행할 수 있는지와 사유. 경로 판정과 같은 함수(설정 스키마·
// 옵션 스펙·providerSupport)로 계산한다. 판정 형태는 도구가 열린 기본 턴이다(계획 제어 턴은 도구를 닫아 요구가 줄어든다). 구현 job 은 토픽에 디자인
// 소스가 있을 때(Figma 관측 요구)의 판정을 따로 준다.
export interface JobSuitability { job: TurnJob; reason: string | null; withDesignSources: string | null }
export interface ProfileSuitability { profileId: string; provider: Provider; problem: string | null; jobs: JobSuitability[] }

export function profileSuitability(profile: AgentProfile): ProfileSuitability {
  const settingsProblem = profileSettingsProblem(profile);
  const optionProblem = providerOptionsProblem(profile.provider, profile.options);
  const problem = settingsProblem ? `설정 ${settingsProblem}` : optionProblem ? `옵션 — ${optionProblem}` : null;
  const jobs = (Object.keys(TURN_OPERATIONS) as TurnRole[]).flatMap(role =>
    (TURN_OPERATIONS[role] as readonly string[]).map(operation => {
      const job = { role, operation } as TurnJob;
      const flags = turnFlags(job);
      const reason = problem ?? providerRoleOptionsProblem(profile.provider, job, profile.options) ?? providerSupport(profile.provider, turnPolicy(job, { protocolOnly: flags.protocolOnly }));
      const withDesignSources = flags.implementation
        ? problem ?? providerRoleOptionsProblem(profile.provider, job, profile.options) ?? providerSupport(profile.provider, turnPolicy(job, { protocolOnly: flags.protocolOnly, figmaRequested: true }))
        : null;
      return { job, reason, withDesignSources };
    }));
  return { profileId: profile.id, provider: profile.provider, problem, jobs };
}

// 두 좌석이 단계마다 실행하거나 다음에 여는 작업 — 엔진 호출 지점의 core.route 인자와 같다: 계획(planning.ts) plan·audit·revision·closeout·ack,
// 구현(delivery.ts) implement·review·fix·final-review. 계속 진행·확인·교정 같은 하위 턴은 여는 작업의 경로를 따르므로(E2b) 여는 작업으로 충분하다.
// 쉬는 좌석은 그 흐름에서 다음에 열 작업이다. 다음 턴이 없는 전달·종료 상태는 구현 단계의 대표 작업(implement·review)이다.
const plannerJob = (operation: "brainstorm" | "plan" | "revision" | "diagnosis-revision" | "ack"): TurnJob => ({ role: "planner", operation });
const implementerJob = (operation: "implement" | "fix"): TurnJob => ({ role: "implementer", operation });
const reviewerJob = (operation: "brainstorm" | "audit" | "closeout" | "ack" | "review" | "final-review"): TurnJob => ({ role: "reviewer", operation });
const STAGE_JOBS: Readonly<Partial<Record<WorkflowState, { author: TurnJob; reviewer: TurnJob }>>> = {
  BRAINSTORM_READY: { author: plannerJob("brainstorm"), reviewer: reviewerJob("brainstorm") },
  BRAINSTORMING: { author: plannerJob("brainstorm"), reviewer: reviewerJob("brainstorm") },
  DRAFT: { author: plannerJob("plan"), reviewer: reviewerJob("audit") },
  CLAUDE_PLAN: { author: plannerJob("plan"), reviewer: reviewerJob("audit") },
  CODEX_AUDIT: { author: plannerJob("revision"), reviewer: reviewerJob("audit") },
  CLAUDE_REVISION: { author: plannerJob("revision"), reviewer: reviewerJob("closeout") },
  CODEX_CLOSEOUT: { author: plannerJob("ack"), reviewer: reviewerJob("closeout") },
  CONSENSUS_ACK: { author: plannerJob("ack"), reviewer: reviewerJob("ack") },
  AWAITING_USER_APPROVAL: { author: implementerJob("implement"), reviewer: reviewerJob("review") },
  IMPLEMENTING: { author: implementerJob("implement"), reviewer: reviewerJob("review") },
  CODEX_REVIEW: { author: implementerJob("fix"), reviewer: reviewerJob("review") },
  CLAUDE_FIX: { author: implementerJob("fix"), reviewer: reviewerJob("final-review") },
  CODEX_FINAL_REVIEW: { author: implementerJob("fix"), reviewer: reviewerJob("final-review") },
  READY_TO_DELIVER: { author: implementerJob("implement"), reviewer: reviewerJob("review") },
  CLOSED: { author: implementerJob("implement"), reviewer: reviewerJob("review") },
};

// 좌석별 현재 작업 — 멈춘 상태(실패·결정 대기·증거 대기)는 재개 단계로 본다. 적용된 계획 변경 진단이 있으면 재시도는 단계와 무관하게 진단 계획 개정으로
// 간다(workflow.retry → DiagnosisService.pendingPlanRevision: 현재 범위 세대의 plan-revision 적용 기록 중 상태 applied) — 같은 판정을 여기서도 쓴다.
export function currentSeatJobs(database: ConsensusDatabase, topic: Topic): { author: TurnJob; reviewer: TurnJob } {
  const stage = STAGE_JOBS[topic.state] ? topic.state : (database.getFlags(topic.id).resumeState ?? "DRAFT");
  const jobs = STAGE_JOBS[stage] ?? STAGE_JOBS.DRAFT!;
  const planRevisionPending = database.diagnoses.list(topic.id)
    .some(record => record.binding.scopeGeneration === topic.scopeGeneration && isPlanRevision(record) && record.status === "applied");
  return planRevisionPending ? { ...jobs, author: plannerJob("diagnosis-revision") } : jobs;
}

// 부속 턴의 부모 작업(host-review F003) — 엔진은 여는 작업의 배정·세션으로 부속 턴을 실행하고 job 만 바꾼다(부속 작업에 따로 둔 배정은 적용되지 않는다):
// 구현자의 계속 진행·완료 확인·허용 오차 교정·계약 교정은 지금의 작업(implement·fix — delivery.workRoute), 검토자의 답변 확인·리뷰 읽기(E3-4c)는 지금의
// 리뷰(review·final-review — delivery.confirmReviewAnswers·runReviewOnce, 모델·추론 설정을 낮추지 않고 그대로 쓴다), 설계자·검토자의 계획 교정·계약 교정은
// 그 역할이 지금 여는 작업(core 의 plan-repair·contract-correction). 확인(ack)은 엔진이 따로 경로를 정하는 독립 작업이다. 부속 턴이 아니면 null.
const INHERITING_OPERATIONS: Readonly<Record<TurnRole, readonly string[]>> = {
  planner: ["evidence-assessment", "plan-repair", "contract-correction"],
  reviewer: ["answer-confirmation", "review-read", "plan-repair", "contract-correction"],
  implementer: ["continue", "completion-confirmation", "tolerance-correction", "contract-correction"],
};

function inheritedParent(job: TurnJob, current: { author: TurnJob; reviewer: TurnJob }): TurnJob | null {
  if (!INHERITING_OPERATIONS[job.role].includes(job.operation)) return null;
  if (job.role === "implementer") return current.author.role === "implementer" ? current.author : implementerJob("implement");
  if (job.operation === "evidence-assessment") return plannerJob("plan");
  if (job.role === "planner") return current.author.role === "planner" && current.author.operation !== "ack" ? current.author : plannerJob("plan");
  if (job.operation === "answer-confirmation" || job.operation === "review-read") {
    return current.reviewer.operation === "final-review" ? reviewerJob("final-review") : reviewerJob("review");
  }
  return current.reviewer.operation === "ack" ? reviewerJob("audit") : current.reviewer;
}

// 역할과 실제 실행 AI 의 표시용 값(E2c C3) — 모든 역할·작업의 실제 경로(또는 실행 전 거부 사유)와 네 좌석 세션의 바인딩. 경로·거부는 엔진 경로 판정
// (EngineCore.route)과 같은 함수·같은 턴 형태로 계산한다 — 화면이 실제 실행과 다른 AI 를 보여 주지 않게. 계획 제어 여부는 호출자가 넘긴다
// (guardedPlanning 이 이 모듈을 import 하므로 순환을 피한다).
export function routingView(database: ConsensusDatabase, topic: Topic, planningControl: (job: TurnJob) => boolean): RoutingView {
  const current = currentSeatJobs(database, topic);
  const jobs = (Object.keys(TURN_OPERATIONS) as TurnRole[]).flatMap(role =>
    (TURN_OPERATIONS[role] as readonly string[]).map(operation => {
      const job = { role, operation } as TurnJob;
      const parent = inheritedParent(job, current);
      try {
        // 부속 턴은 부모 작업의 경로에 job 만 바꾼다 — 엔진(delivery.workRoute·confirmReviewAnswers, core 의 plan-repair·contract-correction)과 같다.
        const route = { ...resolveRoute(database, topic, parent ?? job), job };
        return { role, operation, inheritsFrom: parent?.operation ?? null, route: { ...bindingOf(route), settings: route.settings },
          refusal: routeSupport(route, planningControl(job), designReadRequested(database, topic.id, job)) };
      } catch (error) {
        if (!(error instanceof UnsupportedRoute)) throw error;
        return { role, operation, inheritsFrom: parent?.operation ?? null, route: null, refusal: error.message };
      }
    }));
  const seat = (role: ParticipantRole) => topic.participants.find(participant => participant.role === role);
  const author = seat("claude");
  const planReview = seat("codex");
  const implementationSessionId = database.getFlags(topic.id).implementationSessionId;
  const codeReviewSessionId = database.getCodexReviewSession(topic.id);
  return {
    jobs,
    current,
    sessions: [
      { seat: "author", sessionId: author?.sessionId ?? null, binding: author ? database.participantBinding(topic.id, "claude") : null },
      { seat: "plan-review", sessionId: planReview?.sessionId ?? null, binding: planReview ? database.participantBinding(topic.id, "codex") : null },
      { seat: "implementation", sessionId: implementationSessionId, binding: implementationSessionId ? database.implementationSessionBinding(topic.id) : null },
      { seat: "code-review", sessionId: codeReviewSessionId, binding: codeReviewSessionId ? database.codexReviewSessionBinding(topic.id) : null },
    ],
  };
}

export function describeBinding(binding: SessionBinding): string {
  const basis = binding.basis.kind === "default" ? "기본 배정"
    : `${binding.basis.role}${binding.basis.operation ? `/${binding.basis.operation}` : ""} 배정 ${binding.basis.scope} v${binding.basis.version}`;
  return `${binding.provider}(${binding.participant}${binding.profileId ? `, 프로필 ${binding.profileId}` : ""}, ${basis})`;
}
