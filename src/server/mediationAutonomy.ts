import type { MediationAutonomy } from "../shared/contracts";

// 2026-10-02 사용자 결정: 중재는 Claude·Codex 세션에서 시작하고 자율중재는 항상 ON이다.
// 예전 mediation-autonomy.json은 이력으로 보존하되 현재 권한의 입력으로 읽지 않는다.
export function readMediationAutonomy(): MediationAutonomy {
  return {
    autonomy: "on",
    set_at: null,
    set_by: "policy",
    note: "자율중재는 항상 ON입니다. 지시는 Claude 또는 Codex 중재 세션에서 전달합니다.",
    history: [],
    unset: false,
  };
}
