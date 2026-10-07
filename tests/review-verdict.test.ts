import { describe, expect, it } from "vitest";

import type { AgentResult, Finding } from "../src/shared/contracts";
import { resultPause } from "../src/server/engine/completion";
import {
  reviewCompleted, reviewContractViolation, reviewEvidenceFindings, reviewVerdict, reviewVerdictReached,
  type ReviewJudgment, type ReviewVerdictContext,
} from "../src/server/engine/findingJudgment";

// 리뷰 판정기(2026-10-06) — 리뷰 결과 하나를 다음 전이 하나로 옮기는 단일 정본의 규칙 순서. 새 리뷰·저장 리뷰 재사용이 모두 이 함수를 쓴다.
const finding = (id: string, overrides: Partial<Finding> = {}): Finding => ({
  id, title: `${id} 제목`, severity: "HIGH", disposition: "AGREED_ACTION", rationale: `${id} 근거`, evidenceRefs: [], requiresUserDecision: false, ...overrides,
});
const review = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  kind: "REVIEW", summary: "리뷰", status: "completed", findings: [], evidenceRefs: [], ...overrides,
});
const judgment = (overrides: Partial<ReviewJudgment> = {}): ReviewJudgment => ({
  added: [], deferredNew: [], askUser: [], overruled: new Set(), agreed: [], withdrawn: [], remaining: [], ...overrides,
});
const context = (overrides: Partial<ReviewVerdictContext> = {}): ReviewVerdictContext => ({
  finalPass: false, judgment: judgment(), mediatorWork: [], fix: "available", ...overrides,
});
const evidence = finding("E-1", { disposition: "EXTERNAL_EVIDENCE", rationale: "Figma 원문이 필요합니다." });

describe("reviewVerdict 규칙 순서", () => {
  it("중재자 실행 요청(이 리뷰 또는 해소되지 않은 원장 요청)이 가장 앞이다", () => {
    expect(reviewVerdict(review({ requestedMediatorAction: "swiftc -parse 실행", requestedUserDecision: "범위?" }), context()))
      .toEqual({ kind: "await-mediator", requests: [], action: "swiftc -parse 실행" });
    const pending = [{ id: "R7", sequence: 7, question: "빌드 로그", kind: "mediator-work" as const }];
    expect(reviewVerdict(review(), context({ mediatorWork: pending }))).toEqual({ kind: "await-mediator", requests: pending });
  });

  it("사용자 결정 요청은 결정 대기이고, 저장 리뷰가 그 뒤 결정으로 답을 받았으면 건너뛴다", () => {
    const asked = review({ requestedUserDecision: "범위를 넓힐까요?", findings: [finding("F-1")] });
    expect(reviewVerdict(asked, context()).kind).toBe("await-decision");
    expect(reviewVerdict(asked, context({ ownRequestsAnswered: true, judgment: judgment({ remaining: ["F-1"] }) })).kind).toBe("fix");
  });

  it("끝나지 않은 리뷰는 증거 요청이 있으면 증거 대기, 없으면 미완료다 — 부분 검토로 수정·통과하지 않는다", () => {
    expect(reviewVerdict(review({ status: "in_progress", remainingSteps: ["나머지 파일"], findings: [evidence] }), context()))
      .toMatchObject({ kind: "await-evidence", message: "Figma 원문이 필요합니다." });
    expect(reviewVerdict(review({ status: "in_progress", remainingSteps: ["나머지 파일"], findings: [finding("F-1")] }),
      context({ judgment: judgment({ remaining: ["F-1"] }) }))).toEqual({ kind: "incomplete", remainingSteps: ["나머지 파일"] });
  });

  it("최종 리뷰의 신규 판정 대기·합의 철회는 판정 도달 정지다(결정이 판정했으면 건너뜀)", () => {
    const fresh = finding("N-1", { disposition: undefined, requiresUserDecision: false });
    expect(reviewVerdict(review({ kind: "FINAL_REVIEW" }), context({ finalPass: true, judgment: judgment({ askUser: [fresh] }) })))
      .toEqual({ kind: "new-final-findings", ids: ["N-1"] });
    expect(reviewVerdict(review({ kind: "FINAL_REVIEW" }), context({ finalPass: true, judgment: judgment({ withdrawn: ["F-1"] }) })))
      .toEqual({ kind: "withdrawn", ids: ["F-1"] });
    expect(reviewVerdict(review({ kind: "FINAL_REVIEW" }),
      context({ finalPass: true, decisionsAdjudicate: true, judgment: judgment({ withdrawn: ["F-1"] }) })).kind).toBe("pass");
  });

  it("증거 대기(수정 먼저가 아닐 때)는 최종 리뷰의 신규·철회 판정보다 앞이다 — 최종 리뷰가 새로 청한 증거는 증거 정지다(종전 순서)", () => {
    const newEvidence = finding("NEW-EVIDENCE", { disposition: "EXTERNAL_EVIDENCE", rationale: "smoke 로그" });
    expect(reviewVerdict(review({ kind: "FINAL_REVIEW", findings: [newEvidence] }),
      context({ finalPass: true, judgment: judgment({ askUser: [newEvidence], withdrawn: ["F-1"] }) })).kind).toBe("await-evidence");
    // 수정 먼저(확정 결함 + 수정 가능)여도 최종 리뷰의 신규 판정 대기는 사용자 정지다 — 넘긴 증거 요청은 그 결정 뒤 수정 계약에 실린다.
    expect(reviewVerdict(review({ kind: "FINAL_REVIEW", findings: [finding("F-2"), newEvidence] }),
      context({ finalPass: true, judgment: judgment({ askUser: [newEvidence], remaining: ["F-2"] }) })).kind).toBe("new-final-findings");
  });

  it("수정 먼저: 완료 리뷰 + 확정 결함 + 수정 가능이면 증거 요청을 계약에 넘기고 수정한다(2026-10-06 사용자 결정)", () => {
    const verdict = reviewVerdict(review({ findings: [finding("F-1"), evidence] }), context({ judgment: judgment({ remaining: ["F-1"] }) }));
    expect(verdict).toEqual({ kind: "fix", ids: ["F-1"], deferredEvidence: [evidence] });
    expect(reviewVerdictReached(verdict)).toBe(true);
  });

  it("진짜 증거 요구는 여전히 멈춘다 — 증거만 있거나, 결함이 있어도 수정할 수 없으면 증거 대기", () => {
    expect(reviewVerdict(review({ findings: [evidence] }), context()).kind).toBe("await-evidence");
    expect(reviewVerdict(review({ findings: [finding("F-1"), evidence] }), context({ fix: "used", judgment: judgment({ remaining: ["F-1"] }) })).kind)
      .toBe("await-evidence");
    // 처분 없는 쟁점도 판단 근거 요청이다.
    expect(reviewVerdict(review({ findings: [finding("Q-1", { disposition: undefined })] }), context()).kind).toBe("await-evidence");
  });

  it("확정 결함은 수정, 수정할 수 없으면 사유를 남긴 정지, 아무것도 없으면 통과", () => {
    const defects = context({ judgment: judgment({ remaining: ["F-1"] }) });
    expect(reviewVerdict(review({ findings: [finding("F-1")] }), defects)).toEqual({ kind: "fix", ids: ["F-1"], deferredEvidence: [] });
    for (const reason of ["used", "exhausted", "committed"] as const) {
      expect(reviewVerdict(review({ findings: [finding("F-1")] }), { ...defects, fix: reason })).toEqual({ kind: "fix-blocked", reason, ids: ["F-1"] });
    }
    expect(reviewVerdict(review({ findings: [finding("F-2", { disposition: "AGREED_NO_ACTION" })] }), context())).toEqual({ kind: "pass" });
  });

  it("판정 도달 여부 — 대기·미완료는 원장을 멈춰 두고(같은 ID 재개), 나머지는 닫는다", () => {
    const waiting = ["await-mediator", "await-decision", "await-evidence", "incomplete"];
    const verdicts = [
      reviewVerdict(review({ requestedMediatorAction: "실행" }), context()),
      reviewVerdict(review({ requestedUserDecision: "결정" }), context()),
      reviewVerdict(review({ findings: [evidence] }), context()),
      reviewVerdict(review({ status: "in_progress", remainingSteps: ["x"] }), context()),
      reviewVerdict(review(), context()),
    ];
    expect(verdicts.map((verdict) => [verdict.kind, reviewVerdictReached(verdict)]))
      .toEqual([...waiting.map((kind) => [kind, false]), ["pass", true]]);
  });
});

describe("리뷰 완료 보고 계약(D2)", () => {
  it("completed + remainingSteps 는 모순으로 교정한다", () => {
    expect(reviewContractViolation(review({ remainingSteps: ["구현자 수정 뒤 재검토"] }))).toContain("모순");
  });

  it("요청 필드 없는 in_progress 는 같은 세션 교정 대상이다(095651bf #177·86a5b979 #90 의 '코드 리뷰가 완료되지 않았습니다' 정지)", () => {
    expect(reviewContractViolation(review({ status: "in_progress", remainingSteps: ["중재자 파싱 로그 확인"] }))).toContain("요청 필드");
  });

  it("타입 있는 요청이 있으면 in_progress 도 계약 위반이 아니다 — 진짜 요청은 판정기가 멈춘다", () => {
    expect(reviewContractViolation(review({ status: "in_progress", remainingSteps: ["x"], requestedMediatorAction: "빌드" }))).toBeNull();
    expect(reviewContractViolation(review({ status: "in_progress", remainingSteps: ["x"], requestedUserDecision: "범위" }))).toBeNull();
    expect(reviewContractViolation(review({ status: "in_progress", remainingSteps: ["x"], findings: [evidence] }))).toBeNull();
    expect(reviewContractViolation(review())).toBeNull();
  });

  it("reviewCompleted·증거 분할은 판정기·수정 계약이 같은 정의를 쓴다", () => {
    expect(reviewCompleted(review())).toBe(true);
    expect(reviewCompleted(review({ status: "blocked" }))).toBe(false);
    expect(reviewCompleted(review({ remainingSteps: ["x"] }))).toBe(false);
    const decision = finding("D-1", { disposition: undefined, requiresUserDecision: true });
    expect(reviewEvidenceFindings([finding("F-1"), evidence, decision, finding("Q-1", { disposition: undefined })]).map((item) => item.id))
      .toEqual(["E-1", "Q-1"]);
  });
});

describe("resultPause — 결과가 요청한 정지의 단일 판정", () => {
  it("중재자 → 결정(요청·blocked·결정 쟁점) → 외부 증거 순서", () => {
    expect(resultPause(review({ requestedMediatorAction: " 빌드 ", requestedUserDecision: "범위" }))).toEqual({ kind: "mediator", action: "빌드" });
    expect(resultPause(review({ requestedUserDecision: "범위", findings: [evidence] }))).toMatchObject({ kind: "decision", message: "범위", blocked: false });
    expect(resultPause(review({ status: "blocked", remainingSteps: ["입력"] }))).toMatchObject({ kind: "decision", blocked: true, remainingSteps: ["입력"] });
    expect(resultPause(review({ findings: [finding("D-1", { requiresUserDecision: true, rationale: "선택 필요" })] })))
      .toMatchObject({ kind: "decision", message: "선택 필요" });
    expect(resultPause(review({ findings: [evidence] }))).toEqual({ kind: "evidence", message: "Figma 원문이 필요합니다." });
    expect(resultPause(review())).toBeNull();
  });
});
