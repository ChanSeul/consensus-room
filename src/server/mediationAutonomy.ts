import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  MediationAutonomySchema,
  type MediationAutonomy,
  type MediationAutonomyValue,
} from "../shared/contracts";

// 자율 중재 위임 스위치의 정본 파일. `~/Library/Application Support/ConsensusRoom/mediation_autonomy.sh` 와
// 같은 파일·같은 필드를 쓴다 — 어느 쪽에서 바꿔도 다른 쪽이 그대로 읽는다.
export const MEDIATION_AUTONOMY_FILE = "mediation-autonomy.json";

export function mediationAutonomyPath(dataDirectory: string): string {
  return join(dataDirectory, MEDIATION_AUTONOMY_FILE);
}

const UNSET: MediationAutonomy = { autonomy: "off", set_at: null, set_by: null, note: null, history: [], unset: true };

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function readMediationAutonomy(dataDirectory: string): MediationAutonomy {
  const path = mediationAutonomyPath(dataDirectory);
  if (!existsSync(path)) return UNSET;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const history = Array.isArray(raw.history)
    ? raw.history
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        autonomy: entry.autonomy, set_at: text(entry.set_at), set_by: text(entry.set_by), note: text(entry.note),
      }))
    : [];
  const parsed = MediationAutonomySchema.safeParse({
    autonomy: raw.autonomy, set_at: text(raw.set_at), set_by: text(raw.set_by), note: text(raw.note), history, unset: false,
  });
  if (!parsed.success) {
    throw new Error(`mediation-autonomy.json 형식이 맞지 않습니다: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  return parsed.data;
}

export function writeMediationAutonomy(
  dataDirectory: string,
  input: { autonomy: MediationAutonomyValue; note?: string; setBy: string },
): MediationAutonomy {
  const previous = readMediationAutonomy(dataDirectory);
  const history = [...previous.history];
  if (!previous.unset) {
    history.push({ autonomy: previous.autonomy, set_at: previous.set_at, set_by: previous.set_by, note: previous.note });
  }
  const next: MediationAutonomy = {
    autonomy: input.autonomy,
    set_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    set_by: input.setBy,
    note: input.note ?? "",
    history: history.slice(-20),
    unset: false,
  };
  const { unset: _unset, ...document } = next;
  const path = mediationAutonomyPath(dataDirectory);
  // 셸 스크립트와 같은 원자 쓰기(tmp → rename): 읽는 쪽이 반쯤 쓰인 파일을 보지 않는다.
  // 임시 파일 이름은 호출마다 고유해야 한다 — 웹과 셸 스크립트가 같은 이름을 쓰면 동시 저장 때 서로의 반쯤 쓰인
  // 파일을 rename 해 값이 뒤집히거나 JSON 이 깨진다(2026-09-08 Codex 지적 3).
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 1)}\n`, "utf8");
  renameSync(temporary, path);
  return next;
}
