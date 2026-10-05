import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TimelineEvent, Topic } from "../shared/contracts.js";
import { planningUsageGaps, TIMELINE_REFERENCE_UNIT, TIMELINE_REFERENCE_VERSION, type PlanningCheckpoint, type PlanningFragment, type PlanningMigration,
  type PlanningUsageRecovery,
  type RecoveryAnchor, type RecoveryBoundaryKind, type RecoveryLineage, type RecoveryProgress, type RecoveryVerification,
  type TimelineReference } from "../shared/planningControl.js";

export const planningHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function planningKey(topic: Topic, role: string, prompt: string): string {
  return planningHash(JSON.stringify([topic.id, topic.scopeGeneration, topic.planEpoch, topic.planSHA256, topic.state, role, prompt]));
}

// 계획자는 단계로 가린다 — CLAUDE_PLAN 단계에서 도는 계획 제어 턴은 계획자 job 뿐이다. 체크포인트 role 은 실제 공급자라(E2b 역할 배정)
// 공급자 이름으로 가리면 Codex 계획자의 완료된 첫 계획을 복구하지 못하고 재계획했다(host-review 2fa1309 F-003).
export function recoverableFinalizedFirstPlan(
  record: PlanningCheckpoint | null, topic: Topic, timeline: readonly TimelineEvent[],
): boolean {
  return Boolean(record?.finalized && record.finalResult && record.stage === "CLAUDE_PLAN" &&
    !topic.planSHA256 && record.scopeGeneration === topic.scopeGeneration && record.planEpoch === topic.planEpoch &&
    record.planSHA256 === topic.planSHA256 && !timeline.some(event => event.sequence > record.inputSequence &&
      event.actor === "user" && ["decision", "evidence", "scope_change"].includes(event.kind)));
}

// 타임라인 참조 문서와 그 색인의 selector(guardedPlanning 이 kind=context 문서로 싣는다) — 계보 진척은 이 원문을 전달 인정 기록으로만 센다.
const TIMELINE_FRAGMENT_SELECTOR = /^timeline(?::\d+|-index)@[0-9a-f]{64}$/;

// 파일을 읽는 PlanningReader와 같은 경로 신원. 원래 selector·조각 id는 전달 영수증이므로 바꾸지 않는다.
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
// status: open(판정 전) → judged(최종 판정 호출이 판정을 돌려줌 — 이 ID 는 닫힌다) → completed(완료 리뷰 + 원장 전 구간 인정 + 같은 tree/계약).
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
  status: "open" | "judged" | "completed";
  createdAt: string;
  updatedAt: string;
}

export class PlanningStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS planning_policies(topic_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_checkpoints(key TEXT PRIMARY KEY, topic_id TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_fragments(key TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_session_fragments(session_id TEXT NOT NULL,id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS planning_sessions(topic_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_archives(id INTEGER PRIMARY KEY, topic_id TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_reference_reads(session_id TEXT NOT NULL, scope_key TEXT NOT NULL, selector TEXT NOT NULL, offset INTEGER NOT NULL,
        record_json TEXT NOT NULL, PRIMARY KEY(session_id, scope_key, selector, offset));
      CREATE TABLE IF NOT EXISTS planning_session_references(session_id TEXT NOT NULL, scope_key TEXT NOT NULL, selector TEXT NOT NULL, record_json TEXT NOT NULL,
        PRIMARY KEY(session_id, scope_key, selector));
      CREATE TABLE IF NOT EXISTS planning_recovery_lineages(topic_id TEXT NOT NULL, job_role TEXT NOT NULL, record_json TEXT NOT NULL,
        PRIMARY KEY(topic_id, job_role));
      CREATE TABLE IF NOT EXISTS planning_adopted_fragments(session_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(session_id, id));
      CREATE TABLE IF NOT EXISTS planning_review_ledgers(id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_session_receipts(session_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, record_json TEXT NOT NULL);`);
    // 옛 DB에는 전달과 채택을 구분할 기록이 없다. 그 전달을 채택으로 승격하지 않고, 재읽기로 추가 복구를 얻지 못하도록
    // 기존 미확인 구간을 한 번만 고정한다. 이후 거절된 호출은 이 목록에 추가하지 않는다(DB 재개도 같음).
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='planning_progress_exclusions'").get()) {
        db.exec(`CREATE TABLE planning_progress_exclusions(session_id TEXT NOT NULL, id TEXT NOT NULL, record_json TEXT NOT NULL,
          PRIMARY KEY(session_id, id));
          INSERT INTO planning_progress_exclusions SELECT delivered.session_id, delivered.id, delivered.record_json
          FROM planning_session_fragments delivered WHERE NOT EXISTS
            (SELECT 1 FROM planning_adopted_fragments adopted WHERE adopted.session_id=delivered.session_id AND adopted.id=delivered.id);`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  policyVersion(topicId: string): number {
    const row = this.db.prepare("SELECT version FROM planning_policies WHERE topic_id=?").get(topicId);
    return row ? Number(row.version) : 0;
  }
  enabled(topicId: string): boolean { return this.policyVersion(topicId) > 0; }
  continuityEnabled(topicId: string): boolean { return this.policyVersion(topicId) === 2; }
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
  assertMigration(topic: Topic, input: PlanningMigration): void {
    const flags = this.db.prepare("SELECT resume_state,implementation_session_id FROM topics WHERE id=?").get(topic.id);
    const session = topic.participants.find(p => p.role === "claude");
    const artifact = this.db.prepare("SELECT sha256 FROM artifacts WHERE topic_id=? AND scope_generation=? AND kind='interrupted-output' ORDER BY revision DESC LIMIT 1")
      .get(topic.id, topic.scopeGeneration);
    const completed = this.db.prepare("SELECT 1 FROM artifacts WHERE topic_id=? AND kind!='interrupted-output' LIMIT 1").get(topic.id);
    if (!["USER_DECISION_REQUIRED", "FAILED"].includes(topic.state) || flags?.resume_state !== "CLAUDE_PLAN" ||
        flags?.implementation_session_id || topic.planSHA256 || topic.approvedPlanSHA256 || topic.planRevision !== 0 ||
        topic.scopeGeneration !== input.scopeGeneration || topic.planEpoch !== input.planEpoch ||
        session?.sessionId !== input.sessionId || session.acknowledgedPlanSHA256 ||
        artifact?.sha256 !== input.interruptedSHA256 || completed || this.latest(topic.id) || this.continuityEnabled(topic.id)) {
      throw new Error("Only an interrupted initial plan with the exact session and artifact can migrate.");
    }
  }
  migrateInterrupted(topic: Topic, input: PlanningMigration): void {
    this.assertMigration(topic, input);
    this.db.prepare("INSERT INTO planning_policies VALUES (?,2) ON CONFLICT(topic_id) DO UPDATE SET version=2").run(topic.id);
  }
  // 타임라인 참조의 전달 인정(E3-2-2a). 호출이 반환하고 반환 뒤 동기 재대조(중단·주제 현재성·좌석)를 통과한 참조 조각만 적는다 — 기존 세션 조각 기록
  // (recordDelivery)은 현재성 검사 전에 적혀 취소를 무시하고 늦게 끝난 호출의 조각도 남으므로 참조에는 쓰지 않는다. 참조 문서의 재전송 생략과 완독
  // 판정이 모두 이 기록만 읽는다(두 집합이 갈라지면 다시 보내지 않는 구간이 영원히 미완독으로 남는다). 단위·버전은 PlanningReader 의 UTF-8 바이트 v1 이다.
  acknowledgeReferenceReads(sessionId: string, topic: Pick<Topic, "id" | "scopeGeneration">,
    reads: ReadonlyArray<{ selector: string; hash: string; offset: number; nextOffset: number | null; total: number }>): void {
    const insert = this.db.prepare("INSERT INTO planning_reference_reads VALUES (?,?,?,?,?) ON CONFLICT(session_id,scope_key,selector,offset) DO NOTHING");
    for (const read of reads) insert.run(sessionId, JSON.stringify([topic.id, topic.scopeGeneration, read.hash]), read.selector, read.offset, JSON.stringify({
      topicId: topic.id, scopeGeneration: topic.scopeGeneration, unit: TIMELINE_REFERENCE_UNIT, version: TIMELINE_REFERENCE_VERSION,
      hash: read.hash, offset: read.offset, end: read.nextOffset ?? read.total, total: read.total }));
  }
  private referenceReads(sessionId: string, topic: Pick<Topic, "id" | "scopeGeneration">, selector: string, hash: string) {
    return this.db.prepare("SELECT record_json FROM planning_reference_reads WHERE session_id=? AND selector=?").all(sessionId, selector)
      .map(row => JSON.parse(String(row.record_json)) as { topicId: string; scopeGeneration: number; unit: string; version: number;
        hash: string; offset: number; end: number; total: number })
      .filter(read => read.topicId === topic.id && read.scopeGeneration === topic.scopeGeneration && read.hash === hash &&
        read.unit === TIMELINE_REFERENCE_UNIT && read.version === TIMELINE_REFERENCE_VERSION);
  }
  referenceReadAcknowledged(sessionId: string, topic: Pick<Topic, "id" | "scopeGeneration">, selector: string, hash: string, offset: number): boolean {
    return this.referenceReads(sessionId, topic, selector, hash).some(read => read.offset === offset);
  }
  // 처음부터 빈틈없이 인정된 바이트 수 — 다음에 읽을 위치다. 첫 공백에서 멈춘다(그 뒤에 인정된 구간이 있어도 세지 않는다).
  // pending: 지금 보내는 패킷의 조각(아직 인정 전) — 읽기 현황 안내가 "이 패킷을 읽은 뒤" 이어 읽을 위치를 알리도록 계산에만 더한다(저장하지 않는다).
  referenceCovered(sessionId: string, topic: Pick<Topic, "id" | "scopeGeneration">,
    reference: Pick<TimelineReference, "selector" | "hash" | "bytes" | "unit" | "version">,
    pending: ReadonlyArray<{ selector: string; hash: string; offset: number; nextOffset: number | null }> = []): number {
    if (reference.unit !== TIMELINE_REFERENCE_UNIT || reference.version !== TIMELINE_REFERENCE_VERSION) return 0;
    let covered = 0;
    const reads = [...this.referenceReads(sessionId, topic, reference.selector, reference.hash), ...pending
      .filter(read => read.selector === reference.selector && read.hash === reference.hash)
      .map(read => ({ offset: read.offset, end: read.nextOffset ?? reference.bytes, total: reference.bytes }))];
    for (const read of reads.sort((left, right) => left.offset - right.offset)) {
      if (read.total !== reference.bytes || read.offset > covered) break;
      covered = Math.max(covered, read.end);
    }
    return covered;
  }
  // 완독: 인정된 구간이 [0, 전체) 를 빈틈없이 덮을 때만. 끝 조각 하나(nextOffset null)·마지막 조각 먼저·중간 공백은 미완독이다.
  referenceComplete(sessionId: string, topic: Pick<Topic, "id" | "scopeGeneration">,
    reference: Pick<TimelineReference, "selector" | "hash" | "bytes" | "unit" | "version">): boolean {
    return reference.unit === TIMELINE_REFERENCE_UNIT && reference.version === TIMELINE_REFERENCE_VERSION &&
      this.referenceCovered(sessionId, topic, reference) >= reference.bytes;
  }
  // 호스트가 과제 프롬프트에 직접 실은 쪽의 전달 인정(E3-2-2b) — 정상 반환한 호출이 실제로 보낸 판의 쪽만 반환된 세션에 적는다. 같은 offset 에 더 긴
  // 쪽이 인정되면 끝을 늘린다(쪽 크기가 바뀌어도 인정 구간이 줄지 않는다). 2a 모델 요청 경로(acknowledgeReferenceReads)의 기록·판정은 그대로다.
  acknowledgeReferencePages(sessionId: string, topic: Pick<Topic, "id" | "scopeGeneration">,
    pages: ReadonlyArray<{ selector: string; hash: string; offset: number; end: number; total: number }>): void {
    const upsert = this.db.prepare(`INSERT INTO planning_reference_reads VALUES (?,?,?,?,?) ON CONFLICT(session_id,scope_key,selector,offset)
      DO UPDATE SET record_json=excluded.record_json
      WHERE json_extract(excluded.record_json,'$.end') > json_extract(planning_reference_reads.record_json,'$.end')`);
    for (const page of pages) upsert.run(sessionId, JSON.stringify([topic.id, topic.scopeGeneration, page.hash]), page.selector, page.offset, JSON.stringify({
      topicId: topic.id, scopeGeneration: topic.scopeGeneration, unit: TIMELINE_REFERENCE_UNIT, version: TIMELINE_REFERENCE_VERSION,
      hash: page.hash, offset: page.offset, end: page.end, total: page.total }));
  }
  // 인정 구간 합집합 밖의 바이트 구간(E3-2-2b) — 호스트가 다음 쪽을 고르는 근거다. 완독·첫 공백 판정(referenceCovered)은 앞에서부터 빈틈없는 구간만
  // 세지만, 여기서는 첫 공백 뒤의 인정 구간도 빼므로 다시 싣는 것은 공백뿐이다. 겹치거나 크기가 다른 구간도 합집합이라 건너뛰거나 두 번 세지 않는다.
  // 같은 session·topic·scope·hash·unit·version 의 기록만 쓴다(referenceReads). 세션이 없으면(새 세션 판) 전체가 공백이다.
  referenceGaps(sessionId: string | null, topic: Pick<Topic, "id" | "scopeGeneration">,
    reference: Pick<TimelineReference, "selector" | "hash" | "bytes" | "unit" | "version">): Array<{ offset: number; end: number }> {
    const reads = sessionId && reference.unit === TIMELINE_REFERENCE_UNIT && reference.version === TIMELINE_REFERENCE_VERSION
      ? this.referenceReads(sessionId, topic, reference.selector, reference.hash).filter(read => read.total === reference.bytes) : [];
    const gaps: Array<{ offset: number; end: number }> = [];
    let cursor = 0;
    for (const read of reads.sort((left, right) => left.offset - right.offset)) {
      if (read.offset > cursor) gaps.push({ offset: cursor, end: Math.min(read.offset, reference.bytes) });
      cursor = Math.max(cursor, read.end);
    }
    if (cursor < reference.bytes) gaps.push({ offset: cursor, end: reference.bytes });
    return gaps;
  }
  // 세션이 받은 참조 목록 — 커서가 전진해 과제에서 빠져도 같은 세션의 다음 계획 제어 턴이 미완독 참조를 이어받는다(새 세션은 상속하지 않는다).
  rememberSessionReferences(sessionId: string, topic: Pick<Topic, "id" | "scopeGeneration">, references: readonly TimelineReference[]): void {
    const insert = this.db.prepare("INSERT INTO planning_session_references VALUES (?,?,?,?) ON CONFLICT(session_id,scope_key,selector) DO NOTHING");
    for (const reference of references) insert.run(sessionId, JSON.stringify([topic.id, topic.scopeGeneration]), reference.selector,
      JSON.stringify({ topicId: topic.id, scopeGeneration: topic.scopeGeneration, reference }));
  }
  unreadSessionReferences(sessionId: string, topic: Pick<Topic, "id" | "scopeGeneration">): TimelineReference[] {
    return this.db.prepare("SELECT record_json FROM planning_session_references WHERE session_id=?").all(sessionId)
      .map(row => JSON.parse(String(row.record_json)) as { topicId: string; scopeGeneration: number; reference: TimelineReference })
      .filter(row => row.topicId === topic.id && row.scopeGeneration === topic.scopeGeneration && !this.referenceComplete(sessionId, topic, row.reference))
      .map(row => row.reference).sort((left, right) => left.seq - right.seq);
  }
  // ---- 코드 리뷰 원장(E3-4c) — 논리 리뷰 한 번 = 호스트 소유 ID 하나 = 리뷰 1회 예약. 주제마다 가장 최근에 연 원장 한 행만 살아 있다. ----

  // 지금 논리 리뷰의 원장. 가장 최근 원장이 판정 전(open)이고 신원이 같으면 그것을 잇는다(재시작·DB 다시 열기·재시도·세션 복구가 같은 ID·같은 예약을
  // 쓴다). 판정이 끝났거나(judged·completed — 같은 ID 로 판정을 되풀이하지 않는다) 신원이 다르면(새 tree·새 계약·다른 리뷰 종류) 새 ID 로 연다. 옛 원장은
  // 더 이상 최신이 아니므로 다시 이어지지 않는다(tree 가 되돌아가도 새 원장이다). 한 INSERT 라 중간 상태가 없다.
  openReviewLedger(identity: ReviewLedgerIdentity): ReviewLedgerRecord {
    const latest = this.latestReviewLedger(identity.topicId);
    if (latest && latest.status === "open" && latest.kind === identity.kind && latest.scopeGeneration === identity.scopeGeneration
      && latest.planEpoch === identity.planEpoch && latest.planSHA256 === identity.planSHA256 && latest.reviewedTree === identity.reviewedTree
      && latest.reportRevision === identity.reportRevision) return latest;
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
  // 최종 판정 호출이 판정을 돌려줬다 — 완료 여부와 무관하게 이 ID 는 닫힌다(다음 리뷰는 새 ID·새 예약).
  judgeReviewLedger(id: string): void {
    this.updateReviewLedger(id, (record) => record.status === "open" && Boolean(record.status = "judged"));
  }
  // 완료 판정(완료 리뷰 + 원장 전 구간 인정 + 같은 tree/계약) — 이때만 리뷰 커서·완료 산출물·재사용이 열린다.
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
  noteReviewContext(sessionId: string): void { this.noteReceived(sessionId, "reviewContext"); }
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
  // 저장된 좌석 계보를 anchor 대조 없이 읽는다(실행기의 신원 짝 검사·작업 재개의 대기 중 복구 확인용). 없으면 null.
  storedRecoveryLineage(topicId: string, jobRole: string): RecoveryLineage | null {
    const row = this.db.prepare("SELECT record_json FROM planning_recovery_lineages WHERE topic_id=? AND job_role=?").get(topicId, jobRole);
    return row ? JSON.parse(String(row.record_json)) as RecoveryLineage : null;
  }
  saveRecoveryLineage(topicId: string, jobRole: string, lineage: RecoveryLineage): void {
    this.db.prepare("INSERT INTO planning_recovery_lineages VALUES (?,?,?) ON CONFLICT(topic_id,job_role) DO UPDATE SET record_json=excluded.record_json")
      .run(topicId, jobRole, JSON.stringify(lineage));
  }
  // 계보 진척 — 계보의 모든 세션에서 **인정된** 원문 구간의 원본별 합집합(덮은 바이트). 세션별 전달 영수증(재전송 생략·완독)과 분리한 집계다:
  // 새 세션이 옛 세션에서 이미 인정된 같은 원본·해시·구간을 다시 받아도 늘지 않는다. 범위 세대는 원본 신원에 넣지 않는다(같은 원문·해시·구간은 같은 근거).
  // 출처는 두 인정 기록뿐이다(plan v3 §3.6).
  // - 타임라인 참조: 전달 인정(planning_reference_reads — 반환·현재성 재대조 뒤 기록). 계획 제어 읽기(2a)와 호스트 쪽(2b)이 같은 신원으로 적는다.
  //   같은 원문을 조각(kind=context, selector timeline:…·timeline-index@…)으로도 받지만 그 조각은 세지 않는다 — 두 경로의 같은 원문을 두 번 세면
  //   옛 세션의 인정 구간을 새 세션이 조각으로 다시 받는 것만으로 진척이 된다(host-review 008064c F002).
  // - 파일·근거 조각: 채택된 조각(planning_adopted_fragments — 현재성 검사와 단계 채택을 통과한 호출의 조각)만. 반환 직후 적는 전달 기록
  //   (planning_session_fragments)은 구간 값을 읽는 데만 쓴다 — 현재성·채택이 거절된 조각은 진척이 아니다.
  lineageProgress(topicId: string, sessions: readonly string[]): RecoveryProgress {
    const intervals = new Map<string, Array<[number, number]>>();
    const excluded = new Map<string, Array<[number, number]>>();
    const add = (key: string, start: number, end: number) => { if (end > start) intervals.set(key, [...(intervals.get(key) ?? []), [start, end]]); };
    for (const session of new Set(sessions)) {
      for (const row of this.db.prepare("SELECT record_json FROM planning_progress_exclusions WHERE session_id=?").all(session)) {
        const fragment = JSON.parse(String(row.record_json)) as PlanningFragment;
        const key = fragmentSourceKey(fragment);
        excluded.set(key, [...(excluded.get(key) ?? []), [fragment.offset,
          fragment.nextOffset ?? fragment.offset + Buffer.byteLength(fragment.content)]]);
      }
      for (const row of this.db.prepare("SELECT selector, record_json FROM planning_reference_reads WHERE session_id=?").all(session)) {
        const read = JSON.parse(String(row.record_json)) as { topicId: string; unit: string; version: number; hash: string; offset: number; end: number };
        if (read.topicId === topicId) add(JSON.stringify(["timeline", read.hash, read.unit, read.version, String(row.selector)]), read.offset, read.end);
      }
      const adopted = new Set(this.db.prepare("SELECT id FROM planning_adopted_fragments WHERE session_id=?").all(session).map(row => String(row.id)));
      for (const fragment of this.deliveredToSession(session)) {
        if (!adopted.has(fragment.id) || (fragment.kind === "context" && TIMELINE_FRAGMENT_SELECTOR.test(fragment.selector))) continue;
        add(fragmentSourceKey(fragment), fragment.offset,
          fragment.nextOffset ?? fragment.offset + Buffer.byteLength(fragment.content));
      }
    }
    const progress: RecoveryProgress = {};
    for (const [key, ranges] of intervals) {
      let covered = 0, cursor = -1;
      for (const [start, end] of ranges.sort((left, right) => left[0] - right[0])) {
        let from = Math.max(start, cursor);
        // 새로 채택한 구간 중 업데이트 전 전달 구간과 겹치지 않는 부분만 진척이다. 쪽 경계가 달라져도 바이트 구간으로 뺀다.
        for (const [oldStart, oldEnd] of (excluded.get(key) ?? []).sort((left, right) => left[0] - right[0])) {
          if (oldEnd <= from) continue;
          if (oldStart >= end) break;
          if (oldStart > from) covered += oldStart - from;
          from = Math.max(from, oldEnd);
        }
        if (end > from) covered += end - from;
        cursor = Math.max(cursor, end);
      }
      if (covered > 0) progress[key] = covered;
    }
    return progress;
  }
  deliveredToSession(sessionId: string): PlanningFragment[] {
    return this.db.prepare("SELECT record_json FROM planning_session_fragments WHERE session_id=?").all(sessionId)
      .map(row => JSON.parse(String(row.record_json)) as PlanningFragment);
  }
  // 단계 채택으로 인정된 조각(E3-3a) — 계보 진척만 읽는다. 전달 기록(recordDelivery)·재전송 생략 판정과는 따로다.
  recordAdoption(sessionId: string, ids: readonly string[]): void {
    const insert = this.db.prepare("INSERT INTO planning_adopted_fragments VALUES (?,?) ON CONFLICT(session_id,id) DO NOTHING");
    for (const id of ids) insert.run(sessionId, id);
  }
  recordDelivery(sessionId: string, fragments: readonly PlanningFragment[]): void {
    const insert = this.db.prepare("INSERT INTO planning_session_fragments VALUES (?,?,?) ON CONFLICT(session_id,id) DO NOTHING");
    for (const fragment of fragments) insert.run(sessionId, fragment.id, JSON.stringify(fragment));
  }
  get(key: string): PlanningCheckpoint | null {
    const row = this.db.prepare("SELECT record_json FROM planning_checkpoints WHERE key=?").get(key);
    return row ? JSON.parse(String(row.record_json)) : null;
  }
  save(record: PlanningCheckpoint): void {
    this.db.prepare("INSERT INTO planning_checkpoints VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET record_json=excluded.record_json")
      .run(record.key, record.topicId, JSON.stringify(record));
  }
  authorizeUnknownUsage(topic: Topic, input: PlanningUsageRecovery, requestKey: string): void {
    const record = this.latest(topic.id);
    const flags = this.db.prepare("SELECT resume_state FROM topics WHERE id=?").get(topic.id);
    if (!record || record.id !== input.checkpointId || planningHash(JSON.stringify(record)) !== input.checkpointSHA256 ||
        record.scopeGeneration !== topic.scopeGeneration || record.planEpoch !== topic.planEpoch || record.planSHA256 !== topic.planSHA256 ||
        !["FAILED", "USER_DECISION_REQUIRED", "BLOCKED_ON_EVIDENCE"].includes(topic.state) || flags?.resume_state !== record.stage ||
        this.db.prepare("SELECT 1 FROM actions WHERE topic_id=? AND status='running'").get(topic.id)) {
      throw new Error("Planning usage recovery requires the current idle, interrupted checkpoint.");
    }
    const gaps = planningUsageGaps(record), requested = new Set(input.gapIds);
    if (requested.size !== input.gapIds.length || input.gapIds.some(id => !gaps.some(gap => gap.id === id && !gap.authorization))) {
      throw new Error("Select unresolved usage gaps from the current checkpoint.");
    }
    const at = new Date().toISOString();
    record.usageGaps = gaps.map(gap => requested.has(gap.id)
      ? { ...gap, authorization: { requestKey, reason: input.reason, at } } : gap);
    record.updatedAt = at;
    this.save(record);
  }
  latest(topicId: string, role?: "claude" | "codex"): PlanningCheckpoint | null {
    const row = this.db.prepare("SELECT record_json FROM planning_checkpoints WHERE topic_id=? AND (? IS NULL OR json_extract(record_json,'$.role')=?) ORDER BY json_extract(record_json,'$.updatedAt') DESC, rowid DESC LIMIT 1").get(topicId, role ?? null, role ?? null);
    return row ? JSON.parse(String(row.record_json)) : null;
  }
  archive(record: PlanningCheckpoint): void {
    this.db.prepare("INSERT INTO planning_archives(topic_id,record_json) VALUES (?,?)").run(record.topicId, JSON.stringify(record));
  }
  rekey(previousKey: string, record: PlanningCheckpoint): void {
    this.db.prepare("UPDATE planning_checkpoints SET key=?,record_json=? WHERE key=?")
      .run(record.key, JSON.stringify(record), previousKey);
  }
  // 재배정·재키로 현재 행이 교체돼도 archive의 측정값은 남는다. 같은 체크포인트의 반복 보관본은 최댓값 한 번,
  // 서로 다른 체크포인트에서 같은 세션에 보낸 호출은 각각 센다. 복구 전 세션의 sessionMeasurements도 같은 규칙이다.
  sessionContext(sessionId: string): { known: boolean; bytes: number } {
    const rows = this.db.prepare(`SELECT record_json FROM
      (SELECT record_json FROM planning_checkpoints UNION ALL SELECT record_json FROM planning_archives)
      WHERE json_extract(record_json,'$.sessionId')=?
      OR EXISTS (SELECT 1 FROM json_each(record_json,'$.sessionMeasurements') WHERE json_extract(value,'$.sessionId')=?)`).all(sessionId, sessionId);
    const checkpoints = new Map<string, { known: boolean; bytes: number }>();
    for (const record of rows.map(r => JSON.parse(String(r.record_json)) as PlanningCheckpoint)) {
      const total = checkpoints.get(record.id) ?? { known: false, bytes: 0 };
      if (record.sessionId === sessionId) {
        total.known ||= record.started;
        total.bytes = Math.max(total.bytes, record.injectedBytes + (record.responseBytes ?? 0));
      }
      for (const measured of record.sessionMeasurements ?? []) {
        if (measured.sessionId !== sessionId) continue;
        total.known ||= measured.started;
        total.bytes = Math.max(total.bytes, measured.injectedBytes + measured.responseBytes);
      }
      checkpoints.set(record.id, total);
    }
    return { known: [...checkpoints.values()].some(value => value.known), bytes: [...checkpoints.values()].reduce((sum, value) => sum + value.bytes, 0) };
  }
  bindSession(topic: Topic, planSHA256: string, sessionId: string, inputSequence: number): void {
    this.db.prepare("INSERT INTO planning_sessions VALUES (?,?) ON CONFLICT(topic_id) DO UPDATE SET record_json=excluded.record_json")
      .run(topic.id, JSON.stringify({ scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch,
        planSHA256, sessionId, inputSequence }));
  }
  // 승인 계획과 복구 세션을 잇는 바인딩(E3-3b, 연속성 v2) — 계획자 checkpoint 를 만든 세션이 아니라 복구 세션 S1 이 승인 계획을 확인했다는 검증 기록을
  // 함께 둔다. 계획 작성의 finalized checkpoint 는 건드리지 않는다. 참여자·ACK·구현 세션 전환과 한 transaction 으로만 부른다(ConsensusDatabase).
  bindRecoveredSession(topic: Topic, planSHA256: string, sessionId: string, inputSequence: number,
    recovery: { fromSession: string | null; verification: RecoveryVerification }): void {
    this.db.prepare("INSERT INTO planning_sessions VALUES (?,?) ON CONFLICT(topic_id) DO UPDATE SET record_json=excluded.record_json")
      .run(topic.id, JSON.stringify({ scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch,
        planSHA256, sessionId, inputSequence, recovery }));
  }
  boundSession(topic: Topic): { sessionId: string; inputSequence: number } | null {
    const row = this.db.prepare("SELECT record_json FROM planning_sessions WHERE topic_id=?").get(topic.id);
    if (!row) return null;
    const binding = JSON.parse(String(row.record_json));
    return binding.scopeGeneration === topic.scopeGeneration && binding.planEpoch === topic.planEpoch &&
      binding.planSHA256 === topic.planSHA256 && binding.sessionId === topic.participants.find(p => p.role === "claude")?.sessionId
      ? { sessionId: binding.sessionId, inputSequence: binding.inputSequence } : null;
  }
  continuesPriorPlan(topic: Topic, previousPlanSHA256: string): boolean {
    return this.priorPlanCursor(topic, previousPlanSHA256) !== null;
  }
  // 유지 계획 세션의 재계획 전달 커서(E3-2-1): 직전 epoch 에 저장 성공으로 묶인 같은 작성자 좌석 세션이 마지막으로 받은 순번이다.
  // 계획 정책 v2·같은 범위 세대·직전 epoch·직전 계획 SHA·지금 작성자 좌석의 세션이 모두 맞을 때만 있다 — 아니면 null(전체를 보낸다).
  priorPlanCursor(topic: Topic, previousPlanSHA256: string): number | null {
    if (!this.continuityEnabled(topic.id)) return null;
    const row = this.db.prepare("SELECT record_json FROM planning_sessions WHERE topic_id=?").get(topic.id);
    if (!row) return null;
    const binding = JSON.parse(String(row.record_json));
    return binding.scopeGeneration === topic.scopeGeneration && binding.planEpoch === topic.planEpoch - 1 &&
      binding.planSHA256 === previousPlanSHA256 &&
      binding.sessionId === topic.participants.find(p => p.role === "claude")?.sessionId ? Number(binding.inputSequence) : null;
  }
  fragment(key: string): PlanningFragment | null {
    const row = this.db.prepare("SELECT record_json FROM planning_fragments WHERE key=?").get(key);
    return row ? JSON.parse(String(row.record_json)) : null;
  }
  saveFragment(key: string, fragment: PlanningFragment): void {
    this.db.prepare("INSERT INTO planning_fragments VALUES (?,?) ON CONFLICT(key) DO NOTHING").run(key, JSON.stringify(fragment));
  }
  // 진행 표시는 논리 시도 단위다 — 참여자가 바뀌어 대화가 여럿이면 지금 대화 값에 앞선 대화들의 합(priorAttempt)을 더한다. 같은 표의 usage 가 이미
  // 시도 합이라 단위를 맞춘다(E2b 사용자 결정 A안). 세션 문맥 판정(sessionContext)은 대화 값만 읽는다.
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
