import {reviewScope} from "../shared/reviews.js";
import type {ReviewLedger} from "./reviewLedger.js";
import type { RevisionLedger } from "./revisionLedger.js";
import type { RewriteKind } from "../shared/revisions.js";
import { BUDGET_KEYS, zeroBudget } from "../shared/budgets.js";
import { randomUUID } from "node:crypto";
import type { AgentAdapter, SessionTurn } from "./types.js";
import { BudgetBlocked, type BudgetLedger } from "./budgetLedger.js";

interface Context { topicId: string; accounts: string[]; stage: string; }
// All model methods pass through this boundary, including direct delivery/correction calls.
export class BudgetController {
  constructor(private readonly ledger: BudgetLedger, private readonly context: (cwd:string) => Context,
    private readonly checkpoint: (topicId:string, output:unknown) => Promise<void>,
    private readonly revisions?: RevisionLedger, private readonly budgetsEnabled = true, private readonly reviews?:ReviewLedger) {}
  wrap(adapter: AgentAdapter): AgentAdapter {
    const wrapper: AgentAdapter = {
      role:adapter.role,
      validateExistingSession: id => adapter.validateExistingSession(id),
      createSession: turn => this.run(adapter.role,turn,t => adapter.createSession(t)),
      resumeTurn: turn => this.run(adapter.role,turn,t => adapter.resumeTurn(t as SessionTurn)),
    };
    if (adapter.resumePlanRepair) wrapper.resumePlanRepair = turn => this.run(adapter.role,{...turn,planningWrite:"repair"},t => adapter.resumePlanRepair!(t as SessionTurn));
    return wrapper;
  }
  private async run<T>(role:string, turn:Omit<SessionTurn,"sessionId">, invoke:(turn:Omit<SessionTurn,"sessionId">)=>Promise<T>):Promise<T> {
    turn.signal?.throwIfAborted();
    const ctx=this.context(turn.cwd), id=randomUUID(), startedAt=Date.now();
    const kind:RewriteKind|undefined=role==="claude" && ["CLAUDE_PLAN","CLAUDE_REVISION"].includes(ctx.stage)
      ? turn.planningWrite ?? (ctx.stage==="CLAUDE_PLAN"?"plan":"revision") : undefined;
    const review=role==="codex"?reviewScope(ctx.stage):undefined;
    if(!this.budgetsEnabled) {
      if(review)this.reviews?.admit(ctx.topicId,id,review);
      if(kind)this.revisions?.admit(ctx.topicId,id,kind);
      return invoke(turn);
    }
    const reserve=()=>{if(kind)this.revisions?.reserve(ctx.topicId,id,kind);if(review)this.reviews?.reserve(ctx.topicId,id,review);};
    this.ledger.start({id,accounts:ctx.accounts,stage:ctx.stage,role,model:turn.settings?.model??"unknown",
      effort:turn.settings?.effort??"unknown",startedAt},reserve);
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
      const result=await invoke({...turn,signal:controller.signal,
        onProcessSpawn:process=>{spawned=true;turn.onProcessSpawn?.(process);},
        onSessionCreated:id=>{sessionId=id;turn.onSessionCreated?.(id);},
        onInterruptedOutput:output=>{partial=output;turn.onInterruptedOutput?.(output);},
        onUsage:usage=>{observe(usage);turn.onUsage?.({...usage,executionId:id});},
      });
      if(failure) throw failure;
      return result;
    } catch(error) {
      if(!spawned) {   // 실행 허용 검사가 spawn 직전에 막았다 — 호출이 없었으므로 예약을 되돌린다(PLAN §2 검증 조건 1)
        if(kind)this.revisions?.release(ctx.topicId,id);
        if(review)this.reviews?.release(ctx.topicId,id);
      }
      if(partial!==undefined || sessionId) await this.checkpoint(ctx.topicId,{sessionId,output:partial,incomplete:true});
      throw failure??error;
    } finally {
      clearInterval(timer);turn.signal?.removeEventListener("abort",abort);
      this.ledger.observe(id,{...observed,durationMs:Date.now()-startedAt},Date.now(),true);
    }
  }
}
