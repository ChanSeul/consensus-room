import {ReviewGrantInputSchema} from "../shared/reviews.js";
import { DIAGNOSIS_ID_PATTERN, DiagnosisInputSchema } from "../shared/diagnoses.js";
import { readFileSync } from "node:fs";
import {
  ToolTreeRebaselineInputSchema,
  ResumeImplementationInputSchema, AmendToleranceInputSchema } from "../shared/contracts.js";
import { RevisionGrantInputSchema } from "../shared/revisions.js";
import { WorkGroupInputSchema } from "../shared/workGroups.js";
import { WorkGroupService } from "./workGroupService.js";
import { BudgetPolicySchema } from "../shared/budgets.js";
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
import { GitService } from "./git.js";
import { redactRecord, safeError } from "./security.js";
import { redactSecrets } from "../shared/workflow.js";
import type { AgentAdapter, CommandRunner, ParticipantRole } from "./types.js";
import {
  type CallOrigin, WorkflowEngine } from "./workflow.js";
import { ProcessSupervisor } from "./processSupervisor.js";
import { ProjectMemoryStore } from "./memoryStore.js";
import { readMediationAutonomy, writeMediationAutonomy } from "./mediationAutonomy.js";
import { scanWorktreeActivity } from "./activity.js";
import { VerificationService, completeVerificationSchema } from "./verifications.js";

export interface AppDependencies {
  config?: ServerConfig;
  database?: ConsensusDatabase;
  runner: CommandRunner;
  claude: AgentAdapter;
  codex: AgentAdapter;
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
  const workflow = new WorkflowEngine({
    database,
    artifacts,
    git,
    claude: dependencies.claude,
    codex: dependencies.codex,
    verifications,
    memory: new ProjectMemoryStore(config.memoryDirectory),
    executionLimits: config.executionLimits,
    enforceBudgets: config.enforceBudgets ?? true,
    maintenanceLockPath: join(config.dataDirectory, "maintenance.lock"),
  });
  // 중재 세션의 호출은 헤더 x-consensus-actor: mediator 로 구분한다. 결정·승인·실행·인도 류는 위임 스위치(mediation-autonomy.json)가
  // on 일 때만 받는다(off 면 403) — "중재자가 사용자와 같은 인증으로 무엇이든 부른다" 를 닫는다(2026-09-14 Codex 감사 D03).
  const delegationPath = join(config.dataDirectory, "mediation-autonomy.json");
  const DELEGATED_ACTIONS = new Set(["approve", "implement", "tool-tree-rebaseline", "commit", "push", "close", "review-resume", "revision-resume", "budget-configure", "budget-resume", "amend-tolerance", "resume-implementation", "reconcile-delivery", "discard-orphan-commit"]);
  const callOrigin = (request: { headers: Record<string, unknown> }, subject: string): CallOrigin | undefined => {
    if (request.headers["x-consensus-actor"] !== "mediator") return undefined;
    let doc: { autonomy?: string; set_at?: string } = {};
    try { doc = JSON.parse(readFileSync(delegationPath, "utf8")) as { autonomy?: string; set_at?: string }; } catch { doc = {}; }
    if (doc.autonomy !== "on") {
      throw Object.assign(new Error(`중재자 위임이 off 입니다 — ${subject} 는 사용자 승인이 필요합니다(mediation_autonomy.sh on).`), { statusCode: 403 });
    }
    return { actor: "mediator", delegationSetAt: doc.set_at ?? null };
  };
  const workGroups = new WorkGroupService(database,git,config.repositoryPath,config.worktreesDirectory,config.defaultAgentSettings);
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

  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/config", async () => ({
    repositoryPath: config.repositoryPath,
    memoryDirectory: config.memoryDirectory,
    defaultAgentSettings: config.defaultAgentSettings,
  }));
  app.get("/api/work-groups",async()=>database.workGroups.list().map(group=>({...group,budget:database.budgets.account(group.id),stageStates:Object.fromEntries(group.stages.map(stage=>[stage.id,group.links[stage.id]?database.getTopic(group.links[stage.id].topicId).state:null]))})));
  app.post("/api/work-groups",async(request,reply)=>{
    const input=WorkGroupInputSchema.parse(request.body);
    return runIdempotent(request,reply,globalLedger(database,"work-group:create"),201,key=>workGroups.create(input,id=>database.annotateGlobalRequest("work-group:create",key,{plannedGroupId:id})));
  });
  app.post<{Params:{id:string}}>("/api/work-groups/:id/next",async(request,reply)=>
    (callOrigin(request, "work-group:next"), runIdempotent(request,reply,globalLedger(database,`work-group:next:${request.params.id}`),201,key=>workGroups.next(request.params.id,(plannedTopicId,worktreePath)=>database.annotateGlobalRequest(`work-group:next:${request.params.id}`,key,{plannedTopicId,worktreePath})))));
  app.post<{Params:{id:string}}>("/api/work-groups/:id/budget",async(request,reply)=>{
    callOrigin(request, "work-group:budget");
    const body=request.body as {policy:unknown;version:number};
    const policy=BudgetPolicySchema.parse(body?.policy);
    return runIdempotent(request,reply,globalLedger(database,`work-group:budget:${request.params.id}`),200,key=>{
      const group=database.workGroups.get(request.params.id);
      for(const link of Object.values(group.links))workflow.assertBudgetEditable(link.topicId);
      const granted=database.budgets.grant(group.id,key,policy,body.version);
      for(const link of Object.values(group.links)) {
        const topic=database.getTopic(link.topicId);
        const interruption=database.getTimeline(topic.id).filter(event=>event.scopeGeneration===topic.scopeGeneration && event.actor==="system" && event.payload?.resumeState).at(-1);
        if(topic.state!=="FAILED" && !(topic.state==="USER_DECISION_REQUIRED" && interruption?.payload?.budgetPause===true))continue;
        try {database.budgets.assertAvailable([topic.id,group.id]);}
        catch {return {...granted,resumeBlocked:"묶음 예산을 늘렸습니다. 해당 토픽의 예산도 추가한 뒤 재개하세요."};}
        if(workflow.reviewPaused(topic.id))return {...granted,resumeBlocked:"묶음 예산을 늘렸습니다. 리뷰 1회 추가 승인도 필요합니다."};
        if(workflow.revisionPaused(topic.id))return {...granted,resumeBlocked:"묶음 예산을 늘렸습니다. 계획 재작성 1회 추가 승인도 필요합니다."};
        workflow.retry(topic.id,requestActionId(topic.id,"group-budget-resume",key));
        return {...granted,resumedTopicId:topic.id};
      }
      return granted;
    });
  });
  app.post<{Params:{id:string}}>("/api/work-groups/:id/revise",async(request,reply)=>{
    const body=request.body as {input:unknown;version:number};
    const input=WorkGroupInputSchema.parse(body?.input);
    return runIdempotent(request,reply,globalLedger(database,`work-group:revise:${request.params.id}`),200,async()=>{
      const group=database.workGroups.get(request.params.id);
      for(const link of Object.values(group.links))workflow.assertBudgetEditable(link.topicId);
      if(group.stages.every(stage=>group.links[stage.id] && database.getTopic(group.links[stage.id].topicId).state==="CLOSED"))throw new Error("완료한 작업 묶음은 변경할 수 없습니다.");
      if(Object.keys(group.pending??{}).length)throw new Error("준비 중인 단계를 먼저 연결하세요.");
      for(const stage of group.stages) {
        const link=group.links[stage.id];
        if(link && database.getTopic(link.topicId).state==="CLOSED" && JSON.stringify(stage)!==JSON.stringify(input.stages.find(next=>next.id===stage.id)))throw new Error("완료한 단계의 목표와 조건은 바꿀 수 없습니다.");
      }
      const next=database.workGroups.previewRevision(group.id,input,body.version);
      for(const [stageId,link] of Object.entries(next.links)) {
        const topic=database.getTopic(link.topicId);
        if(topic.state!=="CLOSED") {
          await workflow.handleScopeChange(topic.id,"공통 계약 변경: "+next.contracts);

        }
      }
      database.workGroups.atomic(()=>{
        database.workGroups.revise(group.id,input,body.version);
        for(const [stageId,link] of Object.entries(next.links))if(database.getTopic(link.topicId).state!=="CLOSED")database.workGroups.acknowledgeRevision(group.id,stageId);
      });
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

  // 자율 중재 위임 스위치 — 웹 토글과 셸 스크립트가 같은 파일(`mediation-autonomy.json`)을 공유한다.
  app.get("/api/mediation-autonomy", async () => readMediationAutonomy(config.dataDirectory));
  app.post("/api/mediation-autonomy", async (request, reply) => {
    // 위임 변경은 사용자 권한이다 — 중재자 호출(헤더)은 OFF 를 스스로 ON 으로 바꿀 수 없다(F07).
    if (request.headers["x-consensus-actor"] === "mediator") {
      throw Object.assign(new Error("위임 스위치는 사용자만 바꿀 수 있습니다(중재자 호출 거부)."), { statusCode: 403 });
    }
    const input = UpdateMediationAutonomyInputSchema.parse(request.body);
    return runIdempotent(request, reply, globalLedger(database, "mediation-autonomy:set"), 200, () =>
      writeMediationAutonomy(config.dataDirectory, { autonomy: input.autonomy, note: input.note, setBy: "web" }));
  });

  app.post("/api/topics", async (request, reply) => {
    const input = CreateTopicInputSchema.parse(request.body);
    // 주제는 아직 topic_id가 없어 전역 원장을 쓴다. claim이 worktree 생성보다 앞이어야 중복 요청이 worktree를 두 번 만들지 않는다.
    return runIdempotent(request, reply, globalLedger(database, "topic:create"), 201, async (idempotencyKey) => {
      const id = randomUUID();
      const safeTitle = redactSecrets(input.title);
      const slug = makeSlug(safeTitle);
      const repositoryPath = config.repositoryPath;
      const worktreePath = resolve(config.worktreesDirectory, `${slug}-${id.slice(0, 8)}`);
      // 부작용 전에 계획을 원장에 남긴다. 서버가 도중에 죽어도 재시작 복구가 topic 존재 여부로 완료를 판정한다.
      database.annotateGlobalRequest("topic:create", idempotencyKey, { plannedTopicId: id, worktreePath });
      await git.createDetachedWorktree(repositoryPath, worktreePath, input.baseRef);
      const timestamp = new Date().toISOString();
      const topic = database.createTopic({
        id, slug, title: safeTitle, repositoryPath, baseRef: input.baseRef, worktreePath,
        branchPrefix: input.branchPrefix,
        requestedBranchName: input.requestedBranchName,
        predecessorTopicId: input.predecessorTopicId,
        branchName: null, state: "DRAFT", scopeGeneration: 1, planRevision: 0,
        planSHA256: null, approvedPlanSHA256: null, createdAt: timestamp, updatedAt: timestamp, lastError: null,
        agentSettings: config.defaultAgentSettings,
      });
      database.appendEvent({
        topicId: id, actor: "system", kind: "system", state: "DRAFT",
        body: "주제 전용 detached worktree를 만들었습니다.",
        payload: { worktreePath, baseRef: input.baseRef, requestKey: idempotencyKey },
      });
      return topic;
    });
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
    };
    return detail;
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
      runningAction: database.runningAction(topic.id) !== null,
      executionUsage: database.getExecutionUsage(topic.id),
      ...activity,
      budget: database.budgets.account(topic.id),
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
    const origin = callOrigin(request, "diagnosis:register");
    const input = DiagnosisInputSchema.parse(request.body);
    return runIdempotent(request, reply, actionLedger(database, request.params.id, "diagnosis:register"), 201,
      (idempotencyKey) => workflow.registerDiagnosis(request.params.id, input, idempotencyKey, origin));
  });

  app.post<{ Params: { id: string; diagnosisId: string } }>("/api/topics/:id/diagnoses/:diagnosisId/apply", async (request, reply) => {
    const topicId = request.params.id;
    const diagnosisId = request.params.diagnosisId;
    if (!DIAGNOSIS_ID_PATTERN.test(diagnosisId)) throw Object.assign(new Error("진단 id 형식(DG-n)이 아닙니다."), { statusCode: 400 });
    const origin = callOrigin(request, "diagnosis:apply");
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

  app.post<{ Params: { id: string; role: string } }>("/api/topics/:id/participants/:role/settings", async (request, reply) => {
    const role = parseRole(request.params.role);
    const input = UpdateAgentSettingsInputSchema.parse(request.body);
    const ledger = actionLedger(database, request.params.id, `participant-settings:${role}`);
    return runIdempotent(request, reply, ledger, 200,
      (idempotencyKey) => workflow.updateAgentSettings(request.params.id, role, input, idempotencyKey));
  });

  app.post<{ Params: { id: string } }>("/api/topics/:id/messages", async (request, reply) => {
    const input = PostMessageInputSchema.parse(request.body);
    const ledger = actionLedger(database, request.params.id, `message:${input.kind}`);
    // 위임 검사는 사용자 권한을 대행하는 종류 전부(decision·scope_change)에 — 증거 게시·메모만 계약상 OFF 에서도 중재자가 한다
    // (README 위임 표, F07). scope_change 를 예외로 두면 OFF 에서 중재자가 범위 세대를 올릴 수 있다(R3-04).
    const mediatorHeader = request.headers["x-consensus-actor"] === "mediator";
    const origin = input.kind === "note" || input.kind === "evidence"
      ? (mediatorHeader ? { actor: "mediator" as const, delegationSetAt: null } : undefined)
      : callOrigin(request, `message:${input.kind}`);
    return runIdempotent(request, reply, ledger, 200, (idempotencyKey) => input.kind === "scope_change"
      ? workflow.handleScopeChange(request.params.id, input.body, idempotencyKey, origin)
      : workflow.postMessage(request.params.id, input.kind, input.body, idempotencyKey, origin));
  });

  app.post<{ Params: { id: string; action: string } }>("/api/topics/:id/actions/:action", async (request, reply) => {
    const topicId = request.params.id;
    const action = request.params.action;
    // 커밋·되돌리기 등 worktree를 바꾸는 action 뒤에는 목록이 즉시 갱신돼야 한다.
    changedPathsCache.delete(topicId);
    const origin = DELEGATED_ACTIONS.has(action) ? callOrigin(request, `action:${action}`) : undefined;
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
        const body = request.body as { policy?: unknown; version?: number };
        const policy = BudgetPolicySchema.parse(body?.policy);
        if (action === "budget-configure") database.budgets.configure(topicId,policy,"user-explicit");
        else database.budgets.grant(topicId,idempotencyKey,policy,body?.version ?? -1);
        if (action === "budget-resume" && ["FAILED","USER_DECISION_REQUIRED"].includes(database.getTopic(topicId).state)) {
          response = workflow.revisionPaused(topicId) || workflow.reviewPaused(topicId)
            ? {...accepted(actionId,database.getTopic(topicId)),resumeBlocked:"예산을 추가했습니다. 중단된 계획 재작성 또는 리뷰의 1회 추가 승인도 필요합니다."}
            : accepted(workflow.retry(topicId,actionId),database.getTopic(topicId));
        } else response = accepted(randomUUID(),database.getTopic(topicId));
      }
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
      } else if (action === "close") response = accepted(randomUUID(), workflow.close(topicId));
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
    const value = error as { issues?: unknown; statusCode?: number };
    const statusCode = value.issues ? 400 : Math.max(400, value.statusCode ?? 500);
    void reply.code(statusCode).send({ error: safeError(error) });
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
    await new ProcessSupervisor().recover(database.runningActions());
    database.recoverInterruptedActions();
    database.recoverInterruptedNonDeliveryRequests();
    database.recoverInterruptedDeliveryRequests();
    database.recoverInterruptedGlobalRequests();
    const restored = workflow.restoreScheduledRetries();
    if (restored > 0) process.stdout.write(`시작: 사용 한도로 멈춘 주제 ${restored}건의 자동 재시도 예약을 복원했습니다.\n`);
  });

  // 종료 순서: 새 요청 차단(shuttingDown) → 실행 중 에이전트 중단·원장 마감 → DB 닫기. DB 만 닫으면 에이전트 프로세스가
  // 고아로 남고 원장이 running 인 채 재시작 회수에 기대야 했다(2026-09-07 Codex 제안 ②).
  app.addHook("onClose", async () => {
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
