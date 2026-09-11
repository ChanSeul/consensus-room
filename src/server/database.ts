import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_AGENT_SETTINGS,
  ParticipantSchema,
  TimelineEventSchema,
  TopicSchema,
  type AgentRole,
  type AgentExecutionSettings,
  type AgentSettings,
  type MessageKind,
  type Participant,
  type TimelineEvent,
  type Topic,
  type WorkflowState,
} from "../shared/contracts.js";
import type { ActionRecord, AutoRetryState, InternalTopicFlags, ParticipantRole, StoredArtifact } from "./types.js";

type SqlValue = string | number | bigint | null | Uint8Array;

interface TimelineEventInput {
  topicId: string;
  actor: AgentRole;
  kind: MessageKind;
  state: WorkflowState;
  body: string;
  payload?: Record<string, unknown>;
}

function now(): string {
  return new Date().toISOString();
}

// 실행이 끝났거나 사용자 판단을 기다리는 상태 — 실패 원장 처리가 이 상태를 FAILED로 덮으면 복구 경로가 사라진다.
export const COMPLETED_TOPIC_STATES: ReadonlySet<WorkflowState> = new Set([
  "AWAITING_USER_APPROVAL", "READY_TO_DELIVER", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED", "CLOSED",
]);

export class ConsensusDatabase {
  readonly events = new EventEmitter();
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  verificationRecords(topicId: string): unknown[] {
    return this.db.prepare("SELECT record_json FROM verification_runs WHERE topic_id = ? ORDER BY rowid DESC")
      .all(topicId).map((row) => JSON.parse(String(row.record_json)));
  }

  saveVerification<T extends { id: string; topicId: string; cacheKey: string; status: string }>(record: T): void {
    this.db.prepare(`INSERT INTO verification_runs(id, topic_id, cache_key, status, record_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, record_json = excluded.record_json`)
      .run(record.id, record.topicId, record.cacheKey, record.status, JSON.stringify(record));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verification_runs (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id),
        cache_key TEXT NOT NULL,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS verification_single_flight ON verification_runs(cache_key) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch_prefix TEXT NOT NULL DEFAULT 'consensus',
        requested_branch_name TEXT,
        branch_name TEXT,
        state TEXT NOT NULL,
        scope_generation INTEGER NOT NULL DEFAULT 1,
        plan_revision INTEGER NOT NULL DEFAULT 0,
        plan_sha256 TEXT,
        approved_plan_sha256 TEXT,
        claude_model TEXT NOT NULL DEFAULT 'fable',
        claude_effort TEXT NOT NULL DEFAULT 'xhigh',
        codex_model TEXT NOT NULL DEFAULT 'gpt-6-astra',
        codex_effort TEXT NOT NULL DEFAULT 'xhigh',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        fix_pass_used INTEGER NOT NULL DEFAULT 0,
        resume_state TEXT,
        implementation_session_id TEXT
        ,reviewed_head TEXT
        ,reviewed_diff_sha256 TEXT
        ,committed_oid TEXT
        ,pushed_oid TEXT
        ,orphan_commit_oid TEXT
      );
      CREATE TABLE IF NOT EXISTS participants (
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        acknowledged_plan_sha256 TEXT,
        PRIMARY KEY(topic_id, role)
      );
      CREATE TABLE IF NOT EXISTS codex_review_sessions (
        topic_id TEXT PRIMARY KEY REFERENCES topics(id),
        session_id TEXT NOT NULL UNIQUE,
        scope_generation INTEGER NOT NULL,
        plan_epoch INTEGER NOT NULL,
        plan_sha256 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS timeline_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        body TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        scope_generation INTEGER NOT NULL DEFAULT 1,
        UNIQUE(topic_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        revision INTEGER NOT NULL,
        scope_generation INTEGER NOT NULL DEFAULT 1,
        sha256 TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(topic_id, kind, revision)
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT,
        pid INTEGER,
        pgid INTEGER,
        process_executable TEXT,
        process_command TEXT,
        process_started_at TEXT
      );
      CREATE TABLE IF NOT EXISTS action_requests (
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        response_json TEXT,
        request_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        PRIMARY KEY(topic_id, action, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS global_requests (
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        response_json TEXT,
        request_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        PRIMARY KEY(scope, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS timeline_topic_sequence ON timeline_events(topic_id, sequence);
      CREATE INDEX IF NOT EXISTS artifact_topic_kind ON artifacts(topic_id, kind, revision DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_action_per_topic
        ON actions(topic_id) WHERE status = 'running';
      CREATE UNIQUE INDEX IF NOT EXISTS one_topic_per_agent_session
        ON participants(role, session_id);
    `);
    this.ensureColumn("artifacts", "scope_generation", "INTEGER NOT NULL DEFAULT 1");
    this.migrateTimelineGenerations();
    this.ensureColumn("actions", "pid", "INTEGER");
    this.ensureColumn("actions", "pgid", "INTEGER");
    this.ensureColumn("actions", "process_executable", "TEXT");
    this.ensureColumn("actions", "process_command", "TEXT");
    this.ensureColumn("actions", "process_started_at", "TEXT");
    this.ensureColumn("action_requests", "status", "TEXT NOT NULL DEFAULT 'running'");
    this.ensureColumn("action_requests", "response_json", "TEXT");
    this.ensureColumn("action_requests", "request_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("action_requests", "error", "TEXT");
    this.ensureColumn("topics", "reviewed_head", "TEXT");
    this.ensureColumn("topics", "reviewed_diff_sha256", "TEXT");
    this.ensureColumn("topics", "committed_oid", "TEXT");
    this.ensureColumn("topics", "pushed_oid", "TEXT");
    this.ensureColumn("topics", "orphan_commit_oid", "TEXT");
    this.ensureColumn("topics", "plan_epoch", "INTEGER NOT NULL DEFAULT 1");
    // 이 컬럼이 생기기 전 주제는 전부 consensus 접두사로 브랜치를 만들었다.
    this.ensureColumn("topics", "branch_prefix", "TEXT NOT NULL DEFAULT 'consensus'");
    this.ensureColumn("topics", "requested_branch_name", "TEXT");
    // 구현 브랜치를 만든 시점의 HEAD. 재시도 baseline을 현재 HEAD로 다시 잡으면 중단 직전의 비인가
    // 커밋이 '원래 상태'로 둔갑한다(감사 ⑥) — 최초 1회 기록하고 범위 변경 때만 지운다.
    this.ensureColumn("topics", "implementation_base_oid", "TEXT");
    // 이어지는 턴에 새 이벤트만 싣기 위한 '마지막으로 전달한 sequence'(2026-09-08 Codex 제안 ⑥). null = 전부 싣는다.
    this.ensureColumn("topics", "implementation_prompt_sequence", "INTEGER");
    this.ensureColumn("codex_review_sessions", "prompt_sequence", "INTEGER");
    // 사용 한도 자동 재시도의 지속 상태(시도 수·마지막 발화·예약 시각·사용자 취소) — 재시작이 상한과 취소를 지우지 않게(Codex 후속 지적 4·5).
    this.ensureColumn("topics", "auto_retry_json", "TEXT");
    // 계획 좌표(annotation)를 요청 본문과 분리 저장한다. request_json에 합쳐 넣으면 같은 키 재전송의
    // 본문 대조(멱등 키 오용 검출)가 자기 주석과 비교하게 되어 정상 재생까지 409가 된다.
    this.ensureColumn("global_requests", "planned_json", "TEXT");
    this.migrateAgentSettings();
    this.db.exec("CREATE INDEX IF NOT EXISTS artifact_topic_scope_kind ON artifacts(topic_id, scope_generation, kind, revision DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS timeline_topic_scope_sequence ON timeline_events(topic_id, scope_generation, sequence)");
  }

  private migrateAgentSettings(): void {
    const definitions = [
      ["claude_model", "TEXT NOT NULL DEFAULT 'opus'"],
      ["claude_effort", "TEXT NOT NULL DEFAULT 'xhigh'"],
      // 아래 두 값은 컬럼을 추가하던 시점의 기본값이다(옛 DB 의 기존 행 backfill 용) — 지금 기본값은
      // DEFAULT_AGENT_SETTINGS 와 CREATE TABLE 쪽이고, createTopic 은 언제나 값을 명시해 넣는다.
      ["codex_model", "TEXT NOT NULL DEFAULT 'gpt-5.6-sol'"],
      ["codex_effort", "TEXT NOT NULL DEFAULT 'xhigh'"],
      // 구현 단계 전용 모델(없으면 NULL = 계획과 동일). 2026-08-31 단계별 분리.
      ["claude_impl_model", "TEXT"],
      ["claude_impl_effort", "TEXT"],
      ["codex_impl_model", "TEXT"],
      ["codex_impl_effort", "TEXT"],
      // 2차 자동 수정 패스 소비 여부(2026-09-05). 1차(fix_pass_used)와 독립.
      ["second_fix_pass_used", "INTEGER NOT NULL DEFAULT 0"],
      // 종결 확인의 새 쟁점을 반영하는 개정 2회차를 이 바퀴에서 열었는지(2026-09-07). resetToDraft 가 되돌린다.
      ["closeout_revision_used", "INTEGER NOT NULL DEFAULT 0"],
      // 선행 토픽(이연 쟁점 승계)과 최종 리뷰 변경분 재검토용 리뷰 시점 트리(2026-09-07).
      ["predecessor_topic_id", "TEXT"],
      ["reviewed_tree_oid", "TEXT"],
    ] as const;
    const existing = new Set(
      (this.db.prepare("PRAGMA table_info(topics)").all() as Array<Record<string, unknown>>)
        .map((column) => String(column.name)),
    );
    const missing = definitions.filter(([column]) => !existing.has(column));
    if (missing.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [column, definition] of missing) {
        this.db.exec(`ALTER TABLE topics ADD COLUMN ${column} ${definition}`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // 세대 컬럼 추가와 백필은 한 transaction이다. 컬럼 추가만 커밋된 채 서버가 죽으면
  // 다음 실행이 "컬럼이 이미 있다"는 이유로 백필을 영구히 건너뛴다 — 함께 성공하거나 함께 없던 일이어야 한다.
  private migrateTimelineGenerations(): void {
    const columns = this.db.prepare("PRAGMA table_info(timeline_events)").all() as Array<Record<string, unknown>>;
    if (columns.some((item) => item.name === "scope_generation")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("ALTER TABLE timeline_events ADD COLUMN scope_generation INTEGER NOT NULL DEFAULT 1");
      this.backfillTimelineGenerations();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // 컬럼을 새로 붙인 DB의 기존 행에 각자의 세대를 복원한다. 세대를 올렸던 두 경로(scope_change,
  // 과거의 합의 무효화)는 모두 당시 이벤트 payload에 scopeGeneration을 남겼으므로, 주제별로 sequence 순으로
  // 걸으며 그 표식에서 세대를 전환하면 정확히 되살릴 수 있다. 전 행을 현재 세대로 뭉개면 철회된 결정이
  // 새 프롬프트에 다시 들어가고, 기본값 1로 두면 세대가 오른 주제의 프롬프트가 통째로 빈다 — 둘 다 안 된다.
  // migrateTimelineGenerations의 transaction 안에서 호출된다. 여기서 BEGIN을 다시 열지 않는다.
  protected backfillTimelineGenerations(): void {
    const rows = this.db.prepare(
      "SELECT id, topic_id, payload_json FROM timeline_events ORDER BY topic_id, sequence",
    ).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return;
    const update = this.db.prepare("UPDATE timeline_events SET scope_generation = ? WHERE id = ?");
    let currentTopic: string | null = null;
    let generation = 1;
    for (const row of rows) {
      if (row.topic_id !== currentTopic) {
        currentTopic = String(row.topic_id);
        generation = 1;
      }
      try {
        const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
        // 세대를 올린 이벤트 자신부터 새 세대에 속한다 — 실행 시의 appendEvent 동작과 같다.
        if (typeof payload.scopeGeneration === "number" && Number.isInteger(payload.scopeGeneration)) {
          generation = payload.scopeGeneration;
        }
      } catch { /* payload가 깨진 행은 직전 세대를 그대로 잇는다 */ }
      update.run(generation, row.id as SqlValue);
    }
  }

  // 컬럼을 실제로 새로 붙였는지 알려 준다. 붙인 직후에만 해야 하는 백필이 있다.
  private ensureColumn(table: string, column: string, definition: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
    if (columns.some((item) => item.name === column)) return false;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }

  recoverInterruptedActions(): void {
    const interrupted = this.db.prepare(`
      SELECT actions.id, actions.topic_id, topics.state,
        actions.pid, actions.pgid, actions.process_command
      FROM actions JOIN topics ON topics.id = actions.topic_id
      WHERE actions.status = 'running'
    `).all() as Array<Record<string, unknown>>;
    if (interrupted.length === 0) return;
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of interrupted) {
        if (COMPLETED_TOPIC_STATES.has(String(row.state) as WorkflowState)) {
          this.db.prepare("UPDATE actions SET status = 'succeeded', finished_at = ?, error = NULL WHERE id = ?")
            .run(timestamp, row.id as SqlValue);
          continue;
        }
        this.db.prepare("UPDATE actions SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ?")
          .run(timestamp, "서버 재시작으로 실행이 중단되었습니다.", row.id as SqlValue);
        this.db.prepare(`
          UPDATE topics SET resume_state = state, state = 'FAILED',
            last_error = ?, updated_at = ? WHERE id = ?
        `).run("서버 재시작으로 실행이 중단되었습니다.", timestamp, row.topic_id as SqlValue);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // planEpoch는 항상 1로 시작하고(컬럼 기본값) 이후 무효화·범위 변경만 올린다. 생성 입력에서 받지 않는다.
  // branchPrefix도 컬럼 기본값(consensus)이 있어 생략할 수 있다.
  createTopic(input: Omit<Topic,
    "participants" | "planEpoch" | "agentSettings" | "branchPrefix" | "requestedBranchName" | "predecessorTopicId"
  > & {
    agentSettings?: AgentSettings;
    branchPrefix?: string;
    requestedBranchName?: string | null;
    predecessorTopicId?: string | null;
  }): Topic {
    const settings = input.agentSettings ?? DEFAULT_AGENT_SETTINGS;
    this.db.prepare(`
      INSERT INTO topics (
        id, slug, title, repository_path, base_ref, worktree_path, branch_prefix, requested_branch_name, predecessor_topic_id, branch_name, state,
        scope_generation, plan_revision, plan_sha256, approved_plan_sha256,
        claude_model, claude_effort, codex_model, codex_effort,
        claude_impl_model, claude_impl_effort, codex_impl_model, codex_impl_effort,
        created_at, updated_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.slug, input.title, input.repositoryPath, input.baseRef, input.worktreePath,
      input.branchPrefix ?? "consensus",
      input.requestedBranchName ?? null,
      input.predecessorTopicId ?? null,
      input.branchName, input.state, input.scopeGeneration, input.planRevision, input.planSHA256,
      input.approvedPlanSHA256,
      settings.claude.model, settings.claude.effort, settings.codex.model, settings.codex.effort,
      settings.claude.implementation?.model ?? null, settings.claude.implementation?.effort ?? null,
      settings.codex.implementation?.model ?? null, settings.codex.implementation?.effort ?? null,
      input.createdAt, input.updatedAt, input.lastError,
    );
    return this.getTopic(input.id);
  }

  listTopics(): Topic[] {
    const rows = this.db.prepare("SELECT * FROM topics ORDER BY updated_at DESC").all();
    return rows.map((row) => this.mapTopic(row));
  }

  getTopic(id: string): Topic {
    const row = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(id);
    if (!row) throw new Error(`주제를 찾을 수 없습니다: ${id}`);
    return this.mapTopic(row);
  }

  getFlags(id: string): InternalTopicFlags {
    const row = this.db.prepare(
      `SELECT fix_pass_used, second_fix_pass_used, closeout_revision_used, resume_state, implementation_session_id, implementation_base_oid,
        implementation_prompt_sequence, reviewed_head, reviewed_diff_sha256, reviewed_tree_oid, committed_oid, pushed_oid, orphan_commit_oid
       FROM topics WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`주제를 찾을 수 없습니다: ${id}`);
    return {
      fixPassUsed: Number(row.fix_pass_used) === 1,
      secondFixPassUsed: Number(row.second_fix_pass_used) === 1,
      closeoutRevisionUsed: Number(row.closeout_revision_used) === 1,
      resumeState: (row.resume_state as WorkflowState | null) ?? null,
      implementationSessionId: (row.implementation_session_id as string | null) ?? null,
      implementationBaseOID: (row.implementation_base_oid as string | null) ?? null,
      implementationPromptSequence: row.implementation_prompt_sequence == null ? null : Number(row.implementation_prompt_sequence),
      reviewedHead: (row.reviewed_head as string | null) ?? null,
      reviewedDiffSHA256: (row.reviewed_diff_sha256 as string | null) ?? null,
      reviewedTreeOID: (row.reviewed_tree_oid as string | null) ?? null,
      committedOID: (row.committed_oid as string | null) ?? null,
      pushedOID: (row.pushed_oid as string | null) ?? null,
      orphanCommitOID: (row.orphan_commit_oid as string | null) ?? null,
    };
  }

  updateTopic(id: string, changes: Partial<{
    state: WorkflowState;
    scopeGeneration: number;
    planEpoch: number;
    planRevision: number;
    planSHA256: string | null;
    approvedPlanSHA256: string | null;
    branchName: string | null;
    lastError: string | null;
    fixPassUsed: boolean; secondFixPassUsed: boolean; closeoutRevisionUsed: boolean;
    resumeState: WorkflowState | null;
    implementationSessionId: string | null;
    worktreePath: string;
    implementationBaseOID: string | null;
    implementationPromptSequence: number | null;
    reviewedHead: string | null;
    reviewedDiffSHA256: string | null;
    reviewedTreeOID: string | null;
    committedOID: string | null;
    pushedOID: string | null;
    orphanCommitOID: string | null;
    predecessorTopicId: string | null;
    claudeModel: string;
    claudeEffort: AgentExecutionSettings["effort"];
    codexModel: string;
    codexEffort: AgentExecutionSettings["effort"];
    claudeImplModel: string | null;
    claudeImplEffort: AgentExecutionSettings["effort"] | null;
    codexImplModel: string | null;
    codexImplEffort: AgentExecutionSettings["effort"] | null;
  }>): Topic {
    const columns: Record<string, string> = {
      state: "state", scopeGeneration: "scope_generation", planEpoch: "plan_epoch", planRevision: "plan_revision",
      planSHA256: "plan_sha256", approvedPlanSHA256: "approved_plan_sha256",
      branchName: "branch_name", lastError: "last_error", fixPassUsed: "fix_pass_used", secondFixPassUsed: "second_fix_pass_used",
      closeoutRevisionUsed: "closeout_revision_used",
      resumeState: "resume_state", implementationSessionId: "implementation_session_id",
      worktreePath: "worktree_path",
      implementationBaseOID: "implementation_base_oid", implementationPromptSequence: "implementation_prompt_sequence",
      reviewedHead: "reviewed_head", reviewedDiffSHA256: "reviewed_diff_sha256",
      reviewedTreeOID: "reviewed_tree_oid", predecessorTopicId: "predecessor_topic_id",
      committedOID: "committed_oid", pushedOID: "pushed_oid",
      orphanCommitOID: "orphan_commit_oid",
      claudeModel: "claude_model", claudeEffort: "claude_effort",
      codexModel: "codex_model", codexEffort: "codex_effort",
      claudeImplModel: "claude_impl_model", claudeImplEffort: "claude_impl_effort",
      codexImplModel: "codex_impl_model", codexImplEffort: "codex_impl_effort",
    };
    const entries = Object.entries(changes);
    if (entries.length === 0) return this.getTopic(id);
    const assignments = entries.map(([key]) => `${columns[key]} = ?`);
    const values = entries.map(([key, value]) => key === "fixPassUsed" ? (value ? 1 : 0) : value) as SqlValue[];
    this.db.prepare(`UPDATE topics SET ${assignments.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...values, now(), id);
    return this.getTopic(id);
  }

  updateAgentSettings(
    topicId: string,
    role: ParticipantRole,
    settings: AgentExecutionSettings,
  ): Topic {
    return role === "claude"
      ? this.updateTopic(topicId, {
          claudeModel: settings.model, claudeEffort: settings.effort,
          claudeImplModel: settings.implementation?.model ?? null,
          claudeImplEffort: settings.implementation?.effort ?? null,
        })
      : this.updateTopic(topicId, {
          codexModel: settings.model, codexEffort: settings.effort,
          codexImplModel: settings.implementation?.model ?? null,
          codexImplEffort: settings.implementation?.effort ?? null,
        });
  }

  upsertParticipant(topicId: string, participant: Participant): void {
    this.db.prepare(`
      INSERT INTO participants(topic_id, role, session_id, mode, acknowledged_plan_sha256)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(topic_id, role) DO UPDATE SET
        session_id = excluded.session_id,
        mode = excluded.mode,
        acknowledged_plan_sha256 = excluded.acknowledged_plan_sha256
    `).run(topicId, participant.role, participant.sessionId, participant.mode, participant.acknowledgedPlanSHA256);
    this.updateTopic(topicId, {});
  }

  participantSessionInUse(topicId: string, role: ParticipantRole, sessionId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM participants WHERE role = ? AND session_id = ? AND topic_id <> ? LIMIT 1
    `).get(role, sessionId, topicId);
    if (row) return true;
    if (role === "codex") return Boolean(this.db.prepare(`
      SELECT 1 FROM codex_review_sessions WHERE session_id = ? AND topic_id <> ? LIMIT 1
    `).get(sessionId, topicId));
    return Boolean(this.db.prepare(`
      SELECT 1 FROM topics WHERE implementation_session_id = ? AND id <> ? LIMIT 1
    `).get(sessionId, topicId));
  }

  setImplementationSession(topicId: string, sessionId: string): void {
    if (this.participantSessionInUse(topicId, "claude", sessionId)) {
      throw new Error("이 Claude 구현 세션은 다른 주제에서 이미 사용 중입니다.");
    }
    // 세션이 바뀌면 '전달한 sequence' 도 무효다 — 새 세션은 첫 프롬프트에 전부 받았고, 그 값은 호출자가 턴 뒤에 다시 적는다.
    const current = this.getFlags(topicId);
    this.updateTopic(topicId, current.implementationSessionId === sessionId
      ? { implementationSessionId: sessionId }
      : { implementationSessionId: sessionId, implementationPromptSequence: null });
  }

  // 계획 세션은 보존한다. 리뷰 세션은 승인된 계획·범위·계획 회차가 같은 동안에만 이어 쓴다.
  getCodexReviewSession(topicId: string): string | null {
    const row = this.db.prepare(`
      SELECT r.session_id FROM codex_review_sessions r JOIN topics t ON t.id = r.topic_id
      WHERE r.topic_id = ? AND r.scope_generation = t.scope_generation
        AND r.plan_epoch = t.plan_epoch AND r.plan_sha256 = t.plan_sha256
        AND r.plan_sha256 = t.approved_plan_sha256
    `).get(topicId) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  setCodexReviewSession(topicId: string, sessionId: string): void {
    const topic = this.getTopic(topicId);
    if (!topic.planSHA256 || topic.approvedPlanSHA256 !== topic.planSHA256) {
      throw new Error("승인된 계획 없이 코드 리뷰 세션을 저장할 수 없습니다.");
    }
    if (!sessionId.trim() || sessionId.startsWith("pending:") ||
        topic.participants.some((participant) => participant.role === "codex" && participant.sessionId === sessionId) ||
        this.participantSessionInUse(topicId, "codex", sessionId)) {
      throw new Error("코드 리뷰 세션은 계획 세션 및 다른 주제 세션과 달라야 합니다.");
    }
    this.db.prepare(`
      INSERT INTO codex_review_sessions(topic_id, session_id, scope_generation, plan_epoch, plan_sha256)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(topic_id) DO UPDATE SET session_id = excluded.session_id,
        scope_generation = excluded.scope_generation, plan_epoch = excluded.plan_epoch, plan_sha256 = excluded.plan_sha256,
        prompt_sequence = NULL
    `).run(topicId, sessionId, topic.scopeGeneration, topic.planEpoch, topic.planSHA256);
  }

  getAutoRetry(topicId: string): AutoRetryState | null {
    const row = this.db.prepare("SELECT auto_retry_json FROM topics WHERE id = ?").get(topicId) as { auto_retry_json: string | null } | undefined;
    if (!row) throw new Error(`주제를 찾을 수 없습니다: ${topicId}`);
    if (!row.auto_retry_json) return null;
    try {
      const parsed = JSON.parse(row.auto_retry_json) as Partial<AutoRetryState>;
      return {
        attempts: Number(parsed.attempts ?? 0),
        lastFiredAt: parsed.lastFiredAt == null ? null : Number(parsed.lastFiredAt),
        scheduledAt: parsed.scheduledAt == null ? null : Number(parsed.scheduledAt),
        cancelled: Boolean(parsed.cancelled),
      };
    } catch {
      return null;
    }
  }

  setAutoRetry(topicId: string, state: AutoRetryState | null): void {
    this.db.prepare("UPDATE topics SET auto_retry_json = ? WHERE id = ?").run(state ? JSON.stringify(state) : null, topicId);
  }

  // 현재 유효한 리뷰 세션에 마지막으로 전달한 타임라인 sequence. 세션이 없거나 아직 한 턴도 안 돌았으면 null.
  getCodexReviewPromptSequence(topicId: string): number | null {
    const row = this.db.prepare(`
      SELECT r.prompt_sequence AS sequence FROM codex_review_sessions r JOIN topics t ON t.id = r.topic_id
      WHERE r.topic_id = ? AND r.scope_generation = t.scope_generation
        AND r.plan_epoch = t.plan_epoch AND r.plan_sha256 = t.plan_sha256
        AND r.plan_sha256 = t.approved_plan_sha256
    `).get(topicId) as { sequence: number | null } | undefined;
    return row?.sequence == null ? null : Number(row.sequence);
  }

  setCodexReviewPromptSequence(topicId: string, sequence: number): void {
    this.db.prepare("UPDATE codex_review_sessions SET prompt_sequence = ? WHERE topic_id = ?").run(sequence, topicId);
  }

  acknowledge(topicId: string, role: ParticipantRole, sha256: string): void {
    const result = this.db.prepare(
      "UPDATE participants SET acknowledged_plan_sha256 = ? WHERE topic_id = ? AND role = ?",
    ).run(sha256, topicId, role);
    if (Number(result.changes) !== 1) throw new Error(`${role} 세션이 연결되지 않았습니다.`);
  }

  clearAcknowledgements(topicId: string): void {
    this.db.prepare(
      "UPDATE participants SET acknowledged_plan_sha256 = NULL WHERE topic_id = ?",
    ).run(topicId);
  }

  appendEvent(input: TimelineEventInput): TimelineEvent {
    let event!: TimelineEvent;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      event = this.insertEventInTransaction(input);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.emitEvent(event);
    return event;
  }

  // 상태 전이와 그 기록(복구 마커 포함)을 한 transaction으로 묶는다. 둘 사이에 서버가 죽으면
  // 복구가 "마커 없음 = 미실행"으로 오판해 같은 조작을 새 키로 중복 실행하기 때문에,
  // 함께 성공하거나 함께 없던 일이 되어야 한다.
  applyTopicTransition(input: {
    topicId: string;
    changes: Parameters<ConsensusDatabase["updateTopic"]>[1];
    clearAcknowledgements?: boolean;
    participants?: Participant[];
    events: Array<Omit<TimelineEventInput, "topicId">>;
  }): Topic {
    const recorded: TimelineEvent[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.updateTopic(input.topicId, input.changes);
      if (input.clearAcknowledgements) this.clearAcknowledgements(input.topicId);
      for (const participant of input.participants ?? []) {
        this.upsertParticipant(input.topicId, participant);
      }
      for (const event of input.events) {
        recorded.push(this.insertEventInTransaction({ ...event, topicId: input.topicId }));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const event of recorded) this.emitEvent(event);
    return this.getTopic(input.topicId);
  }

  private insertEventInTransaction(input: TimelineEventInput): TimelineEvent {
    const topicRow = this.db.prepare("SELECT scope_generation FROM topics WHERE id = ?")
      .get(input.topicId) as { scope_generation: number } | undefined;
    if (!topicRow) throw new Error(`주제를 찾을 수 없습니다: ${input.topicId}`);
    const scopeGeneration = Number(topicRow.scope_generation);
    const sequenceRow = this.db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM timeline_events WHERE topic_id = ?",
    ).get(input.topicId) as { sequence: number };
    const createdAt = now();
    const result = this.db.prepare(`
      INSERT INTO timeline_events(
        topic_id, sequence, scope_generation, actor, kind, state, body, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.topicId, sequenceRow.sequence, scopeGeneration, input.actor, input.kind, input.state,
      input.body, JSON.stringify(input.payload ?? {}), createdAt,
    );
    return TimelineEventSchema.parse({
      id: Number(result.lastInsertRowid), topicId: input.topicId, sequence: sequenceRow.sequence,
      scopeGeneration, actor: input.actor, kind: input.kind, state: input.state, body: input.body,
      payload: input.payload ?? {}, createdAt,
    });
  }

  private emitEvent(event: TimelineEvent): void {
    try {
      this.events.emit(`topic:${event.topicId}`, event);
    } catch {
      // 구독자 오류는 이미 확정된 원장 기록을 실패나 롤백처럼 보이게 만들지 않는다.
    }
  }

  getTimeline(topicId: string, afterSequence = 0): TimelineEvent[] {
    const rows = this.db.prepare(
      "SELECT * FROM timeline_events WHERE topic_id = ? AND sequence > ? ORDER BY sequence",
    ).all(topicId, afterSequence);
    return rows.map((row) => this.mapEvent(row));
  }

  // 프롬프트 전용 조회 — 이전 범위 세대의 응답과 취소된 결정이 새 세대 프롬프트에 섞이지 않게 한다.
  // 프롬프트 렌더(renderTimeline)는 중요 이벤트 전부 + 최근 80개만 쓴다. 그런데 매 턴 타임라인
  // 전체를 읽어 파싱한 뒤 버리고 있었다(감사 최적화 지적) — 필요한 행만 SQL로 고른다.
  // payload.usage 가 있는 행(턴 사용량 기록)은 프롬프트에 넣지 않는다 — 에이전트에게 되돌아가면 그 줄이 곧 입력 비용이다.
  // afterSequence: 이어지는 턴은 세션이 이미 받은 이벤트를 다시 싣지 않는다(2026-09-08 Codex 제안 ⑥).
  getPromptTimeline(topicId: string, scopeGeneration: number, afterSequence = 0): TimelineEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM timeline_events
      WHERE topic_id = ? AND scope_generation = ? AND sequence > ? AND json_extract(payload_json, '$.usage') IS NULL AND json_extract(payload_json, '$.promptMetrics') IS NULL AND json_extract(payload_json, '$.verificationMetrics') IS NULL AND (
        kind IN ('scope_change', 'evidence', 'decision')
        OR sequence IN (
          SELECT sequence FROM timeline_events
          WHERE topic_id = ? AND scope_generation = ? AND json_extract(payload_json, '$.usage') IS NULL AND json_extract(payload_json, '$.promptMetrics') IS NULL AND json_extract(payload_json, '$.verificationMetrics') IS NULL
          ORDER BY sequence DESC LIMIT 80
        )
      )
      ORDER BY sequence
    `).all(topicId, scopeGeneration, afterSequence, topicId, scopeGeneration) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapEvent(row));
  }

  maxSequence(topicId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM timeline_events WHERE topic_id = ?",
    ).get(topicId) as Record<string, unknown>;
    return Number(row.sequence);
  }

  timelineCount(topicId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM timeline_events WHERE topic_id = ?",
    ).get(topicId) as Record<string, unknown>;
    return Number(row.count);
  }

  getScopedTimeline(topicId: string, scopeGeneration: number, afterSequence = 0): TimelineEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM timeline_events
      WHERE topic_id = ? AND scope_generation = ? AND sequence > ? ORDER BY sequence
    `).all(topicId, scopeGeneration, afterSequence);
    return rows.map((row) => this.mapEvent(row));
  }

  addArtifact(topicId: string, artifact: StoredArtifact): void {
    this.db.prepare(`
      INSERT INTO artifacts(topic_id, kind, revision, scope_generation, sha256, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      topicId, artifact.kind, artifact.revision, artifact.scopeGeneration,
      artifact.sha256, artifact.path, artifact.createdAt,
    );
  }

  latestArtifact(topicId: string, kind: string, scopeGeneration?: number): StoredArtifact | null {
    const generation = scopeGeneration ?? this.getTopic(topicId).scopeGeneration;
    const row = this.db.prepare(`
      SELECT kind, revision, scope_generation, sha256, path, created_at FROM artifacts
      WHERE topic_id = ? AND kind = ? AND scope_generation = ? ORDER BY revision DESC LIMIT 1
    `).get(topicId, kind, generation) as Record<string, unknown> | undefined;
    return row ? {
      kind: String(row.kind), revision: Number(row.revision), sha256: String(row.sha256),
      scopeGeneration: Number(row.scope_generation), path: String(row.path), createdAt: String(row.created_at),
    } : null;
  }

  latestArtifactRevision(topicId: string, kind: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(revision), 0) AS revision FROM artifacts
      WHERE topic_id = ? AND kind = ?
    `).get(topicId, kind) as { revision: number };
    return Number(row.revision);
  }

  artifactsForScope(topicId: string, kind: string, scopeGeneration?: number): StoredArtifact[] {
    const generation = scopeGeneration ?? this.getTopic(topicId).scopeGeneration;
    const rows = this.db.prepare(`
      SELECT kind, revision, scope_generation, sha256, path, created_at FROM artifacts
      WHERE topic_id = ? AND kind = ? AND scope_generation = ? ORDER BY revision DESC
    `).all(topicId, kind, generation) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      kind: String(row.kind), revision: Number(row.revision), scopeGeneration: Number(row.scope_generation),
      sha256: String(row.sha256), path: String(row.path), createdAt: String(row.created_at),
    }));
  }

  startAction(record: ActionRecord): void {
    this.db.prepare(`
      INSERT INTO actions(id, topic_id, kind, status, created_at, finished_at, error, pid, pgid, process_executable, process_command, process_started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.topicId, record.kind, record.status, record.createdAt,
      record.finishedAt, record.error, record.pid, record.pgid, record.processExecutable,
      record.processCommand, record.processStartedAt,
    );
  }

  recordActionProcess(id: string, process: {
    pid: number;
    pgid: number;
    executable: string;
    commandLine: string;
    startedAt: string;
  }): void {
    const result = this.db.prepare(`
      UPDATE actions SET pid = ?, pgid = ?, process_executable = ?, process_command = ?, process_started_at = ?
      WHERE id = ? AND status = 'running'
    `).run(process.pid, process.pgid, process.executable, process.commandLine, process.startedAt, id);
    if (Number(result.changes) !== 1) throw new Error("실행 중인 action에 프로세스를 연결할 수 없습니다.");
  }

  finishAction(id: string, status: ActionRecord["status"], error: string | null = null): void {
    this.db.prepare("UPDATE actions SET status = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(status, now(), error, id);
  }

  finishActionAndFailTopic(input: {
    actionId: string;
    topicId: string;
    actionStatus: Extract<ActionRecord["status"], "failed" | "cancelled">;
    error: string;
    expectedScopeGeneration: number;
  }): { actionFinished: boolean; topicFailed: boolean } {
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const actionResult = this.db.prepare(`
        UPDATE actions SET status = ?, finished_at = ?, error = ?
        WHERE id = ? AND topic_id = ? AND status = 'running'
      `).run(input.actionStatus, timestamp, input.error, input.actionId, input.topicId);
      if (Number(actionResult.changes) !== 1) {
        throw new Error("실행 중인 action을 종료할 수 없습니다.");
      }
      const stateRow = this.db.prepare("SELECT state FROM topics WHERE id = ?")
        .get(input.topicId) as { state: string } | undefined;
      if (!stateRow) throw new Error(`주제를 찾을 수 없습니다: ${input.topicId}`);
      if (COMPLETED_TOPIC_STATES.has(stateRow.state as WorkflowState)) {
        // 주제를 바꾸지 않는 경로다. 바꿀 대상이 없으니 세대 일치 조건도 적용할 곳이 없다.
        this.db.exec("COMMIT");
        return { actionFinished: true, topicFailed: false };
      }
      const topicResult = this.db.prepare(`
        UPDATE topics SET
          resume_state = CASE WHEN state = 'FAILED' THEN NULL ELSE state END,
          state = 'FAILED', last_error = ?, updated_at = ?
        WHERE id = ? AND scope_generation = ?
      `).run(input.error, timestamp, input.topicId, input.expectedScopeGeneration);
      if (Number(topicResult.changes) !== 1) {
        throw new Error("action과 같은 범위 세대의 주제를 실패 상태로 바꿀 수 없습니다.");
      }
      this.db.exec("COMMIT");
      return { actionFinished: true, topicFailed: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  runningAction(topicId: string): ActionRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM actions WHERE topic_id = ? AND status = 'running' LIMIT 1",
    ).get(topicId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapAction(row);
  }

  runningActions(): ActionRecord[] {
    const rows = this.db.prepare("SELECT * FROM actions WHERE status = 'running'").all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapAction(row));
  }

  getAction(id: string): ActionRecord | null {
    const row = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapAction(row);
  }

  claimActionRequest(topicId: string, action: string, idempotencyKey: string, request: unknown = {}): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO action_requests(
        topic_id, action, idempotency_key, created_at, status, request_json
      ) VALUES (?, ?, ?, ?, 'running', ?)
    `).run(topicId, action, idempotencyKey, now(), JSON.stringify(request));
    return Number(result.changes) === 1;
  }

  getActionRequest(topicId: string, action: string, idempotencyKey: string): {
    status: "running" | "succeeded" | "failed" | "unknown";
    response: unknown;
    error: string | null;
    request: Record<string, unknown>;
  } | null {
    const row = this.db.prepare(`
      SELECT status, response_json, error, request_json FROM action_requests
      WHERE topic_id = ? AND action = ? AND idempotency_key = ?
    `).get(topicId, action, idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      status: row.status as "running" | "succeeded" | "failed" | "unknown",
      response: row.response_json ? JSON.parse(String(row.response_json)) : null,
      error: row.error ? String(row.error) : null,
      request: parseRequestRecord(row.request_json),
    };
  }

  finishActionRequest(topicId: string, action: string, idempotencyKey: string, response: unknown): void {
    this.db.prepare(`
      UPDATE action_requests SET status = 'succeeded', response_json = ?, error = NULL
      WHERE topic_id = ? AND action = ? AND idempotency_key = ? AND status = 'running'
    `).run(JSON.stringify(response), topicId, action, idempotencyKey);
  }

  failActionRequest(topicId: string, action: string, idempotencyKey: string, error: string): void {
    this.db.prepare(`
      UPDATE action_requests SET status = 'failed', error = ?
      WHERE topic_id = ? AND action = ? AND idempotency_key = ? AND status = 'running'
    `).run(error, topicId, action, idempotencyKey);
  }

  claimGlobalRequest(scope: string, idempotencyKey: string, request: unknown = {}): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO global_requests(
        scope, idempotency_key, created_at, status, request_json
      ) VALUES (?, ?, ?, 'running', ?)
    `).run(scope, idempotencyKey, now(), JSON.stringify(request));
    return Number(result.changes) === 1;
  }

  getGlobalRequest(scope: string, idempotencyKey: string): {
    status: "running" | "succeeded" | "failed" | "unknown";
    response: unknown;
    error: string | null;
    request: Record<string, unknown>;
  } | null {
    const row = this.db.prepare(`
      SELECT status, response_json, error, request_json FROM global_requests
      WHERE scope = ? AND idempotency_key = ?
    `).get(scope, idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      status: row.status as "running" | "succeeded" | "failed" | "unknown",
      response: row.response_json ? JSON.parse(String(row.response_json)) : null,
      error: row.error ? String(row.error) : null,
      request: parseRequestRecord(row.request_json),
    };
  }

  // claim 이후·부작용 이전에 계획된 결과물의 좌표를 남긴다. 재시작 복구가 완료 여부를 판정할 유일한 근거다.
  annotateGlobalRequest(scope: string, idempotencyKey: string, annotation: Record<string, unknown>): void {
    const existing = this.getGlobalRequest(scope, idempotencyKey);
    if (!existing || existing.status !== "running") {
      throw new Error("실행 중인 요청에만 계획 정보를 남길 수 있습니다.");
    }
    const row = this.db.prepare(
      "SELECT planned_json FROM global_requests WHERE scope = ? AND idempotency_key = ?",
    ).get(scope, idempotencyKey) as Record<string, unknown> | undefined;
    const planned = parseRequestRecord(row?.planned_json);
    this.db.prepare(`
      UPDATE global_requests SET planned_json = ?
      WHERE scope = ? AND idempotency_key = ? AND status = 'running'
    `).run(JSON.stringify({ ...planned, ...annotation }), scope, idempotencyKey);
  }

  finishGlobalRequest(scope: string, idempotencyKey: string, response: unknown): void {
    this.db.prepare(`
      UPDATE global_requests SET status = 'succeeded', response_json = ?, error = NULL
      WHERE scope = ? AND idempotency_key = ? AND status = 'running'
    `).run(JSON.stringify(response), scope, idempotencyKey);
  }

  failGlobalRequest(scope: string, idempotencyKey: string, error: string): void {
    this.db.prepare(`
      UPDATE global_requests SET status = 'failed', error = ?
      WHERE scope = ? AND idempotency_key = ? AND status = 'running'
    `).run(error, scope, idempotencyKey);
  }

  recoverInterruptedDeliveryRequests(): void {
    const rows = this.db.prepare(`
      SELECT DISTINCT topic_id FROM action_requests
      WHERE status = 'running' AND action IN ('commit', 'push')
    `).all() as Array<Record<string, unknown>>;
    this.db.prepare(`
      UPDATE action_requests SET status = 'unknown',
        error = '서버가 전달 작업 도중 종료되어 Git 결과를 직접 확인해야 합니다.'
      WHERE status = 'running' AND action IN ('commit', 'push')
    `).run();
    for (const row of rows) {
      this.updateTopic(String(row.topic_id), {
        state: "USER_DECISION_REQUIRED",
        lastError: "서버가 커밋 또는 push 도중 종료되었습니다. Git 결과를 확인한 뒤 다음 동작을 결정해 주세요.",
        resumeState: "READY_TO_DELIVER",
      });
    }
  }

  // 서버가 죽은 시점이 부작용 전인지 후인지 추측하지 않는다. 이벤트에 남긴 requestKey 마커가 있으면
  // 부작용이 이미 끝난 것이므로 succeeded로 닫아 같은 키 재전송이 저장 응답을 재생하게 하고,
  // 마커가 없을 때만 failed로 바꿔 새 실행을 허용한다. 마커 없이 failed 일괄 전환하면
  // 완료된 메시지·세대 변경이 새 키로 중복 실행된다.
  recoverInterruptedNonDeliveryRequests(): void {
    const rows = this.db.prepare(`
      SELECT topic_id, action, idempotency_key FROM action_requests
      WHERE status = 'running' AND action NOT IN ('commit', 'push')
    `).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const topicId = String(row.topic_id);
      const action = String(row.action);
      const key = String(row.idempotency_key);
      if (this.timelineHasRequestKey(topicId, action, key)) {
        // 원본 응답은 복구할 수 없어 현재 주제 상태로 재구성한다. 재생 응답이 원본과 완전히 같지는 않다.
        const response = { accepted: true, actionId: key, topic: this.getTopic(topicId), recovered: true };
        this.db.prepare(`
          UPDATE action_requests SET status = 'succeeded', response_json = ?, error = NULL
          WHERE topic_id = ? AND action = ? AND idempotency_key = ? AND status = 'running'
        `).run(JSON.stringify(response), topicId, action, key);
        continue;
      }
      this.db.prepare(`
        UPDATE action_requests SET status = 'failed',
          error = '서버가 요청 처리 도중 종료되었고 완료 기록이 없습니다. 현재 주제 상태를 확인하고 새 요청으로 다시 실행해 주세요.'
        WHERE topic_id = ? AND action = ? AND idempotency_key = ? AND status = 'running'
      `).run(topicId, action, key);
    }
  }

  private timelineHasRequestKey(topicId: string, action: string, requestKey: string): boolean {
    const rows = this.db.prepare(
      "SELECT payload_json FROM timeline_events WHERE topic_id = ? ORDER BY sequence",
    ).all(topicId) as Array<Record<string, unknown>>;
    return rows.some((row) => {
      try {
        const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
        if (payload.requestKey !== requestKey) return false;
        // 다른 action이 같은 키 문자열을 썼을 때 서로의 완료 마커를 가로채지 않는다(감사 부차 지적).
        // requestAction이 없는 마커는 이 필드가 생기기 전 기록이므로 기존 의미(키만 대조)로 접는다.
        return payload.requestAction === undefined || payload.requestAction === action;
      } catch {
        return false;
      }
    });
  }

  recoverInterruptedGlobalRequests(): void {
    const rows = this.db.prepare(
      "SELECT scope, idempotency_key, request_json, planned_json FROM global_requests WHERE status = 'running'",
    ).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const scope = String(row.scope);
      const key = String(row.idempotency_key);
      // planned_json이 정본. 컬럼 도입 전 행은 request_json에 합쳐져 있던 값으로 접는다.
      const planned: Record<string, unknown> = {
        ...parseRequestRecord(row.request_json),
        ...parseRequestRecord(row.planned_json),
      };
      const plannedTopicId = typeof planned.plannedTopicId === "string" ? planned.plannedTopicId : null;
      const topicExists = plannedTopicId
        ? Boolean(this.db.prepare("SELECT 1 FROM topics WHERE id = ?").get(plannedTopicId))
        : false;
      if (topicExists && plannedTopicId) {
        this.db.prepare(`
          UPDATE global_requests SET status = 'succeeded', response_json = ?, error = NULL
          WHERE scope = ? AND idempotency_key = ? AND status = 'running'
        `).run(JSON.stringify(this.getTopic(plannedTopicId)), scope, key);
        continue;
      }
      const worktreeNote = typeof planned.worktreePath === "string"
        ? ` 만들다 만 worktree가 남았을 수 있습니다: ${planned.worktreePath} — 확인 후 직접 정리해 주세요. 자동으로 지우지 않습니다.`
        : " 남은 worktree가 있는지 확인해 주세요.";
      this.db.prepare(`
        UPDATE global_requests SET status = 'failed',
          error = ?
        WHERE scope = ? AND idempotency_key = ? AND status = 'running'
      `).run(`서버가 종료되었고 이 요청의 완료 기록이 없습니다.${worktreeNote}`, scope, key);
    }
  }

  unknownDeliveryAction(topicId: string): {
    action: "commit" | "push";
    idempotencyKey: string;
    createdAt: string;
    request: Record<string, unknown>;
  } | null {
    const row = this.db.prepare(`
      SELECT action, idempotency_key, created_at, request_json FROM action_requests
      WHERE topic_id = ? AND status = 'unknown' AND action IN ('commit', 'push')
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(topicId) as Record<string, unknown> | undefined;
    if (row?.action !== "commit" && row?.action !== "push") return null;
    return {
      action: row.action,
      idempotencyKey: String(row.idempotency_key),
      createdAt: String(row.created_at),
      request: row.request_json ? JSON.parse(String(row.request_json)) as Record<string, unknown> : {},
    };
  }

  resolveUnknownDeliveryAction(
    topicId: string,
    action: "commit" | "push",
    idempotencyKey: string,
    outcome: "succeeded" | "failed",
  ): void {
    const result = this.db.prepare(`
      UPDATE action_requests SET status = 'failed',
        error = ?
      WHERE topic_id = ? AND action = ? AND idempotency_key = ? AND status = 'unknown'
    `).run(
      `서버 재시작 뒤 사용자가 Git 결과를 ${outcome === "succeeded" ? "성공" : "실패"}으로 별도 확인했습니다. 원래 요청은 재실행할 수 없습니다.`,
      topicId,
      action,
      idempotencyKey,
    );
    if (Number(result.changes) !== 1) throw new Error("확인할 전달 요청이 이미 바뀌었거나 존재하지 않습니다.");
  }

  private mapTopic(raw: unknown): Topic {
    const row = raw as Record<string, unknown>;
    const participants = this.db.prepare(
      "SELECT role, session_id, mode, acknowledged_plan_sha256 FROM participants WHERE topic_id = ? ORDER BY role",
    ).all(String(row.id)).map((item) => {
      const value = item as Record<string, unknown>;
      return ParticipantSchema.parse({
        role: value.role, sessionId: value.session_id, mode: value.mode,
        acknowledgedPlanSHA256: value.acknowledged_plan_sha256,
      });
    });
    return TopicSchema.parse({
      id: row.id, slug: row.slug, title: row.title, repositoryPath: row.repository_path,
      baseRef: row.base_ref, worktreePath: row.worktree_path,
      branchPrefix: row.branch_prefix ?? "consensus",
      requestedBranchName: row.requested_branch_name ?? null, predecessorTopicId: (row.predecessor_topic_id as string | null) ?? null,
      branchName: row.branch_name,
      state: row.state, scopeGeneration: Number(row.scope_generation),
      planEpoch: Number(row.plan_epoch ?? 1),
      planRevision: Number(row.plan_revision), planSHA256: row.plan_sha256,
      approvedPlanSHA256: row.approved_plan_sha256,
      agentSettings: {
        claude: {
          model: row.claude_model, effort: row.claude_effort,
          ...(row.claude_impl_model && row.claude_impl_effort
            ? { implementation: { model: row.claude_impl_model, effort: row.claude_impl_effort } } : {}),
        },
        codex: {
          model: row.codex_model, effort: row.codex_effort,
          ...(row.codex_impl_model && row.codex_impl_effort
            ? { implementation: { model: row.codex_impl_model, effort: row.codex_impl_effort } } : {}),
        },
      },
      participants,
      createdAt: row.created_at, updatedAt: row.updated_at, lastError: row.last_error,
    });
  }

  private mapEvent(raw: unknown): TimelineEvent {
    const row = raw as Record<string, unknown>;
    return TimelineEventSchema.parse({
      id: Number(row.id), topicId: row.topic_id, sequence: Number(row.sequence),
      scopeGeneration: Number(row.scope_generation), actor: row.actor, kind: row.kind,
      state: row.state, body: row.body,
      payload: JSON.parse(String(row.payload_json)), createdAt: row.created_at,
    });
  }

  private mapAction(row: Record<string, unknown>): ActionRecord {
    return {
      id: String(row.id), topicId: String(row.topic_id), kind: String(row.kind),
      status: row.status as ActionRecord["status"], createdAt: String(row.created_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      error: row.error ? String(row.error) : null,
      pid: row.pid == null ? null : Number(row.pid),
      pgid: row.pgid == null ? null : Number(row.pgid),
      processCommand: row.process_command ? String(row.process_command) : null,
      processExecutable: row.process_executable ? String(row.process_executable) : null,
      processStartedAt: row.process_started_at ? String(row.process_started_at) : null,
    };
  }
}

function parseRequestRecord(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? "{}")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
