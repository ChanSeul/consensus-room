import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { EvidenceRootInputSchema, type EvidenceHostImport, type EvidenceDiscoveryLink, type EvidenceCatalog, type EvidenceDiscoveryPage, type EvidenceRoot,
  type EvidenceRootInput, type EvidenceScope, type EvidenceSource, type EvidenceUnitInput } from "../../shared/externalEvidence.js";
import { evidenceHash, stableJSON, type EvidenceStore } from "./store.js";

function conflict(message: string): never { throw Object.assign(new Error(message), { statusCode: 409 }); }
interface Member {
  root_id: string; source_id: string; state: "approved" | "candidate" | "rejected";
  progress: "pending" | "reading" | "complete" | "failed"; cursor: string | null; error: string | null;
}

// Roots belong to a group (or one standalone topic), never to the last visited topic.
// Only explicitly configured workspace roots cross group boundaries.
export class EvidenceCatalogStore {
  constructor(private readonly db: DatabaseSync, private readonly store: EvidenceStore, private readonly clock: () => number) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS evidence_roots(id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_members(root_id TEXT NOT NULL, source_id TEXT NOT NULL,
        state TEXT NOT NULL, progress TEXT NOT NULL, cursor TEXT, error TEXT, PRIMARY KEY(root_id,source_id));
      CREATE TABLE IF NOT EXISTS evidence_discovery_edges(root_id TEXT NOT NULL, source_id TEXT NOT NULL,
        parent_id TEXT NOT NULL, unit_id TEXT NOT NULL, relation TEXT NOT NULL,
        PRIMARY KEY(root_id,source_id,parent_id,unit_id));
      CREATE TABLE IF NOT EXISTS evidence_collection_pages(root_id TEXT NOT NULL, source_id TEXT NOT NULL,
        cursor TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(root_id,source_id,cursor));
      CREATE TABLE IF NOT EXISTS evidence_catalog_history(id INTEGER PRIMARY KEY, scope TEXT NOT NULL,
        owner TEXT NOT NULL, at INTEGER NOT NULL, action TEXT NOT NULL, url TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_unresolved_links(root_id TEXT NOT NULL,id TEXT NOT NULL,url TEXT NOT NULL,
        error TEXT NOT NULL,dismissed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(root_id,id));
      CREATE TABLE IF NOT EXISTS evidence_catalog_migrations(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS evidence_collection_versions(root_id TEXT NOT NULL,source_id TEXT NOT NULL,
        version INTEGER NOT NULL,PRIMARY KEY(root_id,source_id));
      CREATE TABLE IF NOT EXISTS evidence_artifact_boundaries(topic_id TEXT NOT NULL,scope_generation INTEGER NOT NULL,
        artifact_id INTEGER NOT NULL,PRIMARY KEY(topic_id,scope_generation));
    `);
  }
  roots(): EvidenceRoot[] {
    return this.db.prepare("SELECT record FROM evidence_roots ORDER BY rowid").all().map(r => JSON.parse(String(r.record)));
  }
  context(topicId: string): { workspace: string; group: string | null; topic: string } {
    const topic = this.db.prepare("SELECT repository_path FROM topics WHERE id=?").get(topicId);
    if (!topic) throw new Error("작업이 없습니다.");
    const groups = this.db.prepare("SELECT record_json FROM work_groups").all().map(r => JSON.parse(String(r.record_json)));
    const group = groups.find(g => Object.values(g.links as Record<string, { topicId: string }>).some(link => link.topicId === topicId));
    return { workspace: String(topic.repository_path), group: group?.id ?? null, topic: topicId };
  }
  forTopic(topicId: string): EvidenceRoot[] {
    const context = this.context(topicId);
    return this.roots().filter(root => root.owner === context[root.scope]);
  }
  affected(root: EvidenceRoot): string[] {
    return this.db.prepare("SELECT id FROM topics").all().map(r => String(r.id))
      .filter(id => this.context(id)[root.scope] === root.owner);
  }
  private save(root: EvidenceRoot): void {
    this.db.prepare("INSERT INTO evidence_roots VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record").run(root.id, JSON.stringify(root));
  }
  private audit(root: EvidenceRoot, action: string, sourceId = root.sourceId): void {
    this.db.prepare("INSERT INTO evidence_catalog_history(scope,owner,at,action,url) VALUES (?,?,?,?,?)")
      .run(root.scope, root.owner, this.clock(), action, this.store.get(sourceId).url);
  }
  private invalidate(root: EvidenceRoot): void {
    for (const id of this.affected(root)) {
      if (this.db.prepare("SELECT 1 FROM topics WHERE id=? AND (state='CLOSED' OR committed_oid IS NOT NULL)").get(id)) continue;
      this.db.prepare(`INSERT INTO evidence_artifact_boundaries
        SELECT id,scope_generation,COALESCE((SELECT MAX(a.id) FROM artifacts a WHERE a.topic_id=topics.id),0) FROM topics WHERE id=?
        ON CONFLICT(topic_id,scope_generation) DO UPDATE SET artifact_id=excluded.artifact_id`).run(id);
      this.db.prepare(`UPDATE topics SET state=CASE WHEN state='BRAINSTORM_READY' THEN state ELSE 'DRAFT' END,plan_epoch=plan_epoch+1,plan_revision=0,plan_sha256=NULL,
        approved_plan_sha256=NULL,fix_pass_used=0,second_fix_pass_used=0,closeout_revision_used=0,implementation_session_id=NULL,implementation_session_binding_json=NULL,
        implementation_session_provider=NULL,implementation_prompt_sequence=NULL,resume_state=NULL,last_error=NULL,reviewed_head=NULL,reviewed_diff_sha256=NULL WHERE id=?`).run(id);
      for (const row of this.db.prepare("SELECT role FROM participants WHERE topic_id=?").all(id))
        this.db.prepare("UPDATE participants SET session_id=?,mode='created',acknowledged_plan_sha256=NULL,provider=NULL,binding_json=NULL WHERE topic_id=? AND role=?")
          .run(`pending:${randomUUID()}`, id, String(row.role));
      this.db.prepare("DELETE FROM evidence_reviews WHERE topic_id=?").run(id);
    }
  }
  add(topicId: string, raw: EvidenceRootInput, approved = false): EvidenceRoot {
    const input = EvidenceRootInputSchema.parse(raw), context = this.context(topicId);
    const scope = input.scope === "group" && !context.group ? "topic" : input.scope;
    return this.addScoped(scope, context[scope]!, input, approved);
  }
  addScoped(scope: EvidenceScope, owner: string, input: EvidenceRootInput, approved = false): EvidenceRoot {
    const { url, label, mode, intervalSeconds } = input;
    const source = this.store.ensureSource({ url, label, mode, intervalSeconds },true);
    if (scope === "workspace" && source.provider === "jira") throw new Error("Jira 루트는 작업 그룹별로 지정하세요.");
    const existing = this.roots().find(r => r.scope === scope && r.owner === owner && r.sourceId === source.id && r.status !== "removed");
    if (existing) return existing;
    const root: EvidenceRoot = { id: randomUUID(), scope, owner, sourceId: source.id, required: input.required,
      status: approved ? "approved" : "proposed", version: 1, createdAt: this.clock(), approvedAt: approved ? this.clock() : null,
      lastCompleteAt: null, nextCheckAt: 0, scanStartedAt: this.clock() };
    this.atomic(() => {
      this.save(root);
      this.db.prepare("INSERT INTO evidence_members VALUES (?,?,?,'pending',NULL,NULL)").run(root.id, source.id, "approved");
      this.audit(root, approved ? "사용자가 루트와 범위를 승인함" : "검수할 루트 제안");
      if (approved) { this.reuseApproval(source.id,root); this.invalidate(root); }
    });
    return root;
  }
  version(topicId: string): string {
    return evidenceHash(stableJSON(this.forTopic(topicId).map(r => [r.id, r.version, r.status])));
  }
  assertSelection(topicId: string, input: { version: string; rootId: string; action: string; sourceId?: string }): EvidenceRoot {
    if (input.version !== this.version(topicId)) conflict("근거 목록이 바뀌었습니다. 다시 확인하세요.");
    const root = this.forTopic(topicId).find(r => r.id === input.rootId);
    if (!root || root.status === "removed") conflict("현재 범위의 루트가 아닙니다.");
    if (["accept","reject"].includes(input.action) && !this.members(root.id).some(m => m.source_id === input.sourceId && m.source_id !== root.sourceId))
      conflict("검수할 연결 자료가 아닙니다.");
    if (input.action === "accept" && root.scope === "workspace" && this.store.get(input.sourceId!).provider === "jira") conflict("Jira 자료는 작업 그룹에서 승인하세요.");
    if (input.action === "dismiss" && !this.db.prepare("SELECT 1 FROM evidence_unresolved_links WHERE root_id=? AND id=? AND dismissed=0").get(root.id,input.sourceId ?? ""))
      conflict("검수할 누락 링크가 없습니다.");
    return root;
  }
  selectBatch(topicId: string, input: { version: string; rootId: string; action: "accept" | "reject"; sourceIds: string[] }): void {
    this.atomic(() => {
      const root = this.assertSelection(topicId,{...input,sourceId:input.sourceIds[0]});
      for (const sourceId of input.sourceIds) this.assertSelection(topicId,{...input,sourceId});
      for (const sourceId of new Set(input.sourceIds)) {
        this.db.prepare("UPDATE evidence_members SET state=?,progress='pending',cursor=NULL,error=NULL WHERE root_id=? AND source_id=?")
          .run(input.action === "accept" ? "approved" : "rejected",root.id,sourceId);
        this.audit(root,input.action === "accept" ? "연결 자료 묶음 승인" : "연결 자료 묶음 제외",sourceId);
        if (input.action === "accept") this.reuseApproval(sourceId,root);
      }
      root.version++; this.resetCycle(root); this.invalidate(root);
    });
  }
  select(topicId: string, input: { version: string; rootId: string; action: "approve" | "remove" | "accept" | "reject" | "dismiss"; sourceId?: string }): void {
    this.atomic(() => {
      const root = this.assertSelection(topicId,input);
      if (input.action === "approve") { root.status = "approved"; root.approvedAt = this.clock(); }
      else if (input.action === "remove") root.status = "removed";
      else if (input.action === "dismiss") {
        const issue = this.db.prepare("SELECT url FROM evidence_unresolved_links WHERE root_id=? AND id=? AND dismissed=0").get(root.id, input.sourceId ?? "");
        if (!issue) conflict("검수할 누락 링크가 없습니다.");
        this.db.prepare("UPDATE evidence_unresolved_links SET dismissed=1 WHERE root_id=? AND id=?").run(root.id,input.sourceId!);
        this.db.prepare("INSERT INTO evidence_catalog_history(scope,owner,at,action,url) VALUES (?,?,?,?,?)")
          .run(root.scope,root.owner,this.clock(),"사용자가 읽지 못한 링크를 탐색 범위에서 제외",String(issue.url));
      } else {
        const member = this.members(root.id).find(m => m.source_id === input.sourceId);
        if (!member || member.source_id === root.sourceId) conflict("검수할 연결 자료가 아닙니다.");
        this.db.prepare("UPDATE evidence_members SET state=?,progress='pending',error=NULL WHERE root_id=? AND source_id=?")
          .run(input.action === "accept" ? "approved" : "rejected", root.id, member.source_id);
        root.lastCompleteAt = null;
      }
      root.version++; this.resetCycle(root);
      if (input.action !== "dismiss") this.audit(root, ({ approve: "루트와 범위 승인", remove: "앞으로 사용할 근거에서 해제", accept: "연결 자료 승인", reject: "연결 자료 제외" })[input.action], input.sourceId);
      if (input.action === "approve" || input.action === "accept") this.reuseApproval(input.action === "approve" ? root.sourceId : input.sourceId!,root);
      this.invalidate(root);
    });
  }
  members(rootId: string): Member[] {
    return this.db.prepare("SELECT * FROM evidence_members WHERE root_id=? ORDER BY rowid").all(rootId) as unknown as Member[];
  }
  private reachableMembers(rootId: string): Member[] {
    const root = this.roots().find(r => r.id === rootId); if (!root) return [];
    const members = this.members(rootId), byId = new Map(members.map(m=>[m.source_id,m]));
    const visible = new Set([root.sourceId]);
    const edges = this.db.prepare("SELECT parent_id,source_id FROM evidence_discovery_edges WHERE root_id=?").all(rootId);
    for (let changed = true; changed;) {
      changed=false;
      for (const edge of edges) if (visible.has(String(edge.parent_id)) && byId.get(String(edge.parent_id))?.state === "approved" && !visible.has(String(edge.source_id))) {
        visible.add(String(edge.source_id)); changed=true;
      }
    }
    return members.filter(m=>visible.has(m.source_id));
  }
  private sharesApproval(from: EvidenceRoot, to: EvidenceRoot): boolean {
    if (from.scope === to.scope && from.owner === to.owner) return true;
    return from.scope === "workspace" && this.affected(to).some(id => this.context(id).workspace === from.owner);
  }
  private approvedElsewhere(sourceId: string, target: EvidenceRoot): boolean {
    return this.roots().some(root => root.status === "approved" && this.sharesApproval(root,target) &&
      this.reachableMembers(root.id).some(member => member.source_id === sourceId && member.state === "approved"));
  }
  private reuseApproval(sourceId: string, from: EvidenceRoot): void {
    for (const other of this.roots()) {
      if (other.id === from.id || other.status !== "approved" || !this.sharesApproval(from,other)) continue;
      const changed = this.db.prepare("UPDATE evidence_members SET state='approved' WHERE root_id=? AND source_id=? AND state='candidate'").run(other.id,sourceId);
      if (changed.changes) { other.version++; this.resetCycle(other); this.audit(other,"같은 작업 범위에서 승인한 자료 재사용",sourceId); }
    }
  }
  sourceIds(topicId: string): string[] {
    return [...new Set(this.forTopic(topicId).filter(r => r.status === "approved")
      .flatMap(r => this.reachableMembers(r.id).filter(m => m.state === "approved").map(m => m.source_id)))];
  }
  managed(sourceId: string): boolean {
    return this.roots().some(root => root.status === "approved" && this.members(root.id).some(m => m.source_id === sourceId && m.state === "approved") &&
      this.affected(root).some(id => this.db.prepare("SELECT state FROM topics WHERE id=?").get(id)?.state !== "CLOSED"));
  }
  hostManaged(sourceId: string): boolean {
    return this.roots().some(root=>root.status==="approved" && this.store.get(root.sourceId).mode==="connector" &&
      this.reachableMembers(root.id).some(m=>m.source_id===sourceId && m.state==="approved"));
  }
  state(topicId: string): EvidenceCatalog {
    const roots = this.forTopic(topicId), active = roots.filter(r => r.status !== "removed");
    const entries = active.flatMap(root => this.reachableMembers(root.id).map(member => ({ rootId: root.id, source: this.store.get(member.source_id),
      state: member.state, progress: member.progress, error: member.error,
      discoveredFrom: this.db.prepare("SELECT parent_id,unit_id,relation FROM evidence_discovery_edges WHERE root_id=? AND source_id=?")
        .all(root.id, member.source_id).map(r => ({ sourceId: String(r.parent_id), unitId: String(r.unit_id), relation: String(r.relation) })) })));
    const approved = entries.filter(e => e.state === "approved");
    const candidates = entries.filter(e => e.state === "candidate").length + active.filter(r => r.status === "proposed").length;
    const unresolvedLinks = active.flatMap(root => this.db.prepare("SELECT id,url,error FROM evidence_unresolved_links WHERE root_id=? AND dismissed=0").all(root.id)
      .map(row => ({rootId:root.id,id:String(row.id),url:String(row.url),error:String(row.error)})));
    const coverage = { sources: new Set(approved.map(e => e.source.id)).size,
      units: [...new Set(approved.map(e => e.source.id))].reduce((sum, id) => sum + (this.store.snapshot(id)?.units.length ?? 0), 0),
      complete: approved.filter(e => e.progress === "complete").length,
      pending: approved.filter(e => ["pending", "reading"].includes(e.progress)).length,
      failed: approved.filter(e => e.progress === "failed").length + unresolvedLinks.length, candidates,
      ready: unresolvedLinks.length === 0 && active.filter(r => r.required).every(r => r.status === "approved" && r.lastCompleteAt !== null && this.clock() <= r.lastCompleteAt + this.store.get(r.sourceId).intervalSeconds * 2000 &&
        this.reachableMembers(r.id).filter(m => m.state !== "rejected").every(m => m.state === "approved" && m.progress === "complete")) };
    const context = this.context(topicId);
    const history = this.db.prepare("SELECT scope,owner,at,action,url FROM evidence_catalog_history ORDER BY id DESC").all()
      .filter(row => row.owner === context[row.scope as EvidenceScope]).map(r => ({ scope: r.scope as EvidenceScope,
        at: Number(r.at), action: String(r.action), url: String(r.url) }));
    return { version: this.version(topicId), groupId: context.group, roots: roots.map(r => ({ ...r, source: this.store.get(r.sourceId) })), entries, history, unresolvedLinks, coverage };
  }
  due(): EvidenceRoot[] {
    return this.roots().filter(root => root.status === "approved" && root.nextCheckAt <= this.clock() &&
      this.affected(root).some(id => this.db.prepare("SELECT state FROM topics WHERE id=?").get(id)?.state !== "CLOSED"));
  }
  private resetCycle(root: EvidenceRoot): void {
    this.db.prepare("UPDATE evidence_members SET progress='pending',cursor=NULL,error=NULL WHERE root_id=? AND state='approved'").run(root.id);
    root.lastCompleteAt=null; root.nextCheckAt=0; root.scanStartedAt=this.clock(); this.save(root);
  }
  requestRefresh(rootId: string): void {
    const root=this.roots().find(r=>r.id===rootId && r.status==="approved");
    if (root) this.resetCycle(root);
  }
  collectedFresh(source: EvidenceSource): boolean {
    return source.checkedAt !== null && !source.error && this.roots().some(root=>root.status==="approved" && root.lastCompleteAt !== null &&
      root.scanStartedAt !== undefined && source.checkedAt! >= root.scanStartedAt &&
      this.clock() <= root.lastCompleteAt + Math.min(source.intervalSeconds,this.store.get(root.sourceId).intervalSeconds) * 2000 &&
      this.reachableMembers(root.id).some(m=>m.source_id===source.id && m.state==="approved" && m.progress==="complete"));
  }
  next(rootId: string): { root: EvidenceRoot; source: EvidenceSource; cursor: string | null } | null {
    const root = this.roots().find(r => r.id === rootId && r.status === "approved");
    if (!root) return null;
    if (root.lastCompleteAt !== null && root.nextCheckAt <= this.clock()) this.resetCycle(root);
    const member = this.reachableMembers(root.id).find(m => m.state === "approved" && m.progress !== "complete");
    return member ? { root, source: this.store.get(member.source_id), cursor: member.cursor } : null;
  }
  importHostSnapshot(topicId: string, input: EvidenceHostImport, links: EvidenceDiscoveryLink[]): EvidenceSource {
    return this.atomic(() => {
      const root=this.forTopic(topicId).find(r=>r.id===input.rootId && r.status==="approved");
      if (!root || this.version(topicId)!==input.version ||
          !this.reachableMembers(root.id).some(m=>m.source_id===input.sourceId && m.state==="approved"))
        conflict("현재 승인된 루트와 원문 버전으로 다시 수집하세요.");
      const before=this.store.get(input.sourceId), now=this.clock();
      if (before.contentHash!==input.previousHash || before.checkedAt!==input.previousCheckedAt ||
          input.observedAt>now || now-input.observedAt>240_000 || input.observedAt<(before.checkedAt ?? 0))
        conflict("원문이 갱신되었거나 수집 시간이 지났습니다. 다시 읽은 자료를 보내세요.");
      this.store.useMode(root.sourceId,"connector");
      this.store.useMode(before.id,"connector");
      const check=this.store.begin(before.id,true);
      if (!check) conflict("다른 수집이 진행 중이거나 재시도 대기 중입니다.");
      if (root.lastCompleteAt!==null) this.resetCycle(root);
      root.lastCompleteAt=null; root.scanStartedAt ??= input.observedAt; this.save(root);
      // A host import replaces this source's complete captured range, never another source's pages.
      this.db.prepare("UPDATE evidence_members SET cursor=NULL WHERE root_id=? AND source_id=?").run(root.id,before.id);
      this.acceptPage(root,this.store.get(before.id),null,{units:input.units,links,cursor:null,revision:input.revision});
      const after=this.store.ingest(before.id,{checkId:check.checkId,revision:input.revision,units:input.units});
      if (input.missing.length) {
        const partial=this.store.incompleteHostCapture(before.id,input.missing);
        for (const linked of this.roots().filter(r=>r.status==="approved" && this.reachableMembers(r.id).some(m=>m.source_id===before.id && m.state==="approved"))) {
          if (linked.lastCompleteAt!==null) this.resetCycle(linked);
          this.failed(linked.id,before.id,partial.error!);
        }
        return partial;
      }
      this.complete(root.id); return after;
    });
  }
  replacePages(root: EvidenceRoot, source: EvidenceSource, expectedCursor: string | null, page: Omit<EvidenceDiscoveryPage,"cursor">): void {
    this.atomic(() => {
      const member=this.members(root.id).find(m=>m.source_id===source.id && m.state==="approved");
      if (!member || member.cursor!==expectedCursor) conflict("이전 수집 페이지입니다.");
      this.db.prepare("UPDATE evidence_members SET cursor=NULL WHERE root_id=? AND source_id=?").run(root.id,source.id);
      this.acceptPage(root,source,null,{...page,cursor:null});
    });
  }
  acceptPage(root: EvidenceRoot, source: EvidenceSource, cursor: string | null, page: EvidenceDiscoveryPage, sourceGeneration = this.store.generation(source.id)): void {
    const current = this.roots().find(r => r.id === root.id);
    if (!current || current.status !== "approved" || current.version !== root.version) conflict("수집 중 루트 승인이 바뀌었습니다.");
    this.atomic(() => {
      const member = this.members(root.id).find(m => m.source_id === source.id && m.state === "approved");
      if (!member || member.cursor !== cursor) conflict("이전 수집 페이지입니다.");
      if (cursor === null) {
        this.db.prepare("INSERT INTO evidence_collection_versions VALUES (?,?,?) ON CONFLICT(root_id,source_id) DO UPDATE SET version=excluded.version")
          .run(root.id,source.id,sourceGeneration);
        this.db.prepare("DELETE FROM evidence_collection_pages WHERE root_id=? AND source_id=?").run(root.id, source.id);
        this.db.prepare("DELETE FROM evidence_discovery_edges WHERE root_id=? AND parent_id=?").run(root.id, source.id);
      }
      if (page.cursor !== null && (page.cursor === cursor || this.db.prepare("SELECT 1 FROM evidence_collection_pages WHERE root_id=? AND source_id=? AND cursor=?")
        .get(root.id, source.id, page.cursor))) throw new Error("반복된 수집 커서입니다. 완료로 처리하지 않았습니다.");
      this.db.prepare("INSERT INTO evidence_collection_pages VALUES (?,?,?,?)").run(root.id, source.id, cursor ?? "", JSON.stringify(page));
      for (const link of page.links) {
        let child: EvidenceSource;
        try { child = this.store.ensureSource({ url: link.url, label: link.label.slice(0, 160) || link.url.slice(0, 160), mode: source.mode, intervalSeconds: source.intervalSeconds }, true); }
        catch {
          const inserted = this.db.prepare("INSERT OR IGNORE INTO evidence_unresolved_links(root_id,id,url,error) VALUES (?,?,?,?)")
            .run(root.id,evidenceHash(link.url),link.url,"자동으로 읽을 수 없는 링크입니다. 올바른 주소를 추가하거나 탐색 범위에서 제외하세요.");
          if (inserted.changes) current.version++;
          continue;
        }
        const origin = this.store.get(root.sourceId);
        const automatic = this.approvedElsewhere(child.id,current) || (origin.provider === "jira" && child.provider === "jira" && origin.resource.split("/")[0] === child.resource.split("/")[0]) ||
          (origin.provider === "slack" && child.provider === "slack" && origin.resource === child.resource) ||
          (origin.provider === "confluence" && child.provider === "confluence" && link.relation === "child" && origin.resource.split("/")[0] === child.resource.split("/")[0]);
        const added = this.db.prepare("INSERT OR IGNORE INTO evidence_members VALUES (?,?,?,'pending',NULL,NULL)")
          .run(root.id, child.id, automatic ? "approved" : "candidate");
        if (automatic) this.reuseApproval(child.id,current);
        // Approved discoveries change host paging too: their IDs may precede a cursor already handed out.
        if (added.changes) { current.version++; this.audit(current, automatic ? "승인된 탐색 범위에서 새 원문 발견" : "새 연결 자료 검수 대기", child.id); }
        this.db.prepare("INSERT OR IGNORE INTO evidence_discovery_edges VALUES (?,?,?,?,?)").run(root.id, child.id, source.id, link.unitId, link.relation);
      }
      this.db.prepare("UPDATE evidence_members SET cursor=?,progress=?,error=NULL WHERE root_id=? AND source_id=?")
        .run(page.cursor, page.cursor === null ? "complete" : "reading", root.id, source.id);
      this.save(current);
    });
  }
  collected(rootId: string, sourceId: string): { links: EvidenceDiscoveryPage["links"]; units: EvidenceUnitInput[]; revision: string; generation: number } {
    const pages = this.db.prepare("SELECT record FROM evidence_collection_pages WHERE root_id=? AND source_id=? ORDER BY rowid").all(rootId, sourceId)
      .map(r => JSON.parse(String(r.record)) as EvidenceDiscoveryPage);
    const units = new Map<string, EvidenceUnitInput>();
    for (const page of pages) for (const unit of page.units) {
      const old = units.get(unit.id);
      if (old && stableJSON(old) !== stableJSON(unit)) throw new Error("수집 중 같은 항목의 내용이 바뀌었습니다.");
      units.set(unit.id, unit);
    }
    return { links: pages.flatMap(page => page.links), units: [...units.values()], revision: evidenceHash(stableJSON(pages.map(p => p.revision))), generation:Number(this.db.prepare("SELECT version FROM evidence_collection_versions WHERE root_id=? AND source_id=?").get(rootId,sourceId)?.version ?? 0) };
  }
  complete(rootId: string): void {
    const root = this.roots().find(r => r.id === rootId)!;
    if (root.status !== "approved" || root.lastCompleteAt !== null || this.reachableMembers(rootId).some(m => m.state === "approved" && m.progress !== "complete")) return;
    // Drop only future memberships no longer reachable from the approved root. Snapshots and audit survive.
    const reachable = new Set(this.reachableMembers(rootId).map(member=>member.source_id));
    for (const member of this.members(rootId)) if (!reachable.has(member.source_id) && member.state !== "rejected") {
      this.audit(root, "루트에서 더 이상 연결되지 않아 앞으로 사용할 근거에서 해제", member.source_id);
      this.db.prepare("DELETE FROM evidence_members WHERE root_id=? AND source_id=?").run(rootId, member.source_id);
      root.version++;
    }
    const interval=this.reachableMembers(rootId).filter(m=>m.state==="approved").reduce((minimum,m)=>Math.min(minimum,this.store.get(m.source_id).intervalSeconds),this.store.get(root.sourceId).intervalSeconds);
    root.lastCompleteAt = this.clock(); root.nextCheckAt = this.clock() + interval * 1000; this.save(root);
  }
  failed(rootId: string, sourceId: string, message: string, retrySeconds = 300, restart = false): void {
    this.db.prepare("UPDATE evidence_members SET progress='failed',cursor=CASE WHEN ? THEN NULL ELSE cursor END,error=? WHERE root_id=? AND source_id=?").run(restart ? 1 : 0,message.slice(0,500), rootId, sourceId);
    const root = this.roots().find(r => r.id === rootId)!;
    root.nextCheckAt = this.clock() + Math.max(300, retrySeconds) * 1000; this.save(root);
  }
  migrateLegacy(): void {
    if (this.db.prepare("SELECT 1 FROM evidence_catalog_migrations WHERE id='human-review-v1'").get()) return;
    this.atomic(() => {
      for (const row of this.db.prepare("SELECT topic_id,source_id FROM evidence_topics").all()) {
        const source = this.store.get(String(row.source_id));
        this.add(String(row.topic_id), { url: source.url, label: source.label, mode: source.mode,
          intervalSeconds: source.intervalSeconds, scope: "topic", required: true }, false);
      }
      this.db.exec("DELETE FROM evidence_topics");
      this.db.prepare("INSERT INTO evidence_catalog_migrations VALUES ('human-review-v1')").run();
    });
  }
  private atomic<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
