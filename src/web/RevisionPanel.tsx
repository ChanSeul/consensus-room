import type { RevisionAllowance } from "../shared/revisions";

export function RevisionPanel({
  account,
  paused,
  busy,
  onGrant,
}: {
  account: RevisionAllowance;
  paused: boolean;
  busy: boolean;
  onGrant: () => void;
}) {
  return (
    <section aria-label="계획 재작성 횟수" className="budget-panel">
      <strong>
        {paused ? "계획 재작성 중지" : "계획 재작성"} · {account.used} /{" "}
        {account.limit}회
      </strong>
      <p>
        최초 계획 1회만 제외합니다. 재계획·개정·자동 교정·실패한 호출은 함께
        셉니다. 마지막 허용 응답의 저장과 감사는 계속합니다.
      </p>
      {account.historyIncomplete && (
        <p>
          이전 호출 기록이 불완전해 확인한 횟수만 표시합니다. 추가 승인 없이 새
          작성 호출을 시작하지 않습니다.
        </p>
      )}
      {paused && (
        <>
          <p>
            계획과 진행 상태를 보존했습니다. 토큰·시간 예산이 남아 있어야 재개할
            수 있습니다.
          </p>
          <button type="button" disabled={busy} onClick={onGrant}>
            재작성 1회 추가 승인 후 재개
          </button>
        </>
      )}
    </section>
  );
}
