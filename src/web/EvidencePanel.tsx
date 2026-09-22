import { useEffect, useRef, useState } from "react";
import type { EvidenceTopicState } from "../shared/externalEvidence";
import { api } from "./api";

export function EvidencePanel({ topicId, busy }: { topicId: string; busy: boolean }) {
  const [state, setState] = useState<EvidenceTopicState | null>(null);
  const [url, setURL] = useState(""); const [label, setLabel] = useState("");
  const [mode, setMode] = useState<"connector" | "rest">("connector");
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
    <summary>Slack · Jira · Figma 근거 {state ? `(${state.sources.length}) · ${!state.ready ? "원문 확인 필요" : state.reviewed ? "검토됨" : "변경 영향 확인 필요"}` : ""}</summary>
    <p>원문이 바뀌면 변경된 내용만 전달합니다. 변경 감지가 요구사항 확정을 뜻하지는 않습니다.</p>
    {state?.sources.map(source => <div key={source.id}>
      <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>{" · "}
      {source.checkedAt ? new Date(source.checkedAt).toLocaleString() : "아직 확인하지 않음"}
      {source.error && <span role="status"> · {source.error}</span>}
      {source.mode === "rest" ? <button disabled={busy || saving} onClick={() => void run(() => api.checkEvidence(source.id))}>원문 갱신</button> : <span> · 호스트 연결로 확인</span>}
    </div>)}
    <form onSubmit={event => { event.preventDefault(); void run(() => api.addEvidence(topicId, { url, label, mode, intervalSeconds: 900 })); }}>
      <input aria-label="원문 이름" placeholder="기획·디자인·백엔드 자료 이름" value={label} onChange={event => setLabel(event.target.value)} required />
      <input aria-label="원문 링크" type="url" placeholder="Slack 스레드 / Jira 이슈 / Figma 노드 링크" value={url} onChange={event => setURL(event.target.value)} required />
      <select aria-label="원문 연결 방식" value={mode} onChange={event => setMode(event.target.value as typeof mode)}>
        <option value="connector">Codex·중재자 연결 도구로 수집</option><option value="rest">서버에서 주기적으로 확인</option>
      </select>
      <button disabled={busy || saving}>원문 등록</button>
    </form>
    {state && state.sources.length > 0 && !state.reviewed && <form onSubmit={event => {
      event.preventDefault(); void run(() => api.reviewEvidence(topicId, { digest: state.digest, plan: state.plan, reason }));
    }}>
      <input aria-label="원문 변경 영향" placeholder="현재 계획에 미치는 영향과 확인한 근거" value={reason} onChange={event => setReason(event.target.value)} required />
      <button disabled={busy || saving || !state.ready || !state.plan.planSHA256}>현재 계획에서 검토 완료</button>
    </form>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
