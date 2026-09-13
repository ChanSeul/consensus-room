// Input must be independently audited samples, not raw execution_usage rows.
import { readFile } from "node:fs/promises";
import { calibrateBudget, BudgetSampleSchema } from "../src/shared/budgets.js";
const path=process.argv[2];
if(!path) throw new Error("사용법: tsx scripts/calibrate-budgets.ts <검증한 표본 JSON>");
const samples=BudgetSampleSchema.array().parse(JSON.parse(await readFile(path,"utf8")));
const targets=[...new Map(samples.map(s=>[JSON.stringify([s.stage,s.role,s.model,s.effort]),{stage:s.stage,role:s.role,model:s.model,effort:s.effort}])).values()];
console.log(JSON.stringify({version:1,generatedAt:new Date().toISOString(),profiles:targets.map(target=>({target,...calibrateBudget(samples,target)}))},null,2));
