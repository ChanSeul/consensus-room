import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Topic } from "../shared/contracts";
import { ENTRY_COPY, isTopicGroup, topicAncestors, topicForest, workEntry, type TopicNode } from "../shared/topicStructure";

export function EntryGuide() {
  return <section className="entry-guide" aria-label="작업 시작 방식">
    <p>Claude 또는 Codex 중재 세션에서 시작하세요. 웹에서는 목표와 진행 상황을 확인합니다.</p>
    <div className="entry-options">{Object.entries(ENTRY_COPY).map(([mode, copy], index) =>
      <article key={mode}><span className="entry-number">0{index + 1}</span><h3>{copy.label}</h3>
        <p>{copy.description}</p><small>{copy.steps.join(" → ")}</small></article>)}</div>
    <p className="hierarchy-note">큰 그림을 먼저 정하고 Root → Sub → 하위 Sub로 나눕니다. 현재 말단 주제만 상세 계획·구현·검증하고, 그 결과로 다음 단계를 구체화합니다. 관리 주제는 Goal과 진행률을 모읍니다.</p>
  </section>;
}

export function TopicTree({ topics, selectedId, onSelect, status }: { topics: Topic[]; selectedId: string | null; onSelect: (id: string) => void; status?: (topic: Topic) => ReactNode }) {
  const forest = useMemo(() => topicForest(topics), [topics]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(topics.filter(isTopicGroup).map(topic => topic.id)));
  const revealedSelection = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (revealedSelection.current === selectedId) return;
    const selected = topics.find(topic => topic.id === selectedId);
    if (!selected) return;
    revealedSelection.current = selectedId;
    const parents = topicAncestors(selected, topics);
    setCollapsed(previous => {
      if (!parents.some(parent => previous.has(parent.id))) return previous;
      const next = new Set(previous); parents.forEach(parent => next.delete(parent.id)); return next;
    });
  }, [selectedId, topics]);
  const toggle = (id: string) => setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const render = (nodes: TopicNode[], depth: number) => <ul className="topic-tree-level">{nodes.map(node => {
    const { topic, children, leaves, closed } = node;
    const hiddenLeaves = (nodes: TopicNode[]): Topic[] => nodes.flatMap(child => isTopicGroup(child.topic) ? hiddenLeaves(child.children) : [child.topic]);
    const descendants = collapsed.has(topic.id) ? hiddenLeaves(children) : [];
    const outstanding = descendants.filter(leaf => leaf.state !== "CLOSED");
    const summary = new Map<string, { topic: Topic; count: number }>();
    for (const leaf of outstanding.length ? outstanding : descendants) {
      const entry = summary.get(leaf.state);
      if (entry) entry.count += 1; else summary.set(leaf.state, { topic: leaf, count: 1 });
    }
    return <li key={topic.id}>
      <div className="topic-tree-row">
        {children.length > 0 ? <button className="tree-toggle" aria-label={`${topic.title} 하위 주제`} aria-expanded={!collapsed.has(topic.id)} onClick={() => toggle(topic.id)}>{collapsed.has(topic.id) ? "▸" : "▾"}</button> : <span className="tree-spacer" />}
        <button className={`topic-card ${selectedId === topic.id ? "selected" : ""}`} onClick={() => onSelect(topic.id)}>
          <span className="topic-card-kind">{isTopicGroup(topic) ? depth === 0 ? "Root · 큰 그림" : `Sub ${depth} · 관리` : "말단 · 실행"}</span>
          <span className="topic-card-title">{topic.title}</span>
          <span className="topic-card-meta">{ENTRY_COPY[workEntry(topic).mode].label}</span>
          {!isTopicGroup(topic) && status?.(topic)}
          {isTopicGroup(topic) && summary.size > 0 && <span className="topic-status-summary" aria-label="접힌 하위 작업 상태">
            {[...summary.values()].map(entry => <span key={entry.topic.state}>{status?.(entry.topic)}{entry.count > 1 && <small> ×{entry.count}</small>}</span>)}
          </span>}
          {isTopicGroup(topic) ? <span className="topic-card-progress">{leaves ? `말단 ${closed}/${leaves} 종료` : "하위 주제 준비 중"}</span>
            : <span className="topic-card-meta">{topic.state === "CLOSED" ? "종료" : `계획 ${topic.planRevision}판 · 범위 ${topic.scopeGeneration}세대`}</span>}
        </button>
      </div>
      {children.length > 0 && !collapsed.has(topic.id) && render(children, depth + 1)}
    </li>;
  })}</ul>;
  return <nav className="topic-tree" aria-label="주제 계층">{render(forest, 0)}</nav>;
}

export function TopicOverview({ topic, topics, onSelect }: { topic: Topic; topics: Topic[]; onSelect: (id: string) => void }) {
  const entry = workEntry(topic), copy = ENTRY_COPY[entry.mode], group = isTopicGroup(topic);
  const ancestors = topicAncestors(topic, topics);
  const steps: readonly string[] = group ? [...copy.steps.slice(0, -2), "하위 주제 관리"] : copy.steps;
  const implementing = ["IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX", "CODEX_FINAL_REVIEW", "READY_TO_DELIVER", "CLOSED"].includes(topic.state);
  const index = group ? entry.goal ? steps.length - 1 : 0 : implementing ? steps.length - 1 : entry.goal ? steps.length - 2 : 0;
  return <section className="topic-overview" aria-label="주제 목표와 진행 방식">
    {ancestors.length > 0 && <nav className="topic-breadcrumb" aria-label="상위 주제">{ancestors.map((parent, i) =>
      <span key={parent.id}><button onClick={() => onSelect(parent.id)}>{i === 0 ? "Root" : `Sub ${i}`} · {parent.title}</button><span aria-hidden="true"> › </span></span>)}<span>{topic.title}</span></nav>}
    <div className="entry-mode-label"><strong>{copy.label}</strong><span>{group ? "관리 주제" : "말단 실행 주제"}</span></div>
    <ol className="entry-steps">{steps.map((step, i) => <li key={step} className={i < index ? "done" : i === index ? "current" : ""} aria-current={i === index ? "step" : undefined}><span>{i < index ? "✓" : i + 1}</span>{step}</li>)}</ol>
    {entry.goal ? <details className="topic-goal" open><summary>Goal</summary><p>{entry.goal}</p></details>
      : <p className="entry-pending">{entry.mode === "sources" ? "원문을 확인한 뒤 중재 세션에서 Goal을 확정합니다." : "중재 세션에서 논의 결과를 Goal로 정합니다."}</p>}
    {group && <p className="hierarchy-note">큰 그림과 하위 주제를 관리합니다. 계획·구현은 말단 주제에서 진행합니다.</p>}
    <small className="entry-origin">지시·Goal 변경은 Claude 또는 Codex 중재 세션에서 · 자율중재 ON</small>
  </section>;
}
