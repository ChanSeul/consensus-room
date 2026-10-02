import type { DatabaseSync } from "node:sqlite";

// Graph reads metadata only. Never load prompts, source bodies or provider transcripts for polling.
export function graphRecords(db: DatabaseSync, topicId: string) {
  const checkpoints = db.prepare(`SELECT json_extract(record_json,'$.sessionId') AS sessionId,
    json_extract(record_json,'$.sessions') AS sessions, json_extract(record_json,'$.role') AS seat,
    json_extract(record_json,'$.stage') AS stage, json_extract(record_json,'$.updatedAt') AS at
    FROM planning_checkpoints WHERE topic_id=?`).all(topicId);
  const events = db.prepare(`SELECT json_extract(payload_json,'$.sessionId') AS sessionId,
    json_extract(payload_json,'$.role') AS seat, json_extract(payload_json,'$.provider') AS provider,
    json_extract(payload_json,'$.route.provider') AS routeProvider, state, created_at AS at
    FROM timeline_events WHERE topic_id=? AND json_type(payload_json,'$.sessionId')='text' ORDER BY sequence`).all(topicId);
  const receipts = ["evidence_receipts", "evidence_mediator_unit_receipts", "evidence_link_receipts", "evidence_mediator_source_receipts"].flatMap(table =>
    db.prepare(`SELECT consumer,source_id AS sourceId,COUNT(*) AS units FROM ${table}
      WHERE json_valid(consumer) AND json_extract(consumer,'$[0]')=? GROUP BY consumer,source_id`).all(topicId)
      .map(row => ({ consumer: String(row.consumer), sourceId: String(row.sourceId), units: Number(row.units), mediator: table.includes("mediator"), linkOnly: table.includes("link") || table.includes("source_receipts") })));
  const fragments = db.prepare(`SELECT f.session_id AS sessionId, json_extract(f.record_json,'$.kind') AS kind,
    json_extract(f.record_json,'$.selector') AS selector, json_extract(f.record_json,'$.hash') AS hash,
    COUNT(*) AS fragments FROM planning_session_fragments f WHERE f.session_id IN (
      SELECT json_extract(record_json,'$.sessionId') FROM planning_checkpoints WHERE topic_id=?
      UNION SELECT value FROM planning_checkpoints p,json_each(p.record_json,'$.sessions') WHERE p.topic_id=?
      UNION SELECT session_id FROM planning_session_receipts WHERE topic_id=?)
    GROUP BY f.session_id,kind,selector,hash`).all(topicId, topicId, topicId);
  const active = db.prepare(`SELECT e.role,e.phase,e.observed_at AS observedAt,json_extract(e.usage_json,'$.route.job.role') AS jobRole,
    json_extract(e.usage_json,'$.route.job.operation') AS operation FROM execution_usage e JOIN topics t ON t.id=e.topic_id
    WHERE e.topic_id=? AND e.scope_generation=t.scope_generation AND e.final=0
    AND e.rowid=(SELECT MAX(n.rowid) FROM execution_usage n WHERE n.topic_id=e.topic_id AND n.scope_generation=e.scope_generation)
    AND e.observed_at >= (SELECT MAX(created_at) FROM actions WHERE topic_id=e.topic_id AND status='running')
    ORDER BY e.observed_at DESC LIMIT 1`).get(topicId);
  const interrupts = db.prepare(`SELECT m.id, CASE WHEN m.open=1 AND json_extract(m.record_json,'$.binding')=json_array(t.scope_generation,t.plan_epoch,t.state) THEN 1 ELSE 0 END AS open,
    json_extract(m.record_json,'$.sourceRole') AS sourceRole,
    json_extract(record_json,'$.reason') AS reason,json_extract(record_json,'$.deliveries') AS deliveries
    FROM mediator_interrupts m JOIN topics t ON t.id=m.topic_id WHERE m.topic_id=? ORDER BY m.rowid DESC LIMIT 100`).all(topicId);
  return { checkpoints, events, receipts, fragments, active, interrupts };
}
