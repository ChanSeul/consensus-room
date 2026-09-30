import { useEffect, useRef, useState } from "react";
import { parseEvidenceSource, type EvidenceCatalog, type EvidenceHostPlan, type EvidenceScope } from "../shared/externalEvidence";
import { api } from "./api";

const scopes = { group: "이 작업 그룹과 이후 단계", topic: "이 주제만", workspace: "이 저장소의 모든 작업" };
const progress = { pending: "수집 대기", reading: "수집 중", complete: "수집 완료", failed: "수집 실패" };
export function EvidenceCatalogPanel({ topicId, busy }: { topicId: string; busy: boolean }) {
  const [catalog, setCatalog] = useState<EvidenceCatalog | null>(null);
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const [url, setURL] = useState(""); const [label, setLabel] = useState("");
  const [scope, setScope] = useState<EvidenceScope>("group");
  const [mode, setMode] = useState<"connector" | "rest">("connector");
  const [hostPlan, setHostPlan] = useState<EvidenceHostPlan | null>(null);
  const generation = useRef(0); const requests = useRef(0); const pending = useRef(false);
  useEffect(() => {
    const current = ++generation.current; let loading = false;
    setCatalog(null); setHostPlan(null); setError("");
    const load = async () => {
      if (loading || pending.current) return; loading = true;
      const requestId = ++requests.current;
      try { const next = await api.evidenceCatalog(topicId); if (generation.current === current && requestId === requests.current) setCatalog(next); }
      catch (e) { if (generation.current === current) setError(String(e)); }
      finally { loading = false; }
    };
    void load(); const timer = window.setInterval(() => void load(), 15000);
    return () => { ++generation.current; window.clearInterval(timer); };
  }, [topicId]);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy || pending.current) return;
    const current = generation.current; ++requests.current; pending.current = true; setSaving(true); setError("");
    try { await operation(); const next = await api.evidenceCatalog(topicId); if (current === generation.current) setCatalog(next); }
    catch (e) { if (current === generation.current) setError(String(e)); }
    finally { pending.current = false; if (current === generation.current) setSaving(false); }
  };
  const select = (rootId: string, action: "approve" | "remove" | "accept" | "reject" | "dismiss", sourceId?: string) =>
    void run(() => api.selectEvidence(topicId, catalog!.version, rootId, action, sourceId));
  return <section aria-label="근거 탐색 범위">
    <h3>탐색할 루트와 사람의 검수</h3>
    <p>Jira 루트는 작업마다 지정합니다. 승인한 Jira의 하위·연결 티켓과 Slack 채널의 답글을 모두 탐색합니다. 새 외부 문서와 Figma 노드는 아래에서 검수합니다.</p>
    <p>링크를 해제하면 다음 계획과 세션에서 제외합니다. 과거 원문·인용·완료 결과는 보존하며, 진행 중 턴이 끝난 뒤 변경할 수 있습니다.</p>
    {catalog && <>
      <p role="status">자료 {catalog.coverage.sources}개 · 원문 조각 {catalog.coverage.units}개 · 수집 완료 {catalog.coverage.complete} · 대기/진행 {catalog.coverage.pending} · 실패 {catalog.coverage.failed} · 검수 대기 {catalog.coverage.candidates} · {catalog.coverage.ready ? "필수 범위 수집 완료" : "필수 범위 미완료"}</p>
      <button disabled={busy || saving} onClick={() => {
        const current = generation.current;
        void run(async () => { const result = await api.collectEvidence(topicId); if (current === generation.current) setHostPlan(result.hostPlan); });
      }}>수집 이어가기</button>
      {hostPlan && hostPlan.version === catalog.version && <aside aria-label="앱 연결로 읽을 자료">
        <p role="status">앱 연결로 읽을 원문 {hostPlan.total}개 · 링크 검수 대기 {hostPlan.pendingReview}개</p>
        <p>에이전트가 기존 앱 연결로 읽어 공유 근거에 저장합니다. 연결이 없으면 로그인된 브라우저를 사용하며, 읽지 못한 댓글·화면은 누락으로 기록합니다.</p>
        {hostPlan.requests.map(read => <p key={read.sourceId}><a href={read.url} target="_blank" rel="noreferrer">{read.label}</a>
          {` · ${read.integration} · ${read.requiredReads.join(" / ")}`}</p>)}
        {hostPlan.nextOffset !== null && <p>나머지 원문은 에이전트가 다음 목록에서 이어서 읽습니다.</p>}
      </aside>}
      {catalog.roots.filter(r => r.status !== "removed").map(root => <article key={root.id}>
        <a href={root.source.url} target="_blank" rel="noreferrer">{root.source.label}</a> · {scopes[root.scope]} · {root.status === "approved" ? "사용자 승인됨" : "루트 검수 대기"}
        <p>{root.source.url}</p>
        {root.scanStartedAt !== undefined && <small>이번 수집 시작 {new Date(root.scanStartedAt).toLocaleString()} · {root.lastCompleteAt === null ? "수집 중" : `완료 ${new Date(root.lastCompleteAt).toLocaleString()}`} (각 원문의 조회 시각은 서로 다를 수 있습니다.)</small>}
        {root.status === "proposed" && <button disabled={busy || saving} onClick={() => select(root.id,"approve")}>이 루트와 탐색 범위 승인</button>}
        <button disabled={busy || saving} onClick={() => select(root.id,"remove")}>앞으로 사용하지 않기</button>
        <details><summary>연결 자료와 수집 상태</summary>
          {catalog.entries.some(e => e.rootId === root.id && e.state === "candidate") && <button disabled={busy || saving}
            onClick={() => void run(() => api.selectEvidenceBatch(topicId,catalog.version,root.id,catalog.entries.filter(e=>e.rootId===root.id && e.state==="candidate").slice(0,200).map(e=>e.source.id)))}>아래 검수 대기 자료를 확인했고 사용 승인 (최대 200개)</button>}
          {catalog.entries.filter(e => e.rootId === root.id).map(entry => <div key={entry.source.id}>
            <a href={entry.source.url} target="_blank" rel="noreferrer">{entry.source.label}</a> · {entry.state === "candidate" ? "검수 대기" : entry.state === "rejected" ? "제외됨" : progress[entry.progress]}
            <p>{entry.source.url}{entry.source.selector ? ` · 선택 위치 ${entry.source.selector}` : ""}</p>
            {entry.discoveredFrom.map((from, i) => <small key={i}>발견 위치: {catalog.entries.find(e => e.source.id === from.sourceId)?.source.label ?? from.sourceId} / {from.unitId} </small>)}
            {entry.error && <p role="alert">{entry.error}</p>}
            {entry.source.id !== root.sourceId && <>
              {entry.state !== "approved" && <button disabled={busy || saving} onClick={() => select(root.id,"accept",entry.source.id)}>사용 승인</button>}
              {entry.state !== "rejected" && <button disabled={busy || saving} onClick={() => select(root.id,"reject",entry.source.id)}>이 루트에서 제외</button>}
            </>}
          </div>)}
        </details>
      </article>)}
      {(catalog.unresolvedLinks ?? []).map(link => <p key={`${link.rootId}:${link.id}`} role="alert">
        {link.error} <a href={link.url} target="_blank" rel="noreferrer">{link.url}</a>
        <button disabled={busy || saving} onClick={() => select(link.rootId,"dismiss",link.id)}>이 링크를 탐색 범위에서 제외</button>
      </p>)}
      <details><summary>이전 링크와 검수 기록 ({catalog.history.length})</summary>
        {catalog.history.map((entry, index) => <p key={index}>{new Date(entry.at).toLocaleString()} · {entry.action} · <a href={entry.url} target="_blank" rel="noreferrer">{entry.url}</a></p>)}
      </details>
    </>}
    <form onSubmit={e => { e.preventDefault(); void run(() => {
      const input = { url, label, scope, mode, intervalSeconds: 900, required: true };
      // Public documentation needs no service account. The default app route applies to authenticated services.
      return api.addEvidenceRoot(topicId, { ...input, mode: parseEvidenceSource(input).provider === "document" ? "rest" : mode });
    }); }}>
      <input aria-label="탐색 루트 이름" required value={label} onChange={e => setLabel(e.target.value)} placeholder="작업 기획 / 정책서 / 백엔드" />
      <input aria-label="탐색 루트 링크" required type="url" value={url} onChange={e => setURL(e.target.value)} placeholder="Jira 루트·Slack 채널·정책서·API 문서" />
      <select aria-label="근거 적용 범위" value={scope} onChange={e => setScope(e.target.value as EvidenceScope)}>
        <option value="group">이 작업 그룹 (독립 주제면 이 주제)</option><option value="topic">이 주제만</option><option value="workspace">저장소 공통 자료</option>
      </select>
      <select aria-label="원문 수집 방법" value={mode} onChange={e => setMode(e.target.value as "connector" | "rest")}>
        <option value="connector">앱 연결·기존 로그인으로 읽기 (기본)</option><option value="rest">서버 직접 수집 (읽기 인증 필요)</option>
      </select>
      <button disabled={busy || saving}>루트와 탐색 범위 승인·추가</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </section>;
}
