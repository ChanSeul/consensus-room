import type { DatabaseSync } from "node:sqlite";

// Codex 속도(serviceTier) 설정(2026-10-18 사용자 지시 "중재자한테 fast mode on/off 부탁하면 바로 처리"). 실행 프로필과 따로 둔다 — 프로필은 불변이고
// 작업별 배정에 가려지며 묶음 단계에 상속되지 않아, 프로필을 바꾸는 방식으로는 한 번의 호출로 토픽의 모든 Codex 작업을 바꿀 수 없다.
// 범위는 토픽과 작업 묶음뿐이다(사용자 결정: 중재자는 토픽·묶음까지, 전역 계층은 착수 합의 351a9e61 에서 뺐다). 값이 없으면 상위로 간다:
// 토픽 → 그 토픽이 연결된 묶음 → 프로필 자체 options. 설정은 모델·추론 강도·리뷰 기준을 바꾸지 않고 serviceTier 하나만 덮어쓴다.
export type CodexServiceTier = "fast" | "standard";
export type CodexSpeedScope = `topic:${string}` | `group:${string}`;
export type CodexSpeedMode = CodexServiceTier | "inherit";

export interface CodexSpeedSetting {
  scope: CodexSpeedScope;
  serviceTier: CodexServiceTier;
  reason: string;
  actor: "user" | "mediator";
  at: string;
}

export interface CodexSpeedOverride { serviceTier: CodexServiceTier; scope: CodexSpeedScope; source: "topic" | "group" }

export class CodexSpeedRegistry {
  constructor(private readonly db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS codex_speed_settings(scope TEXT PRIMARY KEY,record_json TEXT NOT NULL)");
  }

  setting(scope: CodexSpeedScope): CodexSpeedSetting | null {
    const row = this.db.prepare("SELECT record_json FROM codex_speed_settings WHERE scope=?").get(scope);
    return row ? JSON.parse(String(row.record_json)) as CodexSpeedSetting : null;
  }

  // inherit 은 행을 지워 상위 설정으로 돌아간다. 이력은 호출자가 타임라인 이벤트로 남긴다.
  set(scope: CodexSpeedScope, mode: CodexSpeedMode, reason: string, actor: "user" | "mediator"): CodexSpeedSetting | null {
    if (mode === "inherit") {
      this.db.prepare("DELETE FROM codex_speed_settings WHERE scope=?").run(scope);
      return null;
    }
    const setting: CodexSpeedSetting = { scope, serviceTier: mode, reason, actor, at: new Date().toISOString() };
    this.db.prepare("INSERT INTO codex_speed_settings(scope,record_json) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET record_json=excluded.record_json")
      .run(scope, JSON.stringify(setting));
    return setting;
  }

  // 토픽에 적용할 덮어쓰기. 묶음 설정이 하나도 없으면 묶음 조회를 하지 않는다 — 경로는 턴마다 정해지므로 평소 비용을 늘리지 않는다.
  // 토픽이 속한 묶음은 WorkGroups.forTopic 과 같은 규칙(연결에 그 토픽이 있는 첫 묶음)으로 고르되 id 만 읽는다.
  overrideFor(topicId: string): CodexSpeedOverride | null {
    const topic = this.setting(`topic:${topicId}`);
    if (topic) return { serviceTier: topic.serviceTier, scope: topic.scope, source: "topic" };
    const anyGroup = this.db.prepare("SELECT 1 FROM codex_speed_settings WHERE scope LIKE 'group:%' LIMIT 1").get();
    if (!anyGroup) return null;
    const groupId = this.groupOf(topicId);
    const group = groupId ? this.setting(`group:${groupId}`) : null;
    return group ? { serviceTier: group.serviceTier, scope: group.scope, source: "group" } : null;
  }

  groupOf(topicId: string): string | null {
    const row = this.db.prepare(`SELECT json_extract(record_json, '$.id') AS id FROM work_groups
      WHERE EXISTS (SELECT 1 FROM json_each(work_groups.record_json, '$.links')
        WHERE json_extract(value, '$.topicId')=?) ORDER BY rowid LIMIT 1`).get(topicId);
    return row?.id ? String(row.id) : null;
  }
}

// 공급자 옵션에 속도 덮어쓰기를 적용한다. fast 는 serviceTier 를 싣고, standard 는 프로필의 fast 를 뺀다. 다른 키는 그대로 둔다.
export function applyCodexSpeed(options: Readonly<Record<string, unknown>>, override: CodexSpeedOverride | null): Readonly<Record<string, unknown>> {
  if (!override) return options;
  const { serviceTier: _profileTier, ...rest } = options;
  return override.serviceTier === "fast" ? { ...rest, serviceTier: "fast" } : rest;
}
