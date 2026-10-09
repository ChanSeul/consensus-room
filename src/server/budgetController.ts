import {reviewScope, type ReviewScope} from "../shared/reviews.js";
import type {ReviewLedger} from "./reviewLedger.js";
import type { TurnJob } from "../shared/roles.js";
import { BUDGET_KEYS, hasBudgetLimits, zeroBudget } from "../shared/budgets.js";
import { randomUUID } from "node:crypto";
import { nextEnvelopeMethod, type AgentAdapter, type SessionTurn } from "./types.js";
import { BudgetBlocked, type BudgetLedger } from "./budgetLedger.js";
import type { ConsensusDatabase } from "./database.js";
import { jobOfTurn } from "./adapters/turnPolicy.js";

interface Context { topicId: string; accounts: string[]; stage: string; }
// 코드 리뷰 원장이 소유하는 작업 — 읽기·판정·그 판정의 계약 교정은 한 논리 리뷰다. 교정에도 호스트가 넘긴 원장 ID 가 있어야 재사용하며,
// 답변 확인이나 원장 밖 교정은 기존처럼 호출마다 예약한다. 사용량·실제 호출 기록은 계속 각 실행에 남긴다.
const REVIEW_LEDGER_OPERATIONS: ReadonlySet<string> = new Set(["review", "final-review", "review-read", "contract-correction"]);
// 검토 회차는 단계 이름이 아니라 그 턴의 job 으로 고른다 — 계획 검토(audit·closeout)는 planning, 코드 리뷰(review·final-review·review-read·answer-confirmation)는
// implementation 이다. 그 밖의 검토자 작업(계약 교정·ACK·계획 교정·브레인스토밍)은 원래 턴이 도는 단계로 정한다(교정은 원래 턴의 단계에서 돈다).
const PLANNING_REVIEW_OPERATIONS: ReadonlySet<string> = new Set(["audit", "closeout"]);
const IMPLEMENTATION_REVIEW_OPERATIONS: ReadonlySet<string> = new Set(["review", "final-review", "review-read", "answer-confirmation"]);
function reviewScopeOf(job: TurnJob, stage: string): ReviewScope | undefined {
  if (job.role !== "reviewer") return undefined;
  if (PLANNING_REVIEW_OPERATIONS.has(job.operation)) return "planning";
  if (IMPLEMENTATION_REVIEW_OPERATIONS.has(job.operation)) return "implementation";
  return reviewScope(stage);
}
// All model methods pass through this boundary, including direct delivery/correction calls.
export class BudgetController {
  constructor(private readonly ledger: BudgetLedger, private readonly context: (cwd:string, topicId?:string) => Context,
    private readonly checkpoint: (topicId:string, output:unknown) => Promise<void>,
    private readonly budgetsEnabled = true, private readonly reviews?:ReviewLedger,
    private readonly database?: ConsensusDatabase) {}
  wrap(adapter: AgentAdapter): AgentAdapter {
    const wrapper: AgentAdapter = {
      role:adapter.role,
      validateExistingSession: id => adapter.validateExistingSession(id),
      ...(adapter.isSessionMissing ? { isSessionMissing: (id: string) => adapter.isSessionMissing!(id) } : {}),
      createSession: turn => this.run(adapter.role,turn,t => adapter.createSession(t)),
      resumeTurn: turn => this.run(adapter.role,turn,t => adapter.resumeTurn(t as SessionTurn)),
      // 결과 봉투 턴도 같은 예약·사용량 경계를 지난다. 다음 층 메서드는 예약 전에 확인한다(없으면 예약 없이 멈춘다).
      createEnvelopeSession: async turn => {
        const next = nextEnvelopeMethod(adapter, "createEnvelopeSession");
        return this.run(adapter.role, turn, t => next(t));
      },
      resumeEnvelopeTurn: async turn => {
        const next = nextEnvelopeMethod(adapter, "resumeEnvelopeTurn");
        return this.run(adapter.role, turn, t => next(t as SessionTurn));
      },
    };
    if (adapter.resumePlanRepair) wrapper.resumePlanRepair = turn => this.run(adapter.role,turn,t => adapter.resumePlanRepair!(t as SessionTurn));
    return wrapper;
  }
  private async run<T>(role:string, turn:Omit<SessionTurn,"sessionId">, invoke:(turn:Omit<SessionTurn,"sessionId">)=>Promise<T>):Promise<T> {
    turn.signal?.throwIfAborted();
    const ctx=this.context(turn.cwd, turn.topicId), id=randomUUID(), startedAt=Date.now();
    // 리뷰 한도는 공급자 이름이 아니라 턴의 job 으로 집계한다 — 검토자가 다른 공급자로 배정돼도 한도가 빠지지 않게(E2b).
    // role(공급자)은 세션 귀속이라 체크포인트 대조·키·예산 원장에는 그대로 쓴다.
    const job=jobOfTurn(role as "claude"|"codex",turn);
    const review=reviewScopeOf(job,ctx.stage);
    // 코드 리뷰 원장(E3-4c) — 논리 리뷰 한 번의 읽기·최종 판정 호출은 호스트가 연 원장 ID 하나로 리뷰 1회를 예약한다(ReviewLedger.reserve 는 ID 마다
    // 멱등이라 같은 ID 의 다음 호출은 새로 세지 않는다). 실행 예산·사용량 원장은 여전히 호출마다 따로 id 로 쌓는다(환불·초기화 없음).
    const ledger = review === "implementation" && turn.reviewLedger && REVIEW_LEDGER_OPERATIONS.has(job.operation) ? turn.reviewLedger : null;
    // 옛 계획 제어 표식(planningControl)·체크포인트 예약 재사용은 붙이지 않는다 — 결과 봉투 턴의 출력 스키마·지침을 계획 패킷 모드로 바꾸기 때문이다(⑥,
    // 계약 v3.11 (20)).
    const admissionId = ledger ?? id;
    if(!this.budgetsEnabled) {
      if(review)this.reviews?.admit(ctx.topicId,admissionId,review);
      return invoke(turn);
    }
    const reserve=()=>{if(review)this.reviews?.reserve(ctx.topicId,admissionId,review);};
    const execution=this.ledger.start({id,accounts:ctx.accounts,stage:ctx.stage,role,model:turn.settings?.model??"unknown",
      effort:turn.settings?.effort??"unknown",startedAt,dispatchStarted:false},reserve);
    turn.onBudgetExecution?.(id);
    const boundedAccounts = ctx.accounts.map(id => this.ledger.account(id)!).flatMap(account =>
      hasBudgetLimits(account.policy) ? [{ used: account.used, policy: account.policy }] : []);
    const executionBudget = execution.limit ? Object.fromEntries(BUDGET_KEYS.map(key => [key, Math.min(execution.limit![key],
      ...boundedAccounts.map(account => Math.max(0, account.policy.total[key] - account.used[key])))])) as import("../shared/budgets.js").BudgetVector : undefined;
    const controller=new AbortController();
    const observed=zeroBudget();
    let failure:unknown; let partial:unknown; let sessionId = (turn as SessionTurn).sessionId;
    let finalUsage=false;
    let spawned=false;   // 프로세스가 실제로 떴는가 — 안 떴으면 리뷰 예약을 되돌린다
    const abort=()=>controller.abort(turn.signal?.reason);
    if(turn.signal?.aborted) abort(); else turn.signal?.addEventListener("abort",abort,{once:true});
    const observe=(usage:Parameters<NonNullable<SessionTurn["onUsage"]>>[0])=> {
      if (usage.recordKind === "final" && usage.completeness === "complete" && [usage.inputTokens, usage.outputTokens].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) finalUsage = true;
      for(const key of BUDGET_KEYS) {
        const value=usage[key];
        if(value!==undefined && Number.isFinite(value) && value>=0) observed[key]=Math.max(observed[key],value);
      }
      observed.durationMs=Date.now()-startedAt;
      try {
        const accounts=this.ledger.observe(id,observed);
        const paused=accounts.find(a=>a.pause);
        if(paused?.pause && Date.now()>=paused.pause.deadline) {
          failure=new BudgetBlocked(paused.id,"budget",paused.pause.reason); controller.abort(failure);
        }
      } catch(error) { failure=error; controller.abort(error); }
    };
    const timer=setInterval(()=>observe({}),1000);
    // 호출이 돌려준 결과 — 그 뒤 처리(예산 정지·관측 저장)가 실패해도 결과를 버리지 않고 checkpoint 에 남긴다(79fc4fc5 F008). 돌려주지는 않는다(채택 안 함).
    let returned:{value:T}|undefined; let kept=false;
    const keep=()=>{kept=true;return {result:returned!.value,inputSequence:turn.inputSequence};};
    // 엔진이 수신 슬롯에 잡은 봉투(cd2876b7 F008)는 슬롯이 보존하므로 여기 다시 남기지 않는다. 잡지 못했거나(늦은 응답) 알림이 없으면 지금처럼 남긴다.
    let captured=false;
    const retain=()=>Boolean(returned)&&!captured;
    try {
      // Live from here until finally: a same-account start meanwhile is refused as running, not as unsettled usage.
      this.ledger.enter(id);
      const result=await invoke({...turn,executionBudget,signal:controller.signal,
        // Persist before spawn (not merely in its callback), closing the crash-between-spawn-and-record gap.
        admitSync:()=>{turn.admitSync?.();this.ledger.markDispatching(id);},
        // 원장 호출의 spawn 은 원장에 영속한다 — 이 뒤 원장의 다른 호출이 spawn 전에 실패해도 원장의 예약을 되돌리지 않는다(재시작 뒤에도).
        onProcessSpawn:process=>{spawned=true;this.ledger.markDispatching(id);if(ledger)this.database?.planning.markReviewLedgerSpawned(ledger);turn.onProcessSpawn?.(process);},
        onSessionCreated:(id,phase)=>{sessionId=id;turn.onSessionCreated?.(id,phase);},
        onInterruptedOutput:output=>{partial=output;turn.onInterruptedOutput?.(output);},
        ...(turn.onEnvelopeReceived ? { onEnvelopeReceived:(received:Parameters<NonNullable<typeof turn.onEnvelopeReceived>>[0])=>{
          const value=turn.onEnvelopeReceived!(received)===true;if(value)captured=true;return value;} } : {}),
        onUsage:usage=>{observe(usage);turn.onUsage?.({...usage,executionId:id});},
      });
      returned={value:result};
      if(failure) throw failure;
      return result;
    } catch(error) {
      if(!spawned) {   // 실행 허용 검사가 spawn 직전에 막았다 — 호출이 없었으므로 예약을 되돌린다(PLAN §2 검증 조건 1)
        // 코드 리뷰 원장(E3-4c): 원장의 호출이 한 번이라도 spawn 했으면 그 예약은 원장 것이라 이 호출의 spawn 전 실패로 풀지 않는다 — 풀면 앞 호출이
        // 쓴 리뷰 1회가 사라진다. 원장의 첫 spawn 전이면 호출 단위로 되돌린다(다음 호출이 같은 ID 로 다시 예약한다).
        const executed=Boolean(ledger && this.database?.planning.reviewLedgerSpawned(ledger));
        if(!executed && review)this.reviews?.release(ctx.topicId,admissionId);
      }
      if(returned || partial!==undefined || sessionId) await this.checkpoint(ctx.topicId,{sessionId,output:partial,incomplete:true,...(retain()?keep():{})});
      throw failure??error;
    } finally {
      clearInterval(timer);turn.signal?.removeEventListener("abort",abort);
      try {
        this.ledger.observe(id,{...observed,durationMs:Date.now()-startedAt},Date.now(),
          !turn.requiresFinalUsage || finalUsage || !this.ledger.execution(id).dispatchStarted);
      } catch(error) {
        // 여기서 난 관측 실패는 위 catch 를 지나지 않는다 — 결과를 아직 남기지 않았으면 남기고, 그 관측 오류를 그대로 던진다(보존 실패가 그 오류를 가리지 않는다).
        if(retain() && !kept) await this.checkpoint(ctx.topicId,{sessionId,output:partial,incomplete:true,...keep()}).catch(()=>undefined);
        throw error;
      } finally {
        // An unfinished execution after this is unsettled usage, never a live one, even if the observation threw.
        this.ledger.leave(id);
      }
    }
  }
}
