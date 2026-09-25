import type { DatabaseSync } from "node:sqlite";

import type { AgentProfile, AgentProfileInput, AgentRole, RoleAssignment, RoleAssignmentInput } from "../shared/roles.js";

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

// 역할 배정 원장(엔진 개편 E1). 프로필은 불변 — 설정을 바꾸려면 새 id 로 만든다(이미 실행한 기록이 가리키는 설정이 조용히 바뀌지 않게).
// 배정은 (scope, role, operation) 마다 현재 행 하나와 버전별 이력을 둔다. 이력은 지우지 않는다.
export class RoleRegistry {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_profiles(id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS role_assignments(scope TEXT NOT NULL,role TEXT NOT NULL,operation TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(scope,role,operation));
      CREATE TABLE IF NOT EXISTS role_assignment_history(scope TEXT NOT NULL,role TEXT NOT NULL,operation TEXT NOT NULL,version INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(scope,role,operation,version));`);
  }

  profiles(): AgentProfile[] {
    return this.db.prepare("SELECT record_json FROM agent_profiles ORDER BY id").all().map(row => JSON.parse(String(row.record_json)) as AgentProfile);
  }

  profile(id: string): AgentProfile | null {
    const row = this.db.prepare("SELECT record_json FROM agent_profiles WHERE id=?").get(id);
    return row ? JSON.parse(String(row.record_json)) as AgentProfile : null;
  }

  createProfile(input: AgentProfileInput, now = new Date().toISOString()): AgentProfile {
    const existing = this.profile(input.id);
    if (existing) {
      const { createdAt: _createdAt, ...stored } = existing;
      if (JSON.stringify(stored) === JSON.stringify(input)) return existing;
      throw conflict(`프로필 ${input.id} 은(는) 이미 다른 설정으로 있습니다. 프로필은 바꾸지 않고 새 id 로 만드세요.`);
    }
    const profile: AgentProfile = { ...input, createdAt: now };
    this.db.prepare("INSERT INTO agent_profiles(id,record_json) VALUES(?,?)").run(profile.id, JSON.stringify(profile));
    return profile;
  }

  assignment(scope: string, role: AgentRole, operation = ""): RoleAssignment | null {
    const row = this.db.prepare("SELECT record_json FROM role_assignments WHERE scope=? AND role=? AND operation=?").get(scope, role, operation);
    return row ? JSON.parse(String(row.record_json)) as RoleAssignment : null;
  }

  // 토픽 배정이 있으면 그것, 없으면 전역 배정. 둘 다 없으면 null(배정 전의 기존 동작).
  effective(topicId: string | null, role: AgentRole, operation = ""): RoleAssignment | null {
    return (topicId ? this.assignment(`topic:${topicId}`, role, operation) : null) ?? this.assignment("global", role, operation);
  }

  list(scope?: string, role?: AgentRole): RoleAssignment[] {
    return this.db.prepare("SELECT record_json FROM role_assignments ORDER BY scope,role,operation").all()
      .map(row => JSON.parse(String(row.record_json)) as RoleAssignment)
      .filter(record => (!scope || record.scope === scope) && (!role || record.role === role));
  }

  history(scope: string, role: AgentRole, operation = ""): RoleAssignment[] {
    return this.db.prepare("SELECT record_json FROM role_assignment_history WHERE scope=? AND role=? AND operation=? ORDER BY version")
      .all(scope, role, operation).map(row => JSON.parse(String(row.record_json)) as RoleAssignment);
  }

  // 기대 버전이 현재 버전(없으면 0)과 같을 때만 바꾼다. 확인과 기록을 한 transaction 으로 묶는다.
  // 새 버전은 (역할, 작업)의 모든 scope 이력에서 유일하게 발급한다 — scope 마다 1부터 매기면 전역 m@1 과 토픽 m@1 이 같은 신원 토큰이 되어,
  // 교체 전 세션의 요청이 새 토픽 배정으로 수락된다(host-review a7a9ce86 F-003). 요청 신원은 participant@version 그대로다.
  assign(input: RoleAssignmentInput, now = new Date().toISOString()): RoleAssignment {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.assignment(input.scope, input.role, input.operation);
      const currentVersion = current?.version ?? 0;
      if (input.expectedVersion !== currentVersion) {
        throw conflict(`배정 버전이 바뀌었습니다(기대 ${input.expectedVersion}, 현재 ${currentVersion}). 현재 배정을 다시 읽고 결정하세요.`);
      }
      if (input.profileId && !this.profile(input.profileId)) throw Object.assign(new Error(`프로필 ${input.profileId} 이(가) 없습니다.`), { statusCode: 400 });
      const issued = Number(this.db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM role_assignment_history WHERE role=? AND operation=?")
        .get(input.role, input.operation)?.version ?? 0);
      const next: RoleAssignment = {
        scope: input.scope, role: input.role, operation: input.operation, participant: input.participant,
        profileId: input.profileId, sessionId: input.sessionId, version: Math.max(issued, currentVersion) + 1, assignedAt: now, note: input.note,
      };
      const json = JSON.stringify(next);
      this.db.prepare(`INSERT INTO role_assignments(scope,role,operation,record_json) VALUES(?,?,?,?)
        ON CONFLICT(scope,role,operation) DO UPDATE SET record_json=excluded.record_json`).run(next.scope, next.role, next.operation, json);
      this.db.prepare("INSERT INTO role_assignment_history(scope,role,operation,version,record_json) VALUES(?,?,?,?,?)")
        .run(next.scope, next.role, next.operation, next.version, json);
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
