import { useState, type FormEvent } from "react";
import { BUDGET_KEYS, hasBudgetLimits, OBSERVE_USAGE, type BudgetAccount, type BudgetPolicy } from "../shared/budgets";

export function BudgetPanel({account,busy,recoveryRequired=false,onSubmit}:{account:BudgetAccount|null;busy:boolean;recoveryRequired?:boolean;onSubmit:(action:string,body:unknown)=>void}) {
 const [editing,setEditing]=useState(false);
 const policy=account && hasBudgetLimits(account.policy) ? account.policy : null;
 const cap=(value:number|undefined,minutes=false)=>value===undefined?"한도 없음":`${(minutes?Math.ceil(value/60000):value).toLocaleString()}${minutes?"분":""}`;
 const submit=(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();const data=new FormData(event.currentTarget);
  const policy=Object.fromEntries(["execution","total"].map(scope=>[scope,Object.fromEntries(BUDGET_KEYS.map(key=>[key,Number(data.get(`${scope}.${key}`))*(key==="durationMs"?60000:1)]))])) as BudgetPolicy;
  onSubmit(account?"budget-resume":"budget-configure",{policy,version:account?.version});
 };
 return <section aria-label="작업 예산" className="budget-panel">
  <strong>{recoveryRequired?"중단된 실행 확인":account?.pause?"예산 도달 — 다음 호출 중지":policy?"작업 예산":"한도 없이 사용량 기록"}</strong>
  {account && <p>관측된 입력 {account.used.inputTokens.toLocaleString()} / {cap(policy?.total.inputTokens)} · 출력 {account.used.outputTokens.toLocaleString()} / {cap(policy?.total.outputTokens)} 토큰<br/>누적 실행 시간 {Math.ceil(account.used.durationMs/60000)}분 / {cap(policy?.total.durationMs,true)}<br/>집계 시작: {new Date(account.startedAt).toLocaleString()}{account.pause && ` · ${account.pause.reason.replaceAll("inputTokens","입력 토큰").replaceAll("outputTokens","출력 토큰").replaceAll("durationMs","실행 시간")}`}</p>}
  {account?.pause && busy && <p>현재 응답 유예: 최대 {Math.max(0,Math.ceil((account.pause.deadline-Date.now())/1000))}초. 관측 지연과 유예 중에는 상한을 넘을 수 있습니다.</p>}
  {account?.pause?.executionId && policy && BUDGET_KEYS.every(key=>account.used[key]<policy.total[key]) &&
   <button type="button" disabled={busy} onClick={()=>onSubmit("budget-resume",{resumeExecutionId:account.pause!.executionId,version:account.version})}>현재 예산으로 재개</button>}
  <button type="button" disabled={busy} onClick={()=>setEditing(!editing)}>{policy?"예산 추가 후 재개":"선택 사항: 한도 설정"}</button>
  {policy && <button type="button" disabled={busy} onClick={()=>onSubmit("budget-resume",{policy:OBSERVE_USAGE,version:account!.version})}>한도 없이 계속하기</button>}
  {account && !policy && recoveryRequired && <>
   <p>이전 실행이 종료됐는지 확인한 뒤 재개하세요. 지금까지 기록된 사용량은 유지됩니다.</p>
   <button type="button" disabled={busy} onClick={()=>onSubmit("budget-resume",{policy:OBSERVE_USAGE,version:account.version})}>실행 종료 확인 후 한도 없이 재개</button>
  </>}
 {editing && <form onSubmit={submit} key={account?.version??0}>
   <p>상한은 원할 때만 설정합니다. 입력 토큰에는 캐시 입력이 포함되며, 관측되지 않은 사용량은 합계에 포함되지 않습니다.</p>
   {(["execution","total"] as const).map(scope=><fieldset key={scope}><legend>{scope==="execution"?"실행당 상한":account?.source==="explicit-stage-budgets"?"작업 묶음 누적 상한":"토픽 누적 상한"}</legend>
    {BUDGET_KEYS.map(key=><label key={key}>{key==="inputTokens"?"입력 토큰":key==="outputTokens"?"출력 토큰":"실행 시간(분, 도구 대기 포함)"}
     <input name={`${scope}.${key}`} type="number" min="1" step="1" required defaultValue={policy?policy[scope][key]/(key==="durationMs"?60000:1):undefined}/></label>)}
   </fieldset>)}
   <button disabled={busy} type="submit">{account?"증액하고 재개":"설정 저장"}</button>
  </form>}
 </section>;
}
