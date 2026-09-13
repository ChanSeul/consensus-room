import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { BudgetLedger } from "../src/server/budgetLedger";
import { calibrateBudget } from "../src/shared/budgets";
const policy = {execution:{inputTokens:100,outputTokens:20,durationMs:10000},total:{inputTokens:200,outputTokens:40,durationMs:30000}};
describe("예산 원장", () => {
  it("중복 관측을 더하지 않고 종료와 새 실행에도 누적량을 유지한다", () => {
    const db = new DatabaseSync(":memory:"); const ledger = new BudgetLedger(db);
    ledger.configure("topic",policy,"test",0);
    const start = (id:string) => ledger.start({id,accounts:["topic"],startedAt:0,stage:"PLAN",role:"claude",model:"test",effort:"high"});
    start("one"); ledger.observe("one",{inputTokens:50},1); ledger.observe("one",{inputTokens:50},2);
    ledger.observe("one",{inputTokens:40},3,true); ledger.observe("one",{inputTokens:90},4,true);
    expect(ledger.account("topic")?.used.inputTokens).toBe(50);
    start("two"); ledger.observe("two",{inputTokens:100},5);
    expect(ledger.account("topic")?.used.inputTokens).toBe(150);
    expect(ledger.account("topic")?.pause?.deadline).toBe(60005);
    expect(() => start("three")).toThrow();
    const restored = new BudgetLedger(db); expect(() => restored.assertAvailable(["topic"])).toThrow();
    const added={...policy,execution:{...policy.execution,inputTokens:200}};
    restored.grant("topic","grant",added,1); restored.grant("topic","grant",added,1);
    expect(restored.account("topic")?.used.inputTokens).toBe(150);
    expect(restored.account("topic")?.version).toBe(2);
    start("three"); db.close();
  });
  it("하위 토픽을 바꿔도 상위 예산을 우회하지 못한다", () => {
    const db=new DatabaseSync(":memory:"); const ledger=new BudgetLedger(db);
    for(const id of ["a","b","group"]) ledger.configure(id,{...policy,total:{...policy.total,inputTokens:80}},"test");
    ledger.start({id:"a1",accounts:["a","group"],startedAt:0,stage:"PLAN",role:"claude",model:"test",effort:"high"});
    ledger.observe("a1",{inputTokens:80},0,true);
    expect(()=>ledger.start({id:"b1",accounts:["b","group"],startedAt:1,stage:"PLAN",role:"claude",model:"test",effort:"high"})).toThrow();
    expect(()=>ledger.assertAvailable(["missing"])).toThrow(); db.close();
  });
  it("정상 완료와 원본을 검증한 표본만 상한 산정에 쓴다", () => {
    const sample={executionId:"a",stage:"PLAN",role:"claude",model:"m",effort:"high",verified:true,successful:true,completeness:"complete" as const,mismatch:false,usage:{inputTokens:100,outputTokens:10,durationMs:1000}};
    expect(calibrateBudget([{...sample,verified:false}],sample)).toBeNull();
    expect(calibrateBudget([sample,{...sample,executionId:"bad",mismatch:true,usage:{...sample.usage,inputTokens:9999}}],sample)?.limit.inputTokens).toBe(200);
    expect(calibrateBudget([sample],{...sample,stage:"FIX"})?.provisional).toBe(true);
  });
});
it("계정 목록과 증액 멱등성, 계정별 중단 경계를 지킨다",()=>{
 const db=new DatabaseSync(":memory:"), l=new BudgetLedger(db);
 l.configure("a",policy,"test");l.configure("g",{execution:{inputTokens:1000,outputTokens:100,durationMs:100000},total:{inputTokens:10000,outputTokens:1000,durationMs:1000000}},"test");
 const start={id:"x",accounts:["a","g"],startedAt:0,stage:"PLAN",role:"claude",model:"m",effort:"high"};
 expect(()=>l.start({...start,accounts:[]})).toThrow();expect(()=>l.start({...start,accounts:["a","a"]})).toThrow();
 l.start(start);l.observe("x",{inputTokens:100});expect(l.account("a")?.pause).not.toBeNull();expect(l.account("g")?.pause).toBeNull();
 const reordered={total:{durationMs:30000,outputTokens:40,inputTokens:300},execution:{durationMs:10000,outputTokens:20,inputTokens:200}};
 l.grant("a","key",reordered,1);expect(()=>l.grant("a","key",reordered,1)).not.toThrow();db.close();
});
it("거짓 문자열과 충돌한 중복 표본을 기본값에 쓰지 않는다",()=>{
 const s={executionId:"a",stage:"PLAN",role:"claude",model:"m",effort:"high",verified:true,successful:true,completeness:"complete" as const,mismatch:false,usage:{inputTokens:100,outputTokens:10,durationMs:1000}};
 expect(()=>calibrateBudget([{...s,verified:"false"} as never],s)).toThrow();
 const conflict={...s,usage:{...s.usage,inputTokens:10000}};
 expect(calibrateBudget([s,conflict],s)).toBeNull();expect(calibrateBudget([conflict,s],s)).toBeNull();
});
