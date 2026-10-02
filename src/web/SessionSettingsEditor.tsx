import { useEffect, useRef, useState } from "react";
import type { AgentEffort } from "../shared/contracts";
import type { ReviewCriteria, SessionSettingsTarget, SessionSettingsView } from "../shared/sessionSettings";
import { api, ApiError } from "./api";

const LABELS: Record<SessionSettingsTarget,string> = {
  planner:"계획 작성", implementer:"구현", "plan-review":"계획 검토", "code-review":"코드 검토",
  mediator:"중재자", verifier:"검증자", "host-reviewer":"engine-review",
};
export function SessionSettingsEditor({topicId,target,onSaved}: {topicId:string;target:SessionSettingsTarget;onSaved?:()=>void}) {
  const [open,setOpen]=useState(false),[view,setView]=useState<SessionSettingsView|null>(null);
  const [model,setModel]=useState(""),[effort,setEffort]=useState<AgentEffort|"">("");
  const [criteria,setCriteria]=useState<ReviewCriteria>({selectedIds:[],additionalText:""});
  const [unify,setUnify]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[conflict,setConflict]=useState(false);
  const mounted=useRef(true),pending=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const accept = (next:SessionSettingsView) => {
    setView(next);setModel(next.mixed?"":next.operations[0]?.model??"");setEffort(next.mixed?"":next.operations[0]?.effort??"");
    setCriteria({selectedIds:next.criteria?.selectedIds??[],additionalText:next.criteria?.additionalText??""});setUnify(false);setConflict(false);
  };
  const load = async () => {
    if(pending.current)return;pending.current=true;setBusy(true);setMessage("");
    try { const next=await api.sessionSettings(topicId,target);if(mounted.current)accept(next); }
    catch(error){if(mounted.current)setMessage(error instanceof Error?error.message:String(error));}
    finally {pending.current=false;if(mounted.current)setBusy(false);}
  };
  const save = async () => {
    if(!view?.editable||!model||!effort||pending.current||conflict||((view.mixed||view.criteria?.mixed)&&!unify))return;
    pending.current=true;setBusy(true);setMessage("");
    try {
      const next=await api.updateSessionSettings(topicId,{target,revision:view.revision,model,effort,...(view.criteria?{criteria}:{})});
      if(mounted.current){accept(next);setMessage("저장했습니다. 모델·추론 강도는 다음 실행부터 적용하며 현재 실행과 기존 판정은 유지합니다.");onSaved?.();}
    } catch(error){if(mounted.current){setConflict(error instanceof ApiError&&error.status===409);setMessage(`${error instanceof Error?error.message:String(error)} · 입력한 내용은 유지됩니다.`);}}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  };
  return <section className="node-settings" aria-label={`${LABELS[target]} 다음 실행 설정`}>
    <button type="button" aria-expanded={open} onClick={()=>{setOpen(value=>!value);if(!open&&!view)void load();}}>{LABELS[target]} · 다음 실행 설정 {open?"▾":"▸"}</button>
    {open&&<>
      {message&&<p role={conflict||!view?"alert":"status"}>{message}</p>}
      {!view&&<p>{busy?"설정을 불러오는 중입니다.":"설정을 불러오지 못했습니다."}</p>}
      {!view&&!busy&&<button type="button" onClick={()=>void load()}>다시 불러오기</button>}
      {view&&<>
        <p>현재 설정입니다. 실행 당시 환경과 구분됩니다. 공급자·세션 ID·작업 디렉터리·권한은 여기서 바꾸지 않습니다.</p>
        <dl>{view.operations.map(operation=><div key={operation.operation}><dt>{operation.operation} · {operation.scope}</dt><dd>{operation.provider} · {operation.model} · {operation.effort}</dd></div>)}</dl>
        {!view.editable?<p role="status">{view.reason??"이 역할의 실행 설정은 이 화면에서 변경할 수 없습니다."}</p>:<form onSubmit={event=>{event.preventDefault();void save();}}>
          <fieldset disabled={busy}><legend>다음 실행에 적용할 값</legend>
            <label>모델<select required value={model} onChange={event=>setModel(event.target.value)}><option value="" disabled>모델 선택</option>{view.models.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
            <label>추론 강도<select required value={effort} onChange={event=>setEffort(event.target.value as AgentEffort)}><option value="" disabled>추론 강도 선택</option>{view.efforts.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
            {view.criteria&&<fieldset><legend>리뷰 기준</legend>
              <p>필수 출력 형식·승인·권한 규칙은 항상 유지됩니다. 아래 기준은 새 논리 리뷰부터 적용하며 진행 중인 리뷰의 재시도에는 기존 기준을 유지합니다.</p>
              {view.criteria.catalog.map(item=><label className="node-criterion" key={item.id}><input type="checkbox" checked={criteria.selectedIds.includes(item.id as ReviewCriteria["selectedIds"][number])} onChange={event=>setCriteria(current=>({...current,selectedIds:event.target.checked?[...current.selectedIds,item.id as ReviewCriteria["selectedIds"][number]]:current.selectedIds.filter(id=>id!==item.id)}))}/><span>{item.label}</span></label>)}
              <label>추가 기준<textarea maxLength={4000} value={criteria.additionalText} onChange={event=>setCriteria(current=>({...current,additionalText:event.target.value}))}/></label>
            </fieldset>}
            {(view.mixed||view.criteria?.mixed)&&<label className="node-criterion"><input type="checkbox" checked={unify} onChange={event=>setUnify(event.target.checked)}/><span>작업별 설정이 서로 다릅니다. 위 값과 기준을 이 역할의 작업들에 동일하게 적용합니다.</span></label>}
          </fieldset>
          <p>저장해도 모델을 실행하거나 기존 판정을 바꾸지 않습니다. 모델·추론 강도는 다음 실행부터 적용합니다.</p>
          <div className="node-settings-actions"><button disabled={busy||conflict||!model||!effort||Boolean((view.mixed||view.criteria?.mixed)&&!unify)}>{busy?"저장 중…":"다음 실행 설정 저장"}</button>
            <button type="button" disabled={busy} onClick={()=>void load()}>편집 취소 · 최신 설정</button></div>
        </form>}
      </>}
    </>}
  </section>;
}
