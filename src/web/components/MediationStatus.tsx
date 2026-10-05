import type { TopicActivity } from "../../shared/contracts";

export function MediationStatus({ activity }: { activity: TopicActivity | null }) {
  const connection = activity?.mediationConnection, interrupt = activity?.mediationInterrupt, intervention = activity?.mediationIntervention;
  if (!connection && !interrupt && !intervention) return null;
  return <div className="mediator-interrupt" role="status" aria-label="중재 연결과 처리 상태">
    {connection && <>
      <strong>중재 연결 · {{ unconfigured: "수신 세션 미배정", unreported: "연결 확인 없음", connected: "연결 확인됨", unavailable: "연결 불가", stale: "연결 확인 만료", "scope-mismatch": "구독 범위 불일치" }[connection.state]}</strong>
      {connection.error && connection.state !== "connected" && <span>{connection.error}</span>}
      {connection.checkedAt && <span>마지막 연결 확인: {new Date(connection.checkedAt).toLocaleString()}</span>}
    </>}
    {interrupt && <>
      <strong>중재자 호출 · {{ unconfigured: "수신 세션 미연결", waiting: "전송 대기", sending: "전송 중", sent: "세션에 전달됨", acknowledged: "중재자 수신 확인", failed: "전송 실패", unknown: "전송 결과 확인 필요" }[interrupt.state]}</strong>
      <span>{interrupt.error ?? interrupt.reason}</span>
    </>}
    {intervention && <>
      <span>{intervention.handlingAt ? "중재자 처리 시작 확인" : "중재자 처리 시작 미확인"}</span>
      <span>{intervention.resumedAt ? `새 작업 실행 시작: ${new Date(intervention.resumedAt).toLocaleString()}`
        : intervention.closed ? "이 요청은 종료됨 · 작업 재개 기록 없음" : "작업 재개 미확인"}</span>
    </>}
  </div>;
}
