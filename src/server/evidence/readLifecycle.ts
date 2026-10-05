import type { DatabaseSync } from "node:sqlite";
import { evidenceHash, stableJSON } from "./identity.js";

export interface EvidenceReadRequest { tool: string; input: unknown }
export interface EvidenceReadObservation extends EvidenceReadRequest { content: unknown; isError?: boolean }
export interface EvidenceReadScope { id: string; scopeGeneration: number }
export interface EvidenceReadLinks { sourceIds: string[]; fileKeys: string[] }
export type EvidenceReadEvent =
  | { kind: "requested"; request: EvidenceReadRequest; links: EvidenceReadLinks }
  | { kind: "observed"; request: EvidenceReadRequest }
  | { kind: "unavailable"; request: EvidenceReadRequest; links: EvidenceReadLinks; failure: unknown };
export type EvidenceReadGap =
  | { request: EvidenceReadRequest; observation: "unreceived" }
  | { request: EvidenceReadRequest; observation: "unavailable"; failure: unknown };
export interface EvidenceReadView { pending: EvidenceReadRequest[]; gaps: EvidenceReadGap[] }

// Collectors report facts. This port alone owns their persistent disposition; consumers cannot
// infer successful reads, product decisions or completion from a deferred observation.
export interface EvidenceReadLifecycle {
  beginTurn(scope: EvidenceReadScope, linked: EvidenceReadLinks): void;
  record(scope: EvidenceReadScope, event: EvidenceReadEvent): void;
  view(scope: EvidenceReadScope, linked: EvidenceReadLinks): EvidenceReadView;
  unresolved(scope: EvidenceReadScope): EvidenceReadRequest[];
}

// Legacy storage format is private to this implementation. Keep request identity and scope keys
// unchanged so old interrupted attempts are recoverable without rewriting their provenance.
interface StoredRead {
  request: EvidenceReadRequest;
  sourceIds: string[];
  fileKeys?: string[];
  failure?: unknown;
  deferred?: "unreceived";
}
const binding = (scope: EvidenceReadScope) => stableJSON([scope.id, scope.scopeGeneration]);

export class SqliteEvidenceReadLifecycle implements EvidenceReadLifecycle {
  constructor(private readonly db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS evidence_design_pending(binding TEXT NOT NULL, hash TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(binding,hash))");
  }
  record(scope: EvidenceReadScope, event: EvidenceReadEvent): void {
    const hash = evidenceHash(stableJSON(event.request));
    if (event.kind === "observed") {
      this.db.prepare("DELETE FROM evidence_design_pending WHERE binding=? AND hash=?").run(binding(scope), hash);
      return;
    }
    // A new request reactivates a deferred read. Source associations survive reattachment.
    const record = stableJSON({ request: event.request, ...event.links, ...(event.kind === "unavailable" ? { failure: event.failure ?? null } : {}) });
    this.db.prepare(`INSERT INTO evidence_design_pending(binding,hash,record) VALUES (?,?,?)
      ON CONFLICT(binding,hash) DO UPDATE SET record=json_set(excluded.record,
        '$.sourceIds',json((SELECT json_group_array(value) FROM (
          SELECT value FROM json_each(evidence_design_pending.record,'$.sourceIds')
          UNION SELECT value FROM json_each(excluded.record,'$.sourceIds')
        ))),
        '$.fileKeys',json((SELECT json_group_array(value) FROM (
          SELECT value FROM json_each(evidence_design_pending.record,'$.fileKeys')
          UNION SELECT value FROM json_each(excluded.record,'$.fileKeys')
        ))))`).run(binding(scope), hash, record);
  }
  beginTurn(scope: EvidenceReadScope, linked: EvidenceReadLinks): void {
    // Only the admitted owner calls this, before any tool callback. No previous turn is live.
    // Current-turn capture integrity remains mandatory; old unknowns become explicitly deferred.
    const update = this.db.prepare("UPDATE evidence_design_pending SET record=json_set(record,'$.deferred','unreceived') WHERE binding=? AND hash=?");
    for (const request of this.view(scope, linked).pending) update.run(binding(scope), evidenceHash(stableJSON(request)));
  }
  view(scope: EvidenceReadScope, linked: EvidenceReadLinks): EvidenceReadView {
    const sources = new Set(linked.sourceIds), files = new Set(linked.fileKeys);
    const view: EvidenceReadView = { pending: [], gaps: [] };
    for (const record of this.retained(scope)) {
      if (!record.sourceIds.some(id => sources.has(id)) && !record.fileKeys?.some(key => files.has(key))) continue;
      if ("failure" in record) view.gaps.push({ request: record.request, observation: "unavailable", failure: record.failure });
      else if (record.deferred) view.gaps.push({ request: record.request, observation: "unreceived" });
      else view.pending.push(record.request);
    }
    return view;
  }
  // Visibility is not resolution. Detached requests remain unresolved until an observed event.
  unresolved(scope: EvidenceReadScope): EvidenceReadRequest[] { return this.retained(scope).map(record => record.request); }
  private retained(scope: EvidenceReadScope): StoredRead[] {
    return this.db.prepare("SELECT record FROM evidence_design_pending WHERE binding=? ORDER BY hash").all(binding(scope)).map(row => {
      const record = JSON.parse(String(row.record)) as StoredRead;
      if (!record?.request || typeof record.request.tool !== "string" || !("input" in record.request) ||
          !Array.isArray(record.sourceIds) || (record.fileKeys !== undefined && !Array.isArray(record.fileKeys)) ||
          (record.deferred !== undefined && record.deferred !== "unreceived")) throw new Error("Invalid retained evidence-read state");
      return record;
    });
  }
}
