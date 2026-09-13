import { useState, type FormEvent } from "react";
import { BUDGET_KEYS, type BudgetAccount, type BudgetPolicy } from "../shared/budgets";

export function BudgetPanel({account,busy,onSubmit}:{account:BudgetAccount|null;busy:boolean;onSubmit:(action:string,body:unknown)=>void}) {
 const [editing,setEditing]=useState(false);
 const submit=(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();const data=new FormData(event.currentTarget);
  const policy=Object.fromEntries(["execution","total"].map(scope=>[scope,Object.fromEntries(BUDGET_KEYS.map(key=>[key,Number(data.get(`${scope}.${key}`))*(key==="durationMs"?60000:1)]))])) as BudgetPolicy;
  onSubmit(account?"budget-resume":"budget-configure",{policy,version:account?.version});
 };
 return <section aria-label="작업 예산" className="budget-panel">
  <strong>{account?.pause?"예산 도달 — 다음 호출 중지":account?"작업 예산":"실행 전에 예산을 설정하세요"}</strong>
  {account && <p>관측된 입력 {account.used.inputTokens.toLocaleString()} / {account.policy.total.inputTokens.toLocaleString()} · 출력 {account.used.outputTokens.toLocaleString()} / {account.policy.total.outputTokens.toLocaleString()} 토큰<br/>누적 실행 시간 {Math.ceil(account.used.durationMs/60000)} / {Math.ceil(account.policy.total.durationMs/60000)}분<br/>집계 시작: {new Date(account.startedAt).toLocaleString()}{account.pause && ` · ${account.pause.reason.replaceAll("inputTokens","입력 토큰").replaceAll("outputTokens","출력 토큰").replaceAll("durationMs","실행 시간")}`}</p>}
  {account?.pause && busy && <p>현재 응답 유예: 최대 {Math.max(0,Math.ceil((account.pause.deadline-Date.now())/1000))}초. 관측 지연과 유예 중에는 상한을 넘을 수 있습니다.</p>}
  <button type="button" disabled={busy} onClick={()=>setEditing(!editing)}>{account?"예산 추가 후 재개":"예산 설정"}</button>
  {editing && <form onSubmit={submit} key={account?.version??0}>
   <p>관측되지 않은 사용량은 합계에 포함되지 않습니다. 검증된 기본값이 없으면 상한을 직접 입력하세요. 입력 토큰에는 캐시 입력이 포함됩니다.</p>
   {(["execution","total"] as const).map(scope=><fieldset key={scope}><legend>{scope==="execution"?"실행당 상한":account?.source==="explicit-stage-budgets"?"작업 묶음 누적 상한":"토픽 누적 상한"}</legend>
    {BUDGET_KEYS.map(key=><label key={key}>{key==="inputTokens"?"입력 토큰":key==="outputTokens"?"출력 토큰":"실행 시간(분, 도구 대기 포함)"}
     <input name={`${scope}.${key}`} type="number" min="1" step="1" required defaultValue={account?account.policy[scope][key]/(key==="durationMs"?60000:1):undefined}/></label>)}
   </fieldset>)}
   <button disabled={busy} type="submit">{account?"증액하고 재개":"설정 저장"}</button>
  </form>}
 </section>;
}
