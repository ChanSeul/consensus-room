import {reviewScope} from "../shared/reviews.js";
import type {ReviewLedger} from "./reviewLedger.js";
import type { RevisionLedger } from "./revisionLedger.js";
import type { RewriteKind } from "../shared/revisions.js";
import { BUDGET_KEYS, hasBudgetLimits, zeroBudget } from "../shared/budgets.js";
import { randomUUID } from "node:crypto";
import type { AgentAdapter, SessionTurn } from "./types.js";
import { BudgetBlocked, type BudgetLedger } from "./budgetLedger.js";
import type { ConsensusDatabase } from "./database.js";
import { planningKey, recoverableFinalizedFirstPlan } from "./planningStore.js";
import { planningControlApplies } from "./guardedPlanning.js";
import { jobOfTurn } from "./adapters/turnPolicy.js";
import { planningPacketLimit } from "../shared/planningControl.js";

interface Context { topicId: string; accounts: string[]; stage: string; }
// 코드 리뷰 원장이 소유하는 작업 — 읽기·판정·그 판정의 계약 교정은 한 논리 리뷰다. 교정에도 호스트가 넘긴 원장 ID 가 있어야 재사용하며,
// 답변 확인이나 원장 밖 교정은 기존처럼 호출마다 예약한다. 사용량·실제 호출 기록은 계속 각 실행에 남긴다.
const REVIEW_LEDGER_OPERATIONS: ReadonlySet<string> = new Set(["review", "final-review", "review-read", "contract-correction"]);
// All model methods pass through this boundary, including direct delivery/correction calls.
export class BudgetController {
  constructor(private readonly ledger: BudgetLedger, private readonly context: (cwd:string) => Context,
    private readonly checkpoint: (topicId:string, output:unknown) => Promise<void>,
    private readonly revisions?: RevisionLedger, private readonly budgetsEnabled = true, private readonly reviews?:ReviewLedger,
    private readonly database?: ConsensusDatabase) {}
  wrap(adapter: AgentAdapter): AgentAdapter {
    const wrapper: AgentAdapter = {
      role:adapter.role,
      validateExistingSession: id => adapter.validateExistingSession(id),
      ...(adapter.isSessionMissing ? { isSessionMissing: (id: string) => adapter.isSessionMissing!(id) } : {}),
      createSession: turn => this.run(adapter.role,turn,t => adapter.createSession(t)),
      resumeTurn: turn => this.run(adapter.role,turn,t => adapter.resumeTurn(t as SessionTurn)),
    };
    if (adapter.resumePlanRepair) wrapper.resumePlanRepair = turn => this.run(adapter.role,{...turn,planningWrite:"repair"},t => adapter.resumePlanRepair!(t as SessionTurn));
    return wrapper;
  }
  private async run<T>(role:string, turn:Omit<SessionTurn,"sessionId">, invoke:(turn:Omit<SessionTurn,"sessionId">)=>Promise<T>):Promise<T> {
    turn.signal?.throwIfAborted();
    const ctx=this.context(turn.cwd), id=randomUUID(), startedAt=Date.now();
    // 재작성·리뷰 한도는 공급자 이름이 아니라 턴의 job 역할로 집계한다 — 계획자·검토자가 다른 공급자로 배정돼도 한도가 빠지지 않게(E2b).
    // role(공급자)은 세션 귀속이라 체크포인트 대조·키·예산 원장에는 그대로 쓴다.
    const job=jobOfTurn(role as "claude"|"codex",turn);
    const kind:RewriteKind|undefined=job.role==="planner" && ["CLAUDE_PLAN","CLAUDE_REVISION"].includes(ctx.stage)
      ? turn.planningWrite ?? (ctx.stage==="CLAUDE_PLAN"?"plan":"revision") : undefined;
    const review=job.role==="reviewer"?reviewScope(ctx.stage):undefined;
    const guarded = this.database ? planningControlApplies(this.database, ctx.topicId, ctx.stage, turn) : false;
    const latest = guarded ? this.database!.planning.latest(ctx.topicId) : null;
    const topic = guarded ? this.database!.getTopic(ctx.topicId) : null;
    const finalizedFirstPlanRecovery = Boolean(topic && ctx.stage === "CLAUDE_PLAN" &&
      recoverableFinalizedFirstPlan(latest, topic, this.database!.getTimeline(ctx.topicId)));
    const continued = latest && (!latest.finalized || finalizedFirstPlanRecovery) && latest.stage === ctx.stage && latest.role === role &&
      latest.scopeGeneration === topic?.scopeGeneration && latest.planEpoch === topic.planEpoch && latest.planSHA256 === topic.planSHA256 ? latest : null;
    const saved = continued ?? (guarded ? this.database!.planning.get(planningKey(topic!, role, turn.prompt)) : null);
    // 코드 리뷰 원장(E3-4c) — 논리 리뷰 한 번의 읽기·최종 판정 호출은 호스트가 연 원장 ID 하나로 리뷰 1회를 예약한다(ReviewLedger.reserve 는 ID 마다
    // 멱등이라 같은 ID 의 다음 호출은 새로 세지 않는다). 실행 예산·사용량 원장은 여전히 호출마다 따로 id 로 쌓는다(환불·초기화 없음).
    const ledger = review === "implementation" && turn.reviewLedger && REVIEW_LEDGER_OPERATIONS.has(job.operation) ? turn.reviewLedger : null;
    const admissionId = saved?.admissionId ?? ledger ?? id;
    const preparedTurn = guarded ? { ...turn, planningControl: { admissionId, maxPromptBytes: planningPacketLimit(ctx.stage) } } : turn;
    if(!this.budgetsEnabled) {
      if(review)this.reviews?.admit(ctx.topicId,admissionId,review);
      if(kind)this.revisions?.admit(ctx.topicId,admissionId,kind);
      return invoke(preparedTurn);
    }
    const reserve=()=>{if(kind)this.revisions?.reserve(ctx.topicId,admissionId,kind);if(review)this.reviews?.reserve(ctx.topicId,admissionId,review);};
    const execution=this.ledger.start({id,accounts:ctx.accounts,stage:ctx.stage,role,model:turn.settings?.model??"unknown",
      effort:turn.settings?.effort??"unknown",startedAt,dispatchStarted:false},reserve);
    const boundedAccounts = ctx.accounts.map(id => this.ledger.account(id)!).flatMap(account =>
      hasBudgetLimits(account.policy) ? [{ used: account.used, policy: account.policy }] : []);
    const executionBudget = execution.limit ? Object.fromEntries(BUDGET_KEYS.map(key => [key, Math.min(execution.limit![key],
      ...boundedAccounts.map(account => Math.max(0, account.policy.total[key] - account.used[key])))])) as import("../shared/budgets.js").BudgetVector : undefined;
    const controller=new AbortController();
    const observed=zeroBudget();
    let failure:unknown; let partial:unknown; let sessionId = (turn as SessionTurn).sessionId;
    let spawned=false;   // 프로세스가 실제로 떴는가 — 안 떴으면 리뷰·재작성 예약을 되돌린다
    const abort=()=>controller.abort(turn.signal?.reason);
    if(turn.signal?.aborted) abort(); else turn.signal?.addEventListener("abort",abort,{once:true});
    const observe=(usage:Parameters<NonNullable<SessionTurn["onUsage"]>>[0])=> {
      for(const key of BUDGET_KEYS) {
        const value=usage[key];
        if(value!==undefined && Number.isFinite(value) && value>=0) observed[key]=Math.max(observed[key],value);
      }
      observed.durationMs=Date.now()-startedAt;
      try {
        const accounts=this.ledger.observe(id,observed);
        const paused=accounts.find(a=>a.pause);
        if(paused?.pause && Date.now()>=paused.pause.deadline) {
          failure=new BudgetBlocked(paused.id,paused.pause.reason); controller.abort(failure);
        }
      } catch(error) { failure=error; controller.abort(error); }
    };
    const timer=setInterval(()=>observe({}),1000);
    try {
      const result=await invoke({...preparedTurn,executionBudget,signal:controller.signal,
        // Persist before spawn (not merely in its callback), closing the crash-between-spawn-and-record gap.
        admitSync:()=>{turn.admitSync?.();this.ledger.markDispatching(id);},
        // 원장 호출의 spawn 은 원장에 영속한다 — 이 뒤 원장의 다른 호출이 spawn 전에 실패해도 원장의 예약을 되돌리지 않는다(재시작 뒤에도).
        onProcessSpawn:process=>{spawned=true;this.ledger.markDispatching(id);if(ledger)this.database?.planning.markReviewLedgerSpawned(ledger);turn.onProcessSpawn?.(process);},
        onSessionCreated:id=>{sessionId=id;turn.onSessionCreated?.(id);},
        onInterruptedOutput:output=>{partial=output;turn.onInterruptedOutput?.(output);},
        onUsage:usage=>{observe(usage);turn.onUsage?.({...usage,executionId:id});},
      });
      if(failure) throw failure;
      return result;
    } catch(error) {
      if(!spawned) {   // 실행 허용 검사가 spawn 직전에 막았다 — 호출이 없었으므로 예약을 되돌린다(PLAN §2 검증 조건 1)
        // 이 admission 이 이미 실행됐는지는 논리 시도 단위다 — 참여자가 바뀌어 새 대화가 된 체크포인트는 앞선 대화의 실행을 priorAttempt 로 들고 있다(E2b).
        // 코드 리뷰 원장도 같다(E3-4c): 원장의 호출이 한 번이라도 spawn 했으면 그 예약은 원장 것이라 이 호출의 spawn 전 실패로 풀지 않는다 — 풀면 앞 호출이
        // 쓴 리뷰 1회가 사라진다. 원장의 첫 spawn 전이면 호출 단위로 되돌린다(다음 호출이 같은 ID 로 다시 예약한다).
        const executed=Boolean(saved?.started || saved?.priorAttempt?.started || (ledger && this.database?.planning.reviewLedgerSpawned(ledger)));
        if(!executed && kind)this.revisions?.release(ctx.topicId,admissionId);
        if(!executed && review)this.reviews?.release(ctx.topicId,admissionId);
      }
      if(partial!==undefined || sessionId) await this.checkpoint(ctx.topicId,{sessionId,output:partial,incomplete:true});
      throw failure??error;
    } finally {
      clearInterval(timer);turn.signal?.removeEventListener("abort",abort);
      this.ledger.observe(id,{...observed,durationMs:Date.now()-startedAt},Date.now(),true);
    }
  }
}
