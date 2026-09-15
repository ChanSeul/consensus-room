// 수정 작업 계약 저장소(표 연산만 — 트랜잭션은 호출자 ConsensusDatabase 가 연다). 추가 전용: 같은 contract_id 의 마지막 행이 현재 상태다.
import type { DatabaseSync } from "node:sqlite";

import type { FixContract } from "../shared/fixContract.js";

export class FixContractStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fix_contracts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        contract_id TEXT NOT NULL,
        scope_generation INTEGER NOT NULL,
        plan_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        body_json TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fix_contracts_topic ON fix_contracts(topic_id, scope_generation, plan_epoch, contract_id, seq);
    `);
  }

  // 새 계약 id(FC-n). 옛 토픽의 이관 계약은 옛 수정 작업 id(fixSource)를 그대로 쓰므로 번호에 세지 않는다.
  nextId(topicId: string): string {
    const row = this.db.prepare("SELECT COUNT(DISTINCT contract_id) AS n FROM fix_contracts WHERE topic_id = ? AND contract_id LIKE 'FC-%'").get(topicId) as { n: number };
    return `FC-${Number(row.n) + 1}`;
  }

  append(topicId: string, contract: FixContract, at: string): void {
    this.db.prepare(`
      INSERT INTO fix_contracts(topic_id, contract_id, scope_generation, plan_epoch, status, body_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(topicId, contract.contractId, contract.scopeGeneration, contract.planEpoch, contract.status, JSON.stringify(contract), at);
  }

  // 한 세대·계획 주기에서 처음 기록한 계약 행의 시각 — 그보다 먼저 저장된 산출물은 계약 도입 전(옛 엔진)의 것이다.
  earliestAt(topicId: string, scopeGeneration: number, planEpoch: number): string | null {
    const row = this.db.prepare("SELECT MIN(at) AS at FROM fix_contracts WHERE topic_id = ? AND scope_generation = ? AND plan_epoch = ?")
      .get(topicId, scopeGeneration, planEpoch) as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  // 한 세대·계획 주기의 계약(각 계약의 마지막 행) — 처음 기록한 순서.
  list(topicId: string, scopeGeneration: number, planEpoch: number): FixContract[] {
    const rows = this.db.prepare(`
      SELECT c.body_json FROM fix_contracts c
      JOIN (
        SELECT contract_id, MAX(seq) AS last, MIN(seq) AS first FROM fix_contracts
        WHERE topic_id = ? AND scope_generation = ? AND plan_epoch = ? GROUP BY contract_id
      ) g ON c.contract_id = g.contract_id AND c.seq = g.last
      WHERE c.topic_id = ?
      ORDER BY g.first
    `).all(topicId, scopeGeneration, planEpoch, topicId) as Array<{ body_json: string }>;
    return rows.map((row) => JSON.parse(row.body_json) as FixContract);
  }
}
