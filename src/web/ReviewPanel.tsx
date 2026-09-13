import type { ReviewAllowance, ReviewScope } from "../shared/reviews";
export function ReviewPanel({
  accounts,
  paused,
  busy,
  onGrant,
}: {
  accounts: ReviewAllowance[];
  paused: ReviewScope | null;
  busy: boolean;
  onGrant: (scope: ReviewScope, version: number) => void;
}) {
  return (
    <section aria-label="리뷰 횟수" className="budget-panel">
      <strong>리뷰 호출 한도</strong>
      <p>
        첫 호출부터 셉니다. 자동 교정과 실패한 호출도 포함하며 마지막 허용
        결과는 저장·처리합니다.
      </p>
      {accounts.map((a) => (
        <div key={a.scope}>
          <strong>
            {a.scope === "planning" ? "계획 검토" : "구현 리뷰"} · {a.used} /{" "}
            {a.limit}회
          </strong>
          {a.historyIncomplete && (
            <p>
              이전 기록이 불완전해 확인한 호출만 표시합니다. 다음 호출에는 추가
              승인이 필요합니다.
            </p>
          )}
          {paused === a.scope && (
            <>
              <p>
                리뷰를 멈추고 결과와 진행 상태를 보존했습니다. 토큰·시간 예산도
                남아 있어야 재개합니다.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => onGrant(a.scope, a.version)}
              >
                {a.scope === "planning" ? "계획 검토" : "구현 리뷰"} 1회 추가
                승인 후 재개
              </button>
            </>
          )}
        </div>
      ))}
    </section>
  );
}
