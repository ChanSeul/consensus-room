import type { AgentResult, DeferredFinding, Finding, TimelineEvent } from "./contracts";
import type { TolerancePolicy } from "./tolerance";
import { DISPOSITIONS, FIX_AWARE_KINDS, REQUIRED_PLAN_HEADINGS } from "./contracts";

// 서버는 처분을 두 곳에서 기계적으로 검사한다 — assertDispositionsResolved(앞 단계 쟁점에 처분이 있는지)와
// assertFixDispositionAllowed(RESOLVED_BY_FIX는 실제 수정이 일어난 단계에서만). 그 규칙이 프롬프트에 없으면
// 에이전트가 값을 추측하고 턴이 통째로 거부된다(2026-08-29: 감사 ID 누락, 종결 RESOLVED_BY_FIX 오용).
// fixAware를 손으로 고르지 않는다 — 단계 kind에서 검사기와 같은 정본(FIX_AWARE_KINDS)을 읽어 파생한다.
function dispositionContract(kind: AgentResult["kind"]): string {
  const fixAware = FIX_AWARE_KINDS.has(kind);
  const usable = fixAware ? DISPOSITIONS : DISPOSITIONS.filter((value) => value !== "RESOLVED_BY_FIX");
  const forbidden = fixAware
    ? "이 단계는 실제 수정을 확인하는 단계이므로 RESOLVED_BY_FIX를 쓸 수 있습니다."
    : "이 단계에서 RESOLVED_BY_FIX를 쓰면 서버가 응답 전체를 거부합니다 — 아직 수정이 일어나지 않았기 때문입니다.";
  return `처분(disposition)은 다음 값만 씁니다: ${usable.join(", ")}.
${forbidden}
앞 단계에서 넘어온 쟁점은 하나도 빠짐없이 처분을 붙이세요. 이 단계에서 새로 발견한 쟁점은 처분을 비워 둬도 됩니다.
EXTERNAL_EVIDENCE는 증거를 **아직 기다리는 중**일 때만 씁니다 — 이미 방에 기록된 증거로 해소된 쟁점에 이 값을 쓰면 서버가 증거 대기로 읽어 진행을 막습니다. 해소됐다면 AGREED_NO_ACTION(또는 실제 조치 합의면 AGREED_ACTION)으로 처분하세요.`;
}

function renderDeferredFindings(findings: readonly DeferredFinding[] | undefined, stage: "plan" | "audit"): string {
  if (!findings || findings.length === 0) return "";
  const lines = findings
    .map((item) => `- ${item.id} [${item.severity}] ${item.title} (${item.source}, ${item.topicId.slice(0, 8)}): ${item.rationale.slice(0, 400)}`)
    .join("\n");
  return stage === "plan"
    ? `\n이전 계획·선행 토픽에서 **이연된 쟁점**(이번 범위에서 다시 판단하세요 — 넣으면 계획에 반영하고, 아니면 계획의 범위 밖 절에 이유와 함께 적으세요):\n${lines}\n`
    : `\n이미 이연 판정을 받은 쟁점(이번 범위에서 다시 판단하되, 같은 근거로 재지적하지 말고 계획이 이를 어떻게 다뤘는지만 확인하세요):\n${lines}\n`;
}

function renderFindingIndex(findings: readonly Finding[]): string {
  return findings
    .map((finding) => `- ${finding.id} [${finding.severity}] ${finding.title} → ${finding.disposition ?? "(처분 없음)"}`)
    .join("\n");
}

function renderTimeline(events: readonly TimelineEvent[], includeAllNotes = false, emptyText = "(아직 메시지가 없습니다.)"): string {
  if (events.length === 0) return emptyText;
  const important = events.filter((event) => ["scope_change", "evidence", "decision"].includes(event.kind) ||
    (includeAllNotes && event.kind === "note"));
  const recent = events.slice(-80);
  const selected = [...new Map([...important, ...recent].map((event) => [event.id, event])).values()]
    .sort((left, right) => left.sequence - right.sequence);
  const rendered = selected
    .map((event) => {
      // agent_output의 payload(findings 배열)는 싣지 않는다. 그 데이터는 각 단계 프롬프트가 이미 명시적으로
      // 전달하므로(개정=감사 JSON, 종결=개정 findings) 타임라인 경유는 순수 중복이다 — 2026-08-30 실측:
      // 세대3 타임라인 렌더 77K자 중 57K자가 이 중복이었고, 타임라인을 싣는 모든 턴에 반복 과금됐다.
      const includePayload = event.kind !== "agent_output" && Object.keys(event.payload).length > 0;
      const payload = includePayload ? `\n메타데이터: ${JSON.stringify(event.payload)}` : "";
      return `[${event.sequence}] ${event.actor}/${event.kind}\n${event.body.slice(0, 20_000)}${payload.slice(0, 20_000)}`;
    })
    .join("\n\n");
  return rendered.length <= 240_000
    ? rendered
    : `[앞부분 생략: 입력 한도를 넘었습니다.]\n\n${rendered.slice(-240_000)}`;
}

// 어댑터가 매 턴 프롬프트 앞에 붙인다. 개방된 도구의 사용 규칙은 프롬프트가 아니라 sandbox가 강제하지만,
// 스킬 문서와 하위 에이전트처럼 "읽기는 열고 실행은 재검사"인 경계는 모델에게도 알려야 오작동이 줄어든다.
// 프로젝트 지시문(CLAUDE.md·AGENTS.md)을 주입한 뒤 붙이는 우선순위 규칙. 원본 지시문은 사람이 IDE 에서 쓰는 전제라
// 방의 게이트 계약과 충돌하는 조항이 있고, 홈 아래 참조 문서·훅은 러너 샌드박스에서 접근 불가다(2026-09-02 실측).
export const PROJECT_INSTRUCTION_PRECEDENCE_NOTE = [
  "프로젝트 지시문 적용 규칙 — 이 방의 계획·게이트·결정문이 프로젝트 지시문보다 우선한다:",
  "1. 빌드·테스트·시뮬레이터 실행 여부와 검증 범위는 방의 계획과 게이트를 따른다. 프로젝트 지시문의 \"요청 없이 xcodebuild 금지\"·\"빌드 후 시뮬레이터 설치·실행·로그 확인\" 조항은 이 방에서 적용하지 않는다.",
  "2. 커밋·push·stash 는 방 계약대로 전부 하지 않는다.",
  "3. 홈 디렉터리(~/.claude/…, iCloud) 아래의 참조 문서 경로와 훅 ack 명령은 이 샌드박스에서 읽거나 실행할 수 없다 — 시도하지 않는다. 필요한 메모리는 방이 프롬프트에 직접 넣는다.",
  "4. Xcode 탭·IPA 출력·CI 배포·릴리스 브랜치 동기화 조항은 이 방과 무관하다.",
  "5. 그 밖의 조항(코드 스타일, 근본 해결·이연 금지, 절대 금지 사항, SwiftUI 방침, 분석·비교 방침, 응답 언어)은 그대로 따른다.",
].join("\n");

export const EXECUTION_POLICY_NOTE = [
  "실행 규칙: 스킬 문서는 읽고 참고할 수 있지만, 스킬이 지시하는 셸·MCP·브라우저 작업은 이 방의 권한 규칙을 따로 통과해야 합니다.",
  "웹은 검색과 공개 문서 읽기에만 씁니다. 하위 에이전트가 있다면 탐색·검증에만 쓰고 같은 파일은 한 작업자만 수정합니다.",
].join("\n");

// 출력 언어 계약. 한국어는 실측 2.0바이트/토큰, 영어는 ~4.4 — 같은 내용을 한국어로 쓰면 출력 토큰이
// 약 2배이고 방출 시간도 2배다(2026-08-31 실측: 한국어 계획 61K 토큰 방출에 34분). 대량 방출 지점만
// 영어로 강제하고, 구조 검증에 걸리는 절 제목과 사용자가 직접 읽는 필드는 한국어를 유지한다.
function outputLanguageContract(options: { planBody: boolean }): string {
  const lines = [
    "출력 언어: findings의 title과 rationale은 영어로 작성하세요(한국어는 토큰이 약 2배라 방출이 두 배 느립니다).",
    "summary와 requestedUserDecision은 사용자가 직접 읽으므로 한국어로 쓰세요.",
    "한국어로 된 입력(결정·증거·기존 문서)은 번역하지 말고 그대로 인용하세요.",
  ];
  if (options.planBody) {
    lines.push(
      "계획 본문(planMarkdown)의 새 내용은 영어로 쓰되, 필수 절 제목은 위의 한국어 제목을 글자 그대로 유지하세요.",
      "이미 한국어로 작성된 기존 계획을 고칠 때는 문서의 기존 언어를 따르고, 바뀌지 않는 내용을 번역하지 마세요 — 번역은 전문 재방출을 일으킵니다.",
    );
  }
  return lines.join("\n");
}

function planContract(): string {
  return [
    "최종 plan.md에는 아래 제목이 모두 있어야 합니다.",
    ...REQUIRED_PLAN_HEADINGS.map((heading) => `- ## ${heading}`),
    "`## 허용 오차` 절에는 fenced 블록 ```tolerance {JSON} ``` 을 둡니다 — scopePaths(이 계획의 승인 경로 glob 목록)와 rules(각각 id `T-n`·title·paths(적용 영역 glob)·hunk(`insert-token`|`annotation-only`|`any`)·tokens·maxFiles·maxHunks·invariants). 규칙이 없으면 `\"rules\": []`. 서버가 이 블록을 파싱해 구현 결과의 승인 범위 밖 변경을 git diff 로 기계 대조하므로, 술어는 diff 만으로 판정 가능해야 하고 상한은 숫자여야 합니다. 부류 예: 다른 단계 소유 파일의 격리 표기 한 줄(insert-token: nonisolated), 모듈 선언의 표기 변경(annotation-only: @Sendable). 동작 변경·우회 표기(`@unchecked Sendable`·`nonisolated(unsafe)`·`assumeIsolated`)는 규칙으로 허용하지 마세요.",
    "확정되지 않은 분석 이벤트, API 계약, SDK 동작을 추정해서 만들지 마세요.",
    "외부 증거가 없으면 EXTERNAL_EVIDENCE로 남기고 억지로 합의하지 마세요.",
  ].join("\n");
}

function finalReviewContract(): string {
  return [
    "이것은 한 번의 수정 뒤 최종 검토입니다. 같은 증거의 반복 지적은 하지 마세요.",
    "첫 리뷰에서 AGREED_ACTION이던 쟁점은 수정을 직접 확인했으면 RESOLVED_BY_FIX로 처분하세요.",
    "아직 남아 있으면 AGREED_ACTION을 그대로 유지하세요.",
    "요구 자체를 철회하려면 AGREED_NO_ACTION, REFUTED, DEFERRED_OUT_OF_SCOPE 중 하나를 쓰되,",
    "그 경우 자동으로 전달 준비로 넘어가지 않고 사용자 판단을 기다립니다.",
    "이번 검토에서 처음 발견한 쟁점은 RESOLVED_BY_FIX 로 닫지 말고 **분류**하세요:",
    "- 승인 범위 안의 확정 결함·이번 수정으로 생긴 결함 → AGREED_ACTION (남은 수정 회차 안에서 바로 수정됩니다)",
    "- 이번 범위 밖 개선 제안 → DEFERRED_OUT_OF_SCOPE (후속 목록에 기록되고 전달을 막지 않습니다)",
    "- 제품 결정·범위 변경이 필요한 문제 → requiresUserDecision=true",
    "- 같은 근거로 이미 끝난 지적은 반복하지 마세요.",
  ].join("\n");
}

export function buildClaudePlanPrompt(input: {
  title: string;
  worktreePath: string;
  sourceRepositoryPath: string;
  baseRef: string;
  scopeGeneration: number;
  timeline: readonly TimelineEvent[];
  // 수렴 재시작(closeout 신규 쟁점) 때 직전 계획 전문 — 없으면 새 계획. 타임라인 이벤트와 달리 자르지 않는다.
  previousPlanMarkdown?: string | null;
  // 이 토픽·선행 토픽이 이연한 쟁점 — 이번 범위에서 다시 판단한다(2026-09-07).
  deferredFindings?: readonly DeferredFinding[];
}): string {
  const deferred = renderDeferredFindings(input.deferredFindings, "plan");
  const previous = input.previousPlanMarkdown
    ? `\n직전 계획 전문(재시작 전 마지막 판): 아래 본문을 **그대로 기반**으로 삼고, 타임라인의 최신 결정과 감사 지적만 반영해 다시 내세요. 압축 재작성으로 합의된 검증 규칙·스키마·명령을 빠뜨리지 마세요(2026-09-03 S6 실측: 재시작마다 합의가 새어 3라운드 반복).\n${input.previousPlanMarkdown}\n`
    : "";
  return `당신은 Consensus Room의 계획 작성자입니다. 이 단계에서는 코드를 수정하지 마세요.

주제: ${input.title}
작업 worktree: ${input.worktreePath}
원본 저장소(메타데이터이며 작업 경로로 사용하지 않음): ${input.sourceRepositoryPath}
기준 리비전: ${input.baseRef}
범위 세대: ${input.scopeGeneration}

대화와 증거:
${renderTimeline(input.timeline)}
${previous}${deferred}
${planContract()}

${outputLanguageContract({ planBody: true })}
${dispositionContract("PLAN")}

저장소와 제공된 증거를 읽고 실행 가능한 첫 계획을 작성하세요. 추정과 확인한 사실을 분리하세요.
반환 JSON의 kind는 PLAN, planMarkdown에는 계획 전문을 넣으세요.`;
}

export function buildCodexAuditPrompt(input: {
  title: string;
  planMarkdown: string;
  planSHA256: string;
  scopeGeneration: number;
  timeline: readonly TimelineEvent[];
  planningContextMode?: "full" | "delta";
  claudePlan?: AgentResult;
  deferredFindings?: readonly DeferredFinding[];
}): string {
  return `당신은 Consensus Room의 읽기 전용 적대적 검토자입니다. 코드를 절대 수정하지 마세요.

주제: ${input.title}
범위 세대: ${input.scopeGeneration}
검토할 계획 SHA-256: ${input.planSHA256}

검토할 계획:
---
${input.planMarkdown}
---

Claude가 계획과 함께 기록한 쟁점:
${JSON.stringify(input.claudePlan?.findings ?? [], null, 2)}

${input.planningContextMode === "delta" ? "직전 전달 이후 추가된 결정과 증거:" : "대화와 증거:"}
${renderTimeline(input.timeline, false, input.planningContextMode === "delta" ? "(직전 전달 이후 새 결정·증거 없음)" : undefined)}
${renderDeferredFindings(input.deferredFindings, "audit")}
${outputLanguageContract({ planBody: false })}
${dispositionContract("AUDIT")}

계획의 사실 오류, 빠진 실패 경로, 승인 경계 위반, 검증할 수 없는 주장, 과도한 범위를 찾으세요.
\`## 허용 오차\` 블록도 검토하세요: 규칙 술어가 diff 만으로 기계 판정 가능한지, 상한이 있는지, 동작 변경이나 우회 표기를 허용하지 않는지, 소유 단계의 불변식(예: 소유 폴더 진단 0 유지)을 적었는지.
각 finding은 근거와 재현·검증 방법을 적고, 아직 처분하지 마세요. 반환 kind는 AUDIT입니다.

위에 나열된 Claude의 쟁점 ID(${(input.claudePlan?.findings ?? []).map((finding) => finding.id).join(", ") || "없음"})는
하나도 빠뜨리지 말고 같은 ID로 반환 findings에 다시 담으세요. 서버가 ID 누락을 기계적으로 검사해 응답을 거부합니다.
각 항목에는 그 쟁점을 검증한 결과를 rationale에 적고, 새로 발견한 결함은 새 ID로 추가하세요.`;
}

export function buildClaudeRevisionPrompt(input: {
  planMarkdown: string;
  audit: AgentResult;
  scopeGeneration: number;
  timeline?: readonly TimelineEvent[];
  // "closeout": 종결 확인이 낸 새 쟁점만 반영하는 개정 2회차(2026-09-07). audit 에는 그 새 쟁점만 담아 보낸다.
  source?: "audit" | "closeout";
}): string {
  const closeoutRound = input.source === "closeout";
  return `이 단계에서도 코드를 수정하지 마세요. ${closeoutRound
    ? "Codex 종결 확인이 새로 낸 쟁점에만 답하고 계획을 한 번 더 개정합니다(개정 2회차). 이미 합의된 다른 부분은 건드리지 마세요."
    : "Codex 감사에 답하고 계획을 한 번만 개정합니다."}

범위 세대: ${input.scopeGeneration}
기존 계획:
---
${input.planMarkdown}
---

${closeoutRound ? "Codex 종결 확인의 새 쟁점:" : "Codex 감사:"}
${JSON.stringify(input.audit, null, 2)}

방에 추가된 결정과 증거:
${renderTimeline(input.timeline ?? [])}

${dispositionContract("REVISION")}
${outputLanguageContract({ planBody: true })}
반박할 때는 근거를 적고, 합의된 변경은 계획에 실제로 반영하세요. 새 범위를 몰래 추가하지 마세요.
${planContract()}
반환 kind는 REVISION입니다. 계획 전문을 다시 쓰지 말고 **planEdits 패치**로 반환하세요:
- planEdits는 {find, replace} 목록이고 순서대로 적용됩니다.
- 각 find는 위 "기존 계획" 본문에서 **정확히 한 번** 일치하는 원문이어야 합니다. 0회나 복수 일치면
  서버가 어느 편집이 실패했는지 명시하며 응답을 거부합니다. 필요하면 앞뒤 문맥을 늘려 유일하게 만드세요.
- 삭제는 replace를 빈 문자열로 표현합니다. planEdits를 쓸 때 planMarkdown은 null로 두세요.
- 계획 구조 대부분을 다시 쓰는 개정만 예외적으로 planMarkdown 전문을 사용하세요(그때 planEdits는 null).
  둘 다 있으면 planEdits가 적용됩니다.`;
}

export function buildCodexCloseoutPrompt(input: {
  revisedPlan: string;
  revisedPlanSHA256: string;
  claudeRevision: AgentResult;
  // 종결 재시도 때 새로 올라온 결정·증거가 이 프롬프트에 실리지 않으면 재시도의 의미가 없다(감사 ⑨).
  timeline: readonly TimelineEvent[];
  planningContextMode?: "full" | "delta";
  // 개정 2회차 뒤의 종결 확인이면 true — 새 ID 를 또 내면 처음부터 다시 돌게 되므로 정말 새 결함일 때만.
  secondRound?: boolean;
}): string {
  return `읽기 전용 최종 의견 수렴입니다. 코드를 수정하지 마세요.

개정 계획 SHA-256: ${input.revisedPlanSHA256}
개정 계획:
---
${input.revisedPlan}
---

Claude의 처분:
${JSON.stringify(input.claudeRevision.findings, null, 2)}

${input.planningContextMode === "delta" ? "직전 전달 이후 추가된 결정과 증거:" : "방에 추가된 결정과 증거:"}
${renderTimeline(input.timeline, false, input.planningContextMode === "delta" ? "(직전 전달 이후 새 결정·증거 없음)" : undefined)}

이미 같은 증거로 끝난 논점을 다시 열지 마세요. 재개할 수 있는 조건은 변경된 리비전, 새 실행 증거, 새로 읽은 1차 자료,
서로 다른 새 결함, 사용자의 명시적 재개뿐입니다. 각 finding의 최종 disposition을 확인하세요.

${dispositionContract("CLOSEOUT")}
${outputLanguageContract({ planBody: false })}

종결 확인에서는 기존 지적이 해결됐는지, 이번 개정이 영향을 주는 부분에 문제가 생겼는지 확인합니다. 같은 근거로 끝난 지적은 반복하지 않습니다.
새 결함은 기록하되 **분류**하세요 — 이번 계획의 완료 조건을 막는 이유와 후속 작업으로 넘겨도 되는 이유를 구분합니다:
- 이번 계획의 필수 조건 누락·개정 때문에 생긴 결함 → AGREED_ACTION (${input.secondRound
    ? "개정 2회차는 이미 썼으므로 사용자 결정을 거쳐 최신 계획 위에 반영됩니다. 완료 조건을 막는 경우에만 쓰세요"
    : "Claude가 개정 2회차로 그 쟁점만 반영한 뒤 다시 종결 확인합니다, 바퀴당 1회"}).
- 이번 작업 범위 밖의 개선 제안 → DEFERRED_OUT_OF_SCOPE (후속 목록에 기록되고 이 계획을 막지 않습니다).
- 같은 근거로 이미 결론 난 지적 → 다시 내지 마세요.
- 제품 결정·범위 변경이 필요한 문제 → requiresUserDecision=true.
새 결함 때문에 requestedUserDecision 을 쓰지 마세요 — 분류가 다음 행동을 정합니다.
외부 증거나 사용자 판단이 남으면 정확히 표시하고, 그렇지 않으면 이 SHA를 planSHA256에 넣어 확인하세요.
반환 kind는 CLOSEOUT입니다.`;
}

// 이 프롬프트는 대화 이력 없는 일회용 세션에서 실행된다. 그래서 판단에 필요한 것을 전부 담는다 —
// 세션을 이어받으면 합의 대화 전체가 다시 실려 프로토콜 확인 한 번에 비용이 폭증한다.
export function buildPlanAckPrompt(planSHA256: string, planMarkdown: string): string {
  return `프로토콜 확인 단계입니다. 코드를 수정하거나 계획을 다시 논의하지 마세요.

이 방이 합의한 최종 계획 전문입니다.
---
${planMarkdown}
---

서버가 계산한 SHA-256: ${planSHA256}

파일을 읽거나 명령을 실행하지 마세요. 해시를 직접 계산하지도 마세요 — 도구가 열려 있지 않고,
이 단계에서 확인할 것은 위 본문이 합의된 계획으로서 온전한가입니다.
본문이 잘려 있거나 비어 있지 않고 계획으로 성립하면 kind=ACK, planSHA256=${planSHA256}로 반환하세요.
그렇지 않으면 ACK하지 말고 requestedUserDecision에 무엇이 어긋났는지 적으세요.
설명을 길게 쓰지 말고 summary는 한 문장으로 끝내세요.`;
}

// 정지 정책 — requestedUserDecision 은 드물게. 2026-09-08 사용자 지시("retry 가 일상이 되지 않게"):
// 범위 밖은 구현도 대기도 하지 말고 to-do 로 남기고 계속한다. S9/S10 실측: 정지 1회 = 결정문 작성 10~15분 +
// 재기동·상태 재확인 5~10분이고, 범위 밖을 미리 구현하면 Codex 가 되돌리게 해 그 왕복이 더 크다.
export function stopPolicyContract(): string {
  return `정지 정책 — requestedUserDecision 은 드물게 씁니다:
- 승인 범위 밖 변경이 필요한 자리는 먼저 계획의 \`## 허용 오차\` 규칙과 대조하세요. **규칙 술어를 만족하면 구현하고 반환 JSON 의 toleranceLedger 에 {ruleId, file, note} 로 적으세요**(서버가 git diff 로 대조하며, 원장에 없는 범위 밖 변경은 되돌리게 합니다). 규칙 밖(다른 단계가 소유한 파일의 다른 변경, 모듈 선언, 우회 표기가 필요한 자리)은 **코드를 건드리지 말고 to-do 로 남기고 계속**하세요. 원장·보고서에 진단 정체성·원인 선언·필요한 변경·권장 형태를 한 줄로 적고 다음 일로 갑니다. 그 항목 때문에 턴을 끝내지 마세요. 범위 밖을 미리 구현하는 것도 금지입니다(리뷰가 되돌리게 합니다).
- requestedUserDecision 으로 턴을 끝내는 경우는 셋뿐입니다: (1) 중재자가 실행해야 하는 게이트(시뮬레이터·xcodebuild 등 러너가 돌릴 수 없는 단계), (2) 계획의 전제가 계측으로 반박돼 남은 작업의 방향이 갈릴 때, (3) 되돌리기 어려운 변경(외부 계약·동작 변경)을 피할 수 없을 때.
- to-do 는 원장·보고서 표와 함께 **반환 findings 에도** 남기세요: id \`TODO-n\`, disposition \`DEFERRED_OUT_OF_SCOPE\`, rationale 에 진단 정체성·원인 선언·필요한 변경·권장 형태. 방이 후속 목록에 기록해 다음 계획 턴에 자동으로 싣고, 인도 전에 사용자가 처분(후속 토픽·다음 계획 포함·폐기)을 정합니다.
- 그 경우에도 **한 턴에 한 번, 턴 끝에 모아서** 요청하세요. 요청 전에 결정과 무관한 일을 전부 끝내고, 요청문에는 실측 값·후보·권고를 적어 한 번의 답으로 끝나게 하세요.`;
}

// 계획 본문 절: 첫 턴은 전문, 이어지는 턴은 "이미 전달됨" + 원문 파일 경로(읽기 허용).
function planSection(input: { planMarkdown: string; resumedSession?: boolean; planPath?: string | null }): string {
  if (!input.resumedSession) return `승인된 계획:\n---\n${input.planMarkdown}\n---`;
  const reread = input.planPath
    ? ` 세션 기억이 압축돼 세부가 필요하면 \`${input.planPath}\` 를 읽으세요 — 이 턴에 읽기가 허용돼 있습니다.`
    : "";
  return `(이 세션에 이미 전달한 계획과 같은 전문입니다. 본문은 다시 싣지 않습니다.${reread})`;
}

function continuedTimelineHeading(resumed: boolean | undefined, first: string): string {
  return resumed ? "직전 턴 이후 방에 추가된 사용자 결정과 증거(그 전 것은 이 세션이 이미 받았습니다):" : first;
}

function continuedTimelineEmpty(resumed: boolean | undefined): string | undefined {
  return resumed ? "(직전 턴 이후 새 결정·증거 없음)" : undefined;
}

// 이어지는 턴(resumedSession — 결정 뒤 retry, kickoffDecision 없는 재개 등)은 세션이 이미 받은 것을 다시 싣지 않는다
// (2026-09-08 Codex 제안 ⑥): 계획은 SHA 와 파일 경로만, 타임라인은 직전 턴 이후 이벤트만. 트레이드오프는 리뷰 세션과 같다 —
// CLI 자동 압축으로 계획 기억이 요약됐을 수 있으므로 planPath 를 읽기 허용으로 함께 넘긴다.
export function buildImplementationPrompt(input: {
  planMarkdown: string;
  planSHA256: string;
  worktreePath: string;
  branchName: string;
  timeline: readonly TimelineEvent[];
  resumedSession?: boolean;
  planPath?: string | null;
}): string {
  return `${input.resumedSession
    ? "이 구현 세션의 이어지는 턴입니다. 같은 승인 범위를 계속 구현하세요."
    : "사용자가 아래 계획 버전을 명시적으로 승인했습니다. 이제 이 범위만 구현하세요."}

계획 SHA-256: ${input.planSHA256}
작업 worktree: ${input.worktreePath}
작업 브랜치: ${input.branchName}

${planSection(input)}

${continuedTimelineHeading(input.resumedSession, "현재 방의 사용자 결정과 증거:")}
${renderTimeline(input.timeline, false, continuedTimelineEmpty(input.resumedSession))}

구현 중 발견해 이 턴에서 실제로 고친 쟁점은 RESOLVED_BY_FIX로 처분하고 확인 방법을 evidenceRefs에 남기세요.

${dispositionContract("IMPLEMENTATION")}

분석 이벤트와 외부 계약을 추정하지 마세요.

${stopPolicyContract()}

관련 테스트를 실행하되 commit과 push는 하지 마세요. 반환 kind는 IMPLEMENTATION이며 변경 파일과 검증 근거를 evidenceRefs에 적으세요.`;
}

// resumedSession: 이 코드 리뷰 전용 세션이 이미 승인된 계획 전문과 검토 findings를 받았다. 그때는
// 계획 SHA 만 주고 본문을 생략하며 첫 리뷰 findings 는 id·심각도·제목·처분만 준다(2026-09-07 제안 ①).
// 트레이드오프: 세션이 CLI 자동 압축을 겪었으면 계획 본문 기억이 요약으로 줄어 있을 수 있다 — 그 경우 검토자는
// 방 결정과 diff 로 판단하고, 범위 판단이 막히면 requestedUserDecision 으로 올린다.
export function buildCodexReviewPrompt(input: {
  planMarkdown: string;
  planSHA256: string;
  implementation: AgentResult;
  finalPass: boolean;
  timeline: readonly TimelineEvent[];
  originalReviewFindings?: readonly Finding[];
  resumedSession?: boolean;
  planningFindings?: readonly Finding[];
  planningEvidenceRefs?: readonly string[];
  verificationReceipts?: string;
  // 최종 리뷰: 직전 리뷰 이후 실제로 바뀐 파일과 패치(2026-09-07 Codex 피드백 ①). 있으면 재검토 범위를 이것으로 좁힌다.
  deltaSinceLastReview?: { files: readonly string[]; patch: string } | null;
  // 서버의 허용 오차 대조 결과(규칙·원장·판정). 있으면 범위 밖 변경은 이것으로 판정한다.
  tolerance?: string | null;
  // 계획 원문 파일(읽기 허용). 재개 세션이 압축됐을 때 본문 대신 읽을 수 있다.
  planPath?: string | null;
}): string {
  const knownDelta = input.finalPass && input.resumedSession ? input.deltaSinceLastReview : null;
  const delta = knownDelta
    ? `\n직전 리뷰 이후 실제 변경분(파일 ${knownDelta.files.length}개):\n${knownDelta.files.map((file) => `- ${file}`).join("\n")}\n---\n${
      knownDelta.patch.length > 200_000
        ? `${knownDelta.patch.slice(0, 200_000)}\n[이하 생략: 패치가 200,000자를 넘습니다 — 나머지는 파일 목록으로 직접 확인]`
        : knownDelta.patch}\n---\n**재검토 범위**: 위 변경분과 그 변경이 영향을 주는 호출부·상태 전이만 다시 봅니다. 바뀌지 않은 부분은 앞선 리뷰 결과를 이어받고 전체를 다시 탐색하지 마세요.\n`
    : "";
  const plan = input.resumedSession
    ? `승인된 계획 SHA-256: ${input.planSHA256}
(이 리뷰 세션에 이미 전달한 계획과 같은 전문입니다. 본문은 다시 싣지 않습니다.${
      input.planPath ? ` 세션 기억이 압축돼 세부가 필요하면 \`${input.planPath}\` 를 읽으세요 — 이 턴에 읽기가 허용돼 있습니다.` : ""})`
    : `승인된 계획 SHA-256: ${input.planSHA256}
승인된 계획:
---
${input.planMarkdown}
---`;
  const originalFindings = !input.originalReviewFindings
    ? ""
    : input.resumedSession
      ? `첫 코드 리뷰의 수정 대상(이 세션에서 확인한 finding — id·심각도·제목·처분만 다시 적습니다):\n${
        renderFindingIndex(input.originalReviewFindings)}\n`
      : `첫 코드 리뷰의 수정 대상:\n${JSON.stringify(input.originalReviewFindings, null, 2)}\n`;
  return `당신은 읽기 전용 코드 검토자입니다. 파일을 수정하지 마세요.

${plan}

${input.planningFindings ? `계획 검토의 최종 처분과 근거(계획상 합의이며 구현 완료 증거는 아닙니다):\n${JSON.stringify({
    findings: input.planningFindings, evidenceRefs: input.planningEvidenceRefs ?? [],
  }, null, 2)}\n` : ""}
Claude 구현 보고:
${JSON.stringify(input.implementation, null, 2)}

${input.verificationReceipts ?? ""}

${originalFindings}${delta}${input.tolerance ? `\n허용 오차 대조(서버가 git diff 로 판정한 결과 — 승인 범위 밖 변경은 이 결과와 원장으로 판정하세요; 원장에 있고 술어를 만족하는 hunk 는 범위 이탈이 아닙니다):\n${input.tolerance}\n` : ""}
${input.resumedSession ? "이 리뷰 세션의 직전 턴 이후 방에 추가된 사용자 결정과 증거(그 전 것은 이 세션이 이미 받았습니다):" : "방에 추가된 사용자 결정과 증거:"}
${renderTimeline(input.timeline, true, input.resumedSession ? "(직전 리뷰 턴 이후 새 결정·증거 없음)" : undefined)}

${knownDelta
    ? "finding 별 수정 근거(원인 → 고친 위치 → 실행한 검증 → 미확인 부분)를 실제 코드와 대조해 판정하세요. 같은 코드·의존성·실행 조건에서 이미 통과한 검사는 결과를 재사용하고, 이번 수정이 영향을 준 검사만 다시 요구하세요."
    : "현재 diff와 테스트 증거를 직접 확인하고 정확성, 보안, 취소·복구, 범위 이탈, 테스트 공백을 검토하세요."}
${input.finalPass ? finalReviewContract() : "수정이 필요한 finding은 AGREED_ACTION으로 표시하세요."}

${dispositionContract(input.finalPass ? "FINAL_REVIEW" : "REVIEW")}
${outputLanguageContract({ planBody: false })}

반환 kind는 ${input.finalPass ? "FINAL_REVIEW" : "REVIEW"}입니다.`;
}

export function buildClaudeFixPrompt(input: {
  planMarkdown: string;
  reviewFindings: readonly Finding[];
  timeline: readonly TimelineEvent[];
  // 구현 세션을 이어 쓰는 수정 턴: 계획 본문 생략 + 직전 턴 이후 이벤트만(2026-09-08 Codex 제안 ⑥). 세션 유실로 새 세션이면 false.
  resumedSession?: boolean;
  planSHA256?: string | null;
  planPath?: string | null;
}): string {
  return `승인된 계획 범위 안에서 Codex가 확정한 finding을 한 번만 수정하세요.

${input.resumedSession ? `승인된 계획 SHA-256: ${input.planSHA256 ?? "(미기록)"}\n` : ""}${planSection(input)}

수정 대상:
${JSON.stringify(input.reviewFindings, null, 2)}

${continuedTimelineHeading(input.resumedSession, "방에 추가된 사용자 결정과 증거:")}
${renderTimeline(input.timeline, false, continuedTimelineEmpty(input.resumedSession))}

실제로 고친 finding은 RESOLVED_BY_FIX로 처분하고, **finding 별로** evidenceRefs 에 다음 형식의 한 줄을 남기세요
(Codex 가 원인과 확인 방법을 다시 찾지 않게): \`F-12 → 발생 원인 → 고친 파일:위치 → 실행한 검증과 로그 경로 → 아직 확인하지 못한 부분\`.
고치지 못한 finding은 AGREED_ACTION을 그대로 유지하세요. 고치지 않은 것을 RESOLVED_BY_FIX로 적지 마세요.

${dispositionContract("FIX")}
${outputLanguageContract({ planBody: false })}

${stopPolicyContract()}

관련 테스트를 실행하되 commit과 push는 하지 마세요. 반환 kind는 FIX입니다.`;
}

// 기계 검사가 거부한 응답을 같은 세션에 돌려보내 표기만 고친 재제출을 받는다. 작업을 다시 시키는 것이
// 아니다 — 세션 컨텍스트에 직전 작업이 전부 있으므로 결과 JSON만 계약에 맞춰 다시 방출하면 된다
// (2026-09-01 S1.1: 계약 위반 하나로 1시간 구현 턴이 소각된 사건의 프로그램적 방지).
export function buildContractCorrectionPrompt(violation: string): string {
  return `서버 기계 검사가 방금 응답을 거부했습니다.

거부 사유: ${violation}

작업을 다시 하지 마세요. 파일도 수정하지 마세요. 직전 턴에서 실제로 한 작업 내용 그대로,
거부 사유가 가리키는 필드 값만 계약에 맞게 고쳐 전체 결과 JSON을 다시 반환하세요.
kind는 직전 응답과 동일하게 유지하고, 사실과 다른 값으로 바꿔치기하지 마세요 —
계약에 맞는 값 중 실제 상황을 정직하게 나타내는 값을 고르세요.`;
}

// 허용 오차 위반 교정 — 같은 세션에 위반 목록을 돌려보내 되돌리거나 원장을 채우게 한다(한 번만; 두 번째 위반은 사용자 결정).
export function buildToleranceCorrectionPrompt(
  violations: readonly string[], policy: TolerancePolicy, kind: "IMPLEMENTATION" | "FIX",
): string {
  const rules = policy.rules.map((rule) => ({
    id: rule.id, title: rule.title, paths: rule.paths, hunk: rule.hunk, tokens: rule.tokens, maxFiles: rule.maxFiles, maxHunks: rule.maxHunks,
  }));
  return `서버가 승인 범위 밖 변경을 계획의 허용 오차 규칙과 git diff 로 대조했더니 아래가 어긋납니다. 코드를 고쳐 같은 kind 로 다시 제출하세요(같은 세션, 한 번만).
${violations.map((violation) => `- ${violation}`).join("\n")}

승인 범위(scopePaths): ${policy.scopePaths.join(", ")}
허용 오차 규칙: ${JSON.stringify(rules)}

할 일:
1. 규칙 술어를 만족하지 못하는 범위 밖 변경은 **되돌리고**(파일을 기준 커밋 상태로) to-do 로 옮기세요 — 원장·보고서에 진단·원인·필요한 변경을 한 줄로.
2. 술어를 만족하는 범위 밖 변경은 toleranceLedger 에 {ruleId, file, note} 로 빠짐없이 적으세요. 원장에는 실제로 바뀐 범위 밖 파일만 적습니다.
3. summary·findings·evidenceRefs 는 고친 상태를 반영해 다시 내세요.

${dispositionContract(kind)}`;
}
