import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GraphNode, GraphEdge } from "../shared/sessionGraph.js";

// A running registry row alone may be stale. Match the provider process and its spawn time; never signal it.
function liveProvider(pid: unknown, started: unknown, provider: string | null): boolean {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 1 || !["claude", "codex"].includes(provider ?? "")) return false;
  try {
    const line = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], {encoding:"utf8",timeout:150,stdio:["ignore","pipe","ignore"],env:{...process.env,LC_ALL:"C",LC_TIME:"C"}}).trim();
    const match = line.match(/^(.{24})\s+(.*)$/);
    return Boolean(match && Math.abs(Date.parse(match[1]) - Number(started) * 1000) < 5_000 && match[2].split("/").at(-1) === provider);
  } catch { return false; }
}
// Optional local integration. Missing installation is explicit; no model or global home scan.
export function readHostReviewGraph(dataDirectory: string): { nodes: GraphNode[]; edges: GraphEdge[]; warning?: string } {
  const home = join(dataDirectory, "review-tools"), file = join(home, "reviews.sqlite");
  if (!existsSync(file)) return { nodes: [], edges: [], warning: "engine-review 기록 저장소가 연결되지 않았습니다." };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(`SELECT r.id,r.session_id,r.status,r.head,r.started,r.provider_pid,r.directory,j.repo FROM runs r
      JOIN jobs j ON j.id=r.job WHERE r.session_id IS NOT NULL ORDER BY r.started DESC`).all();
    const nodes: GraphNode[] = [], edges: GraphEdge[] = [], seen = new Set<string>(), latest = new Set<string>();
    for (const row of rows) {
      const session = String(row.session_id), repo = String(row.repo), key = `${repo}:${session}`;
      const id = `host:${key}`, source = `host-source:${row.head}`, historical = latest.has(repo);
      if (!nodes.some(node => node.id === source)) nodes.push({ id: source, kind: "source", topicId: null, lane: "host", label: "검토 스냅샷",
        subtitle: String(row.head).slice(0, 10), status: "complete", historical, details: [{ label: "Git 커밋", value: String(row.head) }] });
      if (!historical) nodes.find(node => node.id === source)!.historical = false;
      if (!edges.some(edge => edge.id === `${source}:${id}`)) edges.push({ id: `${source}:${id}`, from: source, to: id, kind: "delivered", label: "검토 입력" });
      if (seen.has(key)) continue;
      seen.add(key);
      let provider: string | null = null, model = "기록 없음", effort = "기록 없음";
      const subject = join(String(row.directory), "subject.json");
      try { if (existsSync(subject)) {
        const rel = relative(realpathSync(home), realpathSync(subject));
        if (!rel.startsWith("..") && !isAbsolute(rel) && statSync(subject).size < 1_000_000) {
          const value = JSON.parse(readFileSync(subject, "utf8")).runtime?.profile;
          if (value) { provider = typeof value.provider === "string" ? value.provider : null; model = String(value.model ?? model); effort = String(value.effort ?? effort); }
        }
      }
      } catch { /* A missing or corrupt subject affects only this historical session. */ }
      // Probe only live-looking runs; completed histories require no subprocesses.
      nodes.push({ id, kind: "session", role: "host-reviewer", topicId: null, lane: "host", label: "engine-review", subtitle: `${repo} · ${model}`,
        provider, sessionId: session, status: row.status === "passed" ? "complete" : row.status === "running" ? !latest.has(repo) && liveProvider(row.provider_pid, row.started, provider) ? "running" : "unknown" : "blocked",
        historical: latest.has(repo), details: [{ label: "세션 ID", value: session }, { label: "저장소", value: repo },
          { label: "실행 당시 모델", value: model }, { label: "추론 강도", value: effort }, { label: "리뷰 원장 상태", value: String(row.status) },
          { label: "검토 커밋", value: String(row.head) }] });
      latest.add(repo);
    }
    return { nodes, edges };
  } catch { return { nodes: [], edges: [], warning: "engine-review 기록을 읽지 못했습니다. 해당 세션의 상태는 확인할 수 없습니다." }; }
  finally { db?.close(); }
}
