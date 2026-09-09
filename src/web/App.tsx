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
  MediationAutonomy,
  MessageKind,
  Participant,
  TimelineEvent,
  Topic,
  TopicActivity,
  TopicDetail,
  WorkflowState,
} from "../shared/contracts";
import { ApiError, api, topicEventsUrl } from "./api";

const STATE_COPY: Record<WorkflowState, { label: string; tone: StatusTone; hint: string }> = {
  DRAFT: { label: "준비 중", tone: "quiet", hint: "두 에이전트 세션을 연결해 주세요." },
  CLAUDE_PLAN: { label: "Claude 계획 작성", tone: "working", hint: "Claude가 첫 계획을 작성하고 있습니다." },
  CODEX_AUDIT: { label: "Codex 검토", tone: "working", hint: "Codex가 계획의 빈틈과 근거를 확인하고 있습니다." },
  CLAUDE_REVISION: { label: "Claude 계획 수정", tone: "working", hint: "검토 결과를 반영해 계획을 고치고 있습니다." },
  CODEX_CLOSEOUT: { label: "Codex 최종 확인", tone: "working", hint: "합의할 수 있는 계획인지 마지막으로 확인합니다." },
  CONSENSUS_ACK: { label: "계획 해시 확인", tone: "working", hint: "두 에이전트가 같은 계획을 읽었는지 확인합니다." },
  AWAITING_USER_APPROVAL: { label: "승인 대기", tone: "attention", hint: "계획을 읽고 직접 승인해야 구현을 시작할 수 있습니다." },
  IMPLEMENTING: { label: "Claude 구현", tone: "working", hint: "승인된 계획 범위 안에서 Claude가 코드를 고치고 있습니다." },
  CODEX_REVIEW: { label: "Codex 코드 검토", tone: "working", hint: "Codex가 변경 내용을 읽기 전용으로 검토하고 있습니다." },
  CLAUDE_FIX: { label: "Claude 보완", tone: "working", hint: "합의된 범위 안의 확정 문제를 한 번 보완합니다." },
  CODEX_FINAL_REVIEW: { label: "Codex 마무리 검토", tone: "working", hint: "보완된 결과를 마지막으로 확인합니다." },
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

const ACTOR_COPY: Record<AgentRole, string> = {
  claude: "Claude",
  codex: "Codex",
  system: "중앙 진행자",
  user: "나",
};

type StatusTone = "quiet" | "working" | "attention" | "success" | "danger";
type Dialog = "create" | "claude" | "codex" | "commit" | "push" | null;

const ACTIVE_STATES = new Set<WorkflowState>([
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
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mobilePanel, setMobilePanel] = useState<"topics" | "chat" | "plan">("chat");
  const [autonomy, setAutonomy] = useState<MediationAutonomy | null>(null);
  const [autonomyBusy, setAutonomyBusy] = useState(false);
  const [activity, setActivity] = useState<TopicActivity | null>(null);
  const reconnectRef = useRef(0);
  const selectedTopicRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);

  useEffect(() => {
    selectedTopicRef.current = selectedTopicId;
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
    if (!selectedTopicId || !state || !(WORKING_STATES.has(state) || state === "FAILED")) { setActivity(null); return; }
    let cancelled = false;
    const load = () => api.getActivity(selectedTopicId).then((next) => {
      if (!cancelled) setActivity(next);
    }).catch(() => { /* 생존 표시는 부가 정보라 실패해도 화면을 막지 않는다 */ });
    void load();
    const timer = window.setInterval(() => { void load(); }, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedTopicId, detail?.topic.id, detail?.topic.state]);

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
        await operation();
        setDialog(null);
        await refreshTopics();
        if (targetTopicId && selectedTopicRef.current === targetTopicId) await refreshDetail(targetTopicId);
        return true;
      } catch (cause) {
        setError(errorMessage(cause));
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [refreshDetail, refreshTopics, selectedTopicId],
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
                autoRetryAt={activity?.autoRetryAt ?? null}
                topic={selected}
                busyAction={busyAction}
                onSession={(role) => setDialog(role)}
                onAction={(action, body) => void run(action, () => api.runAction(selected.id, action, body))}
              />
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
              detail={detail}
              findings={findings}
              evidence={evidence}
              busyAction={busyAction}
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
          existing={participantFor(selected, dialog)}
          settings={selected.agentSettings[dialog]}
          canChangeSession={selected.state === "DRAFT"}
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
  onSession,
  onAction,
}: {
  topic: Topic;
  busyAction: string | null;
  // FAILED 상태에 예약된 사용 한도 자동 재시도 시각 — 있으면 '예약 취소'(stop) 를 제공한다.
  autoRetryAt: string | null;
  onSession: (role: "claude" | "codex") => void;
  onAction: (action: string, body?: Record<string, unknown>) => void;
}) {
  const claude = participantFor(topic, "claude");
  const codex = participantFor(topic, "codex");
  const canStart = topic.state === "DRAFT" && Boolean(claude && codex);
  const pendingRetry = topic.state === "FAILED" && Boolean(autoRetryAt);
  const canStop = ACTIVE_STATES.has(topic.state) || pendingRetry;
  const deliveryRecovery = topic.state === "USER_DECISION_REQUIRED" && topic.lastError?.includes("커밋 또는 push 도중");
  const canRetry = ["FAILED", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED"].includes(topic.state) && !deliveryRecovery;

  return (
    <div className="room-header">
      <div>
        <div className="room-title-row">
          <h2>{topic.title}</h2>
          <StatusBadge state={topic.state} />
        </div>
        <p>{topic.repositoryPath} · {topic.baseRef}</p>
      </div>
      <div className="room-actions">
        <button className={`session-chip ${claude ? "connected" : ""}`} onClick={() => onSession("claude")}>
          Claude {claude ? "연결됨" : "연결"} · <StageSettings topic={topic} role="claude" />
        </button>
        <button className={`session-chip ${codex ? "connected" : ""}`} onClick={() => onSession("codex")}>
          Codex {codex ? "연결됨" : "연결"} · <StageSettings topic={topic} role="codex" />
        </button>
        {canStop ? (
          <button className="danger-button" disabled={Boolean(busyAction)} onClick={() => onAction("stop")}>{pendingRetry ? "재시도 예약 취소" : "중단"}</button>
        ) : canRetry ? (
          <button className="secondary-button" disabled={Boolean(busyAction)} onClick={() => onAction("retry")}>다시 시도</button>
        ) : (
          <button className="primary-button" disabled={!canStart || Boolean(busyAction)} onClick={() => onAction("plan")}>합의 시작</button>
        )}
      </div>
    </div>
  );
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => bottomRef.current?.scrollIntoView({ block: "nearest" }), [events.length]);

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
            <strong>{ACTOR_COPY[event.actor]}</strong>
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
  detail,
  findings,
  evidence,
  busyAction,
  onAction,
  onDelivery,
}: {
  detail: TopicDetail;
  findings: Finding[];
  evidence: string[];
  busyAction: string | null;
  onAction: (action: string, body?: Record<string, unknown>) => void;
  onDelivery: (action: "commit" | "push") => void;
}) {
  const { topic } = detail;
  const [recoveryOID, setRecoveryOID] = useState("");
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
  const canPush = topic.state === "READY_TO_DELIVER" && Boolean(topic.branchName);

  return (
    <div className="inspector-scroll">
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
          <Ack role="Claude" participant={claude} planHash={topic.planSHA256} />
          <Ack role="Codex" participant={codex} planHash={topic.planSHA256} />
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
          {detail.implementationReport && <details><summary>Claude 구현 보고</summary><pre className="plan-preview">{detail.implementationReport}</pre></details>}
          {detail.codexReview && <details><summary>Codex 코드 검토</summary><pre className="plan-preview">{detail.codexReview}</pre></details>}
        </section>
      )}

      <section className="inspector-section">
        <div className="section-heading"><div><p className="eyebrow">CONTEXT</p><h3>실행 정보</h3></div></div>
        <dl className="context-list">
          <div><dt>Claude 세션</dt><dd>{claude?.sessionId ?? "연결 안 됨"}</dd></div>
          <div><dt>Codex 세션</dt><dd>{codex?.sessionId ?? "연결 안 됨"}</dd></div>
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
          {!(topic.state === "USER_DECISION_REQUIRED" && topic.lastError?.includes("커밋 또는 push 도중")) && (
            <button className="secondary-button" disabled={Boolean(busyAction)} onClick={() => onAction("retry")}>다시 시도</button>
          )}
          {topic.state === "USER_DECISION_REQUIRED" && topic.lastError?.includes("커밋 또는 push 도중") && (
            detail.deliveryRecovery ? (
              <div className="recovery-panel">
                <p>
                  복구 대상: <strong>{detail.deliveryRecovery.action}</strong> · 요청 {detail.deliveryRecovery.idempotencyKey.slice(0, 10)}…
                </p>
                {detail.deliveryRecovery.requestedPaths.length > 0 && (
                  <p>요청 파일: {detail.deliveryRecovery.requestedPaths.join(", ")}</p>
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
                    disabled={Boolean(busyAction)}
                    onClick={() => onAction("reconcile-delivery", {
                      outcome: "failed",
                      idempotencyKey: detail.deliveryRecovery!.idempotencyKey,
                    })}
                  >Git 작업이 실패함</button>
                  <button
                    className="primary-button"
                    disabled={Boolean(busyAction) || !/^[a-f0-9]{40,64}$/.test(recoveryOID)}
                    onClick={() => onAction("reconcile-delivery", {
                      outcome: "succeeded",
                      oid: recoveryOID,
                      idempotencyKey: detail.deliveryRecovery!.idempotencyKey,
                    })}
                  >OID를 검증해 성공 확인</button>
                </div>
              </div>
            ) : <p>복구할 전달 요청을 찾지 못했습니다. 서버를 다시 열어 상태를 갱신해 주세요.</p>
          )}
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

// 지금 단계에 실제로 적용되는 모델·추론을 보여 준다. 구현 전용 오버라이드가 있을 때만 어느 쪽인지
// 라벨을 붙인다 — 오버라이드가 없으면 모든 단계가 같은 설정이라 라벨이 잡음이다.
function StageSettings({ topic, role }: { topic: Topic; role: "claude" | "codex" }) {
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

function CreateTopicDialog({ busy, repositoryPath, memoryDirectory, onClose, onSubmit }: { busy: boolean; repositoryPath: string; memoryDirectory: string; onClose: () => void; onSubmit: (input: { title: string; baseRef: string; branchPrefix: string; requestedBranchName: string | null; predecessorTopicId: string | null }) => void }) {
  const [title, setTitle] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [branchPrefix, setBranchPrefix] = useState("consensus");
  const [requestedBranchName, setRequestedBranchName] = useState("");
  return (
    <Modal title="새 주제 만들기" description="한 주제에는 Claude 세션 하나와 Codex 세션 하나만 연결됩니다." onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ title, baseRef, branchPrefix, requestedBranchName: requestedBranchName.trim() || null , predecessorTopicId: null }); }}>
        <label><span>주제 이름</span><input autoFocus required minLength={2} maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 채팅 취소 처리 정리" /></label>
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
  existing,
  settings,
  canChangeSession,
  busy,
  onClose,
  onSessionSubmit,
  onSettingsSubmit,
}: {
  role: "claude" | "codex";
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
  const label = role === "claude" ? "Claude" : "Codex";
  return (
    <Modal title={`${label} 세션과 실행 설정`} description="모델과 추론 강도를 바꿔도 세션 ID는 유지됩니다. 현재 호출은 그대로 끝나고 다음 호출부터 새 설정을 씁니다." onClose={onClose}>
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

function DeliveryDialog({
  mode,
  busy,
  availablePaths,
  onClose,
  onSubmit,
}: {
  mode: "commit" | "push";
  busy: boolean;
  availablePaths: string[];
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
              {availablePaths.length === 0 ? <p className="muted-copy">현재 변경 파일이 없습니다.</p> : availablePaths.map((path) => (
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
        <div className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>취소</button><button className={mode === "push" ? "danger-button" : "primary-button"} disabled={busy || (mode === "commit" && (!message.trim() || paths.length === 0))}>{busy ? "실행 중…" : mode === "commit" ? "이 범위만 커밋" : "푸시 실행"}</button></div>
      </form>
    </Modal>
  );
}

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError || cause instanceof Error) return cause.message;
  return "알 수 없는 오류가 발생했습니다.";
}
