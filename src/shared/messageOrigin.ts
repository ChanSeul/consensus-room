// 타임라인 이벤트에 기록된 실제 발신자 — 서버가 호출 출처(CallOrigin, server/workflow.ts)를 payload.origin 에 남긴 경우에만 읽는다.
// 출처가 없거나 형식이 다르면 null 이다: 그때는 저장된 역할(actor)을 그대로 쓰고, 없는 근거로 발신자를 추정하거나 사용자 승인을 만들지 않는다.
// 작업자 입력(shared/prompts.ts relayFactsFrom)과 웹 타임라인(web/App.tsx actorLabel)이 같은 판정을 쓴다(2026-11-09 한정 수리 1/3).
export type RecordedSender = "mediator" | "user";

export function recordedSender(payload: Record<string, unknown> | undefined): RecordedSender | null {
  const origin = payload?.origin;
  if (typeof origin !== "object" || origin === null) return null;
  const actor = (origin as { actor?: unknown }).actor;
  return actor === "mediator" || actor === "user" ? actor : null;
}
