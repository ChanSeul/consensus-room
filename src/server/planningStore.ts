import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Topic } from "../shared/contracts.js";
import { planningUsageGaps, type PlanningCheckpoint, type PlanningFragment,
  type RecoveryAnchor, type RecoveryBoundaryKind, type RecoveryLineage, type RecoveryProgress } from "../shared/planningControl.js";

export const planningHash = (value: string) => createHash("sha256").update(value).digest("hex");
// 복구 기준선의 원본 신원(파일 경로는 정규화한다). 원래 selector·조각 id는 전달 영수증이므로 바꾸지 않는다.
function fragmentSourceKey(fragment: Pick<PlanningFragment, "kind" | "selector" | "hash">): string {
  return JSON.stringify([fragment.kind, fragment.kind === "file" ? posix.normalize(fragment.selector) : fragment.selector, fragment.hash]);
}

// 예전 복구 기준선의 키도 맞춘다. 예전 기록은 구간 없이 합계만 남겼으므로 별칭끼리의 중복을 복원할 수 없다.
// 합계를 보수적으로 더해 기준선을 낮추지 않는다. 정규화 자체가 추가 유료 복구를 열어서는 안 된다.
function canonicalRecoveryBaseline(progress: RecoveryProgress): RecoveryProgress {
  const result: RecoveryProgress = {};
  for (const [key, covered] of Object.entries(progress)) {
    const source = JSON.parse(key) as unknown;
    const canonical = Array.isArray(source) && source.length === 3 && source[0] === "file" && typeof source[1] === "string"
      && typeof source[2] === "string" ? fragmentSourceKey({ kind: "file", selector: source[1], hash: source[2] }) : key;
    result[canonical] = (result[canonical] ?? 0) + covered;
  }
  return result;
}

// 좌석 계보의 경계(E3-3a·E3-3b). 계획 제어 좌석은 엔진이 채택한 산출물 종류, 작업·리뷰 좌석은 게이트를 통과한 전이 이벤트의 표식 종류다.
// code-review 는 작업 수락(새 리뷰 입력의 채택)도 경계로 본다(Root Q3b). implementer 는 승인 계획의 구현 시작도 경계다(Q3a).
export const RECOVERY_ANCHORS = {
  planner: { artifacts: ["claude-plan", "diagnosis-plan-revision", "claude-revision"] },
  reviewer: { artifacts: ["audit", "closeout"] },
  implementer: { boundaries: ["approval", "implementation", "fix", "fix-closed"] },
  "code-review": { boundaries: ["review", "review-passed", "implementation", "fix", "fix-closed"] },
} as const satisfies Record<string, { artifacts: readonly string[] } | { boundaries: readonly RecoveryBoundaryKind[] }>;
export type RecoverySeat = keyof typeof RECOVERY_ANCHORS;

// 코드 리뷰 원장의 신원(E3-4c) — 논리 리뷰 한 번을 가르는 것. 검토 tree·계약(범위 세대·계획 epoch·SHA·검토 대상 보고 revision)·리뷰 종류가 하나라도 다르면
// 새 논리 리뷰다. 새 결정·증거는 신원이 아니다 — 판정 전이면 같은 리뷰가 그것까지 읽고 판정한다.
export interface ReviewLedgerIdentity {
  topicId: string;
  kind: "codex-review" | "codex-final-review";
  scopeGeneration: number;
  planEpoch: number;
  planSHA256: string | null;
  // 검토 tree 객체 id(없으면 리뷰 스냅숏 JSON — 교정 문맥 키와 같은 값).
  reviewedTree: string;
  // 검토 대상 보고 산출물 revision(첫 리뷰는 구현 결과, 최종 리뷰는 수정 작업 계약의 대조 보고).
  reportRevision: number;
}

// 코드 리뷰 원장(E3-4c) — 논리 리뷰 한 번의 호스트 소유 기록. id 가 곧 ReviewLedger 예약 ID 다(읽기·최종 판정 호출이 같은 ID 로 예약해 리뷰 1회).
// 인정 구간은 여기 두지 않는다 — 세션별 전달 인정(planning_reference_reads)이 정본이고, 같은 세션은 남은 공백부터 잇는다.
// status: open(판정 전) → paused(판정 호출이 돌아왔지만 판정 아님 — 근거·결정·중재자 대기, 판정 전 필수 구간 미인정, 분류 전 중단. 같은 신원의 재개가 같은 ID·같은
// 예약으로 다시 연다) → completed(리뷰 판정기가 판정에 도달 — 수정·통과·판정 대기 정지. 이 ID 는 닫힌다). judged 는 옛 행(판정 반환이면 무조건 닫던 시절)의
// 읽기 전용 값이며 닫힘으로 본다.
// 세션별 수신 기록(E3-4c host-review 39d21df9 F003·F004) — 원장(논리 리뷰 1회)과 별개로 "그 세션이 무엇을 받았는가"를 세션 id 로 둔다. 프로토콜 턴(도구·지시문·
// 메모리 없음 — ack·완료 확인·답변 확인·리뷰 읽기)이 만든 세션만 기록을 가진다: 만든 순간 두 수신이 모두 없다. 기록이 없는 세션(일반 턴이 만든 세션, 배포 전
// 세션)은 종전 의미 그대로 둘 다 받은 것으로 본다 — 이미 쓰던 세션에 본문을 다시 싣지 않는다.
export interface SessionReceipt {
  topicId: string;
  protocolCreated: true;
  // 리뷰 전문 판(계획 본문·구현 보고·계획 검토 근거)을 받은 판정 호출이 응답을 받았다 — 그 뒤 리뷰는 재개 판이다.
  reviewContext: boolean;
  // 메모리 본문을 실은 일반 턴이 응답을 받았다 — 그 뒤 resume 은 종전대로 매니페스트만이다.
  memoryBodies: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewLedgerRecord extends ReviewLedgerIdentity {
  id: string;
  // 이 원장의 읽기 호출이 새로 만든 리뷰 세션 — 만든 즉시(호출이 끝나기 전) 적는다. 그 세션은 쪽만 받았고 계획·구현 보고·앞선 리뷰를 받은 적이 없어 최종 판정
  // 호출이 재개 판(계획 SHA·직전 커서 뒤)이 아니라 전문 판을 보내야 한다. 그 밖의 저장된 세션은 지금처럼 재개 판이다.
  createdSessions: string[];
  // 마지막 읽기 호출이 돌아온 세션(기록용). 이어 쓸 세션의 정본은 저장된 코드 리뷰 세션이다.
  session: string | null;
  // 이 원장의 호출 가운데 하나라도 프로세스를 띄웠는가 — 예산 래퍼가 spawn 순간에 적고, spawn 전 실패의 예약 되돌림을 막는다.
  spawned: boolean;
  // 정상 반환한 읽기 호출 수(원장 단위 누적 — 재시도·세션 복구로 늘어난 추가 호출도 센다).
  reads: number;
  status: "open" | "paused" | "judged" | "completed";
  createdAt: string;
  updatedAt: string;
}

// 같은 신원의 재개가 이어 쓸 수 있는 원장(판정 전·판정 아님). 원장 열기(openReviewLedger)와 재개의 예약 보유 판정(core.heldReviewLedger)이 같은 정의를 쓴다.
export function isResumableReviewLedger(record: Pick<ReviewLedgerRecord, "status">): boolean {
  return record.status === "open" || record.status === "paused";
}

export class PlanningStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS planning_policies(topic_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_checkpoints(key TEXT PRIMARY KEY, topic_id TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_session_fragments(session_id TEXT NOT NULL,id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS planning_sessions(topic_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_recovery_lineages(topic_id TEXT NOT NULL, job_role TEXT NOT NULL, record_json TEXT NOT NULL,
        PRIMARY KEY(topic_id, job_role));
      CREATE TABLE IF NOT EXISTS planning_review_ledgers(id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_session_receipts(session_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, record_json TEXT NOT NULL);`);
  }
  policyVersion(topicId: string): number {
    const row = this.db.prepare("SELECT version FROM planning_policies WHERE topic_id=?").get(topicId);
    return row ? Number(row.version) : 0;
  }
  continuityEnabled(topicId: string): boolean { return this.policyVersion(topicId) === 2; }
  // 계획 연속성 해제(계약 v3.16 (17')) — 중재자가 작성자 좌석을 교체하면 이 토픽의 "계획 → 구현 한 세션" 보장을 끝낸다. 행을 지우지 않고 v1 로 내린다:
  // 지우면 enable()(ON CONFLICT DO NOTHING — 행이 있을 때만 막는다)이 연속성을 다시 켤 수 있다. 호출자의 transaction 안에서 부른다.
  releaseContinuity(topicId: string): boolean {
    return Number(this.db.prepare("UPDATE planning_policies SET version=1 WHERE topic_id=? AND version=2").run(topicId).changes) === 1;
  }
  enable(topicId: string): void {
    // Existing policies and in-flight/approved work retain their original session contract.
    const topic = this.db.prepare("SELECT state,resume_state,plan_sha256,implementation_session_id FROM topics WHERE id=?").get(topicId);
    const unstartedPlan = !topic?.plan_sha256 && !topic?.implementation_session_id &&
      (["DRAFT", "BRAINSTORM_READY", "CLAUDE_PLAN"].includes(String(topic?.state)) ||
        (["USER_DECISION_REQUIRED", "FAILED"].includes(String(topic?.state)) && topic?.resume_state === "CLAUDE_PLAN"));
    // A paused response can contain a complete plan before topics.plan_sha256 is assigned.
    // Preserve every previously executed topic, including saved response reuse and partial calls.
    const hasHistory = this.db.prepare("SELECT 1 FROM actions WHERE topic_id=? LIMIT 1").get(topicId) ||
      this.db.prepare("SELECT 1 FROM artifacts WHERE topic_id=? LIMIT 1").get(topicId);
    const version = unstartedPlan && !hasHistory ? 2 : 1;
    this.db.prepare("INSERT INTO planning_policies VALUES (?,?) ON CONFLICT(topic_id) DO NOTHING").run(topicId, version);
  }
  // ---- 코드 리뷰 원장(E3-4c) — 논리 리뷰 한 번 = 호스트 소유 ID 하나 = 리뷰 1회 예약. 주제마다 가장 최근에 연 원장 한 행만 살아 있다. ----

  // 같은 신원의 재개가 이어 쓸 원장 — 가장 최근 원장이 판정 전(open)이거나 판정 아님으로 멈췄고(paused) 신원(리뷰 종류·범위 세대·계획 epoch·계획 SHA·
  // 검토 tree·보고판)이 같을 때만 그것, 아니면 null. 부수효과가 없다 — 원장 열기와 재개의 예약 보유 판정이 이 조회 하나를 쓴다. 판정에 도달해 닫혔거나
  // (completed, 옛 행의 judged) 신원이 다르면(새 tree·새 계약·다른 리뷰 종류) 새 논리 리뷰다. 옛 원장은 더 이상 최신이 아니므로 다시 이어지지 않는다
  // (tree 가 되돌아가도 새 원장이다).
  resumableReviewLedger(identity: ReviewLedgerIdentity): ReviewLedgerRecord | null {
    const latest = this.latestReviewLedger(identity.topicId);
    return latest && isResumableReviewLedger(latest) && latest.kind === identity.kind && latest.scopeGeneration === identity.scopeGeneration
      && latest.planEpoch === identity.planEpoch && latest.planSHA256 === identity.planSHA256 && latest.reviewedTree === identity.reviewedTree
      && latest.reportRevision === identity.reportRevision ? latest : null;
  }
  // 지금 논리 리뷰의 원장 — 이어 쓸 원장이 있으면 그것(판정 아님으로 멈춘 원장은 open 으로 되살린다 — 같은 ID 라 ReviewLedger 예약은 멱등, 리뷰 횟수를 새로
  // 쓰지 않는다), 없으면 새 ID 로 연다(한 INSERT 라 중간 상태가 없다). 재시작·DB 다시 열기·재시도·세션 복구가 같은 ID·같은 예약을 쓴다.
  openReviewLedger(identity: ReviewLedgerIdentity): ReviewLedgerRecord {
    const resumable = this.resumableReviewLedger(identity);
    if (resumable) {
      if (resumable.status === "paused") this.updateReviewLedger(resumable.id, (record) => record.status === "paused" && Boolean(record.status = "open"));
      return this.reviewLedger(resumable.id)!;
    }
    const at = new Date().toISOString();
    const record: ReviewLedgerRecord = { ...identity, id: randomUUID(), createdSessions: [], session: null, spawned: false, reads: 0, status: "open",
      createdAt: at, updatedAt: at };
    this.db.prepare("INSERT INTO planning_review_ledgers VALUES (?,?,?)").run(record.id, record.topicId, JSON.stringify(record));
    return record;
  }
  latestReviewLedger(topicId: string): ReviewLedgerRecord | null {
    const row = this.db.prepare("SELECT record_json FROM planning_review_ledgers WHERE topic_id=? ORDER BY rowid DESC LIMIT 1").get(topicId);
    return row ? JSON.parse(String(row.record_json)) as ReviewLedgerRecord : null;
  }
  reviewLedger(id: string): ReviewLedgerRecord | null {
    const row = this.db.prepare("SELECT record_json FROM planning_review_ledgers WHERE id=?").get(id);
    return row ? JSON.parse(String(row.record_json)) as ReviewLedgerRecord : null;
  }
  private updateReviewLedger(id: string, change: (record: ReviewLedgerRecord) => boolean): void {
    const record = this.reviewLedger(id);
    if (!record || !change(record)) return;
    record.updatedAt = new Date().toISOString();
    this.db.prepare("UPDATE planning_review_ledgers SET record_json=? WHERE id=?").run(JSON.stringify(record), id);
  }
  // 원장 호출의 첫 spawn — 예산 래퍼가 프로세스가 뜬 순간 적는다. 이 뒤로는 어느 호출이 spawn 전에 실패해도 원장의 예약을 되돌리지 않는다.
  markReviewLedgerSpawned(id: string): void {
    this.updateReviewLedger(id, (record) => !record.spawned && (record.spawned = true));
  }
  reviewLedgerSpawned(id: string): boolean {
    return this.reviewLedger(id)?.spawned === true;
  }
  // 읽기 호출이 새 리뷰 세션을 만들었다(세션 저장과 같은 순간).
  noteReviewLedgerSession(id: string, sessionId: string): void {
    this.updateReviewLedger(id, (record) => !record.createdSessions.includes(sessionId) && record.createdSessions.push(sessionId) > 0);
  }
  // 정상 반환한 읽기 호출 하나(인정은 호출자가 전달 인정 기록에 이미 적었다).
  noteReviewLedgerRead(id: string, sessionId: string): void {
    this.updateReviewLedger(id, (record) => { record.reads += 1; record.session = sessionId; return true; });
  }
  // 판정 호출이 돌아왔지만 아직 판정이 아니다(돌아온 직후 분류 전, 판정 전 필수 구간 미인정, 리뷰 판정기의 근거·결정·중재자 대기) — 같은 신원의 재개가 같은
  // ID 로 이어 판정한다(새 리뷰 1회를 예약하지 않는다). 판정에 도달해 닫힌 원장은 되돌리지 않는다.
  pauseReviewLedger(id: string): void {
    this.updateReviewLedger(id, (record) => record.status === "open" && Boolean(record.status = "paused"));
  }
  // 리뷰 판정기가 판정에 도달했다(수정·통과·판정 대기 정지) — 이 ID 는 닫히고 다음 리뷰는 새 ID·새 예약이다.
  completeReviewLedger(id: string): void {
    this.updateReviewLedger(id, (record) => record.status !== "completed" && Boolean(record.status = "completed"));
  }
  // ---- 세션별 수신 기록(E3-4c F003·F004) — 원장과 별개. 기록은 프로토콜 턴이 만든 세션에만 있고, 수신은 없음 → 받음 한 방향으로만 바뀐다. ----

  // 프로토콜 턴이 세션을 만들었다(만든 즉시, 호출자가 세션을 저장하기 전). 이미 기록이 있으면 그대로 둔다 — 받은 것을 지우지 않는다.
  noteProtocolSession(topicId: string, sessionId: string): void {
    const at = new Date().toISOString();
    const record: SessionReceipt = { topicId, protocolCreated: true, reviewContext: false, memoryBodies: false, createdAt: at, updatedAt: at };
    this.db.prepare("INSERT INTO planning_session_receipts VALUES (?,?,?) ON CONFLICT(session_id) DO NOTHING").run(sessionId, topicId, JSON.stringify(record));
  }
  // 그 세션의 수신 기록. null 이면 기록 없는 세션 — 종전 의미(리뷰 문맥·메모리 본문 모두 받음)로 읽는다.
  sessionReceipt(sessionId: string): SessionReceipt | null {
    const row = this.db.prepare("SELECT record_json FROM planning_session_receipts WHERE session_id=?").get(sessionId);
    return row ? JSON.parse(String(row.record_json)) as SessionReceipt : null;
  }
  private noteReceived(sessionId: string, field: "reviewContext" | "memoryBodies"): void {
    const record = this.sessionReceipt(sessionId);
    if (!record || record[field]) return;
    record[field] = true;
    record.updatedAt = new Date().toISOString();
    this.db.prepare("UPDATE planning_session_receipts SET record_json=? WHERE session_id=?").run(JSON.stringify(record), sessionId);
  }
  // 리뷰 전문 판을 실은 판정 호출이 응답을 받았다(기록 없는 세션은 이미 받은 것이라 바꾸지 않는다).
  // 메모리 본문을 실은 일반 턴이 응답을 받았다.
  noteMemoryBodies(sessionId: string): void { this.noteReceived(sessionId, "memoryBodies"); }
  // ---- 복구 계보(E3-3a) — 좌석(job 역할)별 한 행. 자동 복구 1회는 계보 단위로 소비된다. ----

  // 그 좌석의 가장 최근 엔진 채택 산출물(범위 세대와 무관) — 계보의 경계다. 엔진이 검증·채택한 단계 결과(saveAgentOutput)만 산출물이 된다.
  recoveryAnchor(topicId: string, kinds: readonly string[]): RecoveryAnchor | null {
    const row = this.db.prepare(`SELECT kind, revision, sha256 FROM artifacts WHERE topic_id=? AND kind IN (${kinds.map(() => "?").join(",")})
      ORDER BY rowid DESC LIMIT 1`).get(topicId, ...kinds);
    return row ? { kind: String(row.kind), revision: Number(row.revision), sha256: String(row.sha256) } : null;
  }
  // 지금 계보. 저장된 계보의 anchor 가 지금 anchor 와 다르면(새 채택) 옛 계보를 previous 로 한 단계 남기고 새 계보를 연다. 계약 좌표·오류 사유·재키·
  // retry·DB 다시 열기는 여기서 보지 않는다 — 계보를 바꾸지 않는다.
  recoveryLineage(topicId: string, jobRole: string, anchor: RecoveryAnchor | null): RecoveryLineage {
    const row = this.db.prepare("SELECT record_json FROM planning_recovery_lineages WHERE topic_id=? AND job_role=?").get(topicId, jobRole);
    const stored = row ? JSON.parse(String(row.record_json)) as RecoveryLineage : null;
    for (const lineage of [stored, stored?.previous]) {
      for (const recovery of lineage?.recoveries ?? []) recovery.baseline = canonicalRecoveryBaseline(recovery.baseline);
    }
    if (stored && JSON.stringify(stored.anchor) === JSON.stringify(anchor)) return stored;
    const { previous: _older, ...closed } = stored ?? { previous: null };
    return { anchor, sessions: [], recoveries: [], blocked: null, previous: stored ? closed as Omit<RecoveryLineage, "previous"> : null };
  }
  // 작업·리뷰 좌석의 계보 경계(E3-3b) — 승인·수락 게이트를 통과한 상태 전이 이벤트에 실은 과제 짝 표식(payload.recoveryBoundary) 중 최신. 전이 문자열이나
  // SHA·epoch 로 추론하지 않는다 — 표식 없는 전이(retry 의 from FAILED, 옛 기록)는 경계가 아니다. 범위 세대와 무관하다(3a anchor 와 같다).
  boundaryAnchor(topicId: string, kinds: readonly RecoveryBoundaryKind[]): RecoveryAnchor | null {
    const row = this.db.prepare(`SELECT sequence, json_extract(payload_json,'$.recoveryBoundary') AS boundary FROM timeline_events
      WHERE topic_id=? AND json_extract(payload_json,'$.recoveryBoundary.kind') IN (${kinds.map(() => "?").join(",")}) ORDER BY sequence DESC LIMIT 1`)
      .get(topicId, ...kinds);
    if (!row) return null;
    const boundary = JSON.parse(String(row.boundary)) as { kind: string };
    return { kind: boundary.kind, revision: Number(row.sequence), sha256: planningHash(String(row.boundary)) };
  }
  // 좌석의 지금 계보 — 그 좌석의 경계 정의(RECOVERY_ANCHORS)로 anchor 를 구해 recoveryLineage 로 연다.
  currentRecoveryLineage(topicId: string, seat: RecoverySeat): RecoveryLineage {
    const anchors: { artifacts: readonly string[] } | { boundaries: readonly RecoveryBoundaryKind[] } = RECOVERY_ANCHORS[seat];
    return this.recoveryLineage(topicId, seat, "artifacts" in anchors
      ? this.recoveryAnchor(topicId, anchors.artifacts) : this.boundaryAnchor(topicId, anchors.boundaries));
  }
  saveRecoveryLineage(topicId: string, jobRole: string, lineage: RecoveryLineage): void {
    this.db.prepare("INSERT INTO planning_recovery_lineages VALUES (?,?,?) ON CONFLICT(topic_id,job_role) DO UPDATE SET record_json=excluded.record_json")
      .run(topicId, jobRole, JSON.stringify(lineage));
  }
  latest(topicId: string, role?: "claude" | "codex"): PlanningCheckpoint | null {
    const row = this.db.prepare("SELECT record_json FROM planning_checkpoints WHERE topic_id=? AND (? IS NULL OR json_extract(record_json,'$.role')=?) ORDER BY json_extract(record_json,'$.updatedAt') DESC, rowid DESC LIMIT 1").get(topicId, role ?? null, role ?? null);
    return row ? JSON.parse(String(row.record_json)) : null;
  }
  bindSession(topic: Topic, planSHA256: string, sessionId: string, inputSequence: number): void {
    this.db.prepare("INSERT INTO planning_sessions VALUES (?,?) ON CONFLICT(topic_id) DO UPDATE SET record_json=excluded.record_json")
      .run(topic.id, JSON.stringify({ scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch,
        planSHA256, sessionId, inputSequence }));
  }
  boundSession(topic: Topic): { sessionId: string; inputSequence: number } | null {
    const row = this.db.prepare("SELECT record_json FROM planning_sessions WHERE topic_id=?").get(topic.id);
    if (!row) return null;
    const binding = JSON.parse(String(row.record_json));
    return binding.scopeGeneration === topic.scopeGeneration && binding.planEpoch === topic.planEpoch &&
      binding.planSHA256 === topic.planSHA256 && binding.sessionId === topic.participants.find(p => p.role === "claude")?.sessionId
      ? { sessionId: binding.sessionId, inputSequence: binding.inputSequence } : null;
  }
  // 진행 표시는 논리 시도 단위다 — 참여자가 바뀌어 대화가 여럿이면 지금 대화 값에 앞선 대화들의 합(priorAttempt)을 더한다. 같은 표의 usage 가 이미
  // 시도 합이라 단위를 맞춘다(E2b 사용자 결정 A안).
  progress(topicId: string) {
    const r = this.latest(topicId);
    const prior = r?.priorAttempt;
    return r ? { version: r.version, checkpointId: r.id, stage: r.stage, round: r.round + (prior?.rounds ?? 0), updatedAt: r.updatedAt,
      questions: r.step.questions, stopped: r.stopped, finalized: r.finalized, usage: r.usage,
      usageIncomplete: Boolean(r.usageIncomplete), usageRecovery: { checkpointId: r.id,
        checkpointSHA256: planningHash(JSON.stringify(r)), gaps: planningUsageGaps(r) },
      injectedBytes: r.injectedBytes + (prior?.injectedBytes ?? 0), deliveredFragments: r.delivered.length + (prior?.deliveredFragments ?? 0),
      lastRequestInputTokens: r.lastRequestInputTokens ?? null, peakRequestInputTokens: r.peakRequestInputTokens ?? null,
      imageBytes: (r.imageBytes ?? 0) + (prior?.imageBytes ?? 0) } : null;
  }
}
