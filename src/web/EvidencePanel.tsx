import { useEffect, useRef, useState } from "react";
import type { EvidenceTopicState } from "../shared/externalEvidence";
import { EvidenceCatalogPanel } from "./EvidenceCatalogPanel";
import { api } from "./api";

export function EvidencePanel({ topicId, busy }: { topicId: string; busy: boolean }) {
  const [state, setState] = useState<EvidenceTopicState | null>(null);
  const [reason, setReason] = useState(""); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const requestVersion = useRef(0); const mutating = useRef(false); const mounted = useRef(true);
  useEffect(() => { setReason(""); }, [state?.digest, state?.plan.scopeGeneration, state?.plan.planEpoch, state?.plan.planSHA256]);
  useEffect(() => {
    let cancelled = false; let loading = false;
    mounted.current = true;
    setState(null); setError(""); setReason("");
    const load = async () => {
      if (loading || mutating.current) return; loading = true;
      const version = ++requestVersion.current;
      try { const result = await api.evidence(topicId); if (!cancelled && version === requestVersion.current) { setState(result); setError(""); } }
      catch (error) { if (!cancelled && version === requestVersion.current) setError(String(error)); }
      finally { loading = false; }
    };
    void load(); const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => { cancelled = true; mounted.current = false; window.clearInterval(timer); };
  }, [topicId]);
  const run = async (action: () => Promise<unknown>) => {
    if (mutating.current || busy) return;
    mutating.current = true; ++requestVersion.current;
    setSaving(true); setError("");
    try { await action(); const updated = await api.evidence(topicId); if (mounted.current) setState(updated); }
    catch (error) { if (mounted.current) setError(String(error)); }
    finally { mutating.current = false; if (mounted.current) setSaving(false); }
  };
  return <details className="evidence-panel">
    <summary>원문 근거 {state ? `(${state.sources.length}) · ${!state.ready ? "원문 확인 필요" : state.reviewed ? "검토됨" : "변경 영향 확인 필요"}` : ""}</summary>
    <EvidenceCatalogPanel key={topicId} topicId={topicId} busy={busy || saving} />
    <p>연결된 읽기 도구로 원문을 수집하고 로컬에서 비교합니다. 변경이 있을 때만 실행 가능한 유휴 작업에서 AI가 영향을 검토합니다. 원문 변경이나 자동 검토로 계획을 승인하지 않습니다.</p>
    {state?.sources.map(source => <div key={source.id}>
      <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>{" · "}
      {source.checkedAt ? new Date(source.checkedAt).toLocaleString() : "아직 확인하지 않음"}
      {state.connections?.filter(connection => connection.sourceId === source.id).map(connection => <span key={connection.sourceId}>
        {source.mode === "connector" ? " · MCP 읽기 연결 (접근 성공은 마지막 수집 결과 확인)" : connection.configured ? " · 서버 인증 설정 있음 (접근 성공은 마지막 수집 결과 확인)" : " · 서버 읽기 인증 설정 필요"}
        {` · 공유 주제 ${connection.sharedTopics}개`}
      </span>)}
      {source.collection && <span role="status"> · {{ reading: "수집 중", collected: "수집 성공", unchanged: "변경 없음", error: "연결 오류" }[source.collection.status]}{source.collection.error ? `: ${source.collection.error}` : ""}</span>}
      {source.collection?.missing?.map(item => <span key={item}> · 미수집: {item}</span>)}
      {source.error && <span role="status"> · {source.error}</span>}
      {source.mode === "rest" ? <button disabled={busy || saving} onClick={() => void run(() => api.checkEvidence(source.id))}>원문 갱신</button> : <span> · 호스트 연결로 확인 <button disabled={busy || saving} onClick={() => void run(() => api.useRestEvidence(source.id))}>서버 수집으로 전환 (공유 주제 모두 적용)</button></span>}
    </div>)}
    {state?.assessments?.map(job => <p key={job.id} role="status">{job.status === "pending" ? "검토 대기" : job.status === "running" ? "영향 검토 중" : job.status === "failed" ? "검토 실패" : ({ "no-impact": "영향 없음", replan: "계획 재검토 필요", decision: "판단 필요" }[job.outcome ?? "decision"])}{job.summary ? ` · ${job.summary}` : ""}</p>)}
    {state?.collectionMetrics && <p>도구 호출 {state.collectionMetrics.toolCalls ?? 0}회 · 변경 없는 수집 {state.collectionMetrics.unchangedCollections ?? 0}회 · 영향 검토 모델 호출 {state.collectionMetrics.modelCalls ?? 0}회</p>}
    {state && state.sources.length > 0 && !state.reviewed && <form onSubmit={event => {
      event.preventDefault(); void run(() => api.reviewEvidence(topicId, { digest: state.digest, plan: state.plan, reason }));
    }}>
      <input aria-label="원문 변경 영향" placeholder="현재 계획에 미치는 영향과 확인한 근거" value={reason} onChange={event => setReason(event.target.value)} required />
      <button disabled={busy || saving || !state.ready || !state.plan.planSHA256}>현재 계획에서 검토 완료</button>
    </form>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
