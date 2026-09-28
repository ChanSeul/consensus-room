import {ReviewPanel} from "./ReviewPanel";
import { EvidencePanel } from "./EvidencePanel";
import { RevisionPanel } from "./RevisionPanel";
import { WorkGroupsPanel } from "./WorkGroupsPanel";
import { BudgetPanel } from "./BudgetPanel";
import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { appliedExecutionSettings, runsImplementationTurn } from "../shared/execution";
import type {
  AgentExecutionSettings,
  AgentRole,
  ClientConfig,
  Finding,
  JobRouteView,
  MediationAutonomy,
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
const SESSION_SEAT_COPY: Record<RoutingView["sessions"][number]["seat"], string> = {
  author: "작성자 좌석 세션", "plan-review": "계획 검토 좌석 세션", implementation: "구현 세션", "code-review": "코드 리뷰 세션",
};
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

function routeCopy(entry: JobRouteView): string {
  // 부속 턴은 부모 작업의 배정·세션으로 실행된다 — 이 작업에 따로 둔 배정은 적용되지 않는다는 것을 함께 쓴다(host-review F003).
  const inherited = entry.inheritsFrom ? ` · ${entry.inheritsFrom} 경로 상속(이 작업의 독립 배정은 적용되지 않음)` : "";
  if (!entry.route) return `실행할 수 없는 배정${inherited}`;
  const route = entry.route;
  return `${PROVIDER_COPY[route.provider]} · ${route.settings.model} · ${route.settings.effort} · ${basisCopy(route.basis)}`
    + `${route.profileId ? `(프로필 ${route.profileId}, 참여자 ${route.participant})` : ""}${inherited}`;
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
type Dialog = "create" | "claude" | "codex" | "commit" | "push" | null;

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

// 자율 중재 위임 토글 — 정본은 서버 데이터 디렉터리의 mediation-autonomy.json(셸 스크립트와 공유).
function AutonomyToggle({
  value,
  busy,
  onToggle,
}: {
  value: MediationAutonomy | null;
  busy: boolean;
  onToggle: () => void;
}) {
  const on = value?.autonomy === "on";
  const detail = value
    ? value.unset
      ? "스위치 파일이 없어 off 로 취급 중"
      : `${value.set_at ?? "?"} · ${value.set_by ?? "?"}${value.note ? ` · ${value.note}` : ""}`
    : "불러오는 중";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="자율중재 위임"
      className={`autonomy-toggle ${on ? "on" : "off"}`}
      disabled={busy || !value}
      title={`자율중재 위임 ${on ? "ON" : "OFF"} — ${detail}`}
      onClick={onToggle}
    >
      <span className="autonomy-track" aria-hidden="true"><span className="autonomy-knob" /></span>
      <span className="autonomy-label">자율중재 위임 {on ? "ON" : "OFF"}</span>
    </button>
  );
}

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

function extractEvidence(detail: TopicDetail | null): string[] {
  if (!detail) return [];
  const refs = new Set<string>();
  for (const event of detail.timeline) {
    const values = event.payload.evidenceRefs;
    if (Array.isArray(values)) {
      for (const value of values) if (typeof value === "string") refs.add(value);
    }
    if (event.kind === "evidence" && event.body) refs.add(event.body);
  }
  for (const finding of extractFindings(detail)) {
    for (const ref of finding.evidenceRefs ?? []) refs.add(ref);
  }
  return [...refs];
}

// 작업 묶음 단계의 전달 진입 — 토픽 상세에는 묶음 판정이 없어 묶음 목록 뷰로 판정한다. 화면은 진입만 열고 최종 판정은 서버가 한다.
//  - closedPush(host-review F002): 그 토픽을 링크로 가진 단계에 그 토픽의 동결 결과가 있고, 결과 커밋이 기록된 로컬 커밋이며 아직 push 되지 않았다.
//  - pendingMerge(2차 F001): 엔진이 합류 병합을 준비해 두었고 아직 확정 커밋이 없다 — 파일 차이가 없어도 계보를 잇는 병합 커밋이 필요하다. 서버 commit 도
//    확정 커밋이 없을 때만 합류 병합 경로를 타므로(확정 뒤 경로 없는 커밋은 일반 커밋으로 거부된다) 같은 조건으로 진입을 연다.
interface StageDeliveryView { closedPush: boolean; pendingMerge: boolean }
function stageDeliveryOf(groups: readonly WorkGroupView[], topicId: string): StageDeliveryView {
  for (const group of groups) {
    const stageId = Object.keys(group.links).find((id) => group.links[id].topicId === topicId);
    if (!stageId) continue;
    const result = group.results?.[stageId];
    const delivery = group.delivery[stageId];
    return {
      closedPush: Boolean(result && result.topicId === topicId && delivery?.committedOID === result.commitOID && delivery.pushedOID !== result.commitOID),
      pendingMerge: Boolean(group.links[stageId].preparedMerge) && !delivery?.committedOID,
    };
  }
  return { closedPush: false, pendingMerge: false };
}

function participantFor(topic: Topic, role: "claude" | "codex"): Participant | undefined {
  return topic.participants.find((participant) => participant.role === role);
}

export function App() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [clientConfig, setClientConfig] = useState<ClientConfig | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TopicDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice,setActionNotice]=useState<string|null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mobilePanel, setMobilePanel] = useState<"topics" | "chat" | "plan">("chat");
  const [autonomy, setAutonomy] = useState<MediationAutonomy | null>(null);
  const [autonomyBusy, setAutonomyBusy] = useState(false);
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

  const refreshTopics = useCallback(async () => {
    try {
      const nextTopics = await api.listTopics();
      setTopics(nextTopics);
      setSelectedTopicId((current) => current ?? nextTopics[0]?.id ?? null);
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
    void refreshTopics();
  }, [refreshTopics]);

  // 위임 스위치는 파일이 정본이라(SSH·스크립트로도 바뀐다) 주기적으로 다시 읽는다.
  useEffect(() => {
    let cancelled = false;
    const load = () => api.getMediationAutonomy().then((next) => {
      if (!cancelled) setAutonomy(next);
    }).catch((cause) => {
      if (!cancelled) setError(errorMessage(cause));
    });
    void load();
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

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
    let view: StageDeliveryView = { closedPush: false, pendingMerge: false };
    try { view = stageDeliveryOf(await api.listWorkGroups(), topicId); } catch { /* 진입만 닫는다 */ }
    if (selectedTopicRef.current === topicId) setStageDelivery({ topicId, ...view });
  }, []);
  useEffect(() => {
    const state = detail?.topic.id === selectedTopicId ? detail.topic.state : null;
    if (!selectedTopicId || (state !== "CLOSED" && state !== "READY_TO_DELIVER")) { setStageDelivery(null); return; }
    void refreshStageDelivery(selectedTopicId);
  }, [selectedTopicId, detail?.topic.id, detail?.topic.state, refreshStageDelivery]);

  const toggleAutonomy = useCallback(async () => {
    if (!autonomy || autonomyBusy) return;
    const nextValue = autonomy.autonomy === "on" ? "off" : "on";
    setAutonomyBusy(true);
    try {
      setAutonomy(await api.setMediationAutonomy({ autonomy: nextValue, note: "웹 토글" }));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAutonomyBusy(false);
    }
  }, [autonomy, autonomyBusy]);

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
  const evidence = useMemo(() => extractEvidence(detail), [detail]);

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
        <AutonomyToggle value={autonomy} busy={autonomyBusy} onToggle={() => { void toggleAutonomy(); }} />
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
        <button className={mobilePanel === "chat" ? "active" : ""} onClick={() => setMobilePanel("chat")}>대화</button>
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
            <button className="icon-button" onClick={() => setDialog("create")} aria-label="새 주제 만들기">+</button>
          </div>
          <WorkGroupsPanel onTopic={id=>{void refreshTopics();setSelectedTopicId(id);setMobilePanel("chat");}}/>
          <div className="topic-list">
            {loading ? (
              <div className="skeleton-list" aria-label="주제를 불러오는 중"><i /><i /><i /></div>
            ) : topics.length === 0 ? (
              <EmptyPanel>
                <strong>아직 주제가 없습니다.</strong>
                <span>첫 주제를 만들고 두 에이전트 세션을 연결해 보세요.</span>
                <button className="primary-button" onClick={() => setDialog("create")}>첫 주제 만들기</button>
              </EmptyPanel>
            ) : (
              topics.map((topic) => (
                <button
                  className={`topic-card ${topic.id === selectedTopicId ? "selected" : ""}`}
                  key={topic.id}
                  onClick={() => {
                    setSelectedTopicId(topic.id);
                    setMobilePanel("chat");
                  }}
                >
                  <span className="topic-card-title">{topic.title}</span>
                  <StatusBadge state={topic.state} />
                  <span className="topic-card-meta">계획 {topic.planRevision}판 · 범위 {topic.scopeGeneration}세대</span>
                  <span className="topic-card-time">{formatTime(topic.updatedAt)}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className={`chat-pane mobile-${mobilePanel}`}>
          {selected && detail ? (
            <>
              <RoomHeader
                budgetPaused={Boolean(activity?.budget?.pause || activity?.budgetRecoveryRequired || activity?.revisionPaused || activity?.reviewPaused)}
                autoRetryAt={activity?.autoRetryAt ?? null}
                topic={selected}
                routing={detail.routing}
                busyAction={busyAction}
                onSession={(role) => setDialog(role)}
                onAction={(action, body) => void run(action, () => api.runAction(selected.id, action, body))}
              />
              {activity && <BudgetPanel account={activity.budget ?? null} busy={Boolean(busyAction) || activity.runningAction}
                recoveryRequired={activity.budgetRecoveryRequired ?? false}
                onSubmit={(action,body)=>void run(action,async()=>{ const result=await api.runAction(selected.id,action,body as Record<string,unknown>);const next=await api.getActivity(selected.id);if(selectedTopicRef.current===selected.id)setActivity(next);return result; })}/>}
              {activity?.revisionAllowance && <RevisionPanel account={activity.revisionAllowance} paused={activity.revisionPaused ?? false}
                busy={Boolean(busyAction) || activity.runningAction}
                onGrant={()=>void run("revision-resume",async()=>{const result=await api.runAction(selected.id,"revision-resume",{version:activity.revisionAllowance!.version});const next=await api.getActivity(selected.id);if(selectedTopicRef.current===selected.id)setActivity(next);return result;})}/>}
              {activity?.reviewAllowances && <ReviewPanel accounts={activity.reviewAllowances} paused={activity.reviewPaused??null}
                busy={Boolean(busyAction) || activity.runningAction} onGrant={(scope,version)=>void run("review-resume",async()=>{const result=await api.runAction(selected.id,"review-resume",{scope,version});const next=await api.getActivity(selected.id);if(selectedTopicRef.current===selected.id)setActivity(next);return result;})}/>}
              {activity?.planningProgress && <section className="panel" aria-label="계획 조사 진행">
                <h3>계획 조사 {activity.planningProgress.round}회 · {activity.planningProgress.finalized ? "최종 결과 저장" : "중간 결과 저장"}</h3>
                <p>누적 입력 {activity.planningProgress.usage.inputTokens.toLocaleString()} 토큰 · 캐시 읽기 {activity.planningProgress.usage.cachedInputTokens.toLocaleString()} 토큰</p>
                <p>누적 입력은 현재 문맥 크기나 과금액이 아닙니다.</p>
                <p>관측한 요청별 최대 입력: {activity.planningProgress.peakRequestInputTokens?.toLocaleString() ?? "측정값 없음"} · 전달한 텍스트 {activity.planningProgress.injectedBytes.toLocaleString()}바이트</p>
                <p>전달한 자료 {activity.planningProgress.deliveredFragments}개 · 남은 질문 {activity.planningProgress.questions.length}개</p>
                {activity.planningProgress.stopped && <p role="status">{activity.planningProgress.stopped}</p>}
              </section>}
              <Timeline events={detail.timeline} />
              <MessageComposer
                disabled={Boolean(busyAction) || selected.state === "CLOSED"}
                onSubmit={(kind, body) =>
                  run("message", () => api.postMessage(selected.id, { kind, body }))
                }
              />
            </>
          ) : (
            <EmptyPanel>
              <strong>왼쪽에서 주제를 선택해 주세요.</strong>
              <span>각 주제는 서로 다른 세션과 작업 디렉터리를 사용합니다.</span>
            </EmptyPanel>
          )}
        </section>

        <aside className={`inspector-pane mobile-${mobilePanel}`}>
          {selected && detail ? (
            <Inspector
              evidenceBusy={Boolean(busyAction) || Boolean(activity?.runningAction) || selected.state === "CLOSED"}
              budgetPaused={Boolean(activity?.budget?.pause || activity?.budgetRecoveryRequired || activity?.revisionPaused || activity?.reviewPaused)}
              detail={detail}
              findings={findings}
              evidence={evidence}
              busyAction={busyAction}
              closedStagePush={stageDelivery?.topicId === selected.id && stageDelivery.closedPush}
              onAction={(action, body) => void run(action, () => api.runAction(selected.id, action, body))}
              onDelivery={(action) => setDialog(action)}
            />
          ) : (
            <EmptyPanel>
              <strong>계획과 근거</strong>
              <span>주제를 선택하면 합의된 계획, 발견 사항, 세션 정보를 볼 수 있습니다.</span>
            </EmptyPanel>
          )}
        </aside>
      </main>

      {dialog === "create" && (
        <CreateTopicDialog
          busy={busyAction === "create"}
          repositoryPath={clientConfig?.repositoryPath ?? "불러오는 중…"}
          memoryDirectory={clientConfig?.memoryDirectory ?? "불러오는 중…"}
          onClose={() => setDialog(null)}
          onSubmit={(input) =>
            run("create", async () => {
              const topic = await api.createTopic(input);
              setSelectedTopicId(topic.id);
            })
          }
        />
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
      {(dialog === "commit" || dialog === "push") && selected && (
        <DeliveryDialog
          mode={dialog}
          availablePaths={detail?.changedPaths ?? []}
          // 합류 병합을 준비했고 아직 확정 커밋이 없는 단계가 파일 차이 없이 전달 준비됐으면 경로 없이 계보 병합 커밋을 요청한다(2차 F001). 그 밖의 경로 없는
          // 커밋(확정 뒤 포함)은 서버가 일반 커밋으로 거부한다.
          lineageMerge={selected.state === "READY_TO_DELIVER" && stageDelivery?.topicId === selected.id && stageDelivery.pendingMerge
            && (detail?.changedPaths.length ?? 0) === 0}
          busy={busyAction === dialog}
          onClose={() => setDialog(null)}
          onSubmit={(message, paths) =>
            run(dialog, () => api.runAction(selected.id, dialog, dialog === "commit" ? { message, paths } : {}))
          }
        />
      )}
    </div>
  );
}

function RoomHeader({
  topic,
  busyAction,
  autoRetryAt,
  budgetPaused,
  onSession,
  onAction,
  routing,
}: {
  topic: Topic;
  routing?: RoutingView;
  busyAction: string | null;
  // FAILED 상태에 예약된 사용 한도 자동 재시도 시각 — 있으면 '예약 취소'(stop) 를 제공한다.
  autoRetryAt: string | null;
  budgetPaused: boolean;
  onSession: (role: "claude" | "codex") => void;
  onAction: (action: string, body?: Record<string, unknown>) => void;
}) {
  const claude = participantFor(topic, "claude");
  const codex = participantFor(topic, "codex");
  const canStart = topic.state === "DRAFT" && Boolean(claude && codex);
  const pendingRetry = topic.state === "FAILED" && Boolean(autoRetryAt);
  const canStop = ACTIVE_STATES.has(topic.state) || pendingRetry;
  const deliveryRecovery = topic.state === "USER_DECISION_REQUIRED" && topic.lastError?.includes("커밋 또는 push 도중");
  const canRetry = ["FAILED", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED"].includes(topic.state) && !deliveryRecovery && !budgetPaused;

  return (
    <div className={`room-header${topic.state.startsWith("BRAINSTORM") ? " brainstorm-header" : ""}`}>
      <div>
        <div className="room-title-row">
          <h2>{topic.title}</h2>
          <StatusBadge state={topic.state} />
        </div>
        <p>{topic.repositoryPath} · {topic.baseRef}</p>
      </div>
      <div className="room-actions">
        {(["claude", "codex"] as const).map((seat) => {
          const participant = seat === "claude" ? claude : codex;
          const entry = seatRoute(routing, seat);
          const provider = routing ? entry?.route?.provider : DEFAULT_SEAT_PROVIDER[seat];
          return (
            <button key={seat} className={`session-chip ${participant ? "connected" : ""}`} onClick={() => onSession(seat)}>
              {topic.state.startsWith("BRAINSTORM") ? `참여자 ${seat === "claude" ? 1 : 2}` : SEAT_COPY[seat]} · {provider ? PROVIDER_COPY[provider] : "실행할 수 없는 배정"} {participant ? "연결됨" : "연결"} · <StageSettings topic={topic} role={seat} routing={routing} />
            </button>
          );
        })}
        {topic.state === "BRAINSTORM_READY" ? (
          <BrainstormActions key={topic.id} connected={Boolean(claude && codex)} busy={Boolean(busyAction)} budgetPaused={budgetPaused} onAction={onAction} />
        ) : canStop ? (
          <button className="danger-button" disabled={Boolean(busyAction)} onClick={() => onAction("stop")}>{pendingRetry ? "재시도 예약 취소" : "중단"}</button>
        ) : canRetry ? (
          <button className="secondary-button" disabled={Boolean(busyAction)} onClick={() => onAction("retry")}>다시 시도</button>
        ) : (
          <button className="primary-button" disabled={!canStart || budgetPaused || Boolean(busyAction)} onClick={() => onAction("plan")}>합의 시작</button>
        )}
      </div>
    </div>
  );
}

function BrainstormActions({ connected, busy, budgetPaused, onAction }: {
  connected: boolean; busy: boolean; budgetPaused: boolean; onAction: (action: string, body?: Record<string, unknown>) => void;
}) {
  const [choice, setChoice] = useState<"plan" | "close" | null>(null);
  const [decision, setDecision] = useState("");
  return <>
    <button className="primary-button" disabled={!connected || busy || budgetPaused} onClick={() => onAction("brainstorm")}>한 바퀴 논의</button>
    <button className="secondary-button" disabled={!connected || busy || budgetPaused} onClick={() => setChoice("plan")}>계획으로 진행</button>
    <button className="ghost-button" disabled={busy} onClick={() => setChoice("close")}>논의 종료</button>
    {choice && <Modal title={choice === "plan" ? "논의에서 계획으로" : "논의 마치기"}
      description={choice === "plan" ? "선택한 방향을 남기면 계획 작성과 검토를 시작합니다. 구현은 계획을 승인한 뒤 시작합니다." : "지금 진행하지 않기로 한 이유나 논의에서 얻은 결론을 남겨 주세요."}
      onClose={() => setChoice(null)}>
      <form className="modal-form" onSubmit={event => { event.preventDefault(); onAction(`brainstorm-${choice}`, { decision: decision.trim() }); setChoice(null); }}>
        <label><span>결론과 다음 행동</span><textarea required maxLength={12000} rows={8} value={decision} onChange={event => setDecision(event.target.value)}
          placeholder={choice === "plan" ? "해결할 문제, 선택한 방향과 이유, 이번에 하지 않을 것, 확인할 결과, 남은 불확실성을 적어 주세요. 작은 실험만 계획해도 됩니다." : "예: 현재 방식으로 충분해서 진행하지 않음 / 자료가 부족해 보류 / 논의만으로 궁금한 점이 해결됨"} /></label>
        <div className="modal-actions"><button type="button" className="ghost-button" onClick={() => setChoice(null)}>취소</button>
          <button className="primary-button" disabled={busy || !decision.trim()}>{choice === "plan" ? "계획 시작" : "결론 남기고 종료"}</button></div>
      </form>
    </Modal>}
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

function MessageComposer({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (kind: "note" | "scope_change" | "evidence" | "decision", body: string) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<"note" | "scope_change" | "evidence" | "decision">("note");
  const [body, setBody] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || disabled) return;
    void onSubmit(kind, trimmed).then((succeeded) => {
      if (succeeded) setBody("");
    });
  };

  return (
    <form className="composer" onSubmit={submit}>
      <label>
        <span className="sr-only">메시지 종류</span>
        <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} disabled={disabled}>
          {Object.entries(MESSAGE_COPY).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        disabled={disabled}
        placeholder={kind === "scope_change" ? "바뀐 범위를 적어 주세요. 기존 승인은 취소됩니다." : kind === "evidence" ? "파일 경로, 실행 결과, 공식 문서처럼 새 근거를 적어 주세요." : kind === "decision" ? "에이전트가 따라야 할 결정을 분명하게 적어 주세요." : "두 에이전트가 함께 알아야 할 내용을 적어 주세요."}
        rows={2}
      />
      <button className="primary-button" disabled={disabled || !body.trim()}>보내기</button>
    </form>
  );
}

function Inspector({
  evidenceBusy,
  budgetPaused,
  detail,
  findings,
  evidence,
  busyAction,
  closedStagePush,
  onAction,
  onDelivery,
}: {
  evidenceBusy: boolean;
  budgetPaused: boolean;
  detail: TopicDetail;
  findings: Finding[];
  evidence: string[];
  busyAction: string | null;
  // 닫힌 묶음 단계의 결과 커밋이 아직 push 되지 않았다(목록 뷰 판정) — CLOSED 토픽의 push 진입을 연다.
  closedStagePush: boolean;
  onAction: (action: string, body?: Record<string, unknown>) => void;
  onDelivery: (action: "commit" | "push") => void;
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
  const canCommit = topic.state === "READY_TO_DELIVER";
  // 닫으면 되돌리기 경로가 영구히 막히므로, 남은 로컬 커밋을 처분하기 전에는 닫기를 열지 않는다.
  const canClose = canCommit && !detail.orphanCommitOID;
  // 닫힌 단계의 push 결과가 불명확하면(서버 재시작으로 요청만 unknown) 결과 확인 전에는 서버가 push 를 거부한다 — 진입도 막는다(2차 F002).
  const closedPushRecovery = topic.state === "CLOSED" && detail.deliveryRecovery?.action === "push" ? detail.deliveryRecovery : null;
  const canPush = (topic.state === "READY_TO_DELIVER" && Boolean(topic.branchName)) || (topic.state === "CLOSED" && closedStagePush && !detail.deliveryRecovery);

  return (
    <div className="inspector-scroll">
      <EvidencePanel key={topic.id} topicId={topic.id} busy={evidenceBusy} />
      <section className="inspector-section plan-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">PLAN</p>
            <h3>합의 계획</h3>
          </div>
          <span className="revision-pill">{topic.planRevision}판</span>
        </div>
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
      </section>

      <section className="inspector-section">
        <div className="section-heading">
          <div><p className="eyebrow">FINDINGS</p><h3>검토 쟁점</h3></div>
          <span className="count-pill">{findings.length}</span>
        </div>
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
      </section>

      {(detail.implementationReport || detail.codexReview) && (
        <section className="inspector-section">
          <div className="section-heading"><div><p className="eyebrow">REPORTS</p><h3>구현·검토 보고서</h3></div></div>
          {detail.implementationReport && <details><summary>구현 보고</summary><pre className="plan-preview">{detail.implementationReport}</pre></details>}
          {detail.codexReview && <details><summary>코드 검토 보고</summary><pre className="plan-preview">{detail.codexReview}</pre></details>}
        </section>
      )}

      <section className="inspector-section">
        <div className="section-heading"><div><p className="eyebrow">CONTEXT</p><h3>실행 정보</h3></div></div>
        <dl className="context-list">
          {detail.routing ? <RoutingRows routing={detail.routing} /> : (
            <>
              <div><dt>작성자 좌석 세션</dt><dd>{claude?.sessionId ?? "연결 안 됨"}</dd></div>
              <div><dt>검토자 좌석 세션</dt><dd>{codex?.sessionId ?? "연결 안 됨"}</dd></div>
            </>
          )}
          <div><dt>범위 세대</dt><dd>{topic.scopeGeneration}</dd></div>
          <div><dt>브랜치</dt><dd>{topic.branchName ?? "구현 승인 뒤 생성"}</dd></div>
          <div><dt>작업 디렉터리</dt><dd>{topic.worktreePath}</dd></div>
        </dl>
      </section>

      <section className="inspector-section">
        <div className="section-heading"><div><p className="eyebrow">EVIDENCE</p><h3>근거</h3></div><span className="count-pill">{evidence.length}</span></div>
        {evidence.length === 0 ? <p className="muted-copy">등록된 근거가 없습니다.</p> : (
          <ul className="evidence-list">{evidence.map((item) => <li key={item}>{item}</li>)}</ul>
        )}
      </section>

      {(topic.state === "BLOCKED_ON_EVIDENCE" || topic.state === "USER_DECISION_REQUIRED" || topic.state === "FAILED") && (
        <section className="gate-card gate-danger">
          <strong>{STATE_COPY[topic.state].label}</strong>
          <p>{topic.lastError ?? STATE_COPY[topic.state].hint}</p>
          {!budgetPaused && !(topic.state === "USER_DECISION_REQUIRED" && topic.lastError?.includes("커밋 또는 push 도중")) && (
            <button className="secondary-button" disabled={Boolean(busyAction)} onClick={() => onAction("retry")}>다시 시도</button>
          )}
          {topic.state === "USER_DECISION_REQUIRED" && topic.lastError?.includes("커밋 또는 push 도중") && (
            detail.deliveryRecovery ? (
              <DeliveryRecoveryPanel recovery={detail.deliveryRecovery} busy={Boolean(busyAction)} onAction={onAction} />
            ) : <p>복구할 전달 요청을 찾지 못했습니다. 서버를 다시 열어 상태를 갱신해 주세요.</p>
          )}
        </section>
      )}

      {/* 닫힌 묶음 단계의 push 도중 서버가 멈추면 요청만 결과 불명확으로 남고 CLOSED 는 그대로다(2차 F002) — 같은 결과 확인으로 복구한다. */}
      {closedPushRecovery && (
        <section className="gate-card gate-danger">
          <strong>푸시 결과를 확인해야 합니다</strong>
          <p>닫힌 단계의 push 도중 서버가 멈춰 결과를 알 수 없습니다. 원격 저장소를 확인해 결과를 기록하기 전에는 다시 push 할 수 없습니다.</p>
          <DeliveryRecoveryPanel recovery={closedPushRecovery} busy={Boolean(busyAction)} onAction={onAction} />
        </section>
      )}

      {detail.orphanCommitOID && (
        <section className="gate-card gate-danger">
          <strong>전달하지 못한 로컬 커밋이 남아 있습니다.</strong>
          <p>
            커밋 뒤 검증이 실패해 이 커밋은 전달하지 않았고 자동으로 지우지도 않았습니다.
            되돌리면 파일 변경은 그대로 두고 최종 리뷰가 확인한 기준으로 되돌아갑니다.
          </p>
          <div className="recovery-panel">
            <p>남은 커밋: <code>{detail.orphanCommitOID}</code></p>
            <div className="button-row">
              <button
                className="secondary-button"
                disabled={Boolean(busyAction)}
                onClick={() => onAction("discard-orphan-commit")}
              >이 커밋 되돌리기</button>
            </div>
          </div>
        </section>
      )}

      <section className="inspector-section delivery-section">
        <div className="section-heading"><div><p className="eyebrow">DELIVERY</p><h3>전달</h3></div></div>
        <p className="muted-copy">커밋과 푸시는 각각 승인해야 실행됩니다. 파일 범위도 직접 확인합니다.</p>
        {detail.changedPaths.length > 0 && (
          <ul className="evidence-list">{detail.changedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
        )}
        <div className="button-row">
          <button className="secondary-button" disabled={!canCommit || Boolean(busyAction)} onClick={() => onDelivery("commit")}>범위 지정 커밋</button>
          <button className="primary-button" disabled={!canPush || Boolean(busyAction)} onClick={() => onDelivery("push")}>푸시 승인</button>
          <button className="ghost-button" disabled={!canClose || Boolean(busyAction)} onClick={() => onAction("close")}>주제 닫기</button>
          <button
            className="ghost-button"
            disabled={topic.state !== "CLOSED" || Boolean(busyAction)}
            title="닫힌 주제의 DerivedData 빌드 트리를 지웁니다. *-logs 도구·증거 트리와 worktree 는 남깁니다."
            onClick={() => onAction("archive")}
          >빌드 트리 정리</button>
        </div>
      </section>
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

// 실행 정보 — 역할별 실제 경로(작업별 배정이 달라지면 작업마다), 실행 전 거부 사유, 네 좌석 세션과 그 세션을 만든 AI.
function RoutingRows({ routing }: { routing: RoutingView }) {
  const roles = ["planner", "implementer", "reviewer"] as const;
  return (
    <>
      {roles.map((role) => {
        const groups = new Map<string, { operations: string[]; entry: JobRouteView }>();
        for (const entry of routing.jobs.filter((job) => job.role === role)) {
          const key = `${routeCopy(entry)}\u0000${entry.refusal ?? ""}`;
          const group = groups.get(key);
          if (group) group.operations.push(entry.operation);
          else groups.set(key, { operations: [entry.operation], entry });
        }
        const list = [...groups.values()];
        return (
          <div key={role}>
            <dt>{ROLE_COPY[role]}</dt>
            <dd>
              {list.map(({ operations, entry }) => (
                <span className="route-line" key={operations.join(",")}>
                  {list.length > 1 ? `${operations.join("·")}: ` : ""}{routeCopy(entry)}
                  {entry.refusal && <span className="route-refusal"> — 실행 불가: {entry.refusal}</span>}
                </span>
              ))}
            </dd>
          </div>
        );
      })}
      {routing.sessions.map((session) => (
        <div key={session.seat}>
          <dt>{SESSION_SEAT_COPY[session.seat]}</dt>
          <dd>{session.sessionId ?? "없음"}{session.binding ? ` · ${PROVIDER_COPY[session.binding.provider]}(${session.binding.participant}, ${basisCopy(session.binding.basis)})` : ""}</dd>
        </div>
      ))}
    </>
  );
}

// 지금 단계에 실제로 적용되는 모델·추론을 보여 준다. 구현 전용 오버라이드가 있을 때만 어느 쪽인지
// 라벨을 붙인다 — 오버라이드가 없으면 모든 단계가 같은 설정이라 라벨이 잡음이다.
function StageSettings({ topic, role, routing }: { topic: Topic; role: "claude" | "codex"; routing?: RoutingView }) {
  // routing 이 있으면 서버가 그 좌석의 현재 작업에 실제로 적용하는 설정을 쓴다 — 배정이면 프로필 설정, 기본 배정이면 주제 설정(구현 작업이면 구현 전용
  // 모델). 멈춘 상태의 재개 단계도 서버가 정한다(host-review F004: FAILED·재개 IMPLEMENTING 에서 계획 모델을 보였다). 아래의 상태 추정은 routing 이 없는
  // 과거 응답에만 쓴다.
  if (routing) {
    const job = routing.current[role === "claude" ? "author" : "reviewer"];
    const route = seatRoute(routing, role)?.route;
    if (!route) return <span className="stage-settings">—</span>;
    const label = route.basis.kind === "assignment" ? "배정 " : topic.agentSettings[role].implementation ? (job.role === "implementer" ? "구현 " : "계획 ") : "";
    return <span className="stage-settings">{label}{route.settings.model} · {route.settings.effort}</span>;
  }
  const settings = topic.agentSettings[role];
  const implementationStage = runsImplementationTurn(role, topic.state);
  const applied = appliedExecutionSettings(settings, implementationStage);
  const label = settings.implementation ? (implementationStage ? "구현 " : "계획 ") : "";
  return <span className="stage-settings">{label}{applied.model} · {applied.effort}</span>;
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

function CreateTopicDialog({ busy, repositoryPath, memoryDirectory, onClose, onSubmit }: { busy: boolean; repositoryPath: string; memoryDirectory: string; onClose: () => void; onSubmit: (input: { title: string; baseRef: string; branchPrefix: string; requestedBranchName: string | null; predecessorTopicId: string | null; startMode: "plan" | "brainstorm" }) => void }) {
  const [title, setTitle] = useState("");
  const [startMode, setStartMode] = useState<"plan" | "brainstorm">("plan");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [branchPrefix, setBranchPrefix] = useState("consensus");
  const [requestedBranchName, setRequestedBranchName] = useState("");
  return (
    <Modal title="새 주제 만들기" description="목표가 정해졌다면 바로 계획하고, 할 가치가 있는지부터 생각하고 싶다면 먼저 논의하세요. 참여할 AI는 역할 배정에 따릅니다." onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ title, baseRef, branchPrefix, requestedBranchName: requestedBranchName.trim() || null , predecessorTopicId: null, startMode }); }}>
        <label><span>주제 이름</span><input autoFocus required minLength={2} maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 채팅 취소 처리 정리" /></label>
        <label><span>시작 방식</span><select aria-label="시작 방식" value={startMode} onChange={event => setStartMode(event.target.value as "plan" | "brainstorm")}>
          <option value="plan">바로 계획하기</option><option value="brainstorm">먼저 논의하기</option>
        </select><small>논의는 매번 순서를 무작위로 정해 AI가 한 번씩 발언합니다. 계획으로 넘어갈지는 직접 선택합니다.</small></label>
        <label><span>고정 저장소</span><output className="fixed-value">{repositoryPath}</output></label>
        <label><span>공용 메모리</span><output className="fixed-value">{memoryDirectory}</output><small>현재 주제에 맞는 문서만 골라 각 모델에 전달합니다.</small></label>
        <label><span>기준 리비전</span><input required value={baseRef} onChange={(event) => setBaseRef(event.target.value)} /></label>
        <label>
          <span>브랜치 접두사</span>
          <input required maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" value={branchPrefix}
            onChange={(event) => setBranchPrefix(event.target.value)} placeholder="consensus" />
          <small>이름을 직접 지정하지 않으면 <code>{branchPrefix || "consensus"}/&lt;주제&gt;-&lt;id&gt;-g&lt;세대&gt;</code>로 만들어집니다.</small>
        </label>
        <label>
          <span>브랜치 이름 직접 지정</span>
          <input maxLength={120} value={requestedBranchName}
            onChange={(event) => setRequestedBranchName(event.target.value)} placeholder="비워 두면 위 규칙으로 자동 생성" />
          <small>적으면 <code>{requestedBranchName.trim() || "…"}-g&lt;세대&gt;</code>가 됩니다. 세대 접미사는 범위 변경 시 브랜치가 겹치지 않게 항상 붙습니다.</small>
        </label>
        <div className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>취소</button><button className="primary-button" disabled={busy || repositoryPath === "불러오는 중…"}>{busy ? "만드는 중…" : "주제 만들기"}</button></div>
      </form>
    </Modal>
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

// 결과 불명확 전달 요청의 확인 — 원격·로컬 상태를 사람이 확인해 실패, 또는 성공한 Git OID 를 기록한다(서버가 OID 를 검증한다).
function DeliveryRecoveryPanel({
  recovery,
  busy,
  onAction,
}: {
  recovery: NonNullable<TopicDetail["deliveryRecovery"]>;
  busy: boolean;
  onAction: (action: string, body?: Record<string, unknown>) => void;
}) {
  const [recoveryOID, setRecoveryOID] = useState("");
  return (
    <div className="recovery-panel">
      <p>
        복구 대상: <strong>{recovery.action}</strong> · 요청 {recovery.idempotencyKey.slice(0, 10)}…
      </p>
      {recovery.requestedPaths.length > 0 && (
        <p>요청 파일: {recovery.requestedPaths.join(", ")}</p>
      )}
      <label>
        <span>성공했다고 확인할 Git OID</span>
        <input
          value={recoveryOID}
          onChange={(event) => setRecoveryOID(event.target.value.trim().toLowerCase())}
          placeholder="현재 커밋 OID 전체"
          spellCheck={false}
        />
      </label>
      <div className="button-row">
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => onAction("reconcile-delivery", {
            outcome: "failed",
            idempotencyKey: recovery.idempotencyKey,
          })}
        >Git 작업이 실패함</button>
        <button
          className="primary-button"
          disabled={busy || !/^[a-f0-9]{40,64}$/.test(recoveryOID)}
          onClick={() => onAction("reconcile-delivery", {
            outcome: "succeeded",
            oid: recoveryOID,
            idempotencyKey: recovery.idempotencyKey,
          })}
        >OID를 검증해 성공 확인</button>
      </div>
    </div>
  );
}

function DeliveryDialog({
  mode,
  busy,
  availablePaths,
  lineageMerge = false,
  onClose,
  onSubmit,
}: {
  mode: "commit" | "push";
  busy: boolean;
  availablePaths: string[];
  // 합류 병합을 준비했고 아직 확정 커밋이 없는 단계가 파일 차이 없이 전달 준비됐다 — 경로 없이 계보 병합 커밋을 요청할 수 있다(2차 F001).
  lineageMerge?: boolean;
  onClose: () => void;
  onSubmit: (message: string, paths: string[]) => void;
}) {
  const [message, setMessage] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const title = mode === "commit" ? "범위를 지정해 커밋" : "원격 저장소로 푸시";
  return (
    <Modal title={title} description={mode === "commit" ? "아래에 적은 파일만 stage합니다. git add -A는 사용하지 않습니다." : "커밋과 별개의 승인입니다. 푸시할 범위를 마지막으로 확인해 주세요."} onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); onSubmit(message, paths); }}>
        {mode === "commit" ? (
          <>
            <label><span>커밋 메시지</span><input autoFocus required value={message} onChange={(event) => setMessage(event.target.value)} /></label>
            <fieldset className="path-picker">
              <legend>커밋할 파일을 직접 고르세요.</legend>
              {availablePaths.length === 0 ? (
                <p className="muted-copy">
                  {lineageMerge
                    ? "파일 차이가 없습니다. 준비한 합류 대상을 부모로 잇는 병합 커밋을 경로 없이 요청합니다."
                    : "현재 변경 파일이 없습니다."}
                </p>
              ) : availablePaths.map((path) => (
                <label key={path}>
                  <input
                    type="checkbox"
                    checked={paths.includes(path)}
                    onChange={(event) => setPaths((current) => event.target.checked
                      ? [...current, path]
                      : current.filter((item) => item !== path))}
                  />
                  <code>{path}</code>
                </label>
              ))}
            </fieldset>
          </>
        ) : (
          <div className="push-confirmation" role="note">
            <strong>현재 브랜치의 커밋을 원격 저장소로 보냅니다.</strong>
            <p>이 동작은 커밋을 새로 만들거나 파일을 추가하지 않습니다.</p>
          </div>
        )}
        <div className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>취소</button><button className={mode === "push" ? "danger-button" : "primary-button"} disabled={busy || (mode === "commit" && (!message.trim() || (paths.length === 0 && !(lineageMerge && availablePaths.length === 0))))}>{busy ? "실행 중…" : mode === "commit" ? "이 범위만 커밋" : "푸시 실행"}</button></div>
      </form>
    </Modal>
  );
}

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError || cause instanceof Error) return cause.message;
  return "알 수 없는 오류가 발생했습니다.";
}
