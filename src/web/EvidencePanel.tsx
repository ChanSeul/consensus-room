import { useEffect, useRef, useState } from "react";
import type { EvidenceTopicState } from "../shared/externalEvidence";
import { EvidenceCatalogPanel } from "./EvidenceCatalogPanel";
import { api } from "./api";
import { EvidencePlatforms } from "./EvidencePlatforms";

export function EvidencePanel({ topicId, busy, archived = false }: { topicId: string; busy: boolean; archived?: boolean }) {
  const [state, setState] = useState<EvidenceTopicState | null>(null);
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const requestVersion = useRef(0); const mutating = useRef(false); const mounted = useRef(true);
  useEffect(() => {
    let cancelled = false; let loading = false;
    mounted.current = true;
    setState(null); setError("");
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
  return <section className="evidence-panel" aria-label="원문 근거">
    <h3>원문 근거 {state && !archived ? `(${state.sources.length}) · ${state.ready ? "원문 준비됨" : "원문 확인 필요"}` : ""}</h3>
    <EvidenceCatalogPanel key={topicId} topicId={topicId} busy={busy || saving} />
    <p>연결된 읽기 도구로 원문을 수집하고 로컬에서 비교합니다. 바뀐 원문은 작업자·중재자에게 사실로 전달합니다. 원문 변경으로 계획을 승인하거나 작업을 멈추지 않습니다.</p>
    {state && state.sources.length > 0 && (archived ? <details className="evidence-history" aria-label="완료 당시 참고 링크">
      <summary>완료 당시 참고 링크 ({state.sources.length}개)</summary>
      <p>완료된 계획에 남은 기록입니다. 앞으로 수집할 링크는 위의 탐색 범위에서 관리합니다.</p>
      <EvidencePlatforms items={state.sources} provider={source => source.provider}>{source => <div key={source.id}>
        <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>
        {source.checkedAt ? ` · 당시 확인: ${new Date(source.checkedAt).toLocaleString()}` : " · 당시 수집 기록 없음"}
      </div>}</EvidencePlatforms>
    </details> : <section aria-label={state.plan.planSHA256 ? "현재 계획에 연결된 원문" : "이 작업에서 사용할 원문"}>
    <h3>{state.plan.planSHA256 ? "현재 계획에 연결된 원문" : "이 작업에서 사용할 원문"}</h3>
    <EvidencePlatforms items={state.sources} provider={source => source.provider}>{source => <div key={source.id}>
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
    </div>}</EvidencePlatforms></section>)}
    {!archived && Boolean(state?.deferred?.length) && <section aria-label="근거 확보 To-do">
      <h3>근거 확보 To-do ({state!.deferred!.length})</h3>
      <p>아래 자료와 이에 의존하는 작업은 보류하고, 확보된 근거로 나머지 작업을 계속합니다.</p>
      {state!.deferred!.map(gap => <p key={gap.sourceId}><a href={gap.url} target="_blank" rel="noreferrer">{gap.label}</a> · {gap.reason}</p>)}
    </section>}
    {state?.collectionMetrics && <p>도구 호출 {state.collectionMetrics.toolCalls ?? 0}회 · 변경 없는 수집 {state.collectionMetrics.unchangedCollections ?? 0}회</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
