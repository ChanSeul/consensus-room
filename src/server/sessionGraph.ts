import type { SessionSettingsTarget } from "../shared/sessionSettings.js";
import { createHash } from "node:crypto";
import type { ConsensusDatabase } from "./database.js";
import { routingView } from "./turnRouting.js";
import { planningControlApplies } from "./guardedPlanning.js";
import { turnFlags } from "../shared/roles.js";
import type { GraphNode, GraphRole, SessionGraph, GraphStatus } from "../shared/sessionGraph.js";
import { GRAPH_ROLES } from "../shared/sessionGraph.js";
import { readHostReviewGraph } from "./hostReviewGraph.js";
import { redactSecrets } from "../shared/workflow.js";

const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const sessionId = (value: unknown): string | null => { const id = text(value); return id?.startsWith("pending:") ? null : id; };
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const stageRole = (stage: string): GraphRole => /IMPLEMENT|CLAUDE_FIX/.test(stage) ? "runner"
  : /FINAL_REVIEW|CODEX_REVIEW/.test(stage) ? "reviewer" : /AUDIT|CLOSEOUT/.test(stage) ? "plan-reviewer" : "planner";
const roleJob = { author: ["planner", "plan"], "plan-review": ["reviewer", "audit"], implementation: ["implementer", "implement"], "code-review": ["reviewer", "review"] } as const;
const settingsTarget: Partial<Record<GraphRole, SessionSettingsTarget>> = { planner: "planner", runner: "implementer", "plan-reviewer": "plan-review", reviewer: "code-review", mediator: "mediator", verifier: "verifier", "host-reviewer": "host-reviewer" };
const seatRole = { author: "planner", "plan-review": "plan-reviewer", implementation: "runner", "code-review": "reviewer" } as const;

export function buildSessionGraph(db: ConsensusDatabase, topicId: string, host: ReturnType<typeof readHostReviewGraph>): SessionGraph {
  db.getTopic(topicId);
  const topics = db.listTopics(), ids = new Set([topicId]);
  for (let changed = true; changed;) { changed = false; for (const topic of topics) if (topic.parentTopicId && ids.has(topic.parentTopicId) && !ids.has(topic.id)) { ids.add(topic.id); changed = true; } }
  const graph: SessionGraph = { topicId, nodes: [], edges: [], lanes: [], warnings: [], checkedAt: new Date().toISOString() };
  const nodes = new Map<string, GraphNode>();
  const add = (node: GraphNode) => { if (!nodes.has(node.id)) { nodes.set(node.id, node); graph.nodes.push(node); } return nodes.get(node.id)!; };
  const edge = (from: string, to: string, kind: SessionGraph["edges"][number]["kind"], label: string) => {
    const id = `${from}:${to}:${kind}`; if (from !== to && !graph.edges.some(item => item.id === id)) graph.edges.push({ id, from, to, kind, label });
  };
  for (const topic of topics.filter(topic => ids.has(topic.id)).sort((a,b) => { const depth = (id: string) => { let n = 0, item = topics.find(t => t.id === id); const seen = new Set<string>(); while (item?.parentTopicId && ids.has(item.parentTopicId) && !seen.has(item.id)) { seen.add(item.id); n++; item = topics.find(t => t.id === item!.parentTopicId); } return n; }; return depth(a.id)-depth(b.id); })) {
    const lane = topic.id, routing = routingView(db, topic, job => planningControlApplies(db, topic.id, topic.state, turnFlags(job)));
    graph.lanes.push({ id: lane, title: topic.title });
    const topicNode = `topic:${lane}`, running = Boolean(db.runningAction(lane));
    add({ id: topicNode, kind: "topic", topicId: lane, lane, label: topic.title, subtitle: topic.topicKind === "group" ? "큰 그림 · 하위 주제 관리" : topic.state,
      status: running ? "running" : topic.state === "CLOSED" ? "complete" : ["FAILED", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED"].includes(topic.state) ? "blocked" : "idle", historical: false,
      details: [{ label: "Goal", value: topic.workEntry?.goal ?? topic.title }, { label: "상태", value: topic.state }] });
    if (topic.parentTopicId && ids.has(topic.parentTopicId)) edge(`topic:${topic.parentTopicId}`, topicNode, "hierarchy", "하위 주제");
    const environments = db.sessions.forTopic(topic.id);
    const sessions = new Map<string, GraphNode[]>(), current: Partial<Record<GraphRole, GraphNode>> = {};
    const session = (sid: string | null, role: GraphRole, provider: string | null, historical: boolean) => {
      sid = sessionId(sid);
      const id = sid ? `session:${lane}:${role}:${provider ?? "unknown"}:${sid}` : `role:${lane}:${role}`;
      const node = add({ id, kind: "session", topicId: lane, lane, label: GRAPH_ROLES[role], subtitle: provider ?? "공급자 기록 없음", role,
        status: sid ? "idle" : "unconnected", historical, sessionId: sid, provider,
        details: [{ label: "세션 ID", value: sid ?? "아직 연결되지 않았습니다." }, { label: "공급자", value: provider ?? "기록 없음" }] });
      if (!historical) {
        node.historical = false;
        const target = settingsTarget[role];
        if (target && !node.settingsTargets?.includes(target)) node.settingsTargets = [...(node.settingsTargets ?? []), target];
      }
      if (sid) node.environment = environments.findLast(record => record.sessionId === sid && record.provider === provider);
      if (sid && !(sessions.get(sid) ?? []).includes(node)) sessions.set(sid, [...(sessions.get(sid) ?? []), node]);
      return node;
    };
    for (const role of ["mediator", "verifier"] as const) {
      const assignment = db.roles.effective(lane, role), profile = assignment?.profileId ? db.roles.profile(assignment.profileId) : null;
      const node = session(assignment?.sessionId ?? null, role, profile?.provider ?? null, false); current[role] = node;
      node.details.push({ label: "현재 배정", value: assignment ? `${assignment.participant} · v${assignment.version}` : "배정 없음" },
        { label: "현재 배정 모델", value: profile ? `${profile.model} · ${profile.effort}` : "기록 없음" });
      if (assignment?.profileId) node.details.push({ label: "프로필", value: assignment.profileId });
      for (const scope of ["global", `topic:${lane}`]) for (const old of db.roles.history(scope, role)) {
        if (old.sessionId) session(old.sessionId, role, old.profileId ? db.roles.profile(old.profileId)?.provider ?? null : null, true);
      }
    }
    for (const seat of routing.sessions) {
      const discussion = topic.state.startsWith("BRAINSTORM");
      const sid = sessionId(seat.sessionId);
      if (topic.topicKind === "group" && !discussion && !sid) continue;
      if (topic.topicKind === "group" && discussion && ["implementation", "code-review"].includes(seat.seat) && !sid) continue;
      const role = seatRole[seat.seat], node = session(sid, role, seat.binding?.provider ?? null, topic.topicKind === "group" && !discussion); current[role] = node;
      const fallback = roleJob[seat.seat];
      const currentJob = seat.seat === "author" || seat.seat === "implementation" ? routing.current.author : routing.current.reviewer;
      const seatOperations = seat.seat === "plan-review" ? ["audit", "closeout", "brainstorm", "ack"] : seat.seat === "code-review" ? ["review", "final-review", "review-read", "contract-correction"] : null;
      const operation = currentJob.role === fallback[0] && (!seatOperations || seatOperations.includes(currentJob.operation)) ? currentJob.operation : fallback[1];
      const route = routing.jobs.find(item => item.role === fallback[0] && item.operation === operation);
      for (const job of routing.jobs.filter(item => item.role === fallback[0] && (seat.seat === "plan-review" ? ["audit","closeout","brainstorm"].includes(item.operation) : seat.seat === "code-review" ? ["review","final-review","review-read"].includes(item.operation) : true))) {
        node.details.push({label:`${job.role}/${job.operation}`,value:job.route ? `${job.route.provider} · ${job.route.settings.model} · ${job.route.settings.effort}` : job.refusal ?? "실행 경로 없음"});
      }
      node.details.push({ label: `${GRAPH_ROLES[role]} 현재 설정`, value: route?.route ? `${route.route.provider} · ${route.route.settings.model} · ${route.route.settings.effort}` : route?.refusal ?? "기록 없음" });
      if (seat.binding) node.details.push({ label: "세션 참여자", value: seat.binding.participant }, { label: "세션 프로필", value: seat.binding.profileId ?? "기본 배정" });
      if (route?.refusal) node.details.push({ label: "실행 제한", value: route.refusal });
      node.details.push({ label: "설정 기준", value: "현재 실행 배정입니다. 과거 턴의 모델을 소급해서 의미하지 않습니다." });
    }
    const records = db.graphRecords(lane);
    const knownSession = (sid: string, role: GraphRole, provider: string | null = null) => {
      const matches = (sessions.get(sid) ?? []).filter(node => node.role === role && (provider === null || node.provider === provider));
      // A SID identifies a conversation, not its role.
      return matches.length === 1 ? matches[0] : session(sid, role, provider, true);
    };
    const sourceConsumer = (sid: string, provider: string | null = null) => {
      const matches = (sessions.get(sid) ?? []).filter(node => node.role !== "session" && (provider === null || node.provider === provider));
      if (matches.length === 1) return matches[0];
      const providers = new Set(matches.map(node => node.provider));
      const sharedProvider = provider ?? (providers.size === 1 ? matches[0]?.provider ?? null : null);
      const node = session(sid, "session", sharedProvider, !matches.some(match => !match.historical));
      node.label = matches.length > 1 ? "공유 세션 참조" : "세션 참조";
      if (!node.details.some(detail => detail.label === "원문 귀속")) node.details.push({ label: "원문 귀속", value: "이 원문 전달 기록에는 역할 구분이 없습니다. 세션 단위 참조이며 별도 실행 역할이 아닙니다." });
      return node;
    };
    for (const recovery of records.recoverySessions) {
      const sid = sessionId(recovery.sessionId); if (!sid) continue;
      const role: GraphRole = recovery.seat === "implementer" ? "runner" : recovery.seat === "code-review" ? "reviewer"
        : recovery.seat === "reviewer" ? "plan-reviewer" : "planner";
      knownSession(sid, role, text(recovery.provider));
    }
    for (const event of records.events) {
      const sid = sessionId(event.sessionId); if (!sid) continue;
      const role: GraphRole = event.seat === "implementation" ? "runner" : event.seat === "code-review" ? "reviewer"
        : event.seat === "codex" || event.seat === "plan-review" ? "plan-reviewer" : event.seat === "claude" || event.seat === "author" ? "planner"
        : event.actorRole === "codex" && !/CODEX_REVIEW|CODEX_FINAL_REVIEW/.test(String(event.state)) ? "plan-reviewer"
        : stageRole(String(event.state));
      knownSession(sid, role, text(event.routeProvider) ?? text(event.provider));
    }
    for (const checkpoint of records.checkpoints) {
      const all = [...(checkpoint.sessions ? JSON.parse(String(checkpoint.sessions)) as string[] : []), checkpoint.sessionId].map(sessionId).filter((id): id is string => Boolean(id));
      for (const sid of all) knownSession(sid, stageRole(String(checkpoint.stage)));
    }
    const sourceNode = (sourceId: string) => {
      const existing = nodes.get(`source:${lane}:${sourceId}`); if (existing) return existing;
      let source; try { source = db.evidence.get(sourceId); } catch { return null; }
      return add({ id: `source:${lane}:${sourceId}`, kind: "source", sourceId, topicId: lane, lane, label: source.label,
        subtitle: source.provider, status: source.collection?.status === "reading" ? "running" : source.error ? "blocked" : source.contentHash ? "complete" : "unknown",
        historical: false, url: source.url, details: [{ label: "원문 주소", value: source.url }, { label: "현재 버전", value: source.contentHash ?? "수집 전" },
          { label: "마지막 확인", value: source.checkedAt ? new Date(source.checkedAt).toISOString() : "기록 없음" }] });
    };
    for (const source of db.evidence.list(topic.id)) { const node = sourceNode(source.id); if (node) edge(node.id, topicNode, "registered", "작업에 연결"); }
    for (const receipt of records.receipts) {
      const consumer = JSON.parse(String(receipt.consumer)) as unknown[], sid = text(consumer[receipt.mediator ? 2 : 3]); if (!sid) continue;
      const node = receipt.mediator ? knownSession(sid, "mediator") : sourceConsumer(sid, text(consumer[2]));
      const source = sourceNode(String(receipt.sourceId));
      if (source) edge(source.id, node.id, "delivered", receipt.linkOnly ? `원문 링크 전달 · 범위 ${consumer[1]}` : `전달 기록 · ${receipt.units}개 원문 조각${receipt.partialChars ? ` · 본문 일부 전달 (${receipt.partialChars}자)` : ""} · 범위 ${consumer[1]}`);
    }
    for (const fragment of records.fragments) {
      const selector = String(fragment.selector), kind = String(fragment.kind);
      if (kind === "context") continue; // Work instructions and full transcripts are not original sources.
      const node = sourceConsumer(String(fragment.sessionId));
      const id = `fragment:${lane}:${hash(`${kind}:${selector}:${fragment.hash}`)}`;
      const source = add({ id, kind: "source", topicId: lane, lane, label: selector, subtitle: `${kind} · 고정 원문`, status: "complete", historical: node.historical,
        details: [{ label: "참조", value: selector }, { label: "전달한 버전", value: String(fragment.hash) }, { label: "전달 종류", value: kind }] });
      if (!node.historical) source.historical = false;
      edge(id, node.id, "delivered", `전달 기록 · ${fragment.fragments}개 구간`);
    }
    const path = [current.mediator, current.planner, current["plan-reviewer"], current.runner, current.reviewer, current.verifier].filter((n): n is GraphNode => Boolean(n));
    if (path[0]) edge(topicNode, path[0].id, "flow", "역할 흐름");
    for (let i = 1; i < path.length; i++) edge(path[i-1].id, path[i].id, "flow", "역할 흐름");
    // Plan ACKs establish shared-plan agreement via the engine, not a direct provider-to-provider socket.
    const author = topic.participants.find(p => p.role === "claude"), reviewer = topic.participants.find(p => p.role === "codex");
    if (topic.planSHA256 && author?.acknowledgedPlanSHA256 === topic.planSHA256 && reviewer?.acknowledgedPlanSHA256 === topic.planSHA256
      && current.planner && current["plan-reviewer"]) graph.edges.push({ id: `ack:${lane}`, from: current.planner.id, to: current["plan-reviewer"].id,
        kind: "communication", status: "acknowledged", label: "동일 계획 확인", detail: `엔진 경유 · 두 세션이 확인한 계획 SHA ${topic.planSHA256}` });
    for (const interrupt of records.interrupts) {
      const from = topicNode; // Legacy interrupts record a role, not a sender session. Do not attach them to a guessed session.
      const deliveries = JSON.parse(String(interrupt.deliveries ?? "{}")) as Record<string, {state: "sending" | "sent" | "acknowledged" | "failed" | "unknown"; updatedAt: number; error: string | null}>;
      const entries = Object.entries(deliveries);
      if (!entries.length && interrupt.open && current.mediator) graph.edges.push({ id: `interrupt:${interrupt.id}`, from, to: current.mediator.id, kind: "communication",
        status: "waiting", label: `${interrupt.sourceRole} → 중재 요청 대기`, detail: String(interrupt.reason) });
      for (const [target, delivery] of entries) {
        const key = JSON.parse(target) as unknown[], sid = text(key[4]); if (!sid) continue;
        const to = knownSession(sid, "mediator", text(key[3]));
        const state = delivery.state === "sending" && (!interrupt.open || Date.now() - delivery.updatedAt >= 30_000) ? "unknown" : delivery.state;
        const label = { sending: "중재 요청 전송 중", sent: "중재 요청 전송됨", acknowledged: "중재 요청 수신 확인", failed: "중재 요청 전송 실패", unknown: "중재 요청 응답 미확인" }[state];
        graph.edges.push({ id: `interrupt:${interrupt.id}:${to.id}`, from, to: to.id, kind: "communication", status: state, label: `${interrupt.sourceRole} · ${label}`,
          detail: `${interrupt.reason}${delivery.error ? ` · ${delivery.error}` : ""} · 발신 세션 ID 기록이 없어 주제에서 연결합니다` });
      }
    }
    if (running && records.active) {
      const jobRole = records.active.jobRole, operation = String(records.active.operation ?? "");
      // Core's repair calls retain the parent's topic stage, although their operation changes.
      const planReview = ["audit", "closeout", "brainstorm", "ack"].includes(operation)
        || ["contract-correction", "plan-repair"].includes(operation) && stageRole(topic.state) === "plan-reviewer";
      const activeRole: GraphRole = jobRole === "planner" ? "planner" : jobRole === "implementer" ? "runner"
        : jobRole === "reviewer" ? planReview ? "plan-reviewer" : "reviewer"
          : topic.state === "BRAINSTORMING" && records.active.role === "codex" ? "plan-reviewer" : stageRole(topic.state);
      const node = current[activeRole];
      // Both a live action and an unfinished provider usage record are needed. Waiting/stopped topics never pulse.
      if (node && (records.active.role === "codex") === ["reviewer", "plan-reviewer"].includes(activeRole)) node.status = "running";
    }
    // Environment records identify a conversation/provider, not the role of that spawn (consumer is consensus-engine/runtime-cli).
    // Do not present a runner's latest observation as the planner's own environment when roles share a conversation.
    for (const group of sessions.values()) for (const node of group) {
      const roles = new Set(group.filter(other => other.provider === node.provider && other.role !== "session").map(other => other.role));
      if (node.environment && roles.size > 1) {
        node.environment = undefined;
        node.details.push({ label: "환경 관측 범위", value: "여러 역할이 같은 세션 ID를 공유합니다. 저장된 최근 관측은 역할별 spawn을 구분하지 못해 이 역할의 환경으로 표시하지 않습니다." });
      }
    }
    for (const node of graph.nodes.filter(n => n.lane === lane && n.kind === "session" && n.sessionId && n.status !== "running")) {
      node.status = node.historical ? "unknown" : topic.state === "CLOSED" ? "complete" : ["FAILED", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED"].includes(topic.state) ? "blocked" : "idle";
    }
  }
  for (const group of db.workGroups.list()) {
    if (!(group.parentTopicId && ids.has(group.parentTopicId)) && !Object.values(group.links).some(link => ids.has(link.topicId))) continue;
    const lane = `pipeline:${group.id}`;
    graph.lanes.push({ id: lane, title: `실행 파이프라인 · ${group.title}` });
    const stageNode = (id: string) => group.links[id] && ids.has(group.links[id].topicId) ? `topic:${group.links[id].topicId}` : `stage:${group.id}:${id}`;
    for (const stage of group.stages) {
      if (!nodes.has(stageNode(stage.id))) add({ id: stageNode(stage.id), kind: "stage", topicId: group.links[stage.id]?.topicId ?? null, lane,
        workGroupId: group.id, stageId: stage.id, label: stage.title, subtitle: group.links[stage.id] ? "다른 주제의 연결된 단계" : "미착수 · 계획 후 실행",
        status: group.links[stage.id] ? "unknown" : "idle", historical: false,
        details: [{label:"목표",value:stage.goal},{label:"완료 조건",value:stage.acceptance ?? "미정"},{label:"선행 작업",value:stage.dependsOn.join(", ") || "없음"}] });
      for (const dep of stage.dependsOn) edge(stageNode(dep), stageNode(stage.id), "dependency", "선행 작업 완료 후 실행");
      // Integration admission waits for every work stage, including those without an explicit dependsOn edge.
      if (stage.kind === "integration") for (const previous of group.stages.filter(item => item.kind === "work")) edge(stageNode(previous.id), stageNode(stage.id), "dependency", "전체 작업 완료 후 통합 검증");
    }
  }
  graph.lanes.push({ id: "host", title: "engine-review · 프로젝트 실행과 별도" });
  if (host.nodes.length) { graph.nodes.push(...structuredClone(host.nodes)); graph.edges.push(...structuredClone(host.edges)); }
  else graph.nodes.push({ id: "host:unconnected", kind: "session", topicId: null, lane: "host", role: "host-reviewer", label: "engine-review", subtitle: "연결된 리뷰 세션 없음",
    status: "unconnected", historical: false, details: [{ label: "상태", value: host.warning ?? "아직 실행 기록이 없습니다." }] });
  if (host.warning) graph.warnings.push(host.warning);
  for (const node of graph.nodes.filter(n => n.kind === "session")) {
    const references = graph.edges.filter(e => e.to === node.id && e.kind === "delivered").map(e => `${graph.nodes.find(n => n.id === e.from)?.label ?? e.from} · ${e.label}`);
    if (references.length) node.details.push({ label: "전달된 원문", value: references.join("\n") });
    const communications = graph.edges.filter(e => e.kind === "communication" && (e.to === node.id || e.from === node.id));
    for (const item of communications) node.details.push({ label: item.label, value: item.detail ?? "" });
  }
  // Labels are data. Expose no secret-looking values from arbitrary source titles or stored settings.
  for (const node of graph.nodes) { node.label = redactSecrets(node.label); node.subtitle = redactSecrets(node.subtitle); node.details = node.details.map(item => ({ ...item, value: redactSecrets(item.value) })); if (node.url) node.url = redactSecrets(node.url); }
  for (const item of graph.edges) { item.label = redactSecrets(item.label); if (item.detail) item.detail = redactSecrets(item.detail); }
  for (const node of graph.nodes.filter(node => node.kind === "session")) {
    if (node.role === "host-reviewer" && !node.historical) node.settingsTargets = ["host-reviewer"];
    const env = node.environment;
    node.details.push({ label: "실행 환경", value: env ? `${env.hostname} · ${env.hostOS.platform} ${env.hostOS.release} (${env.hostOS.arch})` : "관측 기록 없음" });
    if (env) node.details.push({ label: "실행 작업 경로", value: env.cwd }, { label: "시작 소비처", value: env.consumer },
      { label: "격리·sandbox", value: `${env.isolated ? "격리 입력" : "일반 입력"} · ${env.workspace} · ${env.access} · ${env.sandbox}` },
      { label: "실행 당시 모델·강도", value: `${env.model} · ${env.effort}` }, { label: "실행 관측 시각", value: env.spawnedAt });
  }
  return graph;
}
