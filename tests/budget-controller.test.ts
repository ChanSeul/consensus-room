import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { BudgetController } from "../src/server/budgetController";
import { BudgetBlocked, BudgetLedger } from "../src/server/budgetLedger";
import type { AgentAdapter, CommandRunner, SessionTurn } from "../src/server/types";
import { ClaudeAdapter } from "../src/server/adapters/claude";
const policy={execution:{inputTokens:10,outputTokens:10,durationMs:100000},total:{inputTokens:50,outputTokens:50,durationMs:300000}};
afterEach(()=>vi.useRealTimers());
it("passes the narrowest remaining account allowance without changing limits, model, or resumed session", async () => {
 const db=new DatabaseSync(":memory:"),ledger=new BudgetLedger(db);
 const large={execution:{inputTokens:9000000,outputTokens:240000,durationMs:2400000},total:{inputTokens:45000000,outputTokens:900000,durationMs:28800000}};
 ledger.configure("t",large,"test");ledger.configure("group",{...large,total:{...large.total,inputTokens:5000000}},"test");
 ledger.start({id:"prior",accounts:["group"],stage:"PLAN",role:"claude",model:"m",effort:"xhigh",startedAt:0});
 ledger.observe("prior",{inputTokens:1800000},1,true);
 const result={kind:"ACK" as const,summary:"done",findings:[],evidenceRefs:[]};
 const received:SessionTurn[]=[];
 const adapter:AgentAdapter={role:"claude",validateExistingSession:async()=>true,createSession:async()=>{throw Error("must resume");},
  resumeTurn:async turn=>{received.push(turn);return result;}};
 const wrapped=new BudgetController(ledger,()=>({topicId:"t",accounts:["t","group"],stage:"IMPLEMENTING"}),async()=>{}).wrap(adapter);
 await wrapped.resumeTurn({cwd:"/tmp",prompt:"approved work",sessionId:"same-planning-session",settings:{model:"opus",effort:"xhigh"},
  executionBudget:{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:Number.MAX_SAFE_INTEGER,durationMs:Number.MAX_SAFE_INTEGER}});
 expect(received[0]).toMatchObject({sessionId:"same-planning-session",settings:{model:"opus",effort:"xhigh"},
  executionBudget:{inputTokens:3200000,outputTokens:240000,durationMs:2400000}});
 expect(ledger.account("t")!.policy).toEqual(large);
 expect(ledger.account("group")!.used.inputTokens).toBe(1800000);db.close();
});
it("records dispatch before the process can start while preserving the caller's admission guard", async () => {
 const db=new DatabaseSync(":memory:"),ledger=new BudgetLedger(db);ledger.configure("t",policy,"test");
 const current=()=>ledger.execution(String(db.prepare("SELECT id FROM budget_executions").get()!.id));
 const order:string[]=[];
 const result={kind:"ACK" as const,summary:"done",findings:[],evidenceRefs:[]};
 const invoke=async(t:Omit<SessionTurn,"sessionId">)=>{
  expect(current().dispatchStarted).toBe(false);
  t.admitSync?.();
  // A crash here must not be mistaken for preparation, even before onProcessSpawn is delivered.
  expect(current().dispatchStarted).toBe(true);order.push("dispatch");
  t.onProcessSpawn?.({pid:123,pgid:123,executable:"fake",commandLine:"fake",startedAt:"now"});
  return {sessionId:"s",result};
 };
 const adapter:AgentAdapter={role:"claude",validateExistingSession:async()=>true,createSession:invoke,
  resumeTurn:async t=>(await invoke(t)).result};
 const wrapped=new BudgetController(ledger,()=>({topicId:"t",accounts:["t"],stage:"ACK"}),async()=>{}).wrap(adapter);
 await wrapped.createSession({cwd:"/tmp",prompt:"test",admitSync:()=>{expect(current().dispatchStarted).toBe(false);order.push("guard");}});
 expect(order).toEqual(["guard","dispatch"]);expect(current().finished).toBe(true);db.close();
});
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

// 79fc4fc5 F008 — 호출은 성공했는데 뒤 처리(관측 저장)가 실패하면, 원래 오류는 그대로 던지되 돌려받은 결과와 입력 커서를 checkpoint 에 남긴다.
it("성공한 호출의 결과는 뒤 처리 실패로 잃지 않고 checkpoint 에 입력 커서와 함께 보존한다",async()=>{
 const db=new DatabaseSync(":memory:"),ledger=new BudgetLedger(db);ledger.configure("t",policy,"test");
 const original=ledger.observe.bind(ledger);let failed=false;
 vi.spyOn(ledger,"observe").mockImplementation((...args)=>{if(!failed&&args[1].inputTokens){failed=true;throw new Error("storage failure");}return original(...args);});
 const result={kind:"ACK" as const,summary:"완료",findings:[],evidenceRefs:[]};
 const adapter:AgentAdapter={role:"claude",validateExistingSession:async()=>true,createSession:async()=>({sessionId:"s",result}),resumeTurn:async t=>{t.onUsage?.({inputTokens:20});return result;}};
 const saved:unknown[]=[];
 const wrapped=new BudgetController(ledger,()=>({topicId:"t",accounts:["t"],stage:"ACK"}),async(_id,output)=>{saved.push(output);}).wrap(adapter);
 await expect(wrapped.resumeTurn({cwd:"/tmp",prompt:"test",sessionId:"s",inputSequence:7})).rejects.toThrow("storage failure");
 expect(saved).toEqual([expect.objectContaining({sessionId:"s",result,inputSequence:7})]);db.close();
});

// cd2876b7 F008 — 봉투 결과를 엔진이 수신 슬롯에 잡았으면(captured) 슬롯이 보존하므로 checkpoint 에 결과를 다시 남기지 않는다. 잡지 못했으면 지금처럼 남긴다.
it("봉투 결과는 엔진이 잡았을 때만 checkpoint 에서 빼고, 잡지 못했으면 결과와 입력 커서를 남긴다",async()=>{
 for(const captured of [true,false]) {
  const db=new DatabaseSync(":memory:"),ledger=new BudgetLedger(db);ledger.configure("t",policy,"test");
  const original=ledger.observe.bind(ledger);let failed=false;
  vi.spyOn(ledger,"observe").mockImplementation((...args)=>{if(!failed&&args[1].inputTokens){failed=true;throw new Error("storage failure");}return original(...args);});
  const envelope={message:"완료",outcome:"done" as const};
  const adapter:AgentAdapter={role:"claude",validateExistingSession:async()=>true,createSession:async()=>{throw new Error("unused");},resumeTurn:async()=>{throw new Error("unused");},
   resumeEnvelopeTurn:async t=>{t.onEnvelopeReceived?.({sessionId:t.sessionId,envelope});t.onUsage?.({inputTokens:20});return envelope;}};
  const saved:unknown[]=[];
  const wrapped=new BudgetController(ledger,()=>({topicId:"t",accounts:["t"],stage:"ACK"}),async(_id,output)=>{saved.push(output);}).wrap(adapter);
  await expect(wrapped.resumeEnvelopeTurn!({cwd:"/tmp",prompt:"test",sessionId:"s",inputSequence:7,onEnvelopeReceived:()=>captured})).rejects.toThrow("storage failure");
  expect(saved,String(captured)).toEqual([captured?{sessionId:"s",output:undefined,incomplete:true}:expect.objectContaining({sessionId:"s",result:envelope,inputSequence:7})]);
  db.close();
 }
});

it("refuses a same-account start as running only while a run is live; a run that ends without final usage leaves it unsettled",async()=>{
 const db=new DatabaseSync(":memory:"),ledger=new BudgetLedger(db);ledger.configure("t",policy,"test");
 const reason=()=>{try{ledger.assertAvailable(["t"]);return null;}catch(error){return (error as BudgetBlocked).reason;}};
 const result={kind:"ACK" as const,summary:"done",findings:[],evidenceRefs:[]};
 let release!:()=>void;const seen:Array<string|null>=[];
 const adapter:AgentAdapter={role:"codex",validateExistingSession:async()=>false,resumeTurn:async()=>result,createSession:async t=>{
  t.admitSync?.();seen.push(reason());await new Promise<void>(resolve=>{release=resolve;});return {sessionId:"s",result};}};
 const wrapped=new BudgetController(ledger,()=>({topicId:"t",accounts:["t"],stage:"ENGINE_DEFECT_REVIEW"}),async()=>{}).wrap(adapter);
 const run=wrapped.createSession({cwd:"/tmp",prompt:"review",requiresFinalUsage:true});
 await vi.waitFor(()=>expect(seen).toEqual(["running"]));
 release();await run;
 // The run ended without the final usage it requires: the execution stays open, and no live run vouches for it.
 expect(reason()).toBe("unsettled");db.close();
});
it("leaves the live set even when the final observation throws",async()=>{
 const db=new DatabaseSync(":memory:"),ledger=new BudgetLedger(db);ledger.configure("t",policy,"test");
 const original=ledger.observe.bind(ledger);
 vi.spyOn(ledger,"observe").mockImplementation((...args)=>{if(args[3]!==undefined)throw new Error("storage failure");return original(...args);});
 const result={kind:"ACK" as const,summary:"done",findings:[],evidenceRefs:[]};
 const adapter:AgentAdapter={role:"claude",validateExistingSession:async()=>true,createSession:async()=>({sessionId:"s",result}),resumeTurn:async()=>result};
 const wrapped=new BudgetController(ledger,()=>({topicId:"t",accounts:["t"],stage:"ACK"}),async()=>{}).wrap(adapter);
 await expect(wrapped.resumeTurn({cwd:"/tmp",prompt:"test",sessionId:"s"})).rejects.toThrow("storage failure");
 vi.restoreAllMocks();
 expect((()=>{try{ledger.assertAvailable(["t"]);return null;}catch(error){return (error as BudgetBlocked).reason;}})()).toBe("unsettled");db.close();
});

it("charges two topics sharing cwd to their explicit accounts",async()=>{
 const db=new DatabaseSync(":memory:"),ledger=new BudgetLedger(db);for(const id of ["one","two"])ledger.configure(id,policy,"test");
 const adapter:AgentAdapter={role:"claude",validateExistingSession:async()=>true,createSession:async turn=>{turn.onUsage?.({inputTokens:turn.topicId==="one"?3:7,outputTokens:1,recordKind:"final",completeness:"complete"});return {sessionId:"s",result:{kind:"BRAINSTORM",summary:"done",findings:[],evidenceRefs:[]}};},resumeTurn:async()=>{throw Error("unused");}};
 const wrapped=new BudgetController(ledger,(_cwd,topicId)=>{if(!topicId)throw Error("missing topic identity");return {topicId,accounts:[topicId],stage:"BRAINSTORMING"};},async()=>{}).wrap(adapter);
 await Promise.all(["one","two"].map(topicId=>wrapped.createSession({topicId,cwd:"/shared",prompt:"discuss"})));
 expect(ledger.account("one")!.used.inputTokens).toBe(3);expect(ledger.account("two")!.used.inputTokens).toBe(7);db.close();
});
// engine-review 1d47a14d F001: result 뒤 작업이 이어진 Claude 호출의 사용량은 원장에 그 작업까지 남고, 새 최종 집계 없이 끝났으므로 정산되지 않는다.
it("result 뒤 작업이 이어진 Claude 호출은 후속 사용량을 원장에 남기고 최종 사용량 없이 끝나 미정산으로 남는다",async()=>{
 const db=new DatabaseSync(":memory:"),ledger=new BudgetLedger(db);
 ledger.configure("t",{execution:{inputTokens:1000,outputTokens:1000,durationMs:100000},total:{inputTokens:5000,outputTokens:5000,durationMs:300000}},"test");
 const envelope={message:"변경을 검토했습니다.",outcome:"approve",mediatorRequest:null,memoryUpdates:null,engineDefects:null};
 const lines=[{type:"assistant",message:{id:"m1",usage:{input_tokens:5,output_tokens:8}}},
  {type:"result",subtype:"success",is_error:false,num_turns:1,structured_output:envelope,usage:{input_tokens:5,output_tokens:8}},
  {type:"assistant",message:{id:"m2",usage:{input_tokens:2,output_tokens:3}}}];
 const runner:CommandRunner={run:async spec=>{
  spec.admitSync?.();spec.onSpawn?.({pid:123,pgid:123,executable:"claude",commandLine:"claude",startedAt:"now"});
  for(const line of lines)spec.onJSONLine?.(line,Date.now());
  return {exitCode:0,stdout:lines.map(line=>JSON.stringify(line)).join("\n"),stderr:"",jsonLines:lines};}};
 const wrapped=new BudgetController(ledger,()=>({topicId:"t",accounts:["t"],stage:"ACK"}),async()=>{}).wrap(new ClaudeAdapter(runner));
 await expect(wrapped.createEnvelopeSession!({cwd:"/tmp",prompt:"review",job:{role:"reviewer",operation:"review"},requiresFinalUsage:true}))
  .rejects.toThrow(/새 result 가 없습니다/);
 const id=String(db.prepare("SELECT id FROM budget_executions").get()!.id);
 expect(ledger.execution(id).used).toMatchObject({inputTokens:7,outputTokens:11});
 expect((()=>{try{ledger.assertAvailable(["t"]);return null;}catch(error){return (error as BudgetBlocked).reason;}})()).toBe("unsettled");db.close();
});
// CR Engine Advisor 자문 46: 합성 0턴 result 만 낸 첫 호출의 0 토큰을 완전한 최종 사용량으로 보면, 0턴 재호출이 실제 작업 뒤 새 result 없이 끝나도
// 원장이 정산된다. 재호출 횟수(1회)는 그대로다.
it("합성 0턴 재호출 뒤 새 result 없이 끝난 Claude 재개 호출은 첫 호출의 0 토큰으로 정산되지 않고 미정산으로 남는다",async()=>{
 const db=new DatabaseSync(":memory:"),ledger=new BudgetLedger(db);
 ledger.configure("t",{execution:{inputTokens:1000,outputTokens:1000,durationMs:100000},total:{inputTokens:5000,outputTokens:5000,durationMs:300000}},"test");
 const attempts=[[{type:"result",subtype:"success",is_error:false,num_turns:0,result:"No response requested.",usage:{input_tokens:0,output_tokens:0}}],
  [{type:"assistant",message:{id:"real",usage:{input_tokens:7,output_tokens:11}}}]];
 let calls=0;
 const runner:CommandRunner={run:async spec=>{
  const lines=attempts[Math.min(calls++,attempts.length-1)];
  spec.admitSync?.();spec.onSpawn?.({pid:123,pgid:123,executable:"claude",commandLine:"claude",startedAt:"now"});
  for(const line of lines)spec.onJSONLine?.(line,Date.now());
  return {exitCode:0,stdout:lines.map(line=>JSON.stringify(line)).join("\n"),stderr:"",jsonLines:lines};}};
 const wrapped=new BudgetController(ledger,()=>({topicId:"t",accounts:["t"],stage:"ACK"}),async()=>{}).wrap(new ClaudeAdapter(runner));
 await expect(wrapped.resumeEnvelopeTurn!({sessionId:"00000000-0000-4000-8000-000000000000",cwd:"/tmp",prompt:"이어서",
  job:{role:"reviewer",operation:"review"},requiresFinalUsage:true})).rejects.toThrow(/결과 봉투를 반환하지 않았습니다/);
 expect(calls).toBe(2);
 const id=String(db.prepare("SELECT id FROM budget_executions").get()!.id);
 expect(ledger.execution(id).used).toMatchObject({inputTokens:7,outputTokens:11});
 expect((()=>{try{ledger.assertAvailable(["t"]);return null;}catch(error){return (error as BudgetBlocked).reason;}})()).toBe("unsettled");db.close();
});
