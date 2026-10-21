import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ConsensusDatabase } from "./database.js";
import type { CommandRunner } from "./types.js";
import { agentEnvironment } from "./security.js";
import { EngineDefectReportSchema, type EngineDefectClosureInput, type EngineDefectNotApplicableKind } from "../shared/engineDefects.js";
import { redactSecrets } from "../shared/workflow.js";

export const EngineDefectInput = EngineDefectReportSchema;
// The ledger keeps reported defects for the master to triage and assign. Repairs run as Claude worker tasks under
// work-admission, never in this server (user decision 2026-10-15). Rows the removed automatic repair queue wrote keep
// its statuses and fields (fix commit, review receipt, budget execution, wait reason), so they read as recorded.
export interface EngineDefect extends z.infer<typeof EngineDefectInput> {
  id: string; topicId: string; status: "todo" | "executing" | "reviewing" | "ready_to_apply" | "applying" | "passed" | "blocked" | "closed";
  createdAt: string; updatedAt: string; actionId?: string; base?: string; head?: string;
  worktree?: string; error?: string; review?: unknown;
  engineRepository?: string;
  reviewExecutionId?: string;
  budgetAccounts?: string[];
  waiting?: string;
  // Why a person took this defect out of the queue (status closed). The defect and its history stay; the queue skips it.
  closure?: { reason: "fixed"; commit: string; note?: string; actor: "user"; at: string }
    | { reason: "duplicate"; representativeId: string; note?: string; actor: "user"; at: string }
    | { reason: "not_applicable"; kind: EngineDefectNotApplicableKind; finding: string; basis: string; decidedBy: string;
      note?: string; actor: "user"; at: string };
  readyAt?: string; metrics?: { queueWaitMs?: number; applyWaitMs?: number; maintenanceLockMs?: number; reviewDurationMs?: number };
}

// A report is data, not authority: only the authenticated registration route enqueues it.
export class EngineDefectStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS engine_defects (
      id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id),
      defect_key TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL,
      UNIQUE(topic_id,defect_key));`);
  }
  list(topicId?: string): EngineDefect[] {
    return this.db.prepare("SELECT record_json FROM engine_defects ORDER BY rowid").all()
      .map(row => JSON.parse(String(row.record_json)) as EngineDefect)
      .filter(row => topicId === undefined || row.topicId === topicId);
  }
  get(id: string): EngineDefect {
    const row = this.db.prepare("SELECT record_json FROM engine_defects WHERE id=?").get(id);
    if (!row) throw new Error("엔진 결함 To-do가 없습니다.");
    return JSON.parse(String(row.record_json)) as EngineDefect;
  }
  enqueue(topicId: string, input: z.infer<typeof EngineDefectInput>): EngineDefect {
    const existing = this.list(topicId).find(row => row.key === input.key);
    if (existing) {
      if (existing.title !== input.title || existing.evidence !== input.evidence || existing.workaround !== input.workaround) {
        throw Object.assign(new Error("같은 결함 key의 근거가 다릅니다. 새 key로 변경 근거를 등록하세요."), { statusCode: 409 });
      }
      return existing;
    }
    const now = new Date().toISOString();
    const row: EngineDefect = { ...input, id: randomUUID(), topicId, status: "todo", createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO engine_defects VALUES(?,?,?,?,?)")
      .run(row.id, topicId, row.key, row.status, JSON.stringify(row));
    return row;
  }
  save(row: EngineDefect): void {
    // closed is terminal: a writer holding a copy read before the closure records its fact on the row but never reopens
    // it, and the closure stays as the person left it.
    const stored = this.db.prepare("SELECT record_json FROM engine_defects WHERE id=?").get(row.id);
    const previous = stored ? JSON.parse(String(stored.record_json)) as EngineDefect : undefined;
    if (previous?.status === "closed") Object.assign(row, { status: "closed", closure: previous.closure });
    row.updatedAt = new Date().toISOString();
    this.db.prepare("UPDATE engine_defects SET status=?,record_json=? WHERE id=?")
      .run(row.status, JSON.stringify(row), row.id);
  }
}

// A person's closure of a waiting defect: one already fixed by a commit the engine checkout contains, a duplicate of
// another defect, or one judged to need no engine repair. It reads git only to resolve that commit; it never runs a
// model, a review or a merge. A not_applicable judgment is recorded as given, with its finding, basis and source.
export class EngineDefectCloser {
  constructor(private readonly db: ConsensusDatabase, private readonly runner: CommandRunner,
    private readonly repository: string) {}
  async close(id: string, input: EngineDefectClosureInput): Promise<EngineDefect> {
    const refuse = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
    const closable = () => {
      let row: EngineDefect;
      try { row = this.db.engineDefects.get(id); } catch { throw refuse("엔진 결함 To-do가 없습니다.", 404); }
      if (row.status !== "todo" && row.status !== "blocked") throw refuse(`todo·blocked 결함만 종결할 수 있습니다(현재 ${row.status}).`, 409);
      return row;
    };
    closable();
    const note = input.note ? { note: redactSecrets(input.note) } : {};
    let closure: NonNullable<EngineDefect["closure"]>, because: string;
    if (input.reason === "fixed") {
      const commit = await this.mergedCommit(input.commit, refuse);
      closure = { reason: "fixed", commit, ...note, actor: "user", at: new Date().toISOString() };
      because = `이미 고쳐짐(${commit.slice(0, 12)})`;
    } else if (input.reason === "duplicate") {
      if (input.representativeId === id) throw refuse("자기 자신을 대표 결함으로 지정할 수 없습니다.", 400);
      let representative: EngineDefect;
      try { representative = this.db.engineDefects.get(input.representativeId); }
      catch { throw refuse(`대표 결함이 없습니다: ${input.representativeId}`, 400); }
      // The representative stands for this defect, so it is not itself closed as a duplicate (which would also let a cycle form).
      if (representative.closure?.reason === "duplicate") {
        throw refuse(`대표 결함도 중복으로 종결됐습니다. 그 대표(${representative.closure.representativeId})를 지정하세요.`, 400);
      }
      closure = { reason: "duplicate", representativeId: input.representativeId, ...note, actor: "user", at: new Date().toISOString() };
      because = `중복(대표 ${input.representativeId})`;
    } else {
      closure = { reason: "not_applicable", kind: input.kind, finding: redactSecrets(input.finding), basis: redactSecrets(input.basis),
        decidedBy: redactSecrets(input.decidedBy), ...note, actor: "user", at: new Date().toISOString() };
      because = `비수리 종결(${input.kind})`;
    }
    // The commit check awaited git, so another closure may have closed the defect meanwhile.
    const row = closable();
    this.db.engineDefects.save({ ...row, status: "closed", closure, waiting: undefined });
    this.db.appendEvent({ topicId: row.topicId, actor: "system", kind: "system", state: this.db.getTopic(row.topicId).state,
      body: `엔진 결함 종결(사용자): ${row.title} — ${because}`, payload: { engineDefectId: row.id, closure } });
    return this.db.engineDefects.get(id);
  }
  // The full SHA of a commit the engine checkout's HEAD already contains.
  private async mergedCommit(commit: string, refuse: (message: string, statusCode: number) => Error): Promise<string> {
    const git = (args: string[]) => this.runner.run({ command: "git", args, cwd: this.repository, environment: agentEnvironment() });
    const resolved = await git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
    if (resolved.exitCode !== 0) throw refuse(`엔진 저장소에 없는 커밋입니다: ${commit}`, 400);
    const full = resolved.stdout.trim();
    const contained = await git(["merge-base", "--is-ancestor", full, "HEAD"]);
    if (contained.exitCode === 1) throw refuse(`엔진 정본 HEAD 에 들어 있지 않은 커밋입니다: ${commit}`, 400);
    if (contained.exitCode !== 0) throw new Error(`git merge-base 실패: ${contained.stderr.slice(-2000)}`);
    return full;
  }
}
