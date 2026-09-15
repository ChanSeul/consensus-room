// 수정 작업 계약(2026-09-15 사용자 결정 "작업 계약을 기록으로").
//
// CLAUDE_FIX 논리 작업 하나가 무엇을 고치는지(원본 쟁점), 무엇이 이미 사용자 판정을 받았는지, 어느 자동 수정 회차를 소비하는지, 어떤 진단을 싣는지를
// **작업을 여는 순간** 기록한다. 재개 분기·수락 가드·진단 경로·최종 리뷰의 대조 원본은 모두 이 기록만 읽는다.
// 왜: 단계마다 산출물 종류·회차 플래그·진단 사슬로 원본을 다시 추정하면 두 경로(리뷰 수정·진단 전용 수정)가 같은 CLAUDE_FIX 를 쓰는 조합마다 원본이
// 달라졌다 — 사용자 판정이 영구 거부되고, 합의된 결함이 판정 없이 사라지고, 수락되지 않은 보고가 최종 리뷰의 원본이 됐다(2026-09-15 사전 감사 2차).
import type { Finding } from "./contracts.js";

export type FixRoute = "review" | "diagnosis";
// 수락 때 소비할 자동 수정 회차 — first: fixPassUsed, second: secondFixPassUsed(사용자 결정이 연 추가 회차 포함), none: 진단 전용 수정(회차 무관).
export type FixPass = "first" | "second" | "none";
// open: 진행 중(재개 대상) · accepted: 수락되어 최종 리뷰로 · closed: 실은 진단이 모두 정정으로 닫혀 수정 없이 최종 리뷰로 · abandoned: 구현 재개 등으로 버려짐.
export type FixContractStatus = "open" | "accepted" | "closed" | "abandoned";
export type FixOriginStage = "CODEX_REVIEW" | "CODEX_FINAL_REVIEW" | "READY_TO_DELIVER";

export interface FixContract {
  // 논리 작업 id — checkpoint 의 fixSource. 진단이 덧붙어도(같은 작업에 수정 지시로) 바뀌지 않는다.
  contractId: string;
  scopeGeneration: number;
  planEpoch: number;
  route: FixRoute;
  // 원본 쟁점을 낸 단계와 리뷰 산출물(종류·revision). 인도 대기에서 연 진단 전용 수정은 리뷰가 없다.
  origin: { stage: FixOriginStage; review: { kind: "codex-review" | "codex-final-review"; revision: number } | null };
  // 동결된 원본 쟁점 — 리뷰의 쟁점, 또는 최종 리뷰 정지에서 판단이 끝나지 않은 쟁점(이 계약이 싣지 않은 진단의 되돌림 판정 포함).
  source: Finding[];
  // 실은 중재자 진단 id(적용 순서). 열린 것(applied·delivered)만 이번 턴의 원본에 더해진다.
  diagnosisIds: string[];
  // 계약 시점에 이미 사용자 판정이 끝난 쟁점 id — 되돌림 가드에서 면제된다.
  adjudicated: string[];
  // 이 타임라인 sequence 뒤의 사용자 decision 이 줄 머리 `OVERRULE <id>[, <id>]` 로 지시한 쟁점의 처분 변경을 허용한다(사용자만 뒤집는다 — id 언급은 허용이 아니다).
  decisionFrom: number;
  pass: FixPass;
  status: FixContractStatus;
  // 수락 절차 id(accepting checkpoint revision) — 최종 리뷰의 대조 보고는 그 checkpoint 누적본(수락된 결과)이다.
  acceptId?: number;
  // 수락·종결 시점의 타임라인 sequence — 그 뒤에 저장된 최종 리뷰만 이 결과를 본 리뷰다.
  settledAfter?: number;
}

export function isOpen(contract: FixContract | null | undefined): contract is FixContract {
  return contract?.status === "open";
}
