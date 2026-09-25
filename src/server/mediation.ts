import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MEDIATOR_HEADER, MEDIATOR_VERSION_HEADER, type MediatorIdentity } from "../shared/roles.js";
import type { RoleRegistry } from "./roleAssignments.js";

// 공급자 중립 중재 정책의 정본 — Claude·Codex 중재자가 같은 본문과 버전을 받는다(엔진 개편 E1).
export const DEFAULT_MEDIATION_POLICY_PATH = fileURLToPath(new URL("../../docs/mediation/policy.md", import.meta.url));

export interface MediationPolicy {
  path: string;
  version: string | null;
  text: string | null;
  error: string | null;
}

// 호출마다 다시 읽는다 — 정책을 고친 뒤 서버를 재시작하지 않아도 다음 호출부터 새 버전이 기록된다(위임 스위치 파일과 같은 규칙).
export function readMediationPolicy(path: string): MediationPolicy {
  try {
    const text = readFileSync(path, "utf8");
    return { path, version: createHash("sha256").update(text, "utf8").digest("hex"), text, error: null };
  } catch (error) {
    return { path, version: null, text: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function mediationError(message: string, errorCode: string, details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { statusCode: 409, errorCode, ...details });
}

function header(headers: Record<string, unknown>, name: string): string | null {
  const value = headers[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// 중재자 헤더가 붙은 변경 요청의 배정 확인. 적용 배정이 없으면 기존 동작(null)이다.
// 배정이 있으면 참여자·버전이 현재 배정과 같아야 한다 — 교체 전 중재자의 늦은 요청과 중복 명령은 원장에 닿기 전에 거부된다.
export function assertMediatorAssignment(
  roles: RoleRegistry, headers: Record<string, unknown>, topicId: string | null,
): MediatorIdentity | null {
  const assignment = roles.effective(topicId, "mediator");
  if (!assignment) return null;
  const participant = header(headers, MEDIATOR_HEADER);
  const version = header(headers, MEDIATOR_VERSION_HEADER);
  const current = { participant: assignment.participant, version: assignment.version, scope: assignment.scope };
  if (!participant || !version) {
    throw mediationError(`이 작업에는 중재자 배정(${assignment.scope} v${assignment.version})이 있습니다. `
      + `${MEDIATOR_HEADER}·${MEDIATOR_VERSION_HEADER} 로 배정 신원을 보내세요(cr_api.sh: CONSENSUS_MEDIATOR=<참여자>@<버전>).`,
    "MEDIATOR_IDENTITY_REQUIRED", { current });
  }
  if (participant !== assignment.participant || version !== String(assignment.version)) {
    throw mediationError(`중재자 배정이 바뀌었습니다: 요청 ${participant}@${version}, 현재 ${assignment.participant}@${assignment.version}(${assignment.scope}). `
      + "이 세션은 더 이상 이 작업의 중재자가 아닙니다. 요청을 다시 보내지 말고 사용자에게 보고하세요.",
    "STALE_MEDIATOR_ASSIGNMENT", { current });
  }
  return current;
}

// 여러 토픽이 함께 쓰는 리소스(원문·작업 묶음)의 변경 요청 — 적용 배정이 있는 영향 토픽 가운데 **하나의** 현재 배정과 같으면 수락한다.
// 토픽마다 중재자가 다를 수 있어 모두와 같기를 요구하면 아무도 통과하지 못한다(host-review a7a9ce86 F-002). 배정 없는 토픽은 수락 근거가 아니다 —
// 그것을 통과로 세면 배정된 토픽에서 교체된 세션이 배정 없는 토픽과 공유한 리소스로 들어온다(host-review dd71c649 F-009). 영향 토픽이 모두 배정이
// 없으면 기존 동작(null)이고, 영향 토픽이 없으면 전역 배정으로 판정한다. 특정 토픽을 직접 바꾸는 효과는 호출자가 그 토픽으로 다시 판정한다.
export function assertMediatorForAnyTopic(
  roles: RoleRegistry, headers: Record<string, unknown>, topicIds: readonly string[],
): MediatorIdentity | null {
  if (topicIds.length === 0) return assertMediatorAssignment(roles, headers, null);
  const assigned = topicIds.filter(topicId => roles.effective(topicId, "mediator") !== null);
  if (assigned.length === 0) return null;
  let rejection: unknown = null;
  for (const topicId of assigned) {
    try { return assertMediatorAssignment(roles, headers, topicId); }
    catch (error) { rejection ??= error; }
  }
  throw rejection;
}
