import { MediationStatus } from "./components/MediationStatus";
import { PipelineEditor } from "./PipelineEditor";
import { SessionGraph, GraphInspector } from "./SessionGraph";
import type { GraphNode } from "../shared/sessionGraph";
import {ReviewPanel} from "./ReviewPanel";
import { EvidencePanel } from "./EvidencePanel";
import { RevisionPanel } from "./RevisionPanel";
import { WorkGroupsPanel } from "./WorkGroupsPanel";
import { BudgetPanel } from "./BudgetPanel";
import { EntryGuide, TopicOverview, TopicTree } from "./TopicStructure";
import { isTopicGroup, workEntry, topicAncestors } from "../shared/topicStructure";
import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentExecutionSettings,
  AgentRole,
  ClientConfig,
  Finding,
  JobRouteView,
  MessageKind,
  Participant,
  RoutingView,
  TimelineEvent,
  Topic,
  TopicActivity,
  TopicDetail,
  WorkflowState,
} from "../shared/contracts";
import { ApiError, api, topicEventsUrl } from "./api";
import type { WorkGroupView } from "../shared/workGroups";

const STATE_COPY: Record<WorkflowState, { label: string; tone: StatusTone; hint: string }> = {
  BRAINSTORM_READY: { label: "논의 대기", tone: "attention", hint: "AI가 한 번씩 의견을 낸 뒤 멈춥니다. 다음 행동은 사용자가 선택합니다." },
  BRAINSTORMING: { label: "논의 중", tone: "working", hint: "무작위로 정한 순서에 따라 두 참여자가 의견을 나누고 있습니다." },
  DRAFT: { label: "준비 중", tone: "quiet", hint: "작성자·검토자 좌석 세션을 연결해 주세요." },
  // 상태 값(CLAUDE_PLAN 등)은 호환용 이름이다 — 실제로 실행하는 AI 는 역할 배정이 정하므로 문구는 역할로 쓴다(E2c C3).
  CLAUDE_PLAN: { label: "계획 작성", tone: "working", hint: "설계자가 첫 계획을 작성하고 있습니다." },
  CODEX_AUDIT: { label: "계획 검토", tone: "working", hint: "검토자가 계획의 빈틈과 근거를 확인하고 있습니다." },
  CLAUDE_REVISION: { label: "계획 수정", tone: "working", hint: "검토 결과를 반영해 계획을 고치고 있습니다." },
  CODEX_CLOSEOUT: { label: "계획 최종 확인", tone: "working", hint: "합의할 수 있는 계획인지 마지막으로 확인합니다." },
  CONSENSUS_ACK: { label: "계획 해시 확인", tone: "working", hint: "두 좌석이 같은 계획을 읽었는지 확인합니다." },
  AWAITING_USER_APPROVAL: { label: "승인 대기", tone: "attention", hint: "계획을 읽고 직접 승인해야 구현을 시작할 수 있습니다." },
  IMPLEMENTING: { label: "구현", tone: "working", hint: "승인된 계획 범위 안에서 구현자가 코드를 고치고 있습니다." },
  CODEX_REVIEW: { label: "코드 검토", tone: "working", hint: "검토자가 변경 내용을 읽기 전용으로 검토하고 있습니다." },
  CLAUDE_FIX: { label: "보완", tone: "working", hint: "구현자가 합의된 범위 안의 확정 문제를 한 번 보완합니다." },
  CODEX_FINAL_REVIEW: { label: "마무리 검토", tone: "working", hint: "검토자가 보완된 결과를 마지막으로 확인합니다." },
  READY_TO_DELIVER: { label: "전달 준비 완료", tone: "success", hint: "검증 결과를 확인한 뒤 커밋할 수 있습니다." },
  CLOSED: { label: "종료", tone: "success", hint: "이 주제의 작업이 끝났습니다." },
  BLOCKED_ON_EVIDENCE: { label: "증거 필요", tone: "danger", hint: "결론을 내려면 추가 자료나 실행 결과가 필요합니다." },
  USER_DECISION_REQUIRED: { label: "결정 필요", tone: "danger", hint: "범위나 정책을 사용자가 정해야 계속할 수 있습니다." },
  FAILED: { label: "실행 실패", tone: "danger", hint: "오류 내용을 확인한 뒤 다시 시도해 주세요." },
};

const MESSAGE_COPY: Record<Exclude<MessageKind, "agent_output" | "system">, string> = {
  note: "참고",
  scope_change: "범위 변경",
  evidence: "새 증거",
  decision: "결정",
};

// 발화자 — 좌석(claude·codex)은 역할 좌석이다. 실제 실행 AI 는 이벤트에 경로가 기록된 경우에만 붙인다(actorLabel).
const ACTOR_COPY: Record<AgentRole, string> = {
  claude: "작성자",
  codex: "검토자",
  system: "중앙 진행자",
  user: "나",
};

// 역할과 실제 실행 AI(E2c C3). 좌석 이름에서 실제 AI 를 유도하지 않는다 — 경로·세션 바인딩(detail.routing)이나 이벤트의 경로 기록에서만 읽는다.
type Provider = "claude" | "codex";
type Seat = "claude" | "codex";
const PROVIDER_COPY: Record<Provider, string> = { claude: "Claude", codex: "Codex" };
const ROLE_COPY: Record<JobRouteView["role"], string> = { planner: "설계자", implementer: "구현자", reviewer: "검토자" };
const SEAT_COPY: Record<Seat, string> = { claude: "작성자", codex: "검토자" };
// routing 이 없는 과거 응답에서만 쓰는 좌석의 기본 공급자(E2b 이전의 고정 대응).
const DEFAULT_SEAT_PROVIDER: Record<Seat, Provider> = { claude: "claude", codex: "codex" };
// 좌석이 지금 실행 중이거나 다음에 열 작업의 경로 — 단계별 작업은 서버가 엔진 호출 지점과 같은 표로 정한 값(routing.current)만 쓴다(화면이 추정하지 않는다).
function seatRoute(routing: RoutingView | undefined, seat: Seat): JobRouteView | undefined {
  const job = routing?.current[seat === "claude" ? "author" : "reviewer"];
  return job ? routing?.jobs.find((entry) => entry.role === job.role && entry.operation === job.operation) : undefined;
}

function basisCopy(basis: NonNullable<JobRouteView["route"]>["basis"]): string {
  return basis.kind === "default" ? "기본 배정" : `배정 ${basis.scope} v${basis.version}`;
}

// 타임라인 발화자 — 이벤트에 경로(E2b 부터 agent_output 의 payload.route)가 있으면 역할과 실제 AI 를, 없으면 좌석 역할만 쓴다(추측한 AI 를 붙이지 않는다).
function actorLabel(event: TimelineEvent): string {
  const route = event.payload.route as { provider?: unknown; job?: { role?: unknown; operation?: unknown } } | undefined;
  const provider = route?.provider;
  const role = route?.job?.role;
  if ((provider === "claude" || provider === "codex") && (role === "planner" || role === "implementer" || role === "reviewer")) {
    return `${route?.job?.operation === "brainstorm" ? `논의 참여자 ${role === "planner" ? 1 : 2}` : ROLE_COPY[role]} · ${PROVIDER_COPY[provider]}`;
  }
  return ACTOR_COPY[event.actor];
}

type StatusTone = "quiet" | "working" | "attention" | "success" | "danger";
type Dialog = "create" | "claude" | "codex" | null;

const ACTIVE_STATES = new Set<WorkflowState>([
  "BRAINSTORMING",
  "CLAUDE_PLAN",
  "CODEX_AUDIT",
  "CLAUDE_REVISION",
  "CODEX_CLOSEOUT",
  "CONSENSUS_ACK",
  "IMPLEMENTING",
  "CODEX_REVIEW",
  "CLAUDE_FIX",
  "CODEX_FINAL_REVIEW",
]);

const WORKING_STATES = new Set<WorkflowState>([
  "BRAINSTORMING",
  "CLAUDE_PLAN", "CODEX_AUDIT", "CLAUDE_REVISION", "CODEX_CLOSEOUT", "CONSENSUS_ACK",
  "IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX", "CODEX_FINAL_REVIEW",
]);

// 러너 생존 표시: 작업 트리에서 마지막으로 바뀐 파일과 그 시각. 10분 넘게 조용하면 주의 색.
function ActivityBadge({ activity }: { activity: TopicActivity }) {
  if (!activity.lastChangeAt) return <span className="activity-badge quiet">러너 활동 기록 없음</span>;
  const ageSeconds = Math.max(0, Math.round((Date.parse(activity.checkedAt) - Date.parse(activity.lastChangeAt)) / 1000));
  const age = ageSeconds < 60 ? `${ageSeconds}초 전` : ageSeconds < 3600 ? `${Math.round(ageSeconds / 60)}분 전` : `${Math.round(ageSeconds / 360) / 10}시간 전`;
  const file = activity.lastChangedPath ?? "";
  const shortFile = file.length > 48 ? `…${file.slice(-47)}` : file;
  const stale = ageSeconds > 600;
  return (
    <span
      className={`activity-badge ${stale ? "stale" : "live"}`}
      title={`${activity.runningAction ? "실행 중 액션 있음" : "실행 중 액션 없음"} · 마지막 변경 ${activity.lastChangeAt} · ${file}${activity.truncated ? " · (스캔 상한 도달)" : ""}`}
    >
      {activity.runningAction ? "러너 활동" : "러너 없음"} {age}{shortFile ? ` · ${shortFile}` : ""}
    </span>
  );
}

function StatusBadge({ state }: { state: WorkflowState }) {
  const copy = STATE_COPY[state];
  const working = ACTIVE_STATES.has(state);
  return (
    <span className={`status-badge status-${copy.tone}${working ? " status-working" : ""}`}>
      {working && <span aria-hidden="true" className="working-spinner" />}
      {copy.label}
    </span>
  );
}

function EmptyPanel({ children }: { children: ReactNode }) {
  return <div className="empty-panel">{children}</div>;
}

function shortHash(hash: string | null): string {
  return hash ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : "아직 없음";
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function parseFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is Finding => {
    if (!candidate || typeof candidate !== "object") return false;
    const finding = candidate as Partial<Finding>;
    return Boolean(finding.id && finding.title && finding.severity && finding.rationale);
  });
}

function parseMemoryChanges(value: unknown): Array<{ path: string; sha256: string; status: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const change = candidate as Record<string, unknown>;
    if (typeof change.path !== "string" || typeof change.sha256 !== "string" || typeof change.status !== "string") return [];
    return [{ path: change.path, sha256: change.sha256, status: change.status }];
  });
}

function extractFindings(detail: TopicDetail | null): Finding[] {
  if (!detail) return [];
  const byID = new Map<string, Finding>();
  for (const finding of parseFindings(detail.consensus?.findings)) byID.set(finding.id, finding);
  for (const event of detail.timeline) {
    for (const finding of parseFindings(event.payload.findings)) byID.set(finding.id, finding);
  }
  return [...byID.values()];
}

// 닫힌 단계라도 미전달 결과가 남았으면 우측 원문 근거 검수는 계속 제공한다.
interface StageDeliveryView { closedPush: boolean }
function stageDeliveryOf(groups: readonly WorkGroupView[], topicId: string): StageDeliveryView {
  for (const group of groups) {
    const stageId = Object.keys(group.links).find((id) => group.links[id].topicId === topicId);
    if (!stageId) continue;
    const result = group.results?.[stageId];
    const delivery = group.delivery[stageId];
    return {
      closedPush: Boolean(result && result.topicId === topicId && delivery?.committedOID === result.commitOID && delivery.pushedOID !== result.commitOID),
    };
  }
  return { closedPush: false };
}

function participantFor(topic: Topic, role: "claude" | "codex"): Participant | undefined {
  return topic.participants.find((participant) => participant.role === role);
}

export function App() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [centerTab, setCenterTab] = useState<"graph" | "conversation">("graph");
  const [pipelineEditing, setPipelineEditing] = useState(false);
  const [graphRevision, setGraphRevision] = useState(0);
  const [settingsGraphRevision, setSettingsGraphRevision] = useState(0);
  const [graphSelection, setGraphSelection] = useState<{ scope: string; node: GraphNode } | null>(null);
  const [evidenceTopicId, setEvidenceTopicId] = useState<string | null>(null);
  const [clientConfig, setClientConfig] = useState<ClientConfig | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TopicDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice,setActionNotice]=useState<string|null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mobilePanel, setMobilePanel] = useState<"topics" | "chat" | "plan">("chat");
  const [activity, setActivity] = useState<TopicActivity | null>(null);
  const [stageDelivery, setStageDelivery] = useState<({ topicId: string } & StageDeliveryView) | null>(null);
  const reconnectRef = useRef(0);
  const selectedTopicRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);

  useEffect(() => {
    selectedTopicRef.current = selectedTopicId;
    setActionNotice(null);
    detailRequestRef.current += 1;
  }, [selectedTopicId]);

  const topicsRequestRef = useRef(0);
  const refreshTopics = useCallback(async () => {
    const requestID = ++topicsRequestRef.current;
    try {
      const nextTopics = await api.listTopics();
      if (requestID !== topicsRequestRef.current) return;
      setTopics(current => nextTopics.map(topic => {
        const observed = current.find(item => item.id === topic.id);
        return observed && observed.updatedAt > topic.updatedAt ? observed : topic;
      }));
      setSelectedTopicId((current) => current ?? nextTopics.find(topic => !topic.parentTopicId)?.id ?? null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshDetail = useCallback(async (topicId: string, afterSequence = 0) => {
    const requestID = ++detailRequestRef.current;
    try {
      const next = await api.getTopic(topicId, afterSequence);
      if (selectedTopicRef.current !== topicId || detailRequestRef.current !== requestID) return;
      setDetail((current) => {
        if (current?.topic.id !== topicId) return next;
        // A full GET can have started before a newer SSE event. Never replace the
        // already-observed timeline with that older server snapshot.
        const timeline = new Map(current.timeline.map((event) => [event.sequence, event]));
        for (const event of next.timeline) timeline.set(event.sequence, event);
        return { ...next, timeline: [...timeline.values()].sort((left, right) => left.sequence - right.sequence) };
      });
      setTopics((current) =>
        current.map((topic) => (topic.id === topicId ? next.topic : topic)),
      );
      setError(null);
    } catch (cause) {
      if (selectedTopicRef.current === topicId && detailRequestRef.current === requestID) {
        setError(errorMessage(cause));
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false, timer: number | undefined;
    const poll = async () => {
      if (!document.hidden) await refreshTopics();
      if (!cancelled) timer = window.setTimeout(poll, 10_000);
    };
    void refreshTopics().finally(() => { if (!cancelled) timer = window.setTimeout(poll, 10_000); });
    return () => { cancelled = true; window.clearTimeout(timer); topicsRequestRef.current++; };
  }, [refreshTopics]);

  // 러너 생존 표시 — 에이전트가 도는 상태에서만 10초마다 작업 트리 최근 변경을 읽는다.
  useEffect(() => {
    const state = detail?.topic.id === selectedTopicId ? detail.topic.state : null;
    // FAILED 도 읽는다 — 사용 한도(429) 자동 재시도 예약 시각(autoRetryAt)을 보여 주기 위해서다.
    if (!selectedTopicId || !state) { setActivity(null); return; }
    setActivity(null);
    let cancelled = false;
    const load = () => api.getActivity(selectedTopicId).then((next) => {
      if (!cancelled) setActivity(next);
    }).catch(() => { /* 생존 표시는 부가 정보라 실패해도 화면을 막지 않는다 */ });
    void load();
    const timer = window.setInterval(() => { void load(); }, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedTopicId, detail?.topic.id, detail?.topic.state]);

  // 묶음 단계의 전달 진입 판정 — 선택한 토픽이 전달 준비(READY_TO_DELIVER)나 CLOSED 가 될 때 한 번, 전달 동작(commit·push·결과 확인) 뒤에 다시 읽는다.
  // 읽지 못하면 진입을 닫는다(최종 판정은 서버 몫이다).
  const refreshStageDelivery = useCallback(async (topicId: string) => {
    let view: StageDeliveryView = { closedPush: false };
    try { view = stageDeliveryOf(await api.listWorkGroups(), topicId); } catch { /* 진입만 닫는다 */ }
    if (selectedTopicRef.current === topicId) setStageDelivery({ topicId, ...view });
  }, []);
  useEffect(() => {
    const state = detail?.topic.id === selectedTopicId ? detail.topic.state : null;
    if (!selectedTopicId || (state !== "CLOSED" && state !== "READY_TO_DELIVER")) { setStageDelivery(null); return; }
    void refreshStageDelivery(selectedTopicId);
  }, [selectedTopicId, detail?.topic.id, detail?.topic.state, refreshStageDelivery]);

  useEffect(() => {
    let cancelled = false;
    void api.getConfig().then((config) => {
      if (!cancelled) setClientConfig(config);
    }).catch((cause) => {
      if (!cancelled) setError(errorMessage(cause));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedTopicId) {
      setDetail(null);
      return;
    }
    setDetail((current) => current?.topic.id === selectedTopicId ? current : null);
    void refreshDetail(selectedTopicId);
  }, [refreshDetail, selectedTopicId]);

  useEffect(() => {
    if (!selectedTopicId || detail?.topic.id !== selectedTopicId) return;
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let pollTimer: number | undefined;
    let closed = false;
    let lastSequence = detail.timeline.at(-1)?.sequence ?? 0;
    let refreshQueued = false;
    let refreshTimer: number | undefined;

    const poll = () => {
      window.clearInterval(pollTimer);
      pollTimer = window.setInterval(() => void refreshDetail(selectedTopicId), 5_000);
    };

    const connect = () => {
      if (closed) return;
      source = new EventSource(topicEventsUrl(selectedTopicId, lastSequence), { withCredentials: true });
      source.onopen = () => {
        reconnectRef.current = 0;
        window.clearInterval(pollTimer);
      };
      source.addEventListener("timeline", (raw) => {
        let parsed: TimelineEvent | null = null;
        try {
          parsed = JSON.parse((raw as MessageEvent<string>).data) as TimelineEvent;
          lastSequence = Math.max(lastSequence, parsed.sequence);
          setDetail((current) => {
            if (!current || current.topic.id !== selectedTopicId || current.timeline.some((event) => event.sequence === parsed?.sequence)) return current;
            return { ...current, timeline: [...current.timeline, parsed!] };
          });
        } catch { /* 서버 catch-up 조회가 최종 정본이다. */ }
        if (refreshQueued) return;
        refreshQueued = true;
        refreshTimer = window.setTimeout(() => {
          refreshQueued = false;
          if (!closed) void refreshDetail(selectedTopicId, lastSequence);
        }, 100);
      });
      source.onerror = () => {
        source?.close();
        reconnectRef.current += 1;
        poll();
        const delay = Math.min(1_000 * 2 ** reconnectRef.current, 15_000);
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      source?.close();
      window.clearTimeout(retryTimer);
      window.clearInterval(pollTimer);
      window.clearTimeout(refreshTimer);
    };
  }, [detail?.topic.id, refreshDetail, selectedTopicId]);

  const run = useCallback(
    async (name: string, operation: () => Promise<unknown>): Promise<boolean> => {
      const targetTopicId = selectedTopicId;
      setBusyAction(name);
      setError(null);
      try {
        const response=await operation();
        setDialog(null);
        await refreshTopics();
        if (targetTopicId && selectedTopicRef.current === targetTopicId) {
          await refreshDetail(targetTopicId);
          if (["plan", "retry", "stop"].includes(name)) {
            const next = await api.getActivity(targetTopicId).catch(() => null);
            if (next && selectedTopicRef.current === targetTopicId) setActivity(next);
          }
          if ((name === "commit" || name === "push" || name === "reconcile-delivery") && selectedTopicRef.current === targetTopicId) {
            await refreshStageDelivery(targetTopicId);
          }
          if(selectedTopicRef.current===targetTopicId)setActionNotice(response && typeof response==="object" && "resumeBlocked" in response && typeof response.resumeBlocked==="string"?response.resumeBlocked:null);
        }
        return true;
      } catch (cause) {
        setError(errorMessage(cause));
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [refreshDetail, refreshStageDelivery, refreshTopics, selectedTopicId],
  );

  const selected = detail?.topic.id === selectedTopicId ? detail.topic : null;
  const findings = useMemo(() => extractFindings(detail), [detail]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">CR</div>
          <div>
            <strong>Consensus Room</strong>
            <span>계획은 함께 합의하고, 구현은 승인 뒤에 시작합니다.</span>
          </div>
        </div>
        {selected && (
          <div className="topbar-state">
            <StatusBadge state={selected.state} />
            <span>{STATE_COPY[selected.state].hint}</span>
            {activity && WORKING_STATES.has(selected.state) && <ActivityBadge activity={activity} />}
            {activity?.autoRetryAt && selected.state === "FAILED" && (
              <span className="activity-badge live" title={`사용 한도(429) 리셋 뒤 엔진이 같은 세션을 자동 재시도합니다: ${activity.autoRetryAt}`}>
                자동 재시도 예약 {new Date(activity.autoRetryAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </div>
        )}
      </header>

      <nav className="mobile-tabs" aria-label="화면 영역">
        <button className={mobilePanel === "topics" ? "active" : ""} onClick={() => setMobilePanel("topics")}>주제</button>
        <button className={mobilePanel === "chat" ? "active" : ""} onClick={() => setMobilePanel("chat")}>Graph·대화</button>
        <button className={mobilePanel === "plan" ? "active" : ""} onClick={() => setMobilePanel("plan")}>계획·근거</button>
      </nav>

      {actionNotice && <div role="status" className="error-banner">{actionNotice}</div>}
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="오류 안내 닫기">닫기</button>
        </div>
      )}

      <main className="workspace">
        <aside className={`topics-pane mobile-${mobilePanel}`}>
          <div className="pane-heading">
            <div>
              <p className="eyebrow">TOPICS</p>
              <h1>주제</h1>
            </div>
            <button className="icon-button" onClick={() => setDialog("create")} aria-label="작업 시작 방식 안내">+</button>
          </div>
          <div className="topic-list">
            {loading ? (
              <div className="skeleton-list" aria-label="주제를 불러오는 중"><i /><i /><i /></div>
            ) : topics.length === 0 ? (
              <EmptyPanel>
                <strong>아직 주제가 없습니다.</strong>
                <span>Claude 또는 Codex 중재 세션에서 첫 주제를 시작하세요.</span>
                <button className="primary-button" onClick={() => setDialog("create")}>작업 시작 방식 보기</button>
              </EmptyPanel>
            ) : (
              <TopicTree topics={topics} status={topic => <StatusBadge state={topic.state} />} selectedId={selectedTopicId} onSelect={id => { setSelectedTopicId(id); setMobilePanel("chat"); }} />
            )}
          </div>
          <WorkGroupsPanel unparentedOnly onTopic={id => { void refreshTopics(); setSelectedTopicId(id); setMobilePanel("chat"); }} />
        </aside>

        <section className={`chat-pane mobile-${mobilePanel}`}>
          {selected && detail ? (
            <>
              <div className="room-header">
                <div className="room-title-row"><h2>{selected.title}</h2><StatusBadge state={selected.state} /></div>
              </div>
              <MediationStatus activity={activity} />
              <div className="center-navigation">
                <div className="center-tabs" role="tablist" aria-label="작업 보기">
                  <button id="graph-tab" role="tab" aria-controls="graph-panel" aria-selected={centerTab === "graph"} onClick={() => setCenterTab("graph")}>Graph</button>
                  <button id="conversation-tab" role="tab" aria-controls="conversation-panel" aria-selected={centerTab === "conversation"} onClick={() => setCenterTab("conversation")}>대화창</button>
                </div>
                <ExecutionControls topic={selected} busyAction={busyAction} autoRetryAt={activity?.autoRetryAt ?? null}
                  evidenceResumePending={activity?.evidenceResumePending ?? false}
                  continuation={activity?.continuation ?? null}
                  budgetPaused={Boolean(activity?.budget?.pause || activity?.budgetRecoveryRequired || activity?.revisionPaused || activity?.reviewPaused)}
                  onAction={(action, body) => void run(action, () => api.runAction(selected.id, action, body))} />
              </div>
              {centerTab === "graph" ? <div className="center-content" id="graph-panel" role="tabpanel" aria-labelledby="graph-tab">
                {pipelineEditing ? <PipelineEditor key={selected.id} topicId={selected.id} title={selected.title} goal={selected.workEntry?.goal ?? selected.title}
                  topicIds={topics.filter(topic => topic.id === selected.id || topicAncestors(topic, topics).some(parent => parent.id === selected.id)).map(topic => topic.id)}
                  canCreate={isTopicGroup(selected)} onDone={() => { setPipelineEditing(false); setGraphRevision(value => value + 1); void refreshTopics(); }} /> :
                <SessionGraph key={`${selected.id}:${graphRevision}`} topicId={selected.id} refreshVersion={settingsGraphRevision} onEdit={() => { setGraphSelection(null); setPipelineEditing(true); }} onEvidence={() => setEvidenceTopicId(selected.id)} selectedNodeId={graphSelection?.scope === selected.id ? graphSelection.node.id : undefined}
                  onSelect={(node, reveal) => { setGraphSelection(node ? { scope: selected.id, node } : null); if (node && reveal && window.innerWidth <= 820) setMobilePanel("plan"); }} />}
              </div> : <div className="center-content" id="conversation-panel" role="tabpanel" aria-labelledby="conversation-tab"><Timeline events={detail.timeline} /></div>}
            </>
          ) : (
            <EmptyPanel>
              <strong>왼쪽에서 주제를 선택해 주세요.</strong>
              <span>큰 그림 주제 아래에서 실행 작업과 각 세션의 진행 상황을 확인합니다.</span>
            </EmptyPanel>
          )}
        </section>

        <aside className={`inspector-pane mobile-${mobilePanel}`}>
          {selected && detail ? (
            <Inspector
              detail={detail}
              findings={findings}
              busyAction={busyAction}
              onAction={(action, body) => void run(action, () => api.runAction(selected.id, action, body))}
              overview={<TopicOverview topic={selected} topics={topics} onSelect={setSelectedTopicId} />}
              controls={<>
                <GraphInspector node={graphSelection?.scope === selected.id ? graphSelection.node : null} currentTopicId={selected.id} onSettingsSaved={() => setSettingsGraphRevision(value => value + 1)}
                  onTopic={id => { setSelectedTopicId(id); setCenterTab("graph"); setMobilePanel("chat"); }}
                  onEvidence={id => { setSelectedTopicId(id); setEvidenceTopicId(id); }} />
                {isTopicGroup(selected) && <WorkGroupsPanel key={graphRevision}
                  topicIds={topics.filter(topic => topic.id === selected.id || topicAncestors(topic, topics).some(parent => parent.id === selected.id)).map(topic => topic.id)}
                  onTopic={id => { void refreshTopics(); setSelectedTopicId(id); setMobilePanel("chat"); }} />}
              </>}
            >
              {activity && <BudgetPanel account={activity.budget ?? null} busy={Boolean(busyAction) || activity.runningAction}
                recoveryRequired={activity.budgetRecoveryRequired ?? false}
                onSubmit={(action,body)=>void run(action,async()=>{ const result=await api.runAction(selected.id,action,body as Record<string,unknown>);const next=await api.getActivity(selected.id);if(selectedTopicRef.current===selected.id)setActivity(next);return result; })}/>}
              {activity?.revisionAllowance && <RevisionPanel account={activity.revisionAllowance} paused={activity.revisionPaused ?? false}
                busy={Boolean(busyAction) || activity.runningAction}
                onConfigure={(limit,version)=>void run("revision-limit",async()=>{await api.configureIterations(selected.id,"revision",limit,version);const next=await api.getActivity(selected.id);if(selectedTopicRef.current===selected.id)setActivity(next);})}
                onGrant={()=>void run("revision-resume",async()=>{const result=await api.runAction(selected.id,"revision-resume",{version:activity.revisionAllowance!.version});const next=await api.getActivity(selected.id);if(selectedTopicRef.current===selected.id)setActivity(next);return result;})}/>}
              {activity?.reviewAllowances && <ReviewPanel accounts={activity.reviewAllowances} paused={activity.reviewPaused??null}
                onConfigure={(scope,limit,version)=>void run("review-limit",async()=>{await api.configureIterations(selected.id,scope,limit,version);const next=await api.getActivity(selected.id);if(selectedTopicRef.current===selected.id)setActivity(next);})}
                busy={Boolean(busyAction) || activity.runningAction} onGrant={(scope,version)=>void run("review-resume",async()=>{const result=await api.runAction(selected.id,"review-resume",{scope,version});const next=await api.getActivity(selected.id);if(selectedTopicRef.current===selected.id)setActivity(next);return result;})}/>}
              {activity?.planningProgress && <section className="panel" aria-label="계획 조사 진행">
                <h3>계획 조사 {activity.planningProgress.round}회 · {activity.planningProgress.finalized ? "최종 결과 저장" : "중간 결과 저장"}</h3>
                <p>누적 입력 {activity.planningProgress.usage.inputTokens.toLocaleString()} 토큰 · 캐시 읽기 {activity.planningProgress.usage.cachedInputTokens.toLocaleString()} 토큰</p>
                <p>누적 입력은 현재 문맥 크기나 과금액이 아닙니다.</p>
                <p>관측한 요청별 최대 입력: {activity.planningProgress.peakRequestInputTokens?.toLocaleString() ?? "측정값 없음"} · 전달한 텍스트 {activity.planningProgress.injectedBytes.toLocaleString()}바이트</p>
                <p>전달한 자료 {activity.planningProgress.deliveredFragments}개 · 남은 질문 {activity.planningProgress.questions.length}개</p>
                {activity.planningProgress.stopped && <p role="status">{activity.planningProgress.stopped}</p>}
              </section>}
            </Inspector>
          ) : (
            <EmptyPanel>
              <strong>계획과 근거</strong>
              <span>주제를 선택하면 합의된 계획, 발견 사항, 세션 정보를 볼 수 있습니다.</span>
            </EmptyPanel>
          )}
        </aside>
      </main>

      {evidenceTopicId && detail?.topic.id === evidenceTopicId && <Modal title="원문 연결·검수 관리" description="그래프에 표시할 원문과 검수 상태를 관리합니다." onClose={() => setEvidenceTopicId(null)}>
        <EvidencePanel key={evidenceTopicId} topicId={evidenceTopicId} busy={Boolean(busyAction) || Boolean(activity?.runningAction)} archived={detail.topic.state === "CLOSED"}
          archivedReviewRequired={stageDelivery?.topicId === evidenceTopicId && stageDelivery.closedPush} />
      </Modal>}
      {dialog === "create" && (
        <Modal title="중재 세션에서 작업 시작" description="세 가지 방식 중 현재 작업에 맞는 출발점을 중재자에게 전달하세요." onClose={() => setDialog(null)}>
          <EntryGuide />
        </Modal>
      )}
      {(dialog === "claude" || dialog === "codex") && selected && (
        <SessionDialog
          role={dialog}
          route={seatRoute(detail?.routing, dialog)?.route ?? null}
          existing={participantFor(selected, dialog)}
          settings={selected.agentSettings[dialog]}
          canChangeSession={["DRAFT", "BRAINSTORM_READY"].includes(selected.state)}
          busy={busyAction === `session-${dialog}` || busyAction === `settings-${dialog}`}
          onClose={() => setDialog(null)}
          onSessionSubmit={(input) =>
            run(`session-${dialog}`, () => api.attachParticipant(selected.id, dialog, input))
          }
          onSettingsSubmit={(input) =>
            run(`settings-${dialog}`, () => api.updateAgentSettings(selected.id, dialog, input))
          }
        />
      )}

    </div>
  );
}

function ExecutionControls({
  topic,
  busyAction,
  autoRetryAt,
  evidenceResumePending,
  continuation,
  budgetPaused,
  onAction,
}: {
  topic: Topic;
  busyAction: string | null;
  // FAILED 상태에 예약된 사용 한도 자동 재시도 시각 — 있으면 '예약 취소'(stop) 를 제공한다.
  autoRetryAt: string | null;
  evidenceResumePending: boolean;
  continuation: { pending: boolean; step: string; error: string | null } | null;
  budgetPaused: boolean;
  onAction: (action: string, body?: Record<string, unknown>) => void;
}) {
  const claude = participantFor(topic, "claude");
  const codex = participantFor(topic, "codex");
  const canStart = !isTopicGroup(topic) && Boolean(workEntry(topic).goal) && topic.state === "DRAFT" && Boolean(claude && codex);
  const pendingRetry = topic.state === "FAILED" && Boolean(autoRetryAt);
  const canStop = ACTIVE_STATES.has(topic.state) || pendingRetry || evidenceResumePending || continuation?.pending;
  const deliveryRecovery = topic.state === "USER_DECISION_REQUIRED" && topic.lastError?.includes("커밋 또는 push 도중");
  const canRetry = ["FAILED", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED"].includes(topic.state) && !deliveryRecovery && !budgetPaused;

  return (
    <section className="execution-controls" aria-label="작업 실행">
      {evidenceResumePending && <p role="status">근거 수집이 끝나면 자동으로 재개합니다.</p>}
      {continuation && <p role="status">{continuation.error ?? `자동 진행: ${{ evidence: "근거 검토", approve: "계획 승인 확인", implement: "구현과 리뷰", commit: "로컬 커밋", close: "단계 완료 확인", "next-plan": "다음 단계 계획" }[continuation.step] ?? continuation.step}`}</p>}
      <div className="room-actions">
        {topic.state === "BRAINSTORM_READY" ? (
          <BrainstormActions key={topic.id} connected={Boolean(claude && codex)} busy={Boolean(busyAction)} budgetPaused={budgetPaused} onAction={onAction} />
        ) : canStop ? (
          <button className="danger-button" disabled={Boolean(busyAction)} onClick={() => onAction("stop")}>{continuation?.pending ? "자동 진행 중지" : evidenceResumePending ? "자동 재개 취소" : pendingRetry ? "재시도 예약 취소" : "중단"}</button>
        ) : canRetry ? (
          <button className="secondary-button" disabled={Boolean(busyAction)} onClick={() => onAction("retry")}>다시 시도</button>
        ) : isTopicGroup(topic) ? <span className="entry-origin">하위 주제의 진행 상황을 관리합니다.</span> : (
          <button className="primary-button" disabled={!canStart || budgetPaused || Boolean(busyAction)} onClick={() => onAction("plan")}>합의 시작</button>
        )}
      </div>
    </section>
  );
}

function BrainstormActions({ connected, busy, budgetPaused, onAction }: {
  connected: boolean; busy: boolean; budgetPaused: boolean; onAction: (action: string, body?: Record<string, unknown>) => void;
}) {
  return <>
    <button className="primary-button" disabled={!connected || busy || budgetPaused} onClick={() => onAction("brainstorm")}>한 바퀴 논의</button>
    <span className="entry-origin">Goal 확정·계획 전환은 중재 세션에서 진행합니다.</span>
  </>;
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "nearest" }); }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="timeline timeline-empty">
        <EmptyPanel>
          <strong>아직 대화가 없습니다.</strong>
          <span>세션을 연결하고 합의를 시작하면 작업 기록이 시간순으로 쌓입니다.</span>
        </EmptyPanel>
      </div>
    );
  }

  return (
    <div className="timeline" aria-live="polite">
      {events.map((event) => (
        <article className={`message message-${event.actor}`} key={event.id}>
          <div className="message-meta">
            <span className={`actor-dot actor-${event.actor}`} aria-hidden="true" />
            <strong>{actorLabel(event)}</strong>
            <span>{event.kind === "agent_output" ? "작업 결과" : event.kind === "system" ? "진행 기록" : MESSAGE_COPY[event.kind]}</span>
            <time>{formatTime(event.createdAt)}</time>
          </div>
          <div className="message-body">{event.body}</div>
          {typeof event.payload.requestedUserDecision === "string" && (
            <p className="message-warning">결정할 내용: {event.payload.requestedUserDecision}</p>
          )}
          {parseFindings(event.payload.findings).map((finding) => (
            <p className="message-decision" key={finding.id}>
              {finding.id} · {finding.title} · {finding.disposition ?? "판정 중"}
            </p>
          ))}
          {parseMemoryChanges(event.payload.memoryChanges).map((change) => (
            <p className="message-memory" key={`${change.path}:${change.sha256}`}>
              메모리 {change.status === "written" ? "반영" : change.status === "rejected" ? "반영 안 됨" : "이미 반영됨"} · {change.path}{change.status === "rejected" ? "" : ` · ${shortHash(change.sha256)}`}
            </p>
          ))}
          {event.kind === "scope_change" && <p className="message-warning">범위 세대가 바뀌어 기존 계획 승인은 무효가 됩니다.</p>}
          {event.kind === "decision" && <p className="message-decision">이 결정은 다음 실행부터 적용됩니다.</p>}
        </article>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function Inspector({
  detail,
  findings,
  busyAction,
  onAction,
  overview,
  controls,
  children,
}: {
  detail: TopicDetail;
  findings: Finding[];
  busyAction: string | null;
  onAction: (action: string, body?: Record<string, unknown>) => void;
  overview: ReactNode;
  controls: ReactNode;
  children: ReactNode;
}) {
  const { topic } = detail;
  const claude = participantFor(topic, "claude");
  const codex = participantFor(topic, "codex");
  const bothAck = Boolean(
    topic.planSHA256 &&
    claude?.acknowledgedPlanSHA256 === topic.planSHA256 &&
    codex?.acknowledgedPlanSHA256 === topic.planSHA256,
  );
  const canApprove = topic.state === "AWAITING_USER_APPROVAL" && bothAck && Boolean(topic.planSHA256);
  const canImplement = topic.state === "AWAITING_USER_APPROVAL" && topic.approvedPlanSHA256 === topic.planSHA256;

  return (
    <div className="inspector-scroll">
      {overview}
      {controls}
      <details className="inspector-section execution-details">
        <summary>사용량·횟수 설정·계획 조사 기록</summary>
        {children}
      </details>
      <details className="inspector-section plan-section">
        <summary className="section-heading">
          <span>합의 계획</span>
          <span className="revision-pill">{topic.planRevision}판</span>
        </summary>
        <div className="hash-row">
          <span>SHA-256</span>
          <code title={topic.planSHA256 ?? ""}>{shortHash(topic.planSHA256)}</code>
        </div>
        <div className="ack-grid">
          <Ack role={seatSessionLabel(detail.routing, "claude")} participant={claude} planHash={topic.planSHA256} />
          <Ack role={seatSessionLabel(detail.routing, "codex")} participant={codex} planHash={topic.planSHA256} />
        </div>
        {detail.currentPlan ? <pre className="plan-preview">{detail.currentPlan}</pre> : <p className="muted-copy">아직 작성된 계획이 없습니다.</p>}
        {detail.previousPlan && detail.currentPlan && (
          <details className="plan-comparison">
            <summary>이전 계획과 나란히 보기</summary>
            <div className="plan-comparison-grid">
              <div><strong>이전 계획</strong><pre className="plan-preview">{detail.previousPlan}</pre></div>
              <div><strong>현재 계획</strong><pre className="plan-preview">{detail.currentPlan}</pre></div>
            </div>
          </details>
        )}
        {topic.state === "AWAITING_USER_APPROVAL" && (
          <div className="approval-card">
            <strong>{bothAck ? "두 에이전트가 같은 계획을 확인했습니다." : "두 에이전트의 계획 확인이 아직 끝나지 않았습니다."}</strong>
            <p>계획 해시가 바뀌면 이 승인은 자동으로 무효가 됩니다.</p>
            <div className="button-row">
              <button
                className="primary-button"
                disabled={!canApprove || Boolean(busyAction) || topic.approvedPlanSHA256 === topic.planSHA256}
                onClick={() => topic.planSHA256 && onAction("approve", { planSHA256: topic.planSHA256 })}
              >
                {topic.approvedPlanSHA256 === topic.planSHA256 ? "계획 승인됨" : "이 계획 승인"}
              </button>
              <button className="secondary-button" disabled={!canImplement || Boolean(busyAction)} onClick={() => onAction("implement")}>구현 시작</button>
            </div>
          </div>
        )}
      </details>

      <details className="inspector-section findings-section">
        <summary className="section-heading">
          <span>검토 쟁점</span>
          <span className="count-pill">{findings.length}</span>
        </summary>
        {findings.length === 0 ? <p className="muted-copy">아직 분류된 쟁점이 없습니다.</p> : (
          <div className="finding-list">
            {findings.map((finding) => (
              <article className="finding-card" key={finding.id}>
                <div className="finding-topline">
                  <code>{finding.id}</code>
                  <span className={`severity severity-${finding.severity.toLowerCase()}`}>{finding.severity}</span>
                </div>
                <strong>{finding.title}</strong>
                <p>{finding.rationale}</p>
                <span className="disposition">{finding.disposition ?? (finding.requiresUserDecision ? "사용자 결정 필요" : "판정 중")}</span>
              </article>
            ))}
          </div>
        )}
      </details>

    </div>
  );
}

function Ack({ role, participant, planHash }: { role: string; participant?: Participant; planHash: string | null }) {
  const acknowledged = Boolean(planHash && participant?.acknowledgedPlanSHA256 === planHash);
  return (
    <div className={`ack-item ${acknowledged ? "acknowledged" : ""}`}>
      <span>{role}</span>
      <strong>{acknowledged ? "같은 계획 확인" : participant ? "확인 대기" : "세션 없음"}</strong>
    </div>
  );
}

// 계획 확인 표의 좌석 이름 — 좌석 역할과, 그 좌석 세션을 실제로 만든 AI(바인딩)를 함께 쓴다.
function seatSessionLabel(routing: RoutingView | undefined, seat: Seat): string {
  const session = routing?.sessions.find((entry) => entry.seat === (seat === "claude" ? "author" : "plan-review"));
  const provider = routing ? session?.binding?.provider : DEFAULT_SEAT_PROVIDER[seat];
  return provider ? `${SEAT_COPY[seat]} · ${PROVIDER_COPY[provider]}` : SEAT_COPY[seat];
}

function Modal({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <button className="modal-close" onClick={onClose} aria-label="창 닫기">×</button>
        <p className="eyebrow">CONSENSUS ROOM</p>
        <h2 id="modal-title">{title}</h2>
        <p className="modal-description">{description}</p>
        {children}
      </section>
    </div>
  );
}

function SessionDialog({
  role,
  route,
  existing,
  settings,
  canChangeSession,
  busy,
  onClose,
  onSessionSubmit,
  onSettingsSubmit,
}: {
  role: "claude" | "codex";
  route: JobRouteView["route"];
  existing?: Participant;
  settings: AgentExecutionSettings;
  canChangeSession: boolean;
  busy: boolean;
  onClose: () => void;
  onSessionSubmit: (input: { mode: "new" } | { mode: "attach"; sessionId: string }) => void;
  onSettingsSubmit: (input: AgentExecutionSettings) => void;
}) {
  const [mode, setMode] = useState<"new" | "attach">("new");
  const [sessionId, setSessionId] = useState(existing?.sessionId ?? "");
  const [model, setModel] = useState(settings.model);
  const [effort, setEffort] = useState(settings.effort);
  // 구현 전용 오버라이드는 폼에 없으면 저장할 때마다 사라진다 — 서버는 implementation 이 빠진 요청을
  // "오버라이드 없음"으로 읽는다(2026-09-07: 웹에서 모델만 바꾸면 opus 구현 설정이 조용히 지워졌다).
  const [useImplementation, setUseImplementation] = useState(Boolean(settings.implementation));
  const [implementationModel, setImplementationModel] = useState(settings.implementation?.model ?? settings.model);
  const [implementationEffort, setImplementationEffort] = useState(settings.implementation?.effort ?? settings.effort);
  // 입력은 이 좌석의 기본 배정 공급자 설정(topic.agentSettings)이다 — 좌석이 배정 경로로 실행되면 그 사실을 알린다(E2c C3).
  const label = PROVIDER_COPY[DEFAULT_SEAT_PROVIDER[role]];
  const assignment = route && route.basis.kind === "assignment"
    ? ` 지금 이 좌석은 ${basisCopy(route.basis)}(프로필 ${route.profileId ?? "없음"}, ${PROVIDER_COPY[route.provider]})으로 실행됩니다 — 아래 설정은 배정이 없을 때(기본 배정)의 ${label} 설정입니다.`
    : "";
  return (
    <Modal title={`${SEAT_COPY[role]} 좌석 세션과 실행 설정`} description={`모델과 추론 강도를 바꿔도 세션 ID는 유지됩니다. 현재 호출은 그대로 끝나고 다음 호출부터 새 설정을 씁니다.${assignment}`} onClose={onClose}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSettingsSubmit({
            model,
            effort,
            ...(useImplementation
              ? { implementation: { model: implementationModel, effort: implementationEffort } }
              : {}),
          });
        }}
      >
        <label><span>{label} 모델</span><input required maxLength={120} value={model} onChange={(event) => setModel(event.target.value)} placeholder={role === "claude" ? "fable" : "gpt-6-astra"} /></label>
        <label>
          <span>{label} 추론 강도</span>
          <select value={effort} onChange={(event) => setEffort(event.target.value as AgentExecutionSettings["effort"])}>
            {(["low", "medium", "high", "xhigh", "max"] as const).map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={useImplementation}
            onChange={(event) => setUseImplementation(event.target.checked)}
          />
          <span>구현 단계에 다른 모델 사용</span>
        </label>
        {useImplementation && (
          <>
            <label><span>{label} 구현 모델</span><input required maxLength={120} value={implementationModel} onChange={(event) => setImplementationModel(event.target.value)} placeholder={role === "claude" ? "opus" : ""} /></label>
            <label>
              <span>{label} 구현 추론 강도</span>
              <select value={implementationEffort} onChange={(event) => setImplementationEffort(event.target.value as AgentExecutionSettings["effort"])}>
                {(["low", "medium", "high", "xhigh", "max"] as const).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <p className="form-hint">구현·수정 턴에만 쓰는 설정입니다. 계획 수렴은 위 설정으로 돕니다.</p>
          </>
        )}
        {existing && <p className="session-id-copy">현재 세션: <code>{existing.sessionId}</code></p>}
        <div className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>취소</button><button className="primary-button" disabled={busy || !model.trim() || (useImplementation && !implementationModel.trim())}>{busy ? "저장 중…" : "설정 저장"}</button></div>
      </form>
      {canChangeSession && (
        <form className="modal-form session-form" onSubmit={(event) => { event.preventDefault(); onSessionSubmit(mode === "new" ? { mode: "new" } : { mode: "attach", sessionId }); }}>
          <p className="form-section-title">세션 {existing ? "교체" : "연결"}</p>
          <div className="segmented-control">
            <button type="button" className={mode === "new" ? "selected" : ""} onClick={() => setMode("new")}>새 세션</button>
            <button type="button" className={mode === "attach" ? "selected" : ""} onClick={() => setMode("attach")}>기존 세션 연결</button>
          </div>
          {mode === "attach" && <label><span>세션 ID</span><input required value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="세션 UUID" /></label>}
          <div className="modal-actions"><button className="secondary-button" disabled={busy || (mode === "attach" && !sessionId.trim())}>{busy ? "확인 중…" : existing ? "세션 교체" : "세션 연결"}</button></div>
        </form>
      )}
    </Modal>
  );
}

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError || cause instanceof Error) return cause.message;
  return "알 수 없는 오류가 발생했습니다.";
}
