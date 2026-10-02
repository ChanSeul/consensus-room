import "./session-graph.css";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { api } from "./api";
import { GRAPH_STATUS, type GraphNode, type SessionGraph as Graph } from "../shared/sessionGraph";

const ICONS: Record<string, string> = { topic: "◎", stage: "▦", source: "▤", mediator: "◇", planner: "▦", "plan-reviewer": "✓", runner: "▷", reviewer: "✓", "host-reviewer": "⌘", verifier: "◈", session: "○" };
const COLUMN: Record<string, number> = { topic: 0, stage: 0, mediator: 1, planner: 2, "plan-reviewer": 3, runner: 4, reviewer: 5, verifier: 6, "host-reviewer": 1, session: 3, source: 0 };
const WIDTH = 168, HEIGHT = 108, GAP = 60, ROW = 144;

export function layoutGraph(nodes: GraphNode[], lanes: Graph["lanes"]) {
  const positions = new Map<string, { x: number; y: number }>(), sections: Array<{ id: string; title: string; y: number }> = [];
  let y = 30, width = 780;
  for (const lane of lanes) {
    const items = nodes.filter(node => node.lane === lane.id); if (!items.length) continue;
    sections.push({ ...lane, y }); y += 48;
    const rows = new Map<number, number>();
    for (const node of items) {
      const column = COLUMN[node.kind === "session" ? node.role ?? "session" : node.kind], row = rows.get(column) ?? 0;
      const x = 40 + column * (WIDTH + GAP); positions.set(node.id, { x, y: y + row * ROW }); rows.set(column, row + 1);
      width = Math.max(width, x + WIDTH + 40);
    }
    y += Math.max(...rows.values()) * ROW + 56;
  }
  return { positions, sections, width, height: Math.max(450, y) };
}

export function SessionGraph({ topicId, selectedNodeId, onSelect, onEdit, onEvidence }: { topicId: string; selectedNodeId?: string; onSelect: (node: GraphNode | null, reveal?: boolean) => void; onEdit: () => void; onEvidence?: () => void }) {
  const [graph, setGraph] = useState<Graph | null>(null), [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState(false), [sources, setSources] = useState(true), [query, setQuery] = useState("");
  const [lane, setLane] = useState("all"), [zoom, setZoom] = useState(.7);
  const viewport = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const selected = useRef(selectedNodeId); selected.current = selectedNodeId;
  const select = useRef(onSelect); select.current = onSelect;
  useEffect(() => {
    let cancelled = false, timer: number | undefined;
    const refresh = async () => {
      if (document.hidden) { timer = window.setTimeout(refresh, 5_000); return; }
      try {
        const next = await api.sessionGraph(topicId);
        if (cancelled) return;
        setGraph(next); setError(null);
        if (selected.current) select.current(next.nodes.find(node => node.id === selected.current) ?? null);
        timer = window.setTimeout(refresh, next.nodes.some(node => node.status === "running") ? 3_000 : 10_000);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "그래프를 읽지 못했습니다.");
        // Old running indicators must not look live after a failed refresh.
        setGraph(null); select.current(null); timer = window.setTimeout(refresh, 10_000);
      }
    };
    setGraph(null); setLane("all"); select.current(null); void refresh();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [topicId]);
  const nodes = useMemo(() => {
    if (!graph) return [];
    const needle = query.trim().toLocaleLowerCase();
    return graph.nodes.filter(node => (history || !node.historical) && (sources || node.kind !== "source") && (lane === "all" || lane === node.lane)
      && (!needle || `${node.label} ${node.subtitle} ${node.sessionId ?? ""}`.toLocaleLowerCase().includes(needle)));
  }, [graph, history, sources, query, lane]);
  const layout = useMemo(() => layoutGraph(nodes, graph?.lanes ?? []), [nodes, graph?.lanes]);
  const edges = useMemo(() => graph?.edges.filter(edge => layout.positions.has(edge.from) && layout.positions.has(edge.to)) ?? [], [graph, layout]);
  const fit = () => { if (viewport.current) { setZoom(Math.max(.2, Math.min(1, (viewport.current.clientWidth - 24) / layout.width))); viewport.current.scrollTo(0, 0); } };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const view = viewport.current!; drag.current = { x: event.clientX, y: event.clientY, left: view.scrollLeft, top: view.scrollTop };
    view.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !viewport.current) return;
    viewport.current.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
    viewport.current.scrollTop = drag.current.top - (event.clientY - drag.current.y);
  };
  return <section className="session-graph" aria-label="세션과 원문 그래프">
    <div className="graph-toolbar">
      <button onClick={onEdit}>파이프라인 편집</button>{onEvidence && <button onClick={onEvidence}>원문 관리</button>}
      <label className="graph-search"><span>⌕</span><input aria-label="그래프 검색" placeholder="세션·원문 찾기" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label="그래프 주제 범위" value={lane} onChange={event => setLane(event.target.value)}><option value="all">전체 하위 주제</option>{graph?.lanes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
      <label><input type="checkbox" checked={sources} onChange={event => setSources(event.target.checked)} />원문</label>
      <label><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)} />이전 세션</label>
    </div>
    {error && <p className="graph-error" role="alert">{error}</p>}
    {!graph && !error && <p className="graph-empty" role="status">세션 기록을 불러오는 중입니다.</p>}
    {graph && <>
      <div className="graph-viewport" ref={viewport} onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} tabIndex={0} aria-label="그래프 캔버스">
        <div style={{ width: layout.width * zoom, height: layout.height * zoom }}>
          <div className="graph-world" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
            {layout.sections.map(section => <div className="graph-lane" key={section.id} style={{ top: section.y, width: layout.width - 80 }}>{section.title}</div>)}
            <svg className="graph-lines" width={layout.width} height={layout.height} aria-hidden="true">
              {edges.map(edge => {
                const a = layout.positions.get(edge.from)!, b = layout.positions.get(edge.to)!, across = b.x > a.x;
                const x1 = a.x + (across ? WIDTH : WIDTH / 2), y1 = a.y + (across ? HEIGHT / 2 : HEIGHT);
                const x2 = b.x + (across ? 0 : WIDTH / 2), y2 = b.y + (across ? HEIGHT / 2 : 0);
                const path = across ? `M ${x1} ${y1} C ${x1 + GAP/2} ${y1}, ${x2-GAP/2} ${y2}, ${x2} ${y2}` : `M ${x1} ${y1} C ${x1+80} ${y1+35}, ${x2+80} ${y2-35}, ${x2} ${y2}`;
                const highlighted = edge.from === selectedNodeId || edge.to === selectedNodeId;
                return <g key={edge.id} className={`graph-edge edge-${edge.kind} edge-${edge.status ?? "none"}${highlighted ? " highlighted" : ""}`}><title>{edge.label}{edge.detail ? ` · ${edge.detail}` : ""}</title><path d={path} /><circle cx={x2} cy={y2} r={4} />{edge.kind === "communication" && <text x={(x1+x2)/2} y={(y1+y2)/2-10} textAnchor="middle">{edge.label}</text>}</g>;
              })}
            </svg>
            {nodes.map(node => { const p = layout.positions.get(node.id)!; return <button type="button" key={node.id}
              className={`graph-node node-${node.kind} node-${node.status}${node.id === selectedNodeId ? " selected" : ""}${node.historical ? " historical" : ""}`}
              style={{ left: p.x, top: p.y, width: WIDTH, height: HEIGHT }} aria-pressed={node.id === selectedNodeId}
              aria-label={`${node.label} · ${GRAPH_STATUS[node.status]}${node.sessionId ? ` · ${node.sessionId}` : ""}`} onClick={() => onSelect(node, true)}>
              <span className="graph-port input" /><span className="graph-port output" />
              <span className="graph-node-top"><span className="graph-symbol">{ICONS[node.kind === "session" ? node.role ?? "session" : node.kind]}</span><span className="graph-state"><i />{GRAPH_STATUS[node.status]}</span></span>
              <strong title={node.label}>{node.label}</strong><small title={node.subtitle}>{node.subtitle}</small>
            </button>; })}
            {!nodes.length && <p className="graph-empty">조건에 맞는 세션·원문이 없습니다.</p>}
          </div>
        </div>
      </div>
      <div className="graph-footer"><span>{nodes.length}개 노드 · 드래그로 이동</span><div className="graph-legend"><span>━ 전달 기록 · 녹색: 수신 확인 · 주황: 대기 · 빨강: 실패</span><span>┄ 역할 흐름·원문 연결</span></div>
        <button aria-label="그래프 축소" onClick={() => setZoom(value => Math.max(.2, value - .1))}>−</button><output>{Math.round(zoom*100)}%</output><button aria-label="그래프 확대" onClick={() => setZoom(value => Math.min(1.8, value + .1))}>+</button><button onClick={fit}>너비 맞춤</button></div>
      {graph.warnings.map(warning => <p className="graph-notice" key={warning}>{warning}</p>)}
    </>}
  </section>;
}

export function GraphInspector({ node, currentTopicId, onTopic, onSession, onEvidence }: { node: GraphNode | null; currentTopicId: string; onTopic: (id: string) => void; onSession: (role: "claude" | "codex") => void; onEvidence: (id: string) => void }) {
  if (!node) return <section className="graph-inspector empty"><span>◇</span><strong>노드를 선택하세요</strong><p>세션 설정과 연결된 원문을 확인할 수 있습니다.</p></section>;
  const jobSettings = node.details.filter(item => /^(planner|implementer|reviewer)\//.test(item.label));
  const fields = node.details.filter(item => !jobSettings.includes(item));
  const safeUrl = node.url && /^https?:\/\//i.test(node.url) ? node.url : null;
  return <section className="graph-inspector" aria-label="선택한 노드 상세">
    <div className="section-heading"><h3>{node.label}</h3><span className={`graph-detail-state node-${node.status}`}>{GRAPH_STATUS[node.status]}</span></div>
    <p>{node.subtitle}{node.historical ? " · 이전 세션" : ""}</p>
    <dl>{fields.map((item, i) => <div key={`${item.label}-${i}`}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
    {jobSettings.length > 0 && <details className="graph-job-settings"><summary>작업별 설정</summary><dl>{jobSettings.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></details>}
    {safeUrl && <a className="graph-link" href={safeUrl} target="_blank" rel="noreferrer">원문 열기 ↗</a>}
    <div className="button-row">
      {node.kind === "session" && !node.historical && node.topicId === currentTopicId && ["planner", "runner", "plan-reviewer", "reviewer"].includes(node.role ?? "") &&
        <button className="secondary-button" onClick={() => onSession(node.role === "planner" || node.role === "runner" ? "claude" : "codex")}>현재 세션·설정 변경</button>}
      {node.topicId && <button className="secondary-button" onClick={() => onTopic(node.topicId!)}>이 주제로 이동</button>}
      {node.kind === "source" && node.topicId && <button className="secondary-button" onClick={() => onEvidence(node.topicId!)}>원문 연결·검수 관리</button>}
    </div>
  </section>;
}
