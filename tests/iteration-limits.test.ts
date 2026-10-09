import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { ReviewLedger } from "../src/server/reviewLedger";
import { BudgetLedger } from "../src/server/budgetLedger";

it("new topics have unlimited reviews while preserving accounting and explicit finite limits",()=>{
  const db=new DatabaseSync(":memory:");db.exec("CREATE TABLE topics(id TEXT PRIMARY KEY,state TEXT)"); new BudgetLedger(db);
  const reviews=new ReviewLedger(db); reviews.initialize("new");
  for(let n=0;n<20;n++){
    reviews.admit("new",`p${n}`,"planning");reviews.admit("new",`i${n}`,"implementation");
  }
  reviews.admit("new","p19","planning");
  expect(reviews.account("new","planning")).toMatchObject({limit:null,used:20});
  expect(reviews.account("new","implementation")).toMatchObject({limit:null,used:20});
  reviews.configure("new","planning",20,1); expect(()=>reviews.admit("new","next","planning")).toThrow("한도");
  expect(()=>reviews.configure("new","planning",null,1)).toThrow();
  reviews.configure("new","planning",null,2);reviews.admit("new","next","planning");
  expect(reviews.release("new","next")).toBe(true);expect(reviews.account("new","planning").used).toBe(20);
  db.close();
});
it("migration changes only unfinished limits once, never usage, closed records or paused topic state",()=>{
  const db=new DatabaseSync(":memory:");db.exec("CREATE TABLE topics(id TEXT PRIMARY KEY,state TEXT)"); new BudgetLedger(db);
  let reviews=new ReviewLedger(db);
  for(const id of ["open","closed"]){
    reviews.initialize(id);
    for(const scope of ["planning","implementation"] as const) { reviews.configure(id,scope,3,1);reviews.admit(id,`${id}-${scope}`,scope); }
  }
  db.exec("INSERT INTO topics VALUES ('open','USER_DECISION_REQUIRED'),('closed','CLOSED'); DELETE FROM iteration_limit_migrations");
  reviews=new ReviewLedger(db);
  expect(reviews.account("open","planning")).toMatchObject({limit:null,used:1});
  expect(reviews.account("closed","planning")).toMatchObject({limit:3,used:1,version:2});
  expect(db.prepare("SELECT state FROM topics WHERE id='open'").get()?.state).toBe("USER_DECISION_REQUIRED");
  reviews.configure("open","planning",5,reviews.account("open","planning").version);
  expect(new ReviewLedger(db).account("open","planning").limit).toBe(5);
  db.close();
});
