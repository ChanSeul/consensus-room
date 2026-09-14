// 중재자 진단 저장소(표 연산만 — 트랜잭션은 호출자 ConsensusDatabase 가 연다).
//
// diagnoses      진단 본문과 서버 결속(등록 시점의 세대·계획·실패·체크포인트·작업 트리). **UPDATE 하지 않는다** — 정정은 새 행이다.
// diagnosis_log  상태 이력(추가 전용). 현재 상태 = 마지막 행. 적용 경로·전달·처분·해결·대체가 모두 여기에 쌓인다.
import type { DatabaseSync } from "node:sqlite";

import {
  DIAGNOSIS_STATUSES, type DiagnosisBinding, type DiagnosisHistoryEntry, type DiagnosisInput, type DiagnosisOrigin,
  type DiagnosisRecord, type DiagnosisStatus,
} from "../shared/diagnoses.js";

export class DiagnosisStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS diagnoses (
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        number INTEGER NOT NULL,
        kind TEXT NOT NULL,
        input_json TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        origin_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(topic_id, id),
        UNIQUE(topic_id, number)
      );
      CREATE TABLE IF NOT EXISTS diagnosis_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        diagnosis_id TEXT NOT NULL,
        status TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS diagnosis_log_topic ON diagnosis_log(topic_id, diagnosis_id, seq);
    `);
  }

  nextNumber(topicId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM diagnoses WHERE topic_id = ?").get(topicId) as { next: number };
    return Number(row.next);
  }

  insert(row: {
    topicId: string; id: string; number: number; input: DiagnosisInput; binding: DiagnosisBinding; origin: DiagnosisOrigin | null; createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO diagnoses(topic_id, id, number, kind, input_json, binding_json, origin_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.topicId, row.id, row.number, row.input.kind, JSON.stringify(row.input), JSON.stringify(row.binding),
      row.origin ? JSON.stringify(row.origin) : null, row.createdAt);
  }

  log(topicId: string, diagnosisId: string, status: DiagnosisStatus, detail: Record<string, unknown>, at: string): void {
    if (!DIAGNOSIS_STATUSES.includes(status)) throw new Error(`알 수 없는 진단 상태입니다: ${status}`);
    this.db.prepare("INSERT INTO diagnosis_log(topic_id, diagnosis_id, status, detail_json, at) VALUES (?, ?, ?, ?, ?)")
      .run(topicId, diagnosisId, status, JSON.stringify(detail), at);
  }

  get(topicId: string, id: string): DiagnosisRecord | null {
    const row = this.db.prepare("SELECT * FROM diagnoses WHERE topic_id = ? AND id = ?").get(topicId, id) as Record<string, unknown> | undefined;
    return row ? this.map(row) : null;
  }

  list(topicId: string): DiagnosisRecord[] {
    const rows = this.db.prepare("SELECT * FROM diagnoses WHERE topic_id = ? ORDER BY number").all(topicId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.map(row));
  }

  private map(row: Record<string, unknown>): DiagnosisRecord {
    const topicId = String(row.topic_id);
    const id = String(row.id);
    const history = (this.db.prepare("SELECT seq, status, detail_json, at FROM diagnosis_log WHERE topic_id = ? AND diagnosis_id = ? ORDER BY seq")
      .all(topicId, id) as Array<Record<string, unknown>>)
      .map((entry): DiagnosisHistoryEntry => ({
        seq: Number(entry.seq), status: String(entry.status) as DiagnosisStatus,
        detail: JSON.parse(String(entry.detail_json)) as Record<string, unknown>, at: String(entry.at),
      }));
    const status = history.at(-1)?.status;
    if (!status) throw new Error(`진단 ${id} 의 상태 기록이 없습니다(손상).`);
    return {
      id, topicId, number: Number(row.number),
      input: JSON.parse(String(row.input_json)) as DiagnosisInput,
      binding: JSON.parse(String(row.binding_json)) as DiagnosisBinding,
      origin: row.origin_json ? JSON.parse(String(row.origin_json)) as DiagnosisOrigin : null,
      createdAt: String(row.created_at), status, history,
    };
  }
}
