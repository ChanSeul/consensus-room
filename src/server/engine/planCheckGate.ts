// 계획 필수 검사 게이트(2026-10-06 사용자 결정) — 구현·수정 결과를 받아들이기 직전, 완료 판정 루프(delivery.runWorkOnce)의 수락 직전 한 곳에서 계획이 선언한
// 검사(```checks, shared/planChecks)를 판정한다. 결과는 세 갈래다:
//   satisfied ...... 모두 충족 → 수락으로 넘어간다
//   unsatisfied .... 러너가 고칠 수 있는 실패(검사가 돌았고 실패) → 같은 작업 세션의 계속 진행 턴으로 실패 내용을 돌려보낸다
//   unavailable .... 러너가 고칠 수 없는 호스트 문제(도구 미해석·프로필 미등록·Git 미연결·시간 초과·입력 반복 변경) → 결과를 보존한 채 정지
// 선언이 없으면(빈 목록) 아무것도 부르지 않는다. kind 를 더하면 판정표(PlanCheckSatisfiers)가 그 항목을 요구한다.
import type { PlanCheckItem, VerificationProfileId } from "../../shared/planChecks.js";
import type { VerificationOutcome } from "../verifications.js";

type Satisfied = { item: PlanCheckItem; status: "satisfied"; detail: string };
// inputKey: 실패한 검사의 입력 신원 — 같은 입력으로 같은 실패가 반복되면 러너가 고치지 않은 것이다(계속 진행의 정체 판정).
export type PlanCheckFailure = { item: PlanCheckItem; status: "unsatisfied"; detail: string; inputKey: string };
export type PlanCheckUnavailable = { item: PlanCheckItem; status: "unavailable"; detail: string };
export type PlanCheckResult = Satisfied | PlanCheckFailure | PlanCheckUnavailable;

export type PlanCheckSatisfiers = {
  [K in PlanCheckItem["kind"]]: (item: Extract<PlanCheckItem, { kind: K }>, signal: AbortSignal) => Promise<PlanCheckResult>;
};

export type PlanCheckGateVerdict =
  | { kind: "satisfied" }
  | { kind: "unsatisfied"; failures: PlanCheckFailure[]; inputKey: string }
  | { kind: "unavailable"; failures: PlanCheckUnavailable[] };

export async function planCheckGate(items: readonly PlanCheckItem[], satisfiers: PlanCheckSatisfiers, signal: AbortSignal): Promise<PlanCheckGateVerdict> {
  const results: PlanCheckResult[] = [];
  for (const item of items) {
    results.push(await (satisfiers[item.kind] as (item: PlanCheckItem, signal: AbortSignal) => Promise<PlanCheckResult>)(item, signal));
  }
  const unavailable = results.filter((result): result is PlanCheckUnavailable => result.status === "unavailable");
  if (unavailable.length > 0) return { kind: "unavailable", failures: unavailable };
  const failures = results.filter((result): result is PlanCheckFailure => result.status === "unsatisfied");
  if (failures.length > 0) return { kind: "unsatisfied", failures, inputKey: JSON.stringify(failures.map((failure) => [failure.item.id, failure.inputKey])) };
  return { kind: "satisfied" };
}

// 로그는 끝부분만 싣는다 — 구문 오류 진단은 stderr 에 파일:줄:열 로 나온다.
const LOG_TAIL = 6_000;
function logTail(log: { stdout: string; stderr: string } | null): string {
  if (!log) return "(로그를 읽지 못했습니다)";
  const text = [log.stderr.trim(), log.stdout.trim()].filter(Boolean).join("\n");
  if (!text) return "(출력 없음)";
  return text.length > LOG_TAIL ? `…(앞 ${text.length - LOG_TAIL}자 생략)\n${text.slice(-LOG_TAIL)}` : text;
}

// 엔진 실행 검사(kind=verification)의 판정 — VerificationService.ensure 결과를 세 갈래로 옮긴다. stale(검사 중 입력 변경)은 수락 경계에서 입력이 고정돼야
// 하므로 한 번만 다시 돌리고, 두 번째도 stale 이면 호스트 문제로 멈춘다. 작업 취소(signal)는 판정하지 않고 그대로 던진다.
export function verificationSatisfier(
  ensure: ((profileId: VerificationProfileId, signal: AbortSignal) => Promise<VerificationOutcome>) | undefined,
): PlanCheckSatisfiers["verification"] {
  return async (item, signal) => {
    if (!ensure) return { item, status: "unavailable", detail: `${item.id}(${item.profile}): 검사 서비스가 연결되지 않아 실행할 수 없습니다.` };
    for (let attempt = 0; ; attempt += 1) {
      let outcome: VerificationOutcome;
      try {
        outcome = await ensure(item.profile, signal);
      } catch (error) {
        signal.throwIfAborted();
        return { item, status: "unavailable", detail: `${item.id}(${item.profile}): 검사를 실행하지 못했습니다 — ${error instanceof Error ? error.message : String(error)}` };
      }
      signal.throwIfAborted();
      switch (outcome.status) {
        case "succeeded":
          return { item, status: "satisfied", detail: `${item.id}(${item.profile}): 성공 run=${outcome.run.id}${outcome.reused ? "(같은 입력의 기록 재사용)" : ""}` };
        case "no-targets":
          return { item, status: "satisfied", detail: `${item.id}(${item.profile}): 지금 작업 트리에 검사할 대상이 없습니다.` };
        case "failed":
          return { item, status: "unsatisfied", inputKey: outcome.run.inputSHA256,
            detail: `${item.id}(${item.profile}) 실패 run=${outcome.run.id}:\n${logTail(outcome.log)}` };
        case "stale":
          if (attempt === 0) continue;
          return { item, status: "unavailable", detail: `${item.id}(${item.profile}): 검사하는 동안 입력이 두 번 연속 바뀌었습니다(run=${outcome.run.id}).` };
        default:
          return { item, status: "unavailable", detail: `${item.id}(${item.profile}): 검사가 ${outcome.status} 로 끝났습니다(run=${outcome.run.id}).\n${logTail(outcome.log)}` };
      }
    }
  };
}
