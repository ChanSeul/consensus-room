import { useEffect, useState } from "react";
import { WorkGroupInputSchema, type WorkGroupInput, type WorkGroupView, type WorkStage } from "../shared/workGroups";
import { api } from "./api";

export function pipelineInput(group: WorkGroupInput): WorkGroupInput {
  return { title: group.title, goal: group.goal, contracts: group.contracts, stages: structuredClone(group.stages),
    ...(group.questions ? { questions: structuredClone(group.questions) } : {}), ...(group.budgetPolicy ? { budgetPolicy: group.budgetPolicy } : {}) };
}
// Dependency order is execution input, not a canvas-only position. Refuse cycles before saving.
export function orderPipeline(input: WorkGroupInput): WorkGroupInput {
  const remaining = [...input.stages], stages: WorkStage[] = [], done = new Set<string>();
  while (remaining.length) {
    const index = remaining.findIndex(stage => stage.dependsOn.every(id => done.has(id)) && (stage.kind !== "integration" || remaining.length === 1));
    if (index < 0) throw new Error("순환 연결 또는 없는 선행 작업이 있습니다. 통합 검증은 마지막에 실행됩니다.");
    const [stage] = remaining.splice(index, 1); stages.push(stage); done.add(stage.id);
  }
  return WorkGroupInputSchema.parse({ ...input, stages });
}
type Draft = { groupId: string | null; version: number; input: WorkGroupInput };

export function PipelineEditor({ topicId, topicIds, canCreate, title, goal, onDone }: {
  topicId: string; topicIds: string[]; canCreate: boolean; title: string; goal: string; onDone: () => void;
}) {
  const [groups, setGroups] = useState<WorkGroupView[]>([]), [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null), [selected, setSelected] = useState<string | null>(null), [origin, setOrigin] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<{from:string;to:string} | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const key = `consensus:pipeline-draft:${topicId}`;
  useEffect(() => {
    let cancelled = false;
    void api.listWorkGroups().then(all => {
      if (cancelled) return;
      const visible = all.filter(group => group.parentTopicId && topicIds.includes(group.parentTopicId) || Object.values(group.links).some(link => topicIds.includes(link.topicId)));
      setGroups(visible); setLoaded(true);
      let raw: string | null = null;
      try { raw = window.localStorage.getItem(key); } catch { setMessage("브라우저 저장소를 사용할 수 없습니다. 편집안을 저장하려면 사이트 저장소를 허용하세요."); }
      if (raw) {
        try {
          const saved = JSON.parse(raw) as Draft;
          if ((saved.groupId === null && canCreate || visible.some(group => group.id === saved.groupId)) && Number.isInteger(saved.version)) {
            setDraft({ ...saved, input: WorkGroupInputSchema.parse(saved.input) }); setMessage("이 브라우저에 저장한 편집안을 불러왔습니다. 아직 실행에 적용되지 않았습니다."); return;
          }
        } catch { setMessage("저장한 편집안을 읽지 못했습니다. 현재 파이프라인을 불러왔습니다."); }
      }
      if (visible[0]) setDraft({ groupId: visible[0].id, version: visible[0].version, input: pipelineInput(visible[0]) });
    }).catch(error => { if (!cancelled) setMessage(String(error)); });
    return () => { cancelled = true; };
  }, [topicId]);
  const group = groups.find(item => item.id === draft?.groupId);
  const locked = (id: string) => Boolean(group?.links[id] || group?.pending?.[id]);
  const selectedStage = draft?.input.stages.find(stage => stage.id === selected);
  const change = (input: WorkGroupInput) => { setDraft(value => value ? { ...value, input } : null); setMessage("적용 전 편집안"); };
  const updateStage = (patch: Partial<WorkStage>) => { if (draft && selected && !locked(selected)) change({ ...draft.input, stages: draft.input.stages.map(stage => stage.id === selected ? { ...stage, ...patch } : stage) }); };
  const connect = (to: string) => {
    if (!origin || !draft) return;
    if (locked(to)) { setMessage("이미 시작된 작업의 입력 연결은 보호됩니다."); return; }
    if (origin === to) { setMessage("자기 자신에게 연결할 수 없습니다."); return; }
    const input = { ...draft.input, stages: draft.input.stages.map(stage => stage.id === to ? { ...stage, dependsOn: [...new Set([...stage.dependsOn, origin])] } : stage) };
    try { change(orderPipeline(input)); setOrigin(null); } catch (error) { setMessage(String(error)); }
  };
  const removeEdge = (from:string,to:string) => {
    if (!draft || locked(to) || busy) return;
    change({...draft.input,stages:draft.input.stages.map(stage=>stage.id===to?{...stage,dependsOn:stage.dependsOn.filter(id=>id!==from)}:stage)});
    setSelectedEdge(null);
  };
  const removeStage = () => {
    if (!draft || !selectedStage || locked(selectedStage.id) || selectedStage.kind === "integration") return;
    if (draft.input.stages.some(stage => locked(stage.id) && stage.dependsOn.includes(selectedStage.id))) { setMessage("시작된 단계가 참조하는 노드는 삭제할 수 없습니다."); return; }
    if (draft.input.questions?.some(question => question.stageId === selectedStage.id)) { setMessage("이 단계에 연결된 질문을 중재 세션에서 먼저 정리해 주세요."); return; }
    change({ ...draft.input, stages: draft.input.stages.filter(stage => stage.id !== selectedStage.id).map(stage => ({ ...stage, dependsOn: stage.dependsOn.filter(id => id !== selectedStage.id) })) }); setSelected(null); setSelectedEdge(null);
  };
  const save = async (apply: boolean) => {
    if (!draft || busy) return;
    setMessage("");
    try {
      const input = orderPipeline(draft.input);
      try { window.localStorage.setItem(key, JSON.stringify({ ...draft, input })); } catch (error) { if (!apply) throw error; }
      if (!apply) { setMessage("이 브라우저에 편집안을 저장했습니다. 실행 순서는 아직 바뀌지 않았습니다."); return; }
      setBusy(true);
      if (draft.groupId) await api.applyPipeline(draft.groupId, input, draft.version);
      else await api.createWorkGroup(input, topicId);
      try { window.localStorage.removeItem(key); } catch { /* Applying does not depend on browser storage. */ }
      onDone();
    } catch (error) { setMessage(`${error instanceof Error ? error.message : String(error)} · 편집안은 유지됩니다.`); }
    finally { setBusy(false); }
  };
  const fresh = () => {
    setSelected(null); setOrigin(null); setSelectedEdge(null);
    setDraft({ groupId: null, version: 0, input: { title, goal, contracts: "", stages: [
      { id: "step-1", title: "첫 작업", goal: "", kind: "work", dependsOn: [] },
      { id: "integration", title: "전체 통합 검증", goal: "각 단계의 결과를 함께 검증합니다.", kind: "integration", dependsOn: ["step-1"] },
    ] } });
  };
  const add = () => {
    if (!draft) return;
    const id = `step-${crypto.randomUUID().slice(0, 8)}`;
    const stage: WorkStage = { id, title: "새 작업", goal: "", kind: "work", dependsOn: [], outcome: "", separation: { basis: "independent-verification", detail: "" } };
    change({ ...draft.input, stages: [...draft.input.stages.slice(0, -1), stage, draft.input.stages.at(-1)!] }); setSelected(id);
  };
  return <section className="pipeline-editor" aria-label="실행 파이프라인 편집">
    <div className="graph-toolbar">
      <button onClick={onDone} disabled={busy}>← 세션 그래프</button>
      <select aria-label="편집할 파이프라인" value={draft?.groupId ?? ""} disabled={busy} onChange={event => {
        const value = groups.find(group => group.id === event.target.value); if (value) { setDraft({ groupId: value.id, version: value.version, input: pipelineInput(value) }); setSelected(null); setOrigin(null); setSelectedEdge(null); setMessage(""); }
      }}><option value="" disabled>새 파이프라인</option>{groups.map(group => <option key={group.id} value={group.id}>{group.title} · v{group.version}</option>)}</select>
      {canCreate && <button onClick={fresh} disabled={busy}>파이프라인 추가</button>}
      {draft && <><button onClick={add} disabled={busy || draft.input.stages.length >= 20}>작업 노드 추가</button><button onClick={() => void save(false)} disabled={busy}>편집안 저장</button><button className="primary-button" onClick={() => void save(true)} disabled={busy}>실행에 적용</button></>}
    </div>
    <p className="pipeline-help">작업의 출력 ● → 다음 작업의 입력 ● 순서로 연결하세요. 연결선을 선택하고 대상 확인 후 삭제합니다. 각 작업은 계획 → 검토 → 구현 → 검토를 거칩니다. 통합 검증은 모든 작업이 끝난 뒤 실행됩니다.</p>
    {selectedEdge && draft && <div className="graph-toolbar" role="status"><span>선택한 연결: {draft.input.stages.find(s=>s.id===selectedEdge.from)?.title} → {draft.input.stages.find(s=>s.id===selectedEdge.to)?.title}</span>
      <button disabled={busy || locked(selectedEdge.to)} onClick={()=>removeEdge(selectedEdge.from,selectedEdge.to)}>{selectedEdge.from} → {selectedEdge.to} 연결 삭제</button><button onClick={()=>setSelectedEdge(null)}>선택 해제</button></div>}
    {message && <p className="graph-notice" role="status">{message}</p>}
    {!draft && <p className="graph-empty">{loaded ? "연결된 파이프라인이 없습니다. 큰 그림 주제에서 파이프라인을 추가할 수 있습니다." : "파이프라인을 불러오는 중입니다."}</p>}
    {draft && <>
      <div className="pipeline-canvas">
        <div className="pipeline-world" style={{ width: Math.max(620, draft.input.stages.length * 220 + 40) }}>
          <svg role="group" aria-label="파이프라인 연결" className="pipeline-lines" width={Math.max(620, draft.input.stages.length * 220 + 40)} height={280}>
            {draft.input.stages.flatMap((stage, to) => stage.dependsOn.map(dep => {
              const from = draft.input.stages.findIndex(stage => stage.id === dep), x1 = from * 220 + 208, x2 = to * 220 + 40;
              return <g key={`${dep}:${stage.id}`} className={`pipeline-wire${selectedEdge?.from===dep && selectedEdge.to===stage.id ? " selected" : ""}`} role="button" tabIndex={locked(stage.id) || busy ? -1 : 0}
                aria-label={`${dep} → ${stage.id} 연결 선택${locked(stage.id) ? " (보호됨)" : ""}`} aria-disabled={locked(stage.id) || busy}
                onClick={() => { if (!busy) setSelectedEdge({from:dep,to:stage.id}); }}
                onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!busy) setSelectedEdge({from:dep,to:stage.id}); } }}>
                <title>{dep} → {stage.id} · {locked(stage.id) ? "보호됨" : "클릭해 연결 선택"}</title>
                <path className="pipeline-hit" d={`M${x1} 134 C${x1+25} ${40-(to-from)*6},${x2-25} ${40-(to-from)*6},${x2} 134`} />
                <path d={`M${x1} 134 C${x1+25} ${40-(to-from)*6},${x2-25} ${40-(to-from)*6},${x2} 134`} />
              </g>;
            }))}
          </svg>
          {draft.input.stages.map((stage, index) => <div className="pipeline-stage" key={stage.id} style={{ left: index * 220 + 40, top: 80 }}>
            <button className={`graph-node ${stage.id === selected ? "selected" : ""}`} style={{ width:168, height:108 }} onClick={() => setSelected(stage.id)}>
              <small>{stage.kind === "integration" ? "통합 검증" : locked(stage.id) ? "연결된 작업 · 보호됨" : "미착수 작업"}</small><strong>{stage.title}</strong><small>{stage.acceptance ? "완료 조건 설정됨" : "완료 조건 미정"}</small>
            </button>
            <button className="pipeline-port in" aria-label={`${stage.id} 입력에 연결`} disabled={busy || locked(stage.id) || !origin} onClick={() => connect(stage.id)}>●</button>
            <button className={`pipeline-port out ${origin === stage.id ? "chosen" : ""}`} aria-label={`${stage.id} 출력 선택`} disabled={busy || stage.kind === "integration"} onClick={() => setOrigin(origin === stage.id ? null : stage.id)}>●</button>
          </div>)}
        </div>
      </div>
      <div className="pipeline-details">
        {!draft.groupId && <fieldset disabled={busy}><legend>파이프라인</legend>
          <label>이름<input value={draft.input.title} onChange={e => change({ ...draft.input, title: e.target.value })} /></label>
          <label>공통 계약<textarea value={draft.input.contracts} onChange={e => change({ ...draft.input, contracts: e.target.value })} placeholder="각 작업이 함께 지킬 계약" /></label>
        </fieldset>}
        {selectedStage ? <fieldset disabled={busy || locked(selectedStage.id)}><legend>{selectedStage.title}{locked(selectedStage.id) ? " · 시작된 작업은 보호됩니다" : " · 노드 설정"}</legend>
          <label>작업 이름<input value={selectedStage.title} onChange={e => updateStage({ title:e.target.value })} /></label>
          <label>작업 목표<textarea value={selectedStage.goal} onChange={e => updateStage({ goal:e.target.value })} /></label>
          <label>완료 조건<textarea value={selectedStage.acceptance ?? ""} onChange={e => updateStage({ acceptance:e.target.value || undefined })} /></label>
          {selectedStage.separation && <><label>완결 결과<input value={selectedStage.outcome ?? ""} onChange={e => updateStage({ outcome:e.target.value })} /></label>
            <label>분리 이유<input value={selectedStage.separation.detail} onChange={e => updateStage({ separation:{ ...selectedStage.separation!,detail:e.target.value } })} placeholder="이 결과를 따로 검증하는 이점" /></label></>}
          <div className="pipeline-dependencies">선행 작업{selectedStage.dependsOn.length ? selectedStage.dependsOn.map(id => <button key={id}
            onClick={() => updateStage({dependsOn:selectedStage.dependsOn.filter(dep => dep !== id)})}>선행 {draft.input.stages.find(s => s.id === id)?.title ?? id} 제거</button>) : " 없음"}</div>
          <button onClick={removeStage} disabled={busy || locked(selectedStage.id) || selectedStage.kind === "integration"}>선택 노드 삭제</button>
        </fieldset> : <p>노드를 선택하면 목표·완료 조건을 편집할 수 있습니다. 적용한 연결은 실제 다음 단계의 시작 조건에 반영됩니다.</p>}
      </div>
    </>}
  </section>;
}
