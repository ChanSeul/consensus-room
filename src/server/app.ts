import { SessionSettingsTargetSchema, SessionSettingsUpdateSchema } from "../shared/sessionSettings.js";
import { readSessionSettings, updateSessionSettings } from "./sessionSettings.js";
import { buildSessionGraph } from "./sessionGraph.js";
import { readHostReviewGraph } from "./hostReviewGraph.js";
import { registerInterruptRoutes, interruptStatus } from "./mediation/interruptRoutes.js";
import { z } from "zod";
import { SetTopicGoalSchema } from "../shared/topicStructure.js";
import { parseEvidenceSource } from "../shared/externalEvidence.js";
import { adoptTopics, assertTopicParent } from "./topicStructure.js";
import { BrainstormDecisionSchema, BrainstormInputSchema } from "../shared/brainstorm.js";
import { PlanningMigrationSchema } from "../shared/planningControl.js";
import {ReviewGrantInputSchema} from "../shared/reviews.js";
import { DIAGNOSIS_ID_PATTERN, DiagnosisInputSchema } from "../shared/diagnoses.js";
import {
  ToolTreeRebaselineInputSchema,
  ResumeImplementationInputSchema, AmendToleranceInputSchema } from "../shared/contracts.js";
import { RevisionGrantInputSchema } from "../shared/revisions.js";
import { parseWorkGroupCreateBody, stageReady, WorkGroupInputSchema, type WorkGroupView } from "../shared/workGroups.js";
import { WorkGroupService } from "./workGroupService.js";
import { BudgetPolicySchema, BudgetResumeInputSchema } from "../shared/budgets.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  ApprovalInputSchema,
  AttachParticipantInputSchema,
  CreateTopicInputSchema,
  DeferredFindingsSchema,
  DeliveryInputSchema,
  ImplementInputSchema,
  PostMessageInputSchema,
  ReconcileDeliveryInputSchema,
  UpdateAgentSettingsInputSchema,
  UpdateMediationAutonomyInputSchema,
  type TopicDetail,
} from "../shared/contracts.js";
import { ArtifactStore } from "./artifacts.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { ConsensusDatabase } from "./database.js";
import { EngineDefectInput, EngineDefectWorker } from "./engineDefects.js";
import { GitService } from "./git.js";
import { redactRecord, safeError } from "./security.js";
import { redactSecrets } from "../shared/workflow.js";
import type { AgentAdapter, CommandRunner, ParticipantRole } from "./types.js";
import {
  type CallOrigin, type HostSandboxStatus, WorkflowEngine } from "./workflow.js";
import { ProcessSupervisor } from "./processSupervisor.js";
import { ProjectMemoryStore } from "./memoryStore.js";
import { readMediationAutonomy } from "./mediationAutonomy.js";
import { assertMediatorAssignment, assertMediatorForAnyTopic, DEFAULT_MEDIATION_POLICY_PATH, readMediationPolicy } from "./mediation.js";
import { AgentProfileInputSchema, AgentRoleSchema, AssignmentScopeSchema, RoleAssignmentInputSchema, turnFlags, type MediatorIdentity } from "../shared/roles.js";
import { scanWorktreeActivity } from "./activity.js";
import { VerificationService, completeVerificationSchema } from "./verifications.js";
import { EvidenceService, withEvidence } from "./evidence/service.js";
import { guardedPlanning, planningControlApplies } from "./guardedPlanning.js";
import { profileSuitability, routingView } from "./turnRouting.js";
import { guardRunnerControl } from "./adapters/turnPolicy.js";
import { RestEvidenceConnector, evidenceCredentials, type EvidenceConnector } from "./evidence/connectors.js";
import { registerEvidenceRoutes } from "./evidence/routes.js";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
type SandboxProbeRun = (command: string, args: string[]) => Pick<SpawnSyncReturns<string>, "status" | "stderr" | "error">;

// 서버가 macOS 샌드박스(seatbelt) 안에서 떠 있으면 자식이 sandbox-exec 로 새 프로필을 적용하지 못한다(중첩 불가, rc 71 "sandbox_apply: Operation not
// permitted"). 2026-09-28 Claude 중재 세션 Bash(work-admission guard.py exec 의 sandbox-exec) 안에서 restart_room.sh 로 띄운 서버가 그랬다 — 러너 Bash 가
// 전부 실패한 채 구현 턴이 끝까지 돌았고, Codex 리뷰는 세션 생성에서 죽었다. 판정은 부팅 때 한 번이다. 프로세스는 샌드박스를 벗어날 수 없어 결과가 바뀌지 않는다.
export function probeNestedSandbox(options: { run?: SandboxProbeRun; platform?: NodeJS.Platform } = {}): HostSandboxStatus {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return { kind: "not-applicable", detail: `platform ${platform}` };
  const run: SandboxProbeRun = options.run ?? ((command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 10_000 }));
  // 러너·Codex 가 하는 일(새 프로필 적용 뒤 exec)을 가장 작은 형태로 한 번 해 본다.
  const result = run(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]);
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "not-applicable", detail: `${SANDBOX_EXEC} 없음` };
    return { kind: "unavailable", detail: `${SANDBOX_EXEC} 실행 실패: ${result.error.message}` };
  }
  if (result.status === 0) return { kind: "available" };
  return { kind: "unavailable", detail: `${SANDBOX_EXEC} rc ${result.status}: ${(result.stderr ?? "").trim().slice(0, 200)}` };
}

export interface AppDependencies {
  evidenceConnector?: EvidenceConnector;
  nativeEvidenceConnector?: EvidenceConnector;
  config?: ServerConfig;
  database?: ConsensusDatabase;
  runner: CommandRunner;
  claude: AgentAdapter;
  codex: AgentAdapter;
  // 부팅 때 판정한 중첩 샌드박스 가능 여부(index.ts 가 probeNestedSandbox 로 판정). 실행 허용 검사가 쓴다.
  hostSandbox?: HostSandboxStatus;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const config = dependencies.config ?? loadConfig();
  await Promise.all([
    mkdir(config.dataDirectory, { recursive: true }),
    mkdir(config.topicsDirectory, { recursive: true }),
    mkdir(config.worktreesDirectory, { recursive: true }),
  ]);
  const database = dependencies.database ?? new ConsensusDatabase(config.databasePath);
  const artifacts = new ArtifactStore(config.topicsDirectory, database);
  const git = new GitService(dependencies.runner);
  const verifications = new VerificationService(database, artifacts, config.dataDirectory);
  const evidence = new EvidenceService(database.evidence, dependencies.evidenceConnector ?? new RestEvidenceConnector(evidenceCredentials()), source => {
    for (const topic of database.listTopics()) {
      if (topic.state === "CLOSED" || !database.evidence.list(topic.id).some(item => item.id === source.id)) continue;
      database.appendEvent({ topicId: topic.id, actor: "system", kind: "system", state: topic.state,
        body: `외부 원문 변경 감지: ${source.label}. 변경이 요구사항에 미치는 영향은 재확인이 필요합니다.`,
        payload: { sourceId: source.id, contentHash: source.contentHash } });
    }
  }, join(config.dataDirectory, "evidence-images"), dependencies.nativeEvidenceConnector);
  // 러너 제어 경로 감시(E2c)는 CLI 실행에 가장 가까운 층이다 — 증거·계획 제어 래퍼가 여는 모든 턴(내부 재시도 포함)의 앞뒤를 같은 방식으로 본다.
  const workflow = new WorkflowEngine({
    database,
    artifacts,
    git,
    claude: guardedPlanning(withEvidence(guardRunnerControl(dependencies.claude), database, join(config.dataDirectory, "evidence-images")), database, git, config.memoryDirectory, join(config.dataDirectory, "evidence-images")),
    codex: guardedPlanning(withEvidence(guardRunnerControl(dependencies.codex), database, join(config.dataDirectory, "evidence-images")), database, git, config.memoryDirectory, join(config.dataDirectory, "evidence-images")),
    verifications,
    memory: new ProjectMemoryStore(config.memoryDirectory),
    executionLimits: config.executionLimits,
    enforceBudgets: config.enforceBudgets ?? true,
    maintenanceLockPath: join(config.dataDirectory, "maintenance.lock"),
    hostSandbox: dependencies.hostSandbox,
  });
  evidence.onIdle = () => workflow.pollEvidenceAssessments();
  const engineDefects = new EngineDefectWorker(database, dependencies.runner, guardRunnerControl(dependencies.codex),
    config.dataDirectory, resolve(import.meta.dirname, "../.."), dependencies.hostSandbox?.kind !== "unavailable");
  evidence.canPublish = topicId => workflow.canPublishEvidence(topicId);
  evidence.publishSelection = (guarded, change) => workflow.publishEvidence(guarded, change);
  // 자율중재는 항상 ON이다. 요청 인증·현재 중재자 배정·각 액션의 승인/상태 검사는 별도로 유지한다.
  const DELEGATED_ACTIONS = new Set(["brainstorm-plan", "brainstorm-close", "approve", "implement", "tool-tree-rebaseline", "commit", "push", "close", "review-resume", "revision-resume", "budget-configure", "budget-resume", "amend-tolerance", "resume-implementation", "reconcile-delivery", "discard-orphan-commit"]);
  const callOrigin = (request: { headers: Record<string, unknown> }): CallOrigin | undefined => {
    if (request.headers["x-consensus-actor"] !== "mediator") return undefined;
    return mediatorOrigin(request, null);
  };
  // 수락된 중재자 요청의 배정 신원(전역 preHandler 가 확인해 둔 값)과 호출 시점의 공통 정책 버전을 기록한다(엔진 개편 E1).
  const mediatorIdentities = new WeakMap<object, MediatorIdentity | null>();
  const mediatorOrigin = (request: object, delegationSetAt: string | null): CallOrigin => ({
    actor: "mediator", delegationSetAt,
    mediator: mediatorIdentities.get(request) ?? null,
    policyVersion: readMediationPolicy(DEFAULT_MEDIATION_POLICY_PATH).version,
  });
  // 막힌 단계 옆 독립 준비 단계 선택은 엔진의 정지 분류(외부 결정 대 자원 정지)를 쓰고, 통합 단계는 연결 때 위키 기록 버전을 지금 버전과 잰다(E4).
  // 묶음 밖 선행 토픽의 보류 원장은 엔진이 쓰는 산출물(deferred-findings)을 그대로 읽어 생성 때 동결한다 — 동결 근거라 형식이 틀리면 빈 목록으로
  // 넘기지 않고 거부한다.
  const workGroups = new WorkGroupService(database,git,config.repositoryPath,config.worktreesDirectory,config.defaultAgentSettings,
    {blockedExternally:topicId=>workflow.stageBlockedExternally(topicId),memoryDirectory:config.memoryDirectory,
      deferredFindingsOf:async topicId=>{
        const raw=await artifacts.readLatest(topicId,"deferred-findings");
        if(!raw)return [];
        const parsed=DeferredFindingsSchema.safeParse(JSON.parse(raw));
        if(!parsed.success)throw new Error(`선행 토픽 ${topicId} 의 보류 원장 형식이 올바르지 않습니다.`);
        return parsed.data.findings;
      }});
  // 시작 URL의 일회성 token이나 인증 헤더가 request log에 남지 않도록 HTTP request logging을 끈다.
  const app = Fastify({ logger: false });

  await app.register(cookie);
  app.addHook("onRequest", async (request, reply) => {
    const query = request.query as Record<string, unknown> | undefined;
    const queryToken = typeof query?.token === "string" ? query.token : undefined;
    if (queryToken === config.launchToken) {
      reply.setCookie("consensus_room_token", config.launchToken, {
        httpOnly: true, sameSite: "strict", path: "/",
      });
      if (!request.url.startsWith("/api/")) {
        return reply.redirect(request.url.split("?", 1)[0] || "/");
      }
      return;
    }
    if (!request.url.startsWith("/api/")) return;
    const header = request.headers["x-consensus-token"];
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const token = header ?? bearer ?? request.cookies.consensus_room_token;
    if (token !== config.launchToken) await reply.code(401).send({ error: "인증 토큰이 필요합니다." });
  });

  // 중재자 배정 확인(엔진 개편 E1): 중재자 헤더가 붙은 변경 요청은 적용 배정이 있으면 참여자·버전이 현재 배정과 같아야 한다.
  // 멱등 원장 claim 보다 앞(preHandler)에서 거부하므로 교체 전 중재자의 늦은 요청·중복 명령은 원장·타임라인에 흔적을 남기지 않는다.
  app.addHook("preHandler", async (request) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    if (request.headers["x-consensus-actor"] !== "mediator") return;
    const route = request.routeOptions.url ?? "";
    const id = (request.params as { id?: string }).id;
    let parentId = (route === "/api/topics" || route === "/api/work-groups") && typeof (request.body as { parentTopicId?: unknown } | null)?.parentTopicId === "string"
      ? (request.body as { parentTopicId: string }).parentTopicId : null;
    if (id && route === "/api/work-groups/:id/next") parentId = database.workGroups.get(id).parentTopicId ?? null;
    // 토픽 경로는 그 토픽의 적용 배정(토픽 → 전역)과 대조한다. 원문 id 경로(/api/evidence/:id/*, 연결 토픽의 근거 상태)와 작업 묶음 경로
    // (/api/work-groups/:id/*)는 여러 토픽이 함께 쓰는 리소스다 — 영향받는 진행 중(닫히지 않은) 토픽 중 하나의 현재 배정과 같으면 수락한다
    // (host-review a7a9ce86 F-002: 토픽마다 중재자가 다르면 모두와 같을 수 없다). 영향 토픽이 없거나 조회할 수 없으면 전역 배정으로 판정한다.
    // 공유 리소스 요청이 특정 토픽을 직접 바꾸는 효과(묶음 예산 뒤 자동 재시도)는 핸들러가 그 토픽 배정으로 다시 판정한다.
    let identity: MediatorIdentity | null;
    if (id && route.startsWith("/api/topics/:id")) identity = assertMediatorAssignment(database.roles, request.headers, id);
    else if (parentId) identity = assertMediatorAssignment(database.roles, request.headers, parentId);
    else {
      let linked: string[] = [];
      if (id && route.startsWith("/api/evidence/:id/")) linked = database.evidence.linkedTopics(id);
      else if (id && route.startsWith("/api/work-groups/:id/")) {
        try { linked = Object.values(database.workGroups.get(id).links).map(link => link.topicId); } catch { linked = []; }
      }
      const active = linked.filter(topicId => { try { return database.getTopic(topicId).state !== "CLOSED"; } catch { return false; } });
      identity = assertMediatorForAnyTopic(database.roles, request.headers, active);
    }
    mediatorIdentities.set(request, identity);
  });

  app.get("/api/health", async () => ({ ok: true }));
  app.put<{ Params: { id: string } }>("/api/topics/:id/iteration-limits", async request => {
    if (request.headers["x-consensus-actor"] === "mediator") throw Object.assign(new Error("횟수 설정은 사용자만 변경할 수 있습니다."), { statusCode: 403 });
    workflow.assertBudgetEditable(request.params.id);
    const input = z.object({ scope: z.enum(["planning", "implementation", "revision"]), limit: z.number().int().nonnegative().nullable(), version: z.number().int().positive() }).strict().parse(request.body);
    const result = input.scope === "revision" ? database.revisions.configure(request.params.id, input.limit, input.version)
      : database.reviews.configure(request.params.id, input.scope, input.limit, input.version);
    const topic = database.getTopic(request.params.id);
    database.appendEvent({ topicId: topic.id, actor: "user", kind: "note", state: topic.state,
      body: `${input.scope === "revision" ? "계획 재작성" : input.scope === "planning" ? "계획 검토" : "구현 리뷰"} 한도: ${input.limit === null ? "제한 없음" : `${input.limit}회`}. 자동 재개하지 않습니다.`, payload: { iterationLimit: input } });
    return result;
  });
  registerInterruptRoutes(app, database);
  registerEvidenceRoutes(app, database, workflow, evidence, headers => { callOrigin({ headers }); });
  app.get("/api/config", async () => ({
    repositoryPath: config.repositoryPath,
    memoryDirectory: config.memoryDirectory,
    defaultAgentSettings: config.defaultAgentSettings,
  }));
  // 목록 뷰(E4): 단계 상태와 함께 준비·선택 가능 단계, 재계획 대기, 단계별 전달 상태(로컬 커밋과 원격 push 를 나눠)를 붙인다. 묶음 전달 완료는
  // 통합 단계 결과 커밋이 push 된 것이다(push 는 조상 전체를 싣는다) — 기능 검증 완료(통합 단계 CLOSED)와 구분한다. 닫힌 단계도 동결 결과를 push 한다.
  app.get("/api/work-groups",async()=>database.workGroups.list().map((group):WorkGroupView=>{
    const integration=group.stages.at(-1)!,integrationLink=group.links[integration.id],integrationResult=group.results?.[integration.id];
    return {...group,budget:database.budgets.account(group.id),
      stageStates:Object.fromEntries(group.stages.map(stage=>[stage.id,group.links[stage.id]?database.getTopic(group.links[stage.id].topicId).state:null])),
      delivery:Object.fromEntries(Object.entries(group.links).map(([stageId,link])=>{const flags=database.getFlags(link.topicId);return [stageId,{committedOID:flags.committedOID??null,pushedOID:flags.pushedOID??null}];})),
      // 묶음 전달 완료: 통합 결과 커밋이 묶음의 어느 연결 토픽에서든 push 됐다(변경 없는 통합은 다른 단계가 이미 push 한 기준 커밋이 결과일 수 있다 — E4 보완 F003).
      delivered:Boolean(integrationLink&&integrationResult&&Object.values(group.links).some(link=>database.getFlags(link.topicId).pushedOID===integrationResult.commitOID)),
      readyStages:group.stages.filter(stage=>!group.links[stage.id]&&stageReady(group,stage.id)).map(stage=>stage.id),
      selectableStages:workGroups.selectableStages(group),
      replanPending:group.stages.filter(stage=>group.links[stage.id]?.replanPending).map(stage=>stage.id)};
  }));
  app.post("/api/work-groups",async(request,reply)=>{
    // 생성 전용 입력(기준 커밋·단계 브랜치 접두사·묶음 밖 선행 토픽)은 묶음 입력과 따로 검증한다 — 개정 입력(revise)에는 없다.
    const {input,options}=parseWorkGroupCreateBody(request.body);
    if (options.parentTopicId && request.headers["x-consensus-actor"] === "mediator") assertMediatorAssignment(database.roles, request.headers, options.parentTopicId);
    return runIdempotent(request,reply,globalLedger(database,"work-group:create"),201,key=>workGroups.create(input,id=>database.annotateGlobalRequest("work-group:create",key,{plannedGroupId:id}),options));
  });
  // 본문 stageId 가 있으면 막힌 단계 옆 독립 준비 단계를 골라 연다(E4-6). 없으면 기본 규칙(한 번에 한 단계, 첫 준비 단계).
  app.post<{Params:{id:string}}>("/api/work-groups/:id/next",async(request,reply)=>{
    callOrigin(request);
    const parentId = database.workGroups.get(request.params.id).parentTopicId;
    if (parentId && request.headers["x-consensus-actor"] === "mediator") assertMediatorAssignment(database.roles, request.headers, parentId);
    const requested=(request.body as {stageId?:unknown}|undefined)?.stageId;
    if(requested!==undefined&&(typeof requested!=="string"||!requested))throw Object.assign(new Error("stageId 는 단계 ID 문자열이어야 합니다."),{statusCode:400});
    return runIdempotent(request,reply,globalLedger(database,`work-group:next:${request.params.id}`),201,key=>workGroups.next(request.params.id,(plannedTopicId,worktreePath)=>database.annotateGlobalRequest(`work-group:next:${request.params.id}`,key,{plannedTopicId,worktreePath}),requested));
  });
  app.post<{Params:{id:string}}>("/api/work-groups/:id/budget",async(request,reply)=>{
    callOrigin(request);
    const body=BudgetResumeInputSchema.parse(request.body);
    return runIdempotent(request,reply,globalLedger(database,`work-group:budget:${request.params.id}`),200,key=>{
      const group=database.workGroups.get(request.params.id);
      for(const link of Object.values(group.links))workflow.assertBudgetEditable(link.topicId);
      const granted="resumeExecutionId" in body
        ? database.budgets.resumeExecution(group.id,key,body.resumeExecutionId,body.version)
        : database.budgets.grant(group.id,key,body.policy,body.version);
      const resumedAccounts="resumeExecutionId" in body ? database.budgets.execution(body.resumeExecutionId).accounts : null;
      for(const link of Object.values(group.links)) {
        if(resumedAccounts && !resumedAccounts.includes(link.topicId))continue;
        const topic=database.getTopic(link.topicId);
        const interruption=database.getTimeline(topic.id).filter(event=>event.scopeGeneration===topic.scopeGeneration && event.actor==="system" && event.payload?.resumeState).at(-1);
        if(topic.state!=="FAILED" && !(topic.state==="USER_DECISION_REQUIRED" && interruption?.payload?.budgetPause===true))continue;
        const blocker=workflow.budgetResumeBlocker(topic.id);
        if(blocker)return {...granted,resumeBlocked:`묶음 예산 재개를 기록했습니다. ${blocker}`};
        // 예산 증액은 묶음 공유 리소스지만 재개는 이 토픽을 직접 바꾼다 — 중재자 요청이면 이 토픽의 현재 배정과 같을 때만 재개한다(F-002).
        if(request.headers["x-consensus-actor"]==="mediator") {
          try {assertMediatorAssignment(database.roles,request.headers,topic.id);}
          catch(error) {return {...granted,resumeBlocked:`묶음 예산 재개를 기록했습니다. ${topic.id} 는 다른 중재자 배정이라 재개하지 않았습니다 — 그 토픽의 중재자가 재시도하세요(${error instanceof Error?error.message:String(error)}).`};}
        }
        workflow.retry(topic.id,requestActionId(topic.id,"group-budget-resume",key));
        return {...granted,resumedTopicId:topic.id};
      }
      return granted;
    });
  });
  // 개정(E4 D2 — 저장 우선 + 명시적 재계획 대기).
  //  ① 사전 검사: 실행 중 작업·완료 묶음·준비 중 예약, 개정 규칙(저장소 previewRevision), 문맥이 바뀌는 단계가 지금 범위를 바꿀 수 있는지.
  //  ② 개정 저장과, 단계 문맥 해시가 바뀐 연결 단계의 재계획 대기 표식을 한 transaction 으로 쓴다(해시가 같은 단계는 승인·세션·세대를 그대로 둔다).
  //  ③ 대기 단계마다 범위를 바꾸고(handleScopeChange) 대기를 푼다. 실패하면 개정은 저장된 채 대기 표식이 그 단계의 턴·상태 전진·옛 응답 채택을 막는다.
  // 같은 입력을 새 요청 키로 다시 보내면(지금 버전 또는 직전 버전) 저장하지 않고 ③만 이어 한다 — 범위 세대가 이미 오른 단계는 범위를 다시 바꾸지 않고
  // 대기만 푼다(version·범위 세대·예산을 중복으로 올리지 않는다). 예산 계정은 어느 경로에서도 다시 설정하지 않는다.
  app.post<{Params:{id:string}}>("/api/work-groups/:id/revise",async(request,reply)=>{
    const body=request.body as {input:unknown;version:number;mode?:string};
    const input=WorkGroupInputSchema.parse(body?.input);
    const origin=request.headers["x-consensus-actor"]==="mediator"?"mediator":"user";
    return runIdempotent(request,reply,globalLedger(database,`work-group:revise:${request.params.id}`),200,async()=>{
      const group=database.workGroups.get(request.params.id);
      // 실행 중인 단계가 있어도 개정할 수 있다 — 문맥이 같은 단계는 건드리지 않고, 문맥이 바뀌는 단계는 범위 변경이 실행을 멈춘다. 멈추기 전에 범위
      // 변경이 실패해도 대기 표식이 그 실행의 응답 채택을 막는다(core.assertCurrent·writeArtifact accept). E4 전에는 연결 단계 어느 하나라도 실행 중이면
      // 거부했는데, 개정이 모든 미완료 단계를 초기화하던 때의 보수적 조건이라 막힌 단계 옆 독립 단계가 도는 동안 큰 그림을 고칠 수 없었다.
      if(group.stages.every(stage=>group.links[stage.id] && database.getTopic(group.links[stage.id].topicId).state==="CLOSED"))throw new Error("완료한 작업 묶음은 변경할 수 없습니다.");
      if(Object.keys(group.pending??{}).length)throw new Error("준비 중인 단계를 먼저 연결하세요.");
      const preview=database.workGroups.previewRevision(group.id,input,body.version,topicId=>database.getTopic(topicId).state==="CLOSED");
      // Graph edits change only future execution. Never interrupt or invalidate a linked stage's approval.
      if (body.mode === "pipeline" && preview.affected.length) throw Object.assign(new Error("이미 시작된 단계에 영향을 주는 연결 변경입니다. 편집안을 새로 확인하세요."), {statusCode:409});
      const generations:Record<string,number>={};
      for(const stageId of preview.affected) {
        const link=group.links[stageId],topic=database.getTopic(link.topicId);
        if(!(link.replanPending && topic.scopeGeneration>link.replanPending.fromGeneration))workflow.assertScopeChangeAllowed(topic.id);
        generations[stageId]=topic.scopeGeneration;
      }
      if(preview.mode==="revise")database.workGroups.applyRevision(group.id,preview,generations,origin);
      const saved=database.workGroups.get(group.id);
      for(const stage of saved.stages) {
        const pending=saved.links[stage.id]?.replanPending;
        if(!pending)continue;
        const topicId=saved.links[stage.id].topicId;
        if(database.getTopic(topicId).scopeGeneration<=pending.fromGeneration) {
          const cause=(saved.revisions??[]).find(entry=>entry.version===pending.version);
          await workflow.handleScopeChange(topicId,cause?.contractsChanged?"공통 계약 변경: "+saved.contracts:`작업 묶음 개정 v${pending.version}: ${stage.id} 단계 문맥 변경`);
        }
        database.workGroups.completeReplan(saved.id,stage.id,database.getTopic(topicId).scopeGeneration);
      }
      return database.workGroups.get(group.id);
    });
  });
  app.get("/api/topics", async () => database.listTopics());

  app.get<{ Params: { id: string } }>("/api/topics/:id/verifications", async (request) => {
    await verifications.recoverExpired(request.params.id);
    return verifications.list(request.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/verifications/prepare", async (request, reply) => {
    if (JSON.stringify(request.body ?? {}) !== "{}") return reply.code(400).send({ error: "정적 검사 프로필은 호스트에서 등록합니다." });
    return runIdempotent(request, reply, actionLedger(database, request.params.id, "verification:prepare"), 200,
      () => verifications.prepare(request.params.id));
  });
  app.post<{ Params: { id: string; runId: string } }>("/api/topics/:id/verifications/:runId/complete", { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
    const input = completeVerificationSchema.parse(request.body);
    return runIdempotent(request, reply, actionLedger(database, request.params.id, `verification:complete:${request.params.runId}`), 200,
      () => verifications.complete(request.params.id, request.params.runId, input), createHash("sha256").update(JSON.stringify(input)).digest("hex"));
  });

  // 상태 조회와 기존 on 요청은 호환 유지한다. OFF 요청은 거부하고 예전 설정 파일은 수정하지 않는다.
  app.get("/api/mediation-autonomy", async () => readMediationAutonomy());
  app.post("/api/mediation-autonomy", async (request, reply) => {
    if (request.headers["x-consensus-actor"] === "mediator") {
      throw Object.assign(new Error("자율중재는 항상 ON이며 중재자가 변경할 수 없습니다."), { statusCode: 403 });
    }
    UpdateMediationAutonomyInputSchema.parse(request.body);
    // 이전 토글 요청의 멱등 응답(OFF 포함)을 재생하지 않도록 새 정책의 원장을 쓴다.
    return runIdempotent(request, reply, globalLedger(database, "mediation-autonomy:always-on"), 200, () => readMediationAutonomy());
  });

  // 역할·프로필·배정(엔진 개편 E1). 프로필은 불변, 배정 변경은 사용자 전용 + 기대 버전.
  app.get("/api/agent-profiles", async () => database.roles.profiles());
  app.get("/api/engine-defects", async () => database.engineDefects.list());
  app.post<{ Params: { id: string } }>("/api/topics/:id/engine-defects", async request => {
    const topic = database.getTopic(request.params.id);
    const row = database.engineDefects.enqueue(topic.id, EngineDefectInput.parse(redactRecord(EngineDefectInput.parse(request.body))));
    database.appendEvent({ topicId: topic.id, actor: "system", kind: "system", state: topic.state,
      body: `엔진 결함 To-do 보관: ${row.title}. 토픽 완료 후 처리합니다.`, payload: { engineDefectId: row.id } });
    return row;
  });
  app.post<{ Params: { id: string } }>("/api/engine-defects/:id/retry", async request => {
    if (request.headers["x-consensus-actor"] === "mediator") {
      throw Object.assign(new Error("중단된 엔진 결함 재개는 사용자만 요청할 수 있습니다."), { statusCode: 403 });
    }
    const row = database.engineDefects.get(request.params.id);
    if (row.status !== "blocked") throw Object.assign(new Error("blocked 작업만 재개할 수 있습니다."), { statusCode: 409 });
    database.engineDefects.save({ ...row, status: "todo", error: undefined });
    return database.engineDefects.get(row.id);
  });
  // 프로필 역할 적합성(plan §2.5 "프로필 조회·검증", E2c) — 배정하면 역할·작업마다 실행할 수 있는지와 사유. 경로 판정과 같은 함수로 계산한다.
  app.get<{ Params: { id: string } }>("/api/agent-profiles/:id/suitability", async (request) => {
    const profile = database.roles.profile(request.params.id);
    if (!profile) throw Object.assign(new Error(`프로필 ${request.params.id} 이(가) 없습니다.`), { statusCode: 404 });
    return profileSuitability(profile);
  });
  app.post("/api/agent-profiles", async (request, reply) => {
    const input = AgentProfileInputSchema.parse(request.body);
    return runIdempotent(request, reply, globalLedger(database, "agent-profile:create"), 201, () => database.roles.createProfile(input));
  });
  app.get("/api/role-assignments", async (request) => {
    const query = request.query as { scope?: string; role?: string };
    const scope = query.scope === undefined ? undefined : AssignmentScopeSchema.parse(query.scope);
    const role = query.role === undefined ? undefined : AgentRoleSchema.parse(query.role);
    return database.roles.list(scope, role);
  });
  app.post("/api/role-assignments", async (request, reply) => {
    if (request.headers["x-consensus-actor"] === "mediator") {
      throw Object.assign(new Error("역할 배정은 사용자만 바꿀 수 있습니다(중재자 호출 거부)."), { statusCode: 403 });
    }
    const input = RoleAssignmentInputSchema.parse(request.body);
    const topicId = input.scope.startsWith("topic:") ? input.scope.slice("topic:".length) : null;
    if (topicId) database.getTopic(topicId);
    return runIdempotent(request, reply, globalLedger(database, `role-assignment:${input.scope}:${input.role}:${input.operation}`), 200, () => {
      const assignment = database.roles.assign(input);
      if (topicId) {
        database.appendEvent({ topicId, actor: "system", kind: "system", state: database.getTopic(topicId).state,
          body: `${input.role} 배정 v${assignment.version}: ${assignment.participant}${assignment.profileId ? `(${assignment.profileId})` : ""}${assignment.note ? ` — ${assignment.note}` : ""}`,
          payload: { roleAssignment: assignment } });
      }
      database.events.emit("mediation-change");
      return assignment;
    });
  });
  // 중재 진입점이 먼저 읽는 공통 설정 — Claude·Codex 중재자가 같은 위임 상태·배정·정책 본문과 버전을 받는다.
  app.get("/api/mediation/context", async (request) => {
    const topic = (request.query as { topic?: string }).topic;
    if (topic) database.getTopic(topic);
    const assignment = database.roles.effective(topic ?? null, "mediator");
    return {
      autonomy: readMediationAutonomy(),
      assignment,
      profile: assignment?.profileId ? database.roles.profile(assignment.profileId) : null,
      policy: readMediationPolicy(DEFAULT_MEDIATION_POLICY_PATH),
    };
  });

  app.post("/api/topics", async (request, reply) => {
    const input = CreateTopicInputSchema.parse(request.body);
    const entryInput = input.entry ?? (input.startMode === "brainstorm" ? { mode: "brainstorm" as const } : { mode: "goal" as const, goal: input.title });
    if (input.entry && (request.body as { startMode?: string }).startMode
      && input.startMode !== (entryInput.mode === "brainstorm" ? "brainstorm" : "plan"))
      throw Object.assign(new Error("entry와 startMode가 서로 다릅니다."), { statusCode: 400 });
    // 외부 부작용(worktree) 전에 URL과 부모 계약을 확인한다.
    if (entryInput.mode === "sources") entryInput.sources.forEach(parseEvidenceSource);
    assertTopicParent(database, input.parentTopicId);
    if (input.parentTopicId && request.headers["x-consensus-actor"] === "mediator")
      assertMediatorAssignment(database.roles, request.headers, input.parentTopicId);
    // 주제는 아직 topic_id가 없어 전역 원장을 쓴다. claim이 worktree 생성보다 앞이어야 중복 요청이 worktree를 두 번 만들지 않는다.
    return runIdempotent(request, reply, globalLedger(database, "topic:create"), 201, async (idempotencyKey) => {
      const id = randomUUID();
      const safeTitle = redactSecrets(input.title);
      const slug = makeSlug(safeTitle);
      const repositoryPath = config.repositoryPath;
      const worktreePath = input.topicKind === "group" ? repositoryPath : resolve(config.worktreesDirectory, `${slug}-${id.slice(0, 8)}`);
      // 부작용 전에 계획을 원장에 남긴다. 서버가 도중에 죽어도 재시작 복구가 topic 존재 여부로 완료를 판정한다.
      database.annotateGlobalRequest("topic:create", idempotencyKey, { plannedTopicId: id, worktreePath });
      if (input.topicKind !== "group") await git.createDetachedWorktree(repositoryPath, worktreePath, input.baseRef);
      const timestamp = new Date().toISOString();
      // 토픽 행(재작성·리뷰 원장 초기화 포함)과 계획 정책 활성화는 한 transaction 으로 확정한다(E5 host-review F001). 따로 확정하면 그 사이 중단이
      // 정책 0 토픽을 남기고, 재기동 복구가 토픽 존재만으로 요청을 성공으로 확정해 같은 멱등 키 재전송도 그 성공을 재생했다. 단계 토픽 생성과 같은
      // 도구다(workGroups.atomic — 같은 연결의 BEGIN IMMEDIATE). worktree 생성(비동기 외부 부작용)은 이 transaction 밖, 앞에서 끝난다.
      const topic = database.workGroups.atomic(() => {
        assertTopicParent(database, input.parentTopicId);
        if (input.parentTopicId && request.headers["x-consensus-actor"] === "mediator")
          assertMediatorAssignment(database.roles, request.headers, input.parentTopicId);
        const created = database.createTopic({
          topicKind: input.topicKind ?? "task", parentTopicId: input.parentTopicId ?? null,
          workEntry: { mode: entryInput.mode, goal: entryInput.mode === "goal" ? redactSecrets(entryInput.goal) : null, sourceIds: [], evidenceDigest: null },
          id, slug, title: safeTitle, repositoryPath, baseRef: input.baseRef, worktreePath,
          branchPrefix: input.branchPrefix,
          requestedBranchName: input.requestedBranchName,
          predecessorTopicId: input.predecessorTopicId,
          branchName: null, state: entryInput.mode === "brainstorm" ? "BRAINSTORM_READY" : "DRAFT", scopeGeneration: 1, planRevision: 0,
          planSHA256: null, approvedPlanSHA256: null, createdAt: timestamp, updatedAt: timestamp, lastError: null,
          agentSettings: config.defaultAgentSettings,
        });
        if (config.guardedPlanning && input.topicKind !== "group") database.planning.enable(created.id);
        if (entryInput.mode === "sources") {
          const sourceIds = entryInput.sources.map(source => database.evidence.catalog.add(created.id,
            { ...source, scope: "topic", required: true }, request.headers["x-consensus-actor"] !== "mediator").sourceId);
          return database.updateTopic(created.id, { workEntry: { ...created.workEntry!, sourceIds: [...new Set(sourceIds)] } });
        }
        return created;
      });
      database.appendEvent({
        topicId: id, actor: "system", kind: "system", state: topic.state,
        body: input.topicKind === "group" ? "큰 그림과 하위 주제를 관리할 주제를 만들었습니다." : "주제 전용 detached worktree를 만들었습니다.",
        payload: { worktreePath, baseRef: input.baseRef, requestKey: idempotencyKey },
      });
      return topic;
    });
  });

  app.post<{ Params: { id: string } }>("/api/topics/:id/adopt", async (request, reply) => {
    if (request.headers["x-consensus-actor"] === "mediator") throw Object.assign(new Error("기존 주제의 계층 연결은 사용자만 지정할 수 있습니다."), { statusCode: 403 });
    const input = z.object({ topicIds: z.array(z.string().uuid()).max(500).default([]), workGroupIds: z.array(z.string().uuid()).max(50).default([]) })
      .strict().refine(value => value.topicIds.length + value.workGroupIds.length > 0, "연결할 주제 또는 묶음이 필요합니다.").parse(request.body);
    return runIdempotent(request, reply, actionLedger(database, request.params.id, "topics:adopt"), 200,
      () => adoptTopics(database, request.params.id, input.topicIds, input.workGroupIds, id => workflow.assertBudgetEditable(id)),
      createHash("sha256").update(JSON.stringify(input)).digest("hex"));
  });

  app.post<{ Params: { id: string } }>("/api/topics/:id/goal", async (request, reply) => {
    const input = SetTopicGoalSchema.parse(request.body);
    const origin = callOrigin(request);
    return runIdempotent(request, reply, actionLedger(database, request.params.id, "goal:set"), 200,
      () => workflow.setGoal(request.params.id, input, origin), createHash("sha256").update(JSON.stringify(input)).digest("hex"));
  });

  // SSE 이벤트가 올 때마다 클라이언트가 상세를 다시 읽는다. git status는 그중 가장 비싼 부분이라
  // 짧은 TTL 캐시로 흡수한다(감사 최적화 지적). 변경 계열 action이 성공하면 즉시 무효화하므로
  // 커밋·되돌리기 직후에도 낡은 목록이 보이지 않는다.
  const changedPathsCache = new Map<string, { at: number; paths: string[] }>();
  const CHANGED_PATHS_TTL_MS = 2_000;
  const readChangedPaths = async (topicId: string, worktreePath: string): Promise<string[]> => {
    const cached = changedPathsCache.get(topicId);
    if (cached && Date.now() - cached.at < CHANGED_PATHS_TTL_MS) return cached.paths;
    const paths = await git.changedPaths(worktreePath);
    changedPathsCache.set(topicId, { at: Date.now(), paths });
    return paths;
  };

  let graphHostCache: { at: number; value: ReturnType<typeof readHostReviewGraph> } | null = null;
  app.get<{ Params: { id: string } }>("/api/topics/:id/graph", async request => {
    database.getTopic(request.params.id);
    if (!graphHostCache || Date.now() - graphHostCache.at > 10_000)
      graphHostCache = { at: Date.now(), value: readHostReviewGraph(config.dataDirectory) };
    return buildSessionGraph(database, request.params.id, graphHostCache.value);
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/topics/:id", async (request) => {
    const topic = database.getTopic(request.params.id);
    const after = Number(request.query.after ?? 0);
    const detail: TopicDetail = {
      topic,
      timeline: database.getTimeline(topic.id, Number.isFinite(after) ? after : 0),
      // 현재 계획은 현재 계획 sha 에 결속한 산출물이다 — 저장만 되고 승인되지 않은 개정본을 현재 계획으로 보여 주지 않는다(sha 가 없는 계획 전에는 최신 저장본).
      currentPlan: (topic.planSHA256 ? (await artifacts.verifiedRevision(topic.id, "plan", topic.planSHA256))?.content : undefined) ?? await artifacts.readLatest(topic.id, "plan"),
      previousPlan: await artifacts.readPrevious(topic.id, "plan"),
      consensus: await readJsonArtifact(artifacts, topic.id, "consensus"),
      implementationReport: await artifacts.readLatest(topic.id, "implementation"),
      codexReview: await artifacts.readLatest(topic.id, "codexReview"),
      changedPaths: await readChangedPaths(topic.id, topic.worktreePath),
      orphanCommitOID: database.getFlags(topic.id).orphanCommitOID,
      deliveryRecovery: toDeliveryRecovery(database.unknownDeliveryAction(topic.id)),
      // 역할과 실제 실행 AI(E2c C3) — 엔진 경로 판정과 같은 계획 제어 식으로 계산한다.
      routing: routingView(database, topic, job => planningControlApplies(database, topic.id, topic.state, turnFlags(job))),
    };
    return detail;
  });

  // 중재자 인계용 재개 정보(엔진 개편 E1) — 상태·승인·열린 요청·미해결 지적·한도·다음 허용 작업·근거 위치 + 중재 배정·정책 버전.
  app.get<{ Params: { id: string } }>("/api/topics/:id/resume", async (request) => {
    const info = await workflow.resumeInfo(request.params.id);
    const assignment = database.roles.effective(info.topicId, "mediator");
    const policy = readMediationPolicy(DEFAULT_MEDIATION_POLICY_PATH);
    return { ...info, mediation: { assignment, interrupt: interruptStatus(database, info.topicId), autonomy: readMediationAutonomy().autonomy, policyVersion: policy.version } };
  });

  // 러너 생존 표시: 작업 트리 최근 변경 + 실행 중 액션 여부. 스캔은 10초 캐시(큰 트리 반복 스캔 방지).
  const activityCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof scanWorktreeActivity>> }>();
  app.get<{ Params: { id: string } }>("/api/topics/:id/activity", async (request) => {
    const topic = database.getTopic(request.params.id);
    const cached = activityCache.get(topic.id);
    let activity: Awaited<ReturnType<typeof scanWorktreeActivity>>;
    if (!database.runningAction(topic.id)) {
      activity = {lastChangeAt:null,lastChangedPath:null,scanned:0,truncated:false};
    } else if (cached && Date.now() - cached.at < 10_000) {
      activity = cached.value; // 캐시 적중은 만료 시각을 연장하지 않는다(창 두 개가 번갈아 조회하면 영원히 과거에 머문다).
    } else {
      activity = await scanWorktreeActivity(topic.worktreePath);
      activityCache.set(topic.id, { at: Date.now(), value: activity });
    }
    return {
      state: topic.state,
      mediationInterrupt: interruptStatus(database, topic.id),
      runningAction: database.runningAction(topic.id) !== null,
      executionUsage: database.getExecutionUsage(topic.id),
      ...activity,
      budget: database.budgets.account(topic.id),
      budgetRecoveryRequired: !database.runningAction(topic.id) && database.budgets.hasUnfinishedExecution(topic.id),
      planningProgress: database.planning.progress(topic.id),
      revisionAllowance: database.revisions.account(topic.id),
      revisionPaused: workflow.revisionPaused(topic.id),
      reviewAllowances: [database.reviews.account(topic.id,"planning"),database.reviews.account(topic.id,"implementation")],
      reviewPaused: workflow.reviewPaused(topic.id),
      autoRetryAt: workflow.scheduledRetryAt(topic.id),
      checkedAt: new Date().toISOString(),
    };
  });

  // ---- 중재자 진단(2026-09-14) — 일반 메시지와 구분되는 기록. 등록·적용은 분리하고, 기존 멱등 요청 처리와 중재자 위임 검사를 그대로 쓴다.
  app.get<{ Params: { id: string } }>("/api/topics/:id/diagnoses", async (request) => ({ diagnoses: workflow.listDiagnoses(request.params.id) }));

  app.post<{ Params: { id: string } }>("/api/topics/:id/diagnoses", async (request, reply) => {
    const origin = callOrigin(request);
    const input = DiagnosisInputSchema.parse(request.body);
    return runIdempotent(request, reply, actionLedger(database, request.params.id, "diagnosis:register"), 201,
      (idempotencyKey) => workflow.registerDiagnosis(request.params.id, input, idempotencyKey, origin));
  });

  app.post<{ Params: { id: string; diagnosisId: string } }>("/api/topics/:id/diagnoses/:diagnosisId/apply", async (request, reply) => {
    const topicId = request.params.id;
    const diagnosisId = request.params.diagnosisId;
    if (!DIAGNOSIS_ID_PATTERN.test(diagnosisId)) throw Object.assign(new Error("진단 id 형식(DG-n)이 아닙니다."), { statusCode: 400 });
    const origin = callOrigin(request);
    const action = `diagnosis:apply:${diagnosisId}`;
    changedPathsCache.delete(topicId);
    return runIdempotent(request, reply, actionLedger(database, topicId, action), 200, async (idempotencyKey) => {
      const actionId = requestActionId(topicId, action, idempotencyKey);
      const started = await workflow.applyDiagnosis(topicId, diagnosisId, { requestKey: idempotencyKey, origin, actionId });
      return accepted(started, database.getTopic(topicId));
    });
  });

  app.post<{ Params: { id: string; role: string } }>("/api/topics/:id/participants/:role", async (request, reply) => {
    const role = parseRole(request.params.role);
    const input = AttachParticipantInputSchema.parse(request.body);
    const ledger = actionLedger(database, request.params.id, `participant:${role}`);
    return runIdempotent(request, reply, ledger, 200,
      (idempotencyKey) => workflow.attachParticipant(request.params.id, role, input, idempotencyKey));
  });

  app.get<{ Params: { id: string }; Querystring: { target: string } }>("/api/topics/:id/session-settings", async request =>
    readSessionSettings(database, request.params.id, SessionSettingsTargetSchema.parse(request.query.target)));
  app.post<{ Params: { id: string } }>("/api/topics/:id/session-settings", async (request, reply) => {
    if (request.headers["x-consensus-actor"] === "mediator") throw Object.assign(new Error("세션 설정은 사용자만 변경할 수 있습니다."), { statusCode: 403 });
    const input = SessionSettingsUpdateSchema.parse(request.body);
    return runIdempotent(request, reply, globalLedger(database, `session-settings:${request.params.id}:${input.target}`), 200, () => {
      const result = updateSessionSettings(database, request.params.id, input);
      database.events.emit("mediation-change");
      return result;
    });
  });

  app.post<{ Params: { id: string; role: string } }>("/api/topics/:id/participants/:role/settings", async (request, reply) => {
    const role = parseRole(request.params.role);
    const input = UpdateAgentSettingsInputSchema.parse(request.body);
    const ledger = actionLedger(database, request.params.id, `participant-settings:${role}`);
    return runIdempotent(request, reply, ledger, 200,
      (idempotencyKey) => workflow.updateAgentSettings(request.params.id, role, input, idempotencyKey));
  });

  app.post<{ Params: { id: string } }>("/api/topics/:id/planning-control/migration", async (request, reply) => {
    const origin = callOrigin(request);
    const input = PlanningMigrationSchema.parse(request.body);
    return runIdempotent(request, reply, actionLedger(database, request.params.id, "planning:migrate"), 200,
      key => workflow.migrateInterruptedPlanning(request.params.id, input, key, origin));
  });

  app.post<{ Params: { id: string } }>("/api/topics/:id/planning-control", async (request, reply) => {
    callOrigin(request);
    workflow.assertBudgetEditable(request.params.id);
    return runIdempotent(request, reply, actionLedger(database, request.params.id, "planning:enable"), 200, () => {
      database.planning.enable(request.params.id);
      return { version: database.planning.policyVersion(request.params.id), progress: database.planning.progress(request.params.id) };
    });
  });

  app.post<{ Params: { id: string } }>("/api/topics/:id/messages", async (request, reply) => {
    const input = PostMessageInputSchema.parse(request.body);
    const ledger = actionLedger(database, request.params.id, `message:${input.kind}`);
    // 위임 검사는 사용자 권한을 대행하는 종류 전부(decision·scope_change)에 — 증거 게시·메모만 계약상 OFF 에서도 중재자가 한다
    // (README 위임 표, F07). scope_change 를 예외로 두면 OFF 에서 중재자가 범위 세대를 올릴 수 있다(R3-04).
    const mediatorHeader = request.headers["x-consensus-actor"] === "mediator";
    const origin = input.kind === "note" || input.kind === "evidence"
      ? (mediatorHeader ? mediatorOrigin(request, null) : undefined)
      : callOrigin(request);
    return runIdempotent(request, reply, ledger, 200, (idempotencyKey) => input.kind === "scope_change"
      ? workflow.handleScopeChange(request.params.id, input.body, idempotencyKey, origin)
      : workflow.postMessage(request.params.id, input.kind, input.body, idempotencyKey, origin));
  });

  app.post<{ Params: { id: string; action: string } }>("/api/topics/:id/actions/:action", async (request, reply) => {
    const topicId = request.params.id;
    const action = request.params.action;
    // 커밋·되돌리기 등 worktree를 바꾸는 action 뒤에는 목록이 즉시 갱신돼야 한다.
    changedPathsCache.delete(topicId);
    const origin = DELEGATED_ACTIONS.has(action) ? callOrigin(request) : undefined;
    return runIdempotent(request, reply, actionLedger(database, topicId, action), 200, async (idempotencyKey) => {
      const actionId = requestActionId(topicId, action, idempotencyKey);
      if (origin) {
        database.appendEvent({ topicId, actor: "system", kind: "system", state: database.getTopic(topicId).state,
          body: `중재자 위임 호출: ${action}(위임 on, set_at ${origin.delegationSetAt ?? "?"})`, payload: { origin, action } });
      }
      let response: unknown;
      if(action === "resume-implementation") {
        const input = ResumeImplementationInputSchema.parse(request.body);
        response = accepted(randomUUID(), workflow.resumeImplementation(topicId, input, origin));
      }
      else if(action === "tool-tree-rebaseline") {
        const input = ToolTreeRebaselineInputSchema.parse(request.body);
        response = accepted(randomUUID(), await workflow.rebaselineToolTree(topicId, input.reason, origin, input.maintenanceLock));
      }
      else if(action === "review-resume") {
        workflow.assertBudgetEditable(topicId);
        const input=ReviewGrantInputSchema.parse(request.body);
        if(workflow.reviewPaused(topicId)!==input.scope)throw new Error("추가 승인이 필요한 리뷰 중단 상태가 아닙니다.");
        database.reviews.grant(topicId,input.scope,idempotencyKey,input.version);
        let budgetBlocked=false;
        const group=database.workGroups.forTopic(topicId);
        try {database.budgets.assertAvailable(group?[topicId,group.id]:[topicId]);} catch {budgetBlocked=true;}
        response=budgetBlocked?{...accepted(actionId,database.getTopic(topicId)),resumeBlocked:"리뷰 1회를 추가했습니다. 토큰·시간 예산도 추가한 뒤 재개하세요."}
          :accepted(workflow.retry(topicId,actionId),database.getTopic(topicId));
      }
      else if(action === "amend-tolerance") {
        const input=AmendToleranceInputSchema.parse(request.body);
        response=accepted(actionId, await workflow.amendTolerance(topicId,input,idempotencyKey));
      }
      else if(action === "revision-resume") {
        workflow.assertBudgetEditable(topicId);
        const input=RevisionGrantInputSchema.parse(request.body);
        if(!workflow.revisionPaused(topicId))throw new Error("추가 승인이 필요한 계획 재작성 중단 상태가 아닙니다.");
        database.revisions.grant(topicId,idempotencyKey,input.version);
        let budgetBlocked=false;
        const group=database.workGroups.forTopic(topicId);
        try {database.budgets.assertAvailable(group?[topicId,group.id]:[topicId]);} catch {budgetBlocked=true;}
        if(budgetBlocked)response={...accepted(actionId,database.getTopic(topicId)),resumeBlocked:"재작성 1회를 추가했습니다. 토큰·시간 예산도 추가한 뒤 재개하세요."};
        else response=accepted(database.getTopic(topicId).state==="DRAFT"?workflow.startPlan(topicId,actionId):workflow.retry(topicId,actionId),database.getTopic(topicId));
      }
      else if (action === "budget-configure" || action === "budget-resume") {
        workflow.assertBudgetEditable(topicId);
        if (action === "budget-configure") {
          const body = request.body as { policy?: unknown };
          database.budgets.configure(topicId,BudgetPolicySchema.parse(body?.policy),"user-explicit");
        } else {
          const body = BudgetResumeInputSchema.parse(request.body);
          if ("resumeExecutionId" in body) database.budgets.resumeExecution(topicId,idempotencyKey,body.resumeExecutionId,body.version);
          else database.budgets.grant(topicId,idempotencyKey,body.policy,body.version);
        }
        if (action === "budget-resume" && ["FAILED","USER_DECISION_REQUIRED"].includes(database.getTopic(topicId).state)) {
          const blocker=workflow.budgetResumeBlocker(topicId);
          response = blocker
            ? {...accepted(actionId,database.getTopic(topicId)),resumeBlocked:`예산 재개를 기록했습니다. ${blocker}`}
            : accepted(workflow.retry(topicId,actionId),database.getTopic(topicId));
        } else response = accepted(randomUUID(),database.getTopic(topicId));
      }
      else if (action === "brainstorm") response = accepted(workflow.startBrainstorm(topicId, BrainstormInputSchema.parse(request.body ?? {}), actionId), database.getTopic(topicId));
      else if (action === "brainstorm-plan" || action === "brainstorm-close") response = accepted(workflow.finishBrainstorm(topicId,
        BrainstormDecisionSchema.parse(request.body), action === "brainstorm-plan" ? "plan" : "close", actionId, origin), database.getTopic(topicId));
      else if (action === "plan") response = accepted(workflow.startPlan(topicId, actionId), database.getTopic(topicId));
      else if (action === "stop") {
        workflow.stop(topicId);
        response = accepted(randomUUID(), database.getTopic(topicId));
      } else if (action === "retry") response = accepted(workflow.retry(topicId, actionId), database.getTopic(topicId));
      else if (action === "approve") {
        const input = ApprovalInputSchema.parse(request.body);
        response = accepted(randomUUID(), workflow.approve(topicId, input.planSHA256));
      } else if (action === "implement") {
        const input = ImplementInputSchema.parse(request.body ?? {});
        response = accepted(workflow.startImplementation(topicId, actionId, input.kickoffDecision), database.getTopic(topicId));
      }
      else if (action === "commit") {
        const input = DeliveryInputSchema.parse(request.body);
        const oid = await workflow.commit(topicId, input.message, input.paths, idempotencyKey);
        response = { accepted: true, actionId: oid, topic: database.getTopic(topicId) };
      } else if (action === "push") {
        const oid = await workflow.push(topicId);
        response = { accepted: true, actionId: oid, topic: database.getTopic(topicId) };
      } else if (action === "reconcile-delivery") {
        const input = ReconcileDeliveryInputSchema.parse(request.body);
        response = accepted(randomUUID(), await workflow.reconcileDelivery(topicId, input));
      } else if (action === "discard-orphan-commit") {
        response = accepted(randomUUID(), await workflow.discardOrphanCommit(topicId));
      } else if (action === "close") response = accepted(randomUUID(), await workflow.closeStage(topicId));
      else if (action === "archive") response = accepted(workflow.archiveBuildTrees(topicId, actionId), database.getTopic(topicId));
      else throw Object.assign(new Error(`알 수 없는 action입니다: ${action}`), { statusCode: 404 });
      return response;
    });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; token?: string } }>(
    "/api/topics/:id/events",
    async (request, reply) => streamEvents(request, reply, database),
  );

  app.setErrorHandler((error, _request, reply) => {
    const value = error as { issues?: unknown; statusCode?: number; errorCode?: unknown; current?: unknown };
    const statusCode = value.issues ? 400 : Math.max(400, value.statusCode ?? 500);
    void reply.code(statusCode).send({ error: safeError(error),
      ...(typeof value.errorCode === "string" ? { code: value.errorCode, current: value.current ?? null } : {}) });
  });

  try {
    await access(config.webDirectory);
    await app.register(fastifyStatic, {
      root: config.webDirectory,
      wildcard: false,
      // index.html이 캐시되면 리빌드로 해시가 바뀐 옛 에셋을 가리켜 빈 화면이 된다(2026-09-01 실측).
      // 해시 붙은 에셋은 불변이므로 길게, html은 항상 재검증.
      setHeaders: (reply, path) => {
        if (path.endsWith(".html")) reply.header("Cache-Control", "no-cache");
        else if (path.includes("/assets/")) reply.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "API를 찾을 수 없습니다." });
      // wildcard:false는 기동 시점 파일 목록으로 에셋 라우트를 고정한다 — 서버가 도는 동안 리빌드된
      // 새 해시 에셋은 여기로 떨어지고, index.html 폴백이 module script MIME 거부(빈 화면)를 만든다
      // (2026-09-01 실측). 실재 파일이면 파일로 서빙한다. sendFile은 root 밖 탈출을 스스로 막는다.
      const pathname = request.url.split("?", 1)[0];
      if (pathname.startsWith("/assets/") && existsSync(join(config.webDirectory, pathname))) {
        return reply.sendFile(pathname.slice(1));
      }
      return reply.sendFile("index.html");
    });
  } catch {
    app.get("/", async (_request, reply) => reply.type("text/plain").send("Consensus Room backend is running."));
  }

  // 이전 서버의 잔여 작업 회수는 listen 성공 뒤에만 한다 — 같은 데이터 폴더로 두 번째 서버를
  // 실수로 띄우면 포트 바인드에서 먼저 죽어야지, 첫 서버의 정상 작업을 회수(=강제 종료)하고
  // 죽으면 안 된다(2026-08-31 Codex 지적: 부팅 회수가 bind보다 먼저라 소유권 없이 남의 작업을 죽임).
  app.addHook("onListen", async () => {
    await verifications.recoverExpired();
    await new ProcessSupervisor(undefined, undefined, join(config.dataDirectory, "review-tools", "host-review")).recover(database.runningActions());
    database.recoverInterruptedActions();
    database.recoverInterruptedNonDeliveryRequests();
    database.recoverInterruptedDeliveryRequests();
    database.recoverInterruptedGlobalRequests();
    database.restoreMediatorInterrupts();
    const restored = workflow.restoreScheduledRetries();
    evidence.start();
    engineDefects.start();
    if (restored > 0) process.stdout.write(`시작: 사용 한도로 멈춘 주제 ${restored}건의 자동 재시도 예약을 복원했습니다.\n`);
  });

  // 종료 순서: 새 요청 차단(shuttingDown) → 실행 중 에이전트 중단·원장 마감 → DB 닫기. DB 만 닫으면 에이전트 프로세스가
  // 고아로 남고 원장이 running 인 채 재시작 회수에 기대야 했다(2026-09-07 Codex 제안 ②).
  app.addHook("onClose", async () => {
    await engineDefects.stop();
    await evidence.stop();
    const stopped = await workflow.shutdown();
    if (stopped > 0) process.stdout.write(`종료: 실행 중이던 action ${stopped}건을 중단하고 원장을 마감했습니다.\n`);
    database.close();
  });
  return app;
}

// actionId null: 실행을 열지 않았다(예: 등록된 다른 수정 진단의 적용을 기다리는 순차 적용).
function accepted(actionId: string | null, topic: ReturnType<ConsensusDatabase["getTopic"]>) {
  return { accepted: true, actionId, topic };
}

interface RequestLedger {
  claim(idempotencyKey: string, request: Record<string, unknown>): boolean;
  read(idempotencyKey: string): {
    status: "running" | "succeeded" | "failed" | "unknown";
    response: unknown;
    error: string | null;
    request: Record<string, unknown>;
  } | null;
  finish(idempotencyKey: string, response: unknown): void;
  fail(idempotencyKey: string, error: string): void;
}

function actionLedger(database: ConsensusDatabase, topicId: string, action: string): RequestLedger {
  return {
    claim: (key, record) => database.claimActionRequest(topicId, action, key, record),
    read: (key) => database.getActionRequest(topicId, action, key),
    finish: (key, response) => database.finishActionRequest(topicId, action, key, response),
    fail: (key, error) => database.failActionRequest(topicId, action, key, error),
  };
}

function globalLedger(database: ConsensusDatabase, scope: string): RequestLedger {
  return {
    claim: (key, record) => database.claimGlobalRequest(scope, key, record),
    read: (key) => database.getGlobalRequest(scope, key),
    finish: (key, response) => database.finishGlobalRequest(scope, key, response),
    fail: (key, error) => database.failGlobalRequest(scope, key, error),
  };
}

// 변경 라우트는 전부 claim → 실행 → finish/fail 3단을 지난다. 같은 키를 다시 받으면 저장한 응답을 같은 상태코드로 재생한다.
async function runIdempotent(
  request: FastifyRequest,
  reply: FastifyReply,
  ledger: RequestLedger,
  successCode: number,
  work: (idempotencyKey: string) => Promise<unknown> | unknown,
  requestFingerprint?: string,
): Promise<unknown> {
  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200) {
    return reply.code(400).send({ error: "Idempotency-Key 헤더가 필요합니다." });
  }
  const requestRecord = request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? redactRecord(request.body as Record<string, unknown>)
    : {};
  if (requestFingerprint) requestRecord._requestFingerprint = requestFingerprint;
  if (!ledger.claim(idempotencyKey, requestRecord)) {
    const existing = ledger.read(idempotencyKey);
    // 같은 키가 다른 본문으로 재사용되면 예전 응답을 재생하지 않는다(감사 부차 지적) — 클라이언트 버그가
    // 조용히 엉뚱한 결과를 받는 대신 409로 드러나게 한다. 비교 기준은 claim 때 저장한 마스킹된 본문이다.
    if (existing && JSON.stringify(existing.request) !== JSON.stringify(requestRecord)) {
      return reply.code(409).send({
        error: "같은 Idempotency-Key가 다른 요청 본문으로 재사용되었습니다. 새 키를 쓰세요.",
        status: existing.status,
      });
    }
    if (existing?.status === "succeeded") return reply.code(successCode).send(existing.response);
    const message = existing?.error ?? (existing?.status === "running"
      ? "같은 요청이 아직 처리 중입니다."
      : "같은 Idempotency-Key 요청의 결과를 확인할 수 없습니다.");
    return reply.code(409).send({ error: message, status: existing?.status ?? "unknown" });
  }
  try {
    const response = await work(idempotencyKey);
    ledger.finish(idempotencyKey, response);
    return reply.code(successCode).send(response);
  } catch (error) {
    ledger.fail(idempotencyKey, safeError(error));
    throw error;
  }
}

function makeSlug(title: string): string {
  const slug = title.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "topic";
}

function parseRole(value: string): ParticipantRole {
  if (value !== "claude" && value !== "codex") throw new Error(`지원하지 않는 역할입니다: ${value}`);
  return value;
}

function requestActionId(topicId: string, action: string, key: string): string {
  return createHash("sha256").update(`${topicId}\0${action}\0${key}`, "utf8").digest("hex");
}

async function readJsonArtifact(store: ArtifactStore, topicId: string, kind: string): Promise<Record<string, unknown> | null> {
  const raw = await store.readLatest(topicId, kind);
  return raw ? JSON.parse(raw) as Record<string, unknown> : null;
}

function toDeliveryRecovery(value: ReturnType<ConsensusDatabase["unknownDeliveryAction"]>) {
  if (!value) return null;
  return {
    action: value.action,
    idempotencyKey: value.idempotencyKey,
    createdAt: value.createdAt,
    requestedPaths: Array.isArray(value.request.paths)
      ? value.request.paths.filter((path): path is string => typeof path === "string")
      : [],
  };
}

function streamEvents(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { after?: string; token?: string } }>,
  reply: FastifyReply,
  database: ConsensusDatabase,
): void {
  const topicId = request.params.id;
  database.getTopic(topicId);
  const after = Number(request.query.after ?? request.headers["last-event-id"] ?? 0);
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let lastSent = Number.isFinite(after) ? after : 0;
  const send = (event: ReturnType<ConsensusDatabase["getTimeline"]>[number]) => {
    if (event.sequence <= lastSent) return;
    lastSent = event.sequence;
    response.write(`id: ${event.sequence}\nevent: timeline\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const eventName = `topic:${topicId}`;
  database.events.on(eventName, send);
  database.getTimeline(topicId, lastSent).forEach(send);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  request.raw.once("close", () => {
    clearInterval(heartbeat);
    database.events.off(eventName, send);
  });
}
