import { createHash, randomUUID } from "node:crypto";
import { AGENT_EFFORTS, AgentExecutionSettingsSchema, DEFAULT_AGENT_SETTINGS } from "../shared/contracts.js";
import { AgentProfileInputSchema, type TurnJob } from "../shared/roles.js";
import { REVIEW_CRITERIA, type ReviewCriteria, type SessionSettingsTarget, type SessionSettingsView, type SessionSettingsUpdate } from "../shared/sessionSettings.js";
import type { ConsensusDatabase } from "./database.js";
import { designReadRequested, resolveRoute, routeSupport } from "./turnRouting.js";
import { redactSecrets } from "../shared/workflow.js";

const emptyCriteria = (): ReviewCriteria => ({ selectedIds: [], additionalText: "" });
const readonlyReasons: Partial<Record<SessionSettingsTarget, string>> = {
  mediator: "외부 중재 세션의 모델·실행 환경은 이 서버가 제어하지 않습니다.",
  verifier: "검증자는 외부 세션 배정이며 서버에 모델 실행 소비처가 없습니다.",
  "host-reviewer": "engine-review는 별도 보호된 설치 설정을 사용합니다. 웹에서 변경하지 않습니다.",
};
export function settingsJobs(target: SessionSettingsTarget): TurnJob[] {
  if (target === "planner") return ["plan", "revision", "diagnosis-revision", "brainstorm", "ack"].map(operation => ({ role: "planner", operation }) as TurnJob);
  if (target === "implementer") return [{ role: "implementer", operation: "implement" }, { role: "implementer", operation: "fix" }];
  if (target === "plan-review") return [{ role: "reviewer", operation: "audit" }, { role: "reviewer", operation: "closeout" }];
  if (target === "code-review") return [{ role: "reviewer", operation: "review" }, { role: "reviewer", operation: "final-review" }];
  return [];
}
function describe(db: ConsensusDatabase, topicId: string, target: SessionSettingsTarget) {
  const topic = db.getTopic(topicId), jobs = settingsJobs(target);
  const routes = jobs.map(job => resolveRoute(db, topic, job));
  // Include inherited records as well as local versions: a global edit must invalidate an open editor too.
  const revision = createHash("sha256").update(JSON.stringify({ target, routes,
    local: jobs.map(job => db.roles.assignment(`topic:${topicId}`, job.role, job.operation)) })).digest("hex");
  return { topic, jobs, routes, revision };
}
export function readSessionSettings(db: ConsensusDatabase, topicId: string, target: SessionSettingsTarget): SessionSettingsView {
  db.getTopic(topicId);
  const base: SessionSettingsView = { target, editable: false, revision: "readonly", appliesTo: "next-execution", mixed: false, models: [], efforts: [...AGENT_EFFORTS], operations: [] };
  if (readonlyReasons[target]) return { ...base, reason: readonlyReasons[target] };
  try {
    const { routes, revision } = describe(db, topicId, target);
    const provider = routes[0]?.provider;
    const mixedProvider = routes.some(route => route.provider !== provider);
    const defaults = provider && DEFAULT_AGENT_SETTINGS[provider];
    const registeredModels = db.roles.profiles().filter(profile => profile.provider === provider
      && AgentExecutionSettingsSchema.safeParse({ model: profile.model, effort: profile.effort }).success).map(profile => profile.model);
    const models = [...new Set([defaults?.model, defaults?.implementation?.model, ...routes.map(route => route.settings.model), ...registeredModels]
      .filter((v): v is string => Boolean(v)))];
    const criteria = routes.map(route => route.reviewCriteria ?? emptyCriteria());
    return { ...base, revision, editable: !mixedProvider && models.length > 0,
      ...(mixedProvider ? { reason: "작업별 공급자가 달라 모델 설정을 함께 변경할 수 없습니다." } : {}), models,
      mixed: routes.some(route => route.settings.model !== routes[0].settings.model || route.settings.effort !== routes[0].settings.effort),
      operations: routes.map(route => ({ operation: route.job.operation, provider: route.provider, model: route.settings.model, effort: route.settings.effort,
        scope: route.basis.kind === "assignment" ? route.basis.scope : "default" })),
      ...(["plan-review", "code-review"].includes(target) ? { criteria: { ...criteria[0], catalog: REVIEW_CRITERIA.map(({ id, label }) => ({ id, label })),
        mixed: criteria.some(item => JSON.stringify(item) !== JSON.stringify(criteria[0])) } } : {}),
    };
  } catch (error) { return { ...base, reason: `현재 배정을 실행할 수 없습니다: ${error instanceof Error ? error.message : String(error)}` }; }
}
export function updateSessionSettings(db: ConsensusDatabase, topicId: string, input: SessionSettingsUpdate): SessionSettingsView {
  return db.roles.atomic(() => {
    const view = readSessionSettings(db, topicId, input.target);
    const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }); };
    if (!view.editable) fail(view.reason ?? "변경할 수 없는 설정입니다.", 403);
    if (input.revision !== view.revision) fail("세션 설정이 변경되었습니다. 최신 설정을 읽고 다시 저장하세요.", 409);
    if (!view.models.includes(input.model) || !view.efforts.includes(input.effort)) fail("현재 공급자의 허용 모델·추론 강도에서 선택하세요.");
    if (input.criteria && !view.criteria) fail("리뷰 역할에만 검토 기준을 설정할 수 있습니다.");
    const { routes } = describe(db, topicId, input.target);
    for (const route of routes) {
      const candidate = { ...route, settings: { model: input.model, effort: input.effort } };
      const problem = routeSupport(candidate, designReadRequested(db, topicId, route.job));
      if (problem) fail(problem);
      const profile = AgentProfileInputSchema.parse({ id: `session-settings:${randomUUID()}`, provider: route.provider,
        model: input.model, effort: input.effort, options: route.options,
        ...(input.criteria ? { reviewCriteria: { ...input.criteria, additionalText: redactSecrets(input.criteria.additionalText) } }
          : route.reviewCriteria ? { reviewCriteria: route.reviewCriteria } : {}) });
      db.roles.createProfile(profile);
      const current = db.roles.assignment(`topic:${topicId}`, route.job.role, route.job.operation);
      db.roles.assign({ scope: `topic:${topicId}`, role: route.job.role, operation: route.job.operation,
        participant: route.participant, profileId: profile.id, sessionId: null,
        expectedVersion: current?.version ?? 0, note: current?.note ?? "" });
    }
    return readSessionSettings(db, topicId, input.target);
  });
}

export function reviewCriteriaPrompt(criteria: ReviewCriteria | undefined): string {
  if (!criteria || (!criteria.selectedIds.length && !criteria.additionalText)) return "";
  return "\n\n추가 검토 기준 (기존 필수 규칙·승인·권한·결과 형식은 그대로 유지):\n"
    + REVIEW_CRITERIA.filter(item => criteria.selectedIds.includes(item.id)).map(item => `- ${item.instruction}`).join("\n")
    + (criteria.additionalText ? `\n사용자 추가 검토 관점:\n${criteria.additionalText}` : "");
}
