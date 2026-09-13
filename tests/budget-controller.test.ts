import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { BudgetController } from "../src/server/budgetController";
import { BudgetLedger } from "../src/server/budgetLedger";
import type { AgentAdapter, SessionTurn } from "../src/server/types";
const policy={execution:{inputTokens:10,outputTokens:10,durationMs:100000},total:{inputTokens:50,outputTokens:50,durationMs:300000}};
afterEach(()=>vi.useRealTimers());
it("응답을 기다리는 60초 동안 다음 호출을 막고 중단 출력을 보존한다",async()=>{
 vi.useFakeTimers();vi.setSystemTime(0);
 const db=new DatabaseSync(":memory:"), ledger=new BudgetLedger(db); ledger.configure("t",policy,"test");
 let calls=0;const saved:unknown[]=[];
 const pending=(turn:Omit<SessionTurn,"sessionId">)=>new Promise<any>((_resolve,reject)=>{
  calls++;turn.onUsage?.({inputTokens:10});
  turn.signal?.addEventListener("abort",()=>{turn.onInterruptedOutput?.({stdout:"partial",stderr:"",jsonLines:[],truncated:false});reject(turn.signal?.reason);},{once:true});
 });
 const adapter:AgentAdapter={role:"claude",validateExistingSession:async()=>true,createSession:pending,resumeTurn:pending,resumePlanRepair:pending};
 const wrapped=new BudgetController(ledger,()=>({topicId:"t",accounts:["t"],stage:"PLAN"}),async(_id,output)=>{saved.push(output);}).wrap(adapter);
 const task=wrapped.createSession({cwd:"/tmp",prompt:"test"});const rejected=expect(task).rejects.toThrow("예산");
 await expect(wrapped.resumePlanRepair!({cwd:"/tmp",prompt:"repair",sessionId:"s"})).rejects.toThrow();
 await vi.advanceTimersByTimeAsync(59000);expect(saved).toHaveLength(0);
 await vi.advanceTimersByTimeAsync(1000);await rejected;
 expect(saved).toEqual([{sessionId:undefined,incomplete:true,output:{stdout:"partial",stderr:"",jsonLines:[],truncated:false}}]);expect(calls).toBe(1);
 expect(ledger.account("t")?.pause).not.toBeNull();db.close();
});
it("유예 안에 완성한 결과는 보존하되 다음 모델 호출은 허용하지 않는다",async()=>{
 const db=new DatabaseSync(":memory:"),ledger=new BudgetLedger(db);ledger.configure("t",policy,"test");
 const result={kind:"ACK" as const,summary:"완료",findings:[],evidenceRefs:[]};
 const adapter:AgentAdapter={role:"claude",validateExistingSession:async()=>true,createSession:async()=>({sessionId:"s",result}),resumeTurn:async t=>{t.onUsage?.({inputTokens:10});return result;}};
 const wrapped=new BudgetController(ledger,()=>({topicId:"t",accounts:["t"],stage:"ACK"}),async()=>{}).wrap(adapter);
 expect(await wrapped.resumeTurn({cwd:"/tmp",prompt:"test",sessionId:"s"})).toEqual(result);
 await expect(wrapped.resumeTurn({cwd:"/tmp",prompt:"test",sessionId:"s"})).rejects.toThrow();db.close();
});

it("관측 저장이 실패해도 토큰을 복구하고 다음 호출을 막는다",async()=>{
 const db=new DatabaseSync(":memory:"),ledger=new BudgetLedger(db);ledger.configure("t",policy,"test");
 const original=ledger.observe.bind(ledger);let failed=false;
 vi.spyOn(ledger,"observe").mockImplementation((...args)=>{if(!failed&&args[1].inputTokens){failed=true;throw new Error("storage failure");}return original(...args);});
 const result={kind:"ACK" as const,summary:"완료",findings:[],evidenceRefs:[]};
 const adapter:AgentAdapter={role:"claude",validateExistingSession:async()=>true,createSession:async()=>({sessionId:"s",result}),resumeTurn:async t=>{t.onUsage?.({inputTokens:20});return result;}};
 const wrapped=new BudgetController(ledger,()=>({topicId:"t",accounts:["t"],stage:"ACK"}),async()=>{}).wrap(adapter);
 await expect(wrapped.resumeTurn({cwd:"/tmp",prompt:"test",sessionId:"s"})).rejects.toThrow();
 expect(ledger.account("t")?.used.inputTokens).toBe(20);
 await expect(wrapped.resumeTurn({cwd:"/tmp",prompt:"test",sessionId:"s"})).rejects.toThrow();db.close();
});
