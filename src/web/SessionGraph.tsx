import "./session-graph.css";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { api } from "./api";
import { SessionSettingsEditor } from "./SessionSettingsEditor";
import { PlatformIcon } from "./PlatformIcon";
import { GRAPH_STATUS, type GraphNode, type SessionGraph as Graph } from "../shared/sessionGraph";

const COLUMN: Record<string, number> = { topic: 0, stage: 0, mediator: 1, planner: 2, "plan-reviewer": 3, runner: 4, reviewer: 5, verifier: 6, "host-reviewer": 1, session: 3, source: 0 };
const WIDTH = 168, HEIGHT = 108, GAP = 60, ROW = 144;

const SOURCE_COLUMNS = 6;
const sourceGroupKey = (node: GraphNode) => JSON.stringify([node.lane, node.subtitle]);
function isSwiftFileSource(node: GraphNode): boolean {
  if (node.kind !== "source") return false;
  const references = [node.url, ...node.details.filter(item => item.label === "참조").map(item => item.value)];
  if (["file", "search"].includes(node.subtitle.split(" · ")[0])) references.push(node.label);
  return references.some(reference => {
    if (!reference) return false;
    let path = reference;
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(reference)) {
      try { path = new URL(reference).pathname; } catch { /* File selectors need not be URLs. */ }
    }
    try { path = decodeURIComponent(path); } catch { return false; }
    path = path.split("::")[0].split(/[?#]/)[0];
    return /\.swift$/i.test(path) && (/^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|[^\s\\/]+[\\/])/.test(path) || !/\s/.test(path));
  });
}

export function layoutGraph(nodes: GraphNode[], lanes: Graph["lanes"], expanded = new Set<string>(), searching = false, selectedNodeId?: string, edges: Graph["edges"] = []) {
  const positions = new Map<string, { x: number; y: number }>(), sections: Array<{ id: string; title: string; y: number }> = [];
  const sourceGroups: Array<{ id: string; title: string; nodes: GraphNode[]; y: number; expanded: boolean }> = [];
  const columnOf = (node: GraphNode) => COLUMN[node.kind === "session" ? node.role ?? "session" : node.kind];
  const columns = [...new Set(nodes.filter(node => node.kind !== "source").map(columnOf))].sort((a,b) => a-b);
  let y = 30, width = Math.max(780, columns.length * (WIDTH + GAP) + 20);
  for (const lane of [...lanes].sort((a, b) => Number(a.id === "host") - Number(b.id === "host"))) {
    const items = nodes.filter(node => node.lane === lane.id); if (!items.length) continue;
    sections.push({ ...lane, y }); y += 48;
    const rows = new Map<number, number>();
    for (const node of items.filter(node => node.kind !== "source")) {
      const column = columns.indexOf(columnOf(node)), row = rows.get(column) ?? 0;
      positions.set(node.id, { x: 40 + column * (WIDTH + GAP), y: y + row * ROW }); rows.set(column, row + 1);
    }
    y += Math.max(0, ...rows.values()) * ROW;
    const groups = new Map<string, GraphNode[]>();
    for (const node of items.filter(node => node.kind === "source")) {
      const key = sourceGroupKey(node), group = groups.get(key); if (group) group.push(node); else groups.set(key, [node]);
    }
    for (const [id, sources] of groups) {
      const open = searching || expanded.has(id) || sources.length <= SOURCE_COLUMNS || sources.some(node => node.id === selectedNodeId);
      sourceGroups.push({ id, title: sources[0].subtitle || "원문", nodes: sources, y, expanded: open });
      y += 52;
      if (open) {
        sources.forEach((node, index) => positions.set(node.id, { x: 40 + index % SOURCE_COLUMNS * (WIDTH + GAP), y: y + Math.floor(index / SOURCE_COLUMNS) * ROW }));
        width = Math.max(width, Math.min(SOURCE_COLUMNS, sources.length) * (WIDTH + GAP) + 20);
        y += Math.ceil(sources.length / SOURCE_COLUMNS) * ROW;
      }
      y += 18;
    }
    y += 40;
  }
  const children = new Map<string, Graph["edges"]>();
  for (const edge of edges) {
    if (edge.kind !== "hierarchy" || !positions.has(edge.from) || !positions.has(edge.to)) continue;
    const group = children.get(edge.from); if (group) group.push(edge); else children.set(edge.from, [edge]);
  }
  const tracks: number[] = [];
  const hierarchy = [...children].map(([from, branches]) => {
    const ys = [positions.get(from)!.y + HEIGHT * 2 / 3, ...branches.map(edge => positions.get(edge.to)!.y + HEIGHT / 3)];
    return { from, branches, top: Math.min(...ys), bottom: Math.max(...ys), x: 0 };
  }).sort((a,b) => a.top-b.top || b.bottom-a.bottom);
  for (const group of hierarchy) {
    let track = tracks.findIndex(end => end + 12 < group.top);
    if (track < 0) track = tracks.length;
    tracks[track] = group.bottom; group.x = 40 + track * 24;
  }
  const gutter = tracks.length ? tracks.length * 24 + 16 : 0;
  for (const position of positions.values()) position.x += gutter;
  return { positions, sections, sourceGroups, hierarchy, contentLeft: 40 + gutter, width: width + gutter, height: Math.max(450, y) };
}

export function SessionGraph({ topicId, selectedNodeId, onSelect, onEdit, onEvidence, refreshVersion = 0 }: { refreshVersion?: number; topicId: string; selectedNodeId?: string; onSelect: (node: GraphNode | null, reveal?: boolean) => void; onEdit: () => void; onEvidence?: () => void }) {
  const [graph, setGraph] = useState<Graph | null>(null), [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState(false), [sources, setSources] = useState(true), [query, setQuery] = useState("");
  const [lane, setLane] = useState("all"), [zoom, setZoom] = useState(1);
  const [expandedSources, setExpandedSources] = useState(new Set<string>());
  const [fullscreen, setFullscreen] = useState(false);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const panel = useRef<HTMLElement>(null), fullscreenButton = useRef<HTMLButtonElement>(null);
  const leaveFullscreen = () => {
    if (document.fullscreenElement === panel.current) void document.exitFullscreen?.().catch(() => {});
    setFullscreen(false); fullscreenButton.current?.focus();
  };
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow; document.body.style.overflow = "hidden";
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); leaveFullscreen(); }
      if (event.key === "Tab" && panel.current) {
        const controls = [...panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), input, select, [tabindex='0']")];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const changed = () => { if (!document.fullscreenElement) { setFullscreen(false); fullscreenButton.current?.focus(); } };
    document.addEventListener("keydown", keydown); document.addEventListener("fullscreenchange", changed);
    return () => { document.body.style.overflow = previous; document.removeEventListener("keydown", keydown); document.removeEventListener("fullscreenchange", changed); };
  }, [fullscreen]);
  const enterFullscreen = () => {
    setFullscreen(true);
    // Embedded browsers may omit or reject the native API; the same panel then fills the app viewport.
    try { void panel.current?.requestFullscreen?.().catch(() => {}); } catch { /* Keep the in-page fullscreen panel. */ }
  };
  const viewport = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const selected = useRef(selectedNodeId); selected.current = selectedNodeId;
  const select = useRef(onSelect); select.current = onSelect;
  useEffect(() => { setGraph(null); setLane("all"); setExpandedSources(new Set()); select.current(null); }, [topicId]);
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
    void refresh();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [topicId, refreshVersion, settingsRevision]);
  const nodes = useMemo(() => {
    if (!graph) return [];
    const needle = query.trim().toLocaleLowerCase();
    return graph.nodes.filter(node => !(node.kind === "session" && node.role === "verifier" && !node.sessionId && !node.historical && !node.environment && node.details.some(item => item.label === "현재 배정" && item.value === "배정 없음"))
      && !isSwiftFileSource(node) && (history || !node.historical) && (sources || node.kind !== "source") && (lane === "all" || lane === node.lane || node.lane === "host")
      && (!needle || `${node.label} ${node.subtitle} ${node.sessionId ?? ""}`.toLocaleLowerCase().includes(needle)));
  }, [graph, history, sources, query, lane]);
  const layout = useMemo(() => layoutGraph(nodes, graph?.lanes ?? [], expandedSources, Boolean(query.trim()), selectedNodeId, graph?.edges), [nodes, graph, expandedSources, query, selectedNodeId]);
  const edges = useMemo(() => graph?.edges.filter(edge => layout.positions.has(edge.from) && layout.positions.has(edge.to)) ?? [], [graph, layout]);
  const communicationGroups = useMemo(() => {
    const groups = new Map<string, typeof edges>();
    for (const edge of edges.filter(item => item.kind === "communication")) {
      const key = `${edge.from}:${layout.positions.get(edge.to)!.x > layout.positions.get(edge.from)!.x}`;
      const group = groups.get(key); if (group) group.push(edge); else groups.set(key, [edge]);
    }
    return groups;
  }, [edges, layout]);
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
  return <section ref={panel} className={`session-graph${fullscreen ? " is-fullscreen" : ""}`} aria-label="세션과 원문 그래프">
    <div className="graph-toolbar">
      <button ref={fullscreenButton} onClick={fullscreen ? leaveFullscreen : enterFullscreen} aria-pressed={fullscreen}>{fullscreen ? "전체화면 나가기 · Esc" : "전체화면"}</button>
      <button onClick={() => { if (fullscreen) leaveFullscreen(); onEdit(); }}>파이프라인 편집</button>{onEvidence && <button onClick={() => { if (fullscreen) leaveFullscreen(); onEvidence(); }}>원문 관리</button>}
      <label className="graph-search"><span>⌕</span><input aria-label="그래프 검색" placeholder="세션·원문 찾기" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label="그래프 주제 범위" value={lane} onChange={event => setLane(event.target.value)}><option value="all">전체 하위 주제</option>{graph?.lanes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
      <label><input type="checkbox" checked={sources} onChange={event => setSources(event.target.checked)} />원문</label>
      <label><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)} />이전 세션</label>
    </div>
    <p className="graph-flow-hint">세션 흐름 → <span>원문은 종류별 묶음에서 펼쳐 확인합니다. 검색하면 일치하는 원문이 표시됩니다.</span></p>
    {error && <p className="graph-error" role="alert">{error}</p>}
    {!graph && !error && <p className="graph-empty" role="status">세션 기록을 불러오는 중입니다.</p>}
    {graph && <>
      <div className="graph-stage">
      <div className="graph-viewport" ref={viewport} onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} tabIndex={0} aria-label="그래프 캔버스">
        <div style={{ width: layout.width * zoom, height: layout.height * zoom }}>
          <div className="graph-world" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
            {layout.sections.map(section => <div className="graph-lane" key={section.id} style={{ left: layout.contentLeft, top: section.y, width: layout.width - layout.contentLeft - 40 }}>{section.title}</div>)}
            <svg className="graph-lines" width={layout.width} height={layout.height} aria-hidden="true">
              {layout.hierarchy.map(group => {
                const parent = layout.positions.get(group.from)!;
                const highlighted = group.from === selectedNodeId || group.branches.some(edge => edge.to === selectedNodeId);
                return <g key={group.from} className="graph-hierarchy">
                  <g className={`graph-edge edge-hierarchy${highlighted ? " highlighted" : selectedNodeId ? " dimmed" : ""}`}><title>하위 주제 연결</title><path className="hierarchy-trunk" d={`M ${parent.x} ${parent.y + HEIGHT * 2 / 3} H ${group.x} M ${group.x} ${group.top} V ${group.bottom}`} /></g>
                  {group.branches.map(edge => { const child = layout.positions.get(edge.to)!; const active = edge.from === selectedNodeId || edge.to === selectedNodeId;
                    return <g key={edge.id} className={`graph-edge edge-hierarchy${active ? " highlighted" : selectedNodeId ? " dimmed" : ""}`}><title>{edge.label}</title><path className="hierarchy-branch" d={`M ${group.x} ${child.y + HEIGHT / 3} H ${child.x}`} /><circle cx={child.x} cy={child.y + HEIGHT / 3} r={4} /></g>;
                  })}
                </g>;
              })}
              {edges.filter(edge => edge.kind !== "hierarchy").map(edge => {
                const a = layout.positions.get(edge.from)!, b = layout.positions.get(edge.to)!, across = b.x > a.x;
                const x1 = a.x + (across ? WIDTH : WIDTH / 2), y1 = a.y + (across ? HEIGHT / 2 : HEIGHT);
                const x2 = b.x + (across ? 0 : WIDTH / 2), y2 = b.y + (across ? HEIGHT / 2 : 0);
                const path = across ? `M ${x1} ${y1} C ${x1 + GAP/2} ${y1}, ${x2-GAP/2} ${y2}, ${x2} ${y2}` : `M ${x1} ${y1} C ${x1+80} ${y1+35}, ${x2+80} ${y2-35}, ${x2} ${y2}`;
                const highlighted = edge.from === selectedNodeId || edge.to === selectedNodeId;
                const communicationLabel = edge.status ? {waiting:"대기",sending:"전송중",sent:"전송됨",acknowledged:"확인됨",failed:"실패",unknown:"미확인"}[edge.status] : "통신";
                const communicationGroup = communicationGroups.get(`${edge.from}:${across}`);
                const grouped = communicationGroup && communicationGroup.length > 1;
                return <g key={edge.id} className={`graph-edge edge-${edge.kind} edge-${edge.status ?? "none"}${highlighted ? " highlighted" : selectedNodeId ? " dimmed" : ""}`}><title>{edge.label}{edge.detail ? ` · ${edge.detail}` : ""}</title><path d={path} /><circle cx={x2} cy={y2} r={4} />{edge.kind === "communication" && !grouped && <text x={across ? a.x + WIDTH + GAP/2 : a.x + WIDTH/2} y={across ? a.y + HEIGHT/2-10 : a.y-6} textAnchor="middle">{communicationLabel}</text>}</g>;
              })}
              {[...communicationGroups].filter(([, group]) => group.length > 1).map(([key, group]) => {
                const a = layout.positions.get(group[0].from)!, across = layout.positions.get(group[0].to)!.x > a.x;
                const highlighted = group.some(edge => edge.from === selectedNodeId || edge.to === selectedNodeId);
                return <g key={key} className={`graph-edge edge-communication communication-label${highlighted ? " highlighted" : selectedNodeId ? " dimmed" : ""}`}>
                  <text x={across ? a.x + WIDTH + GAP/2 : a.x + WIDTH/2} y={across ? a.y + HEIGHT/2-10 : a.y-6} textAnchor="middle">통신 {group.length}<title>{group.map(edge => `${edge.label}${edge.detail ? ` · ${edge.detail}` : ""}`).join("\n")}</title></text>
                </g>;
              })}
            </svg>
            {layout.sourceGroups.map(group => <button key={group.id} className="graph-source-group" style={{left:layout.contentLeft, top:group.y}}
              aria-expanded={group.expanded} disabled={group.nodes.length <= SOURCE_COLUMNS || Boolean(query.trim())}
              onClick={() => { if (group.expanded && group.nodes.some(node => node.id === selectedNodeId)) onSelect(null); setExpandedSources(current => { const next = new Set(current); if (group.expanded) next.delete(group.id); else next.add(group.id); return next; }); }}>
              <PlatformIcon node={group.nodes[0]} /><strong>{group.title}</strong><span>원문 {group.nodes.length}개</span><span>{group.expanded ? "▾" : "▸ 펼치기"}</span>
            </button>)}
            {nodes.filter(node => layout.positions.has(node.id)).map(node => { const p = layout.positions.get(node.id)!; return <button type="button" key={node.id}
              className={`graph-node node-${node.kind} node-${node.status}${node.id === selectedNodeId ? " selected" : ""}${node.historical ? " historical" : ""}`}
              style={{ left: p.x, top: p.y, width: WIDTH, height: HEIGHT }} aria-pressed={node.id === selectedNodeId}
              aria-label={`${node.label} · ${GRAPH_STATUS[node.status]}${node.sessionId ? ` · ${node.sessionId}` : ""}`} onClick={() => onSelect(node, !fullscreen)}>
              <span className="graph-port input" /><span className="graph-port output" />
              <span className="graph-node-top"><PlatformIcon node={node} /><span className="graph-state"><i />{GRAPH_STATUS[node.status]}</span></span>
              <strong title={node.label}>{node.label}</strong><small title={node.subtitle}>{node.subtitle}</small>
            </button>; })}
            {!nodes.length && <p className="graph-empty">조건에 맞는 세션·원문이 없습니다.</p>}
          </div>
        </div>
      </div>
      {fullscreen && selectedNodeId && <aside className="graph-fullscreen-detail" aria-label="전체화면 노드 상세">
        <button className="graph-detail-close" onClick={() => onSelect(null)}>상세 닫기</button>
        <GraphInspector node={graph.nodes.find(node => node.id === selectedNodeId) ?? null} currentTopicId={topicId} onSettingsSaved={() => setSettingsRevision(value => value + 1)} />
      </aside>}
      </div>
      <div className="graph-footer"><span>{layout.positions.size}/{nodes.length}개 노드 표시 · 드래그로 이동</span><div className="graph-legend"><span className="legend-flow">┄ 역할·계층</span><span className="legend-source">┄ 원문 연결</span><span className="legend-delivered">━ 원문 전달</span><span className="legend-communication">━ 통신</span><span className="legend-dependency">━ 선행 작업</span><span>통신 상태: 녹색 수신 · 주황 대기/미확인 · 빨강 실패</span></div>
        <button aria-label="그래프 축소" onClick={() => setZoom(value => Math.max(.2, value - .1))}>−</button><output>{Math.round(zoom*100)}%</output><button aria-label="그래프 확대" onClick={() => setZoom(value => Math.min(1.8, value + .1))}>+</button><button onClick={fit}>너비 맞춤</button></div>
      {graph.warnings.map(warning => <p className="graph-notice" key={warning}>{warning}</p>)}
    </>}
  </section>;
}

export function GraphInspector({ node, currentTopicId, onTopic, onEvidence, onSettingsSaved }: { onSettingsSaved?: () => void; node: GraphNode | null; currentTopicId: string; onTopic?: (id: string) => void; onEvidence?: (id: string) => void }) {
  if (!node) return <section className="graph-inspector empty"><span>◇</span><strong>노드를 선택하세요</strong><p>세션 설정과 연결된 원문을 확인할 수 있습니다.</p></section>;
  const jobSettings = node.details.filter(item => /^(planner|implementer|reviewer)\//.test(item.label));
  const environmentLabels = new Set(node.environment ? ["실행 환경", "실행 작업 경로", "시작 소비처", "격리·sandbox", "실행 당시 모델·강도", "실행 관측 시각"] : ["실행 환경"]);
  const fields = node.details.filter(item => !jobSettings.includes(item) && !(node.kind === "session" && environmentLabels.has(item.label)));
  const safeUrl = node.url && /^https?:\/\//i.test(node.url) ? node.url : null;
  return <section className="graph-inspector" aria-label="선택한 노드 상세">
    <div className="section-heading"><h3><PlatformIcon node={node} />{node.label}</h3><span className={`graph-detail-state node-${node.status}`}>{GRAPH_STATUS[node.status]}</span></div>
    <p>{node.subtitle}{node.historical ? " · 이전 세션" : ""}</p>
    <dl>{fields.map((item, i) => <div key={`${item.label}-${i}`}><dt>{item.label === "세션 프로필" ? "세션 생성 시 프로필" : item.label}</dt><dd>{item.value}</dd></div>)}</dl>
    {jobSettings.length > 0 && <details className="graph-job-settings"><summary>작업별 설정</summary><dl>{jobSettings.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></details>}
    {safeUrl && <a className="graph-link" href={safeUrl} target="_blank" rel="noreferrer">원문 열기 ↗</a>}
    {node.kind === "session" && <>
      {node.role === "verifier" && <p className="graph-notice">검증자는 외부에서 배정한 역할입니다. 이 서버는 검증자 모델을 자동 실행하지 않습니다.</p>}
      <details className="node-spawn-record" open><summary>실행 당시 환경</summary>
        {node.environment ? <><p>실제 프로세스 실행 때 기록한 값입니다. 현재 설정으로 과거 값을 대체하지 않습니다.</p><dl>
          <div><dt>기록 시각</dt><dd>{node.environment.spawnedAt}</dd></div>
          <div><dt>실행 ID</dt><dd>{node.environment.executionId}</dd></div>
          <div><dt>기록된 세션 ID</dt><dd>{node.environment.sessionId ?? "실행 당시 기록 없음"}</dd></div>
          <div><dt>공급자 · 모델 · 추론 강도</dt><dd>{node.environment.provider} · {node.environment.model} · {node.environment.effort}</dd></div>
          <div><dt>실행 작업</dt><dd>{node.environment.consumer}</dd></div>
          <div><dt>작업 디렉터리</dt><dd>{node.environment.cwd}</dd></div>
          <div><dt>실행 호스트</dt><dd>{node.environment.hostname} · {node.environment.hostOS.platform} · {node.environment.hostOS.release} · {node.environment.hostOS.arch}</dd></div>
          <div><dt>작업 공간</dt><dd>{node.environment.workspace} · {node.environment.isolated ? "격리됨" : "격리 안 됨"}</dd></div>
          <div><dt>접근 권한 · 샌드박스</dt><dd>{node.environment.access} · {node.environment.sandbox}</dd></div>
        </dl></> : <p>실행 당시 환경 기록이 없습니다. 현재 설정이나 이 서버의 환경으로 추정하지 않습니다.</p>}
      </details>
      {node.historical ? <p className="graph-notice">과거 세션 기록은 읽기 전용입니다. 현재 역할 노드에서 다음 실행 설정을 변경하세요.</p>
        : node.settingsTargets?.length ? node.settingsTargets.map(target => <SessionSettingsEditor key={`${node.topicId ?? currentTopicId}:${node.id}:${target}`} topicId={node.topicId ?? currentTopicId} target={target} onSaved={onSettingsSaved} />)
        : <p className="graph-notice">현재 설정 대상을 확인할 수 없는 세션입니다. 실행 환경 기록만 표시합니다.</p>}
    </>}
    <div className="button-row">

      {onTopic && node.topicId && <button className="secondary-button" onClick={() => onTopic(node.topicId!)}>이 주제로 이동</button>}
      {onEvidence && node.kind === "source" && node.topicId && <button className="secondary-button" onClick={() => onEvidence(node.topicId!)}>원문 연결·검수 관리</button>}
    </div>
  </section>;
}
