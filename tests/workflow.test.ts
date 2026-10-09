import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { AgentResult, Finding, Participant } from "../src/shared/contracts";
import { AgentResultSchema, BranchNameSchema, CreateTopicInputSchema, REQUIRED_PLAN_HEADINGS } from "../src/shared/contracts";
import {
  assertImplementationGate,
  assertPlanContract,
  assertTransition,
  bothAgentsAcknowledged,
  hashPlan,
  normalizePlan,
  redactSecrets,
  resolutionIds,
  resolveBranchName,
  CORRECTION_SUMMARY_SEPARATOR,
  mergeCorrectionResult,
  salvageResultFields,
} from "../src/shared/workflow";

function completePlan(extra = ""): string {
  return `${REQUIRED_PLAN_HEADINGS.map((heading) => `## ${heading}\n\n내용${heading === "허용 오차" ? '\n\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```' : ""}`).join("\n\n")}\n${extra}`;
}

function participants(sha: string | null): Participant[] {
  return [
    { role: "claude", sessionId: "claude-1", mode: "created", acknowledgedPlanSHA256: sha },
    { role: "codex", sessionId: "codex-1", mode: "created", acknowledgedPlanSHA256: sha },
  ];
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-1",
    title: "취소 뒤 결과 반영",
    severity: "HIGH",
    disposition: "AGREED_ACTION",
    rationale: "늦게 도착한 결과가 현재 화면을 덮습니다.",
    evidenceRefs: ["src/view-model.ts:42"],
    requiresUserDecision: false,
    ...overrides,
  };
}

describe("구현 브랜치 이름", () => {
  const base = {
    requestedBranchName: null as string | null,
    branchPrefix: "consensus",
    slug: "devscrum-9071-s0-1-rx-removal",
    id: "0f56d712-370c-400f-a834-d24b18980237",
    scopeGeneration: 1,
  };

  it("이름을 지정하지 않으면 접두사와 id·세대 접미사로 만든다", () => {
    expect(resolveBranchName(base))
      .toBe("consensus/devscrum-9071-s0-1-rx-removal-0f56d712-g1");
    expect(resolveBranchName({ ...base, branchPrefix: "refactoring", scopeGeneration: 2 }))
      .toBe("refactoring/devscrum-9071-s0-1-rx-removal-0f56d712-g2");
  });

  it("이름을 지정하면 접두사·slug 없이 그 이름을 base로 쓴다", () => {
    expect(resolveBranchName({ ...base, requestedBranchName: "refactoring/PROJECT-123" }))
      .toBe("refactoring/PROJECT-123-g1");
  });

  // 세대 접미사는 지정 이름에도 붙는다. 없으면 범위가 바뀌어도 이전 세대 브랜치를 이어 쓴다.
  it("범위 세대가 올라가면 지정 이름도 다른 브랜치가 된다", () => {
    const pinned = { ...base, requestedBranchName: "refactoring/PROJECT-123" };
    expect(resolveBranchName({ ...pinned, scopeGeneration: 3 })).toBe("refactoring/PROJECT-123-g3");
    expect(resolveBranchName({ ...pinned, scopeGeneration: 3 })).not.toBe(resolveBranchName(pinned));
  });
});

describe("계획 검토 상태", () => {
  it("사용자가 계획 검토를 시작하면 작성 → 검토 ⇄ 수정 → 동의 뒤 승인 대기 순서를 허용한다", () => {
    const path = [
      ["DRAFT", "CLAUDE_PLAN"],
      ["CLAUDE_PLAN", "CODEX_AUDIT"],
      ["CODEX_AUDIT", "CLAUDE_REVISION"],
      ["CLAUDE_REVISION", "CODEX_AUDIT"],
      ["CODEX_AUDIT", "AWAITING_USER_APPROVAL"],
    ] as const;

    for (const [from, to] of path) {
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  it("사용자가 승인하지 않았는데 구현으로 건너뛰면 거부한다", () => {
    expect(() => assertTransition("CODEX_AUDIT", "IMPLEMENTING")).toThrow(
      "허용되지 않은 상태 전이",
    );
  });
});

describe("계획 본문과 버전", () => {
  it("사용자가 완성된 계획을 제출하면 필수 절을 모두 확인한다", () => {
    expect(() => assertPlanContract(completePlan())).not.toThrow();
  });

  it("계획에서 실패·취소·복구 절이 빠지면 합의 단계로 보내지 않는다", () => {
    const incomplete = completePlan().replace("## 실패·취소·복구\n\n내용\n\n", "");

    expect(() => assertPlanContract(incomplete)).toThrow("실패·취소·복구");
  });

  it("같은 계획의 줄바꿈과 마지막 공백만 달라도 같은 SHA-256 버전으로 본다", () => {
    const plan = completePlan();
    const windowsLineEndings = `  ${plan.replace(/\n/g, "\r\n")}   `;

    expect(hashPlan(windowsLineEndings)).toBe(hashPlan(plan));
    expect(normalizePlan(windowsLineEndings)).toBe(normalizePlan(plan));
  });

  it("계획 내용이 실제로 바뀌면 새 버전으로 본다", () => {
    expect(hashPlan(completePlan("첫 안"))).not.toBe(hashPlan(completePlan("둘째 안")));
  });

  it("기존 계획 해시 규칙은 보존한다 — LF 원문은 원문 SHA-256 그대로다", () => {
    const old = '```tolerance\n{"scopePaths":["a/**"],"rules":[],}\n```\n';
    expect(hashPlan(old)).toBe(createHash("sha256").update(old).digest("hex"));
  });
});

describe("동일 계획 ACK와 사용자 승인", () => {
  it("계획 작업은 사용자가 현재 계획 버전을 승인하면 구현을 시작할 수 있다", () => {
    const sha = hashPlan(completePlan());

    expect(bothAgentsAcknowledged(participants(sha), sha)).toBe(true);
    expect(() =>
      assertImplementationGate({
        state: "AWAITING_USER_APPROVAL",
        workflowMode: "planned",
        planSHA256: sha,
        approvedPlanSHA256: sha,
      }),
    ).not.toThrow();
  });

  // CR 흐름 단순화 D1: 두 에이전트의 계획 확인(ACK)은 구현 시작 조건이 아니다 — 사용자 승인만 권한으로 남는다.
  it("계획 작업은 두 에이전트의 계획 확인이 엇갈려도 사용자 승인이 현재 계획이면 구현을 막지 않는다", () => {
    const current = hashPlan(completePlan("현재"));

    expect(() =>
      assertImplementationGate({
        state: "AWAITING_USER_APPROVAL",
        workflowMode: "planned",
        planSHA256: current,
        approvedPlanSHA256: current,
      }),
    ).not.toThrow();
  });

  it("사용자가 이전 계획을 승인했다면 새 계획 구현을 막는다", () => {
    const current = hashPlan(completePlan("현재"));
    const approved = hashPlan(completePlan("승인했던 이전 계획"));

    expect(() =>
      assertImplementationGate({
        state: "AWAITING_USER_APPROVAL",
        workflowMode: "planned",
        planSHA256: current,
        approvedPlanSHA256: approved,
      }),
    ).toThrow("현재 계획 버전");
  });

});

describe("기록 전 비밀 값 제거", () => {
  it("사용자가 근거 로그를 올리면 인증값을 가리고 나머지 문장은 유지한다", () => {
    const raw = [
      "Authorization: Bearer abc.def.ghi",
      "api_key=secret-value",
      "password: hunter2",
      "OpenAI key sk-proj-1234567890abcdef",
      "GitHub ghp_12345678901234567890",
      "요청은 500으로 실패했습니다.",
    ].join("\n");

    const redacted = redactSecrets(raw);

    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("secret-value");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("sk-proj-");
    expect(redacted).not.toContain("ghp_");
    expect(redacted).toContain("요청은 500으로 실패했습니다.");
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBe(5);
  });
});


// 감사 부차 지적: OPENAI_API_KEY=... 같은 환경 변수 표기와 { "token": "..." } JSON 표기가 가려지지 않았다.
describe("시크릿 마스킹 확장", () => {
  it("환경 변수 표기의 키·토큰을 가린다", () => {
    const redacted = redactSecrets("OPENAI_API_KEY=abc123def 그리고 SENTRY_AUTH_TOKEN=xyz789");

    expect(redacted).not.toContain("abc123def");
    expect(redacted).not.toContain("xyz789");
    expect(redacted).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(redacted).toContain("SENTRY_AUTH_TOKEN=[REDACTED]");
  });

  it("JSON 문자열 값의 토큰을 가린다", () => {
    const redacted = redactSecrets('{ "token": "secret-abc", "access_token": "secret-def" }');

    expect(redacted).not.toContain("secret-abc");
    expect(redacted).not.toContain("secret-def");
  });

  it("일반 대문자 환경 변수는 건드리지 않는다", () => {
    expect(redactSecrets("CONSENSUS_ROOM_PORT=4317")).toBe("CONSENSUS_ROOM_PORT=4317");
  });
  it("masks URL and inline header credentials while preserving their enclosing syntax", () => {
    expect(redactSecrets("https://example.test/?token=url-credential&next=kept"))
      .toBe("https://example.test/?token=[REDACTED]&next=kept");
    expect(redactSecrets("curl -H 'Authorization: Basic dXNlcjpwYXNz' https://example.test"))
      .toBe("curl -H 'Authorization: [REDACTED]' https://example.test");
    expect(redactSecrets("Request Cookie: session=inline-credential; theme=dark"))
      .toBe("Request Cookie: session=[REDACTED]; theme=[REDACTED]");
    expect(redactSecrets("Authorization: Basic c2VjcmV0==")).toBe("Authorization: [REDACTED]");
    expect(redactSecrets('Authorization: Digest username="private-user", response="private-proof"'))
      .toBe('Authorization: Digest username="[REDACTED]", response="[REDACTED]"');
    expect(redactSecrets('https://example.test/?token=read&api_key=keychain.read()'))
      .not.toContain('token=read');
    expect(redactSecrets('{"headers":{"Authorization":"Basic dXNlcjpwYXNz"}}'))
      .toBe('{"headers":{"Authorization":"[REDACTED]"}}');
  });

  it("preserves JSON escapes and masks quoted cookie values in raw headers and JSON strings", () => {
    for (const header of ["Cookie", "Set-Cookie"]) {
      const raw = `${header}: sid="private-session"; theme=dark`;
      const redacted = redactSecrets(raw);
      expect(redacted).not.toContain("private-session");
      expect(redacted).toContain('sid="[REDACTED]"');
      expect(redactSecrets(redacted)).toBe(redacted);
      expect(JSON.parse(redactSecrets(JSON.stringify({ invariant: raw })))).toEqual({ invariant: redacted });
    }
    const invariant = 'Authorization: "Bearer <accessToken>" on every request';
    const policy = JSON.stringify({ scopePaths: ["**"], rules: [{ paths: ["Sources/**"], invariants: [invariant] }] });
    expect(redactSecrets(policy)).toBe(policy);
    expect(JSON.parse(redactSecrets(policy))).toEqual(JSON.parse(policy));
    for (const secret of ['sensitive', 'value\\"with-quote', 'trailing\\\\']) {
      const header = `Cookie: sid=${JSON.stringify(secret)}`;
      const nested = JSON.stringify({ note: header });
      expect(JSON.parse(redactSecrets(nested)).note).toBe('Cookie: sid="[REDACTED]"');
    }
  });

  it("preserves code, header placeholders and structured plan JSON while masking literal credentials", () => {
    const samples = [
      "func refresh(token: String) async throws -> Session",
      "func refresh(authorization: String) async throws -> Session",
      "func refresh(authorization: String? = nil) async throws -> Session",
      "- `AuthService.login(password: String, token: String?)` signature stays unchanged.",
      "| Header | Authorization: Bearer <accessToken> on every request | required |",
      "On expiry, re-read with secret = keychain.read().",
      '{"scopePaths":["**"],"rules":[{"paths":["Sources/**"],"invariants":["token:abc"]}]}',
      "api_key: read only from the environment (never hard-coded).",
    ];
    for (const sample of samples) expect(redactSecrets(sample)).toBe(sample);
    expect(redactSecrets('token=AbcSecret123 password=abc.def')).toBe('token=[REDACTED] password=[REDACTED]');
    expect(JSON.parse(redactSecrets('{"token":"secret-abc","next":"kept"}'))).toEqual({ token: "[REDACTED]", next: "kept" });
    expect(redactSecrets('let token = "literal-value"; next()')).toBe('let token = "[REDACTED]"; next()');
  });

  it("redacts literal dollar prefixes and every authorization pair without damaging outer JSON", () => {
    for (const raw of ["password='$SYNTHETIC_VALUE'", 'Cookie: sid="$SYNTHETIC_VALUE"', "Cookie: sid=$SYNTHETIC_VALUE"]) {
      const masked = redactSecrets(raw);
      expect(masked).not.toContain("SYNTHETIC_VALUE");
      expect(redactSecrets(masked)).toBe(masked);
    }
    expect(redactSecrets("password=$PASSWORD")).toBe("password=$PASSWORD");
    const aws = "Authorization: AWS4-HMAC-SHA256 Credential=synthetic-key/20261005/region/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=synthetic-proof";
    expect(redactSecrets(aws)).toBe("Authorization: AWS4-HMAC-SHA256 Credential=[REDACTED], SignedHeaders=[REDACTED], Signature=[REDACTED]");
    for (const raw of ["Cookie: sid='VALUE", 'Cookie: sid="VALUE', "password='VALUE", "password='VALUE\"TAIL", 'Cookie: sid="VALUE\\']) {
      const masked = redactSecrets(JSON.stringify({ invariant: raw, keep: "next" }));
      expect(JSON.parse(masked).keep).toBe("next");
      expect(masked).not.toContain("VALUE");
      expect(masked).not.toContain("TAIL");
    }
    expect(redactSecrets("curl -H 'Cookie: sid=synthetic-value' https://example.invalid"))
      .toBe("curl -H 'Cookie: sid=[REDACTED]' https://example.invalid");
    expect(redactSecrets(String.raw`curl -H "Cookie: sid=synthetic\$tail" https://example.invalid`))
      .toBe('curl -H "Cookie: sid=[REDACTED]" https://example.invalid');
    for (const punctuation of ["&", ")", "|"]) {
      expect(redactSecrets(`Cookie: sid=synthetic${punctuation}tail; csrf=second-value`))
        .toBe("Cookie: sid=[REDACTED]; csrf=[REDACTED]");
      expect(redactSecrets(`Authorization: Digest username=synthetic${punctuation}tail, response=synthetic-proof`))
        .toBe("Authorization: Digest username=[REDACTED], response=[REDACTED]");
    }
    const fields = "password=private-value\n".repeat(8000);
    expect(redactSecrets(fields)).toBe("password=[REDACTED]\n".repeat(8000));
  });

  it("uses shell, declaration and JSON contexts when redacting credentials", () => {
    for (const raw of ["curl --data-raw 'password=$SYNTHETIC_VALUE' https://example.invalid",
      "curl --data-raw 'x=1 password=$SYNTHETIC_VALUE'", "curl --data-raw 'x=1&password=$SYNTHETIC_VALUE'"]) {
      const masked = redactSecrets(raw);
      expect(masked).not.toContain("SYNTHETIC_VALUE");
      expect(redactSecrets(masked)).toBe(masked);
      expect(JSON.parse(redactSecrets(JSON.stringify({ command: raw })))).toEqual({ command: masked });
    }
    expect(redactSecrets("password=$PASSWORD")).toBe("password=$PASSWORD");
    for (const type of ["AuthorizationHeader", "API.AuthorizationHeader?", "Result<Header, Error>", "[String: Header]"]) {
      const signature = `func refresh(authorization: ${type} = makeHeader()) async throws -> Session`;
      expect(redactSecrets(signature)).toBe(signature);
      expect(JSON.parse(redactSecrets(JSON.stringify({ signature, keep: "next" })))).toEqual({ signature, keep: "next" });
    }
    expect(redactSecrets('func login(password: Password = "SYNTHETIC_VALUE")'))
      .toBe('func login(password: Password = "[REDACTED]")');
    expect(redactSecrets('function login(options = { password: "SYNTHETIC_VALUE" }, authorization: Header) {}'))
      .toBe('function login(options = { password: "[REDACTED]" }, authorization: Header) {}');
    expect(redactSecrets("Authorization: AuthorizationHeader")).toBe("Authorization: [REDACTED]");
    const raw = JSON.stringify({ invariants: ['Fixture command: "OPENAI_API_KEY=SYNTHETIC_VALUE"'], keep: "next" });
    const masked = redactSecrets(raw);
    expect(JSON.parse(masked)).toEqual({ invariants: ['Fixture command: "OPENAI_API_KEY=[REDACTED]"'], keep: "next" });
    expect(redactSecrets(masked)).toBe(masked);
  });

  it("retains multiline shell quoting and the complete environment value boundary", () => {
    const cases = [
      ["curl --data-raw 'x=1\npassword=$SYNTHETIC_VALUE'", "curl --data-raw 'x=1\npassword=[REDACTED]'"],
      [String.raw`DB_PASSWORD=\SYNTHETIC_VALUE`, "DB_PASSWORD=[REDACTED]"],
      ["DB_PASSWORD=one&SYNTHETIC_VALUE", "DB_PASSWORD=[REDACTED]"],
      ["DB_PASSWORD=one|SYNTHETIC_VALUE", "DB_PASSWORD=[REDACTED]"],
      ["curl 'DB_PASSWORD=one&SYNTHETIC_VALUE' next", "curl 'DB_PASSWORD=[REDACTED]' next"],
      ["TLS_PRIVATE_KEY='HEADER\nSYNTHETIC_VALUE\nFOOTER'", "TLS_PRIVATE_KEY='[REDACTED]'"],
      ["request failed (password: SYNTHETIC_VALUE)", "request failed (password: [REDACTED])"],
    ];
    for (const [raw, expected] of cases) {
      expect(redactSecrets(raw)).toBe(expected);
      const json = redactSecrets(JSON.stringify({ command: raw, keep: "next" }));
      expect(JSON.parse(json)).toEqual({ command: expected, keep: "next" });
      expect(redactSecrets(json)).toBe(json);
    }
  });

  it("preserves constructor annotations and handles repeated truncated declarations", () => {
    for (const signature of ["struct Session { init(password: Password) {} }", "init?(authorization: API.Header?) {}", "init<T>(authorization: API.Header<T>) {}",
      "subscript(token: AccessToken) -> Value { get }", "init(check: Bool = 1 < 2, password: Password)",
      "func login(check: Bool = 1 < 2, authorization: Header) {}"]) {
      expect(redactSecrets(signature)).toBe(signature);
      expect(JSON.parse(redactSecrets(JSON.stringify({ signature })))).toEqual({ signature });
    }
    const truncated = "func login(\n  password: Password\n".repeat(1000);
    expect(redactSecrets(truncated)).toBe("func login(\n  password: [REDACTED]\n".repeat(1000));
  });

  it("separates declaration parameters from generic defaults and constructor member calls", () => {
    const cases = [
      'function make(config = factory<string, number>({password: "SYNTHETIC_VALUE"})) {}',
      'function make(config = factory<Map<string, number>, Header>({password: "SYNTHETIC_VALUE"}), authorization: Header) {}',
      'func make(config: Config = factory<String, Int>(password: "SYNTHETIC_VALUE"), authorization: Header) {}',
      'let c = Credentials.init(password: "SYNTHETIC_VALUE")',
      'let c = Credentials . init(password: "SYNTHETIC_VALUE")',
      'let c = Credentials. /*comment*/ init(password: "SYNTHETIC_VALUE")',
      'let c = Credentials.init(password: SYNTHETIC_VALUE)',
      'const c = Credentials.constructor(password: "SYNTHETIC_VALUE")',
    ];
    for (const raw of cases) {
      const expected = raw.replace("SYNTHETIC_VALUE", "[REDACTED]");
      expect(redactSecrets(raw)).toBe(expected);
      expect(redactSecrets(expected)).toBe(expected);
      const json = redactSecrets(JSON.stringify({ signature: raw, keep: "next" }));
      expect(JSON.parse(json)).toEqual({ signature: expected, keep: "next" });
      expect(redactSecrets(json)).toBe(json);
    }
    for (const raw of ['let c = Credentials. /*comment*/ init(password: 4815162342)',
      'let c = Credentials. // comment\n init(password: 4815162342)']) {
      expect(redactSecrets(raw)).toBe(raw.replace("4815162342", "[REDACTED]"));
      expect(JSON.parse(redactSecrets(JSON.stringify({ signature: raw })))).toEqual({ signature: redactSecrets(raw) });
    }
    for (const signature of ['class C { constructor(private readonly password: string = "SYNTHETIC_VALUE") {} }',
      'func f(@Sensitive password: Password = "SYNTHETIC_VALUE") {}']) {
      const expected = signature.replace("SYNTHETIC_VALUE", "[REDACTED]");
      expect(redactSecrets(signature)).toBe(expected);
      expect(JSON.parse(redactSecrets(JSON.stringify({ signature })))).toEqual({ signature: expected });
      expect(redactSecrets(expected)).toBe(expected);
    }
    for (const signature of ['func f(password: @escaping () -> String) {}', 'func f(token: @Sendable () -> String) {}',
      'function f(token: { value: string }) {}', 'func login(/* input */ password: Password) {}',
      'func login(// input\n password: Password) {}',
      'func login(/* (, = < */ password: /* type */ Password) {}',
      'func f(@Wrapper(check: predicate()) password: Password) {}',
      'function parse(token: "identifier" | "number") {}',
      'class C { constructor(@Inject(token()) private readonly password: Password) {} }',
      'class C { constructor(private /* input */ readonly password: Password) {} }']) {
      expect(redactSecrets(signature)).toBe(signature);
      expect(JSON.parse(redactSecrets(JSON.stringify({ signature })))).toEqual({ signature });
    }
    const truncatedComments = '/* input\n'.repeat(8000);
    expect(redactSecrets(truncatedComments)).toBe(truncatedComments);
    const commentCandidates = '// init(\n'.repeat(8000);
    expect(redactSecrets(commentCandidates)).toBe(commentCandidates);
    const commentedMember = `Credentials. ${commentCandidates}init(password: 4815162342)`;
    expect(redactSecrets(commentedMember)).toBe(commentedMember.replace("4815162342", "[REDACTED]"));
    expect(redactSecrets('func login(/* input */ password: Password = /* default */ "SYNTHETIC_VALUE") {}'))
      .toBe('func login(/* input */ password: Password = /* default */ "[REDACTED]") {}');
    expect(redactSecrets('function login(@Flag({ password: "SYNTHETIC_VALUE" }) password: Password) {}'))
      .toBe('function login(@Flag({ password: "[REDACTED]" }) password: Password) {}');
    for (const argument of ["'https://example.invalid'", "'/*'", '`https://example.invalid`', "'it\\'s /* text'", "'it\\'s ) = /* text'"]) {
      const raw = `class C { constructor(@Inject(${argument}) private readonly password: string = "SYNTHETIC_VALUE") {} }`;
      const expected = raw.replace("SYNTHETIC_VALUE", "[REDACTED]");
      expect(redactSecrets(raw)).toBe(expected);
      expect(JSON.parse(redactSecrets(JSON.stringify({ signature: raw })))).toEqual({ signature: expected });
      expect(redactSecrets(expected)).toBe(expected);
    }
    for (const raw of [
      'func login(password: String = /* outer /* inner */ note */ "SYNTHETIC_VALUE") {}',
      'init(password: String = /* outer /* inner */ note */ "SYNTHETIC_VALUE") {}',
      'function login(password: string = /* opener /* is text */ "SYNTHETIC_VALUE") {}',
      'function parse(token: "identifier" | "number" = "SYNTHETIC_VALUE") {}',
      '```swift\nfunc login(password: String = /* outer /* inner */ note */ "SYNTHETIC_VALUE") {}\n```',
      'let c = Credentials. /* outer /* inner */ note */ init(password: "SYNTHETIC_VALUE")',
      '`let c = Credentials. /* outer /* inner */ note */ init(password: "SYNTHETIC_VALUE")`',
      '`func login(password: Password = /* default */ "SYNTHETIC_VALUE") {}`',
      '/* marker /* */\nfunction login(password: string = "SYNTHETIC_VALUE") {}',
      'Example (use `func login(password: String = /* default */ "SYNTHETIC_VALUE") {}`)',
      'function login(password: string = `SYNTHETIC_VALUE`) {}',
      String.raw`let label = "\(url ?? "https://example.invalid")"; Credentials.init(password: "SYNTHETIC_VALUE")`,
      String.raw`let label = "\(url ?? "https://example.invalid")"; Credentials. /* gap */ init(password: "SYNTHETIC_VALUE")`,

      '```typescript\nfunction first() {}\n```\n```swift\nCredentials. /* outer /* inner */ note */ init(password: "SYNTHETIC_VALUE")\n```',
    ]) {
      const expected = raw.replace("SYNTHETIC_VALUE", "[REDACTED]");
      expect(redactSecrets(raw)).toBe(expected);
      expect(JSON.parse(redactSecrets(JSON.stringify({ signature: raw })))).toEqual({ signature: expected });
      expect(redactSecrets(expected)).toBe(expected);
    }
    for (const literal of ['`${`SYNTHETIC_VALUE`}`', '`${({ value: `SYNTHETIC_VALUE` }).value}`',
      '`${/* comment with } */ `SYNTHETIC_VALUE`}`', String.raw`"\(value ?? "SYNTHETIC_VALUE")"`]) {
      const swift = literal.startsWith('"');
      const raw = `${swift ? 'func' : 'function'} login(password: ${swift ? 'String' : 'string'} = ${literal}) {}`;
      const expected = raw.replace(literal, `${literal[0]}[REDACTED]${literal[0]}`);
      expect(redactSecrets(raw)).toBe(expected);
      expect(JSON.parse(redactSecrets(JSON.stringify({ signature: raw })))).toEqual({ signature: expected });
      expect(redactSecrets(expected)).toBe(expected);
    }
    for (const literal of [
      '${/\\}/.test(input) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${/[}`]/.test(input) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${/[/}]/.test(input) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(() => { return /}/.test(input) ? `SYNTHETIC_VALUE` : `fallback`; })()}',
      '${(8 / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(n++ / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(obj.return / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(obj?. /* member */ in / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(obj.if(input) / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(() => { if (input) /\\}\\)\\}/.test(input); return `SYNTHETIC_VALUE`; })()}',
      '${(() => { while (input) /[}`]/.test(input); return `SYNTHETIC_VALUE`; })()}',
      '${(() => { for (; input;) /[}`]/.test(input); return `SYNTHETIC_VALUE`; })()}',
      '${(() => { if (input) {} /\\}\\)\\}/.test(input); return `SYNTHETIC_VALUE`; })()}',
      '${(() => { if (input) {} else /[}`]/.test(input); return `SYNTHETIC_VALUE`; })()}',
      '${(() => { do /[}`]/.test(input); while (input); return `SYNTHETIC_VALUE`; })()}',
      '${(() => { function f() {} /\\}\\)\\}/.test(input); return `SYNTHETIC_VALUE`; })()}',
      '${(() => { function f(x = (() => {})()) {} /\\}\\)\\}/.test(input); return `SYNTHETIC_VALUE`; })()}',
      '${(() => { async function* f() {} /\\}\\)\\}/.test(input); return `SYNTHETIC_VALUE`; })()}',
      '${(() => { class C extends Base {} /\\}\\)\\}/.test(input); return `SYNTHETIC_VALUE`; })()}',
      '${(function() {} / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(async function() {} / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(class {} / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(() => { try {} catch {} /\\}\\)\\}/.test(input); return `SYNTHETIC_VALUE`; })()}',
      '${(() => { try {} catch (e) {} /\\}\\)\\}/.test(input); return `SYNTHETIC_VALUE`; })()}',
      '${(() => { label: {} /\\}\\)\\}/.test(input); return `SYNTHETIC_VALUE`; })()}',
      '${(() => { switch (input) { case a ? b : c: {} /\\}\\)\\}/.test(input); } return `SYNTHETIC_VALUE`; })()}',
      '${({ label: {} / 2 }) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(π / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(한글 / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(𐊧 / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(\\u03c0 / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(value! / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(value != /[}`]/) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${({ f() { function g() {} /\\}\\)\\}/.test(input); return `SYNTHETIC_VALUE`; } }).f()}',
      '${({ f() { label: {} /\\}\\)\\}/.test(input); return `SYNTHETIC_VALUE`; } }).f()}',
      '${(() => { class C { static { function f() {} /\\}\\}\\}\\)\\}/.test(input); } } return `SYNTHETIC_VALUE`; })()}',
      '${({ f(): string { function g() {} /\\}\\}\\)\\}/.test(input); return `SYNTHETIC_VALUE`; } }).f()}',
      '${(value as NonNullable<number | null> / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(<number>value / 2) ? `SYNTHETIC_VALUE` : `fallback`}',
      '${(<div title="quoted">{`SYNTHETIC_VALUE`}</div>)}',
    ]) {
      const raw = 'function login(password: string = `' + literal + '`) {}\nconst keep = 42;';
      const expected = 'function login(password: string = `[REDACTED]`) {}\nconst keep = 42;';
      expect(redactSecrets(raw)).toBe(expected);
      expect(JSON.parse(redactSecrets(JSON.stringify({ signature: raw })))).toEqual({ signature: expected });
      expect(redactSecrets(expected)).toBe(expected);
    }
    for (const [raw, expected] of [
      ['class C extends B { f() { const password = `${super.foo ?? `SYNTHETIC_VALUE`}`; } }',
        'class C extends B { f() { const password = `[REDACTED]`; } }'],
      ['function* f() { const password = `${yield `SYNTHETIC_VALUE`}`; }',
        'function* f() { const password = `[REDACTED]`; }'],
      ['class C { #value; f() { const password = `${this.#value}`; } }',
        'class C { #value; f() { const password = `[REDACTED]`; } }'],
      ['const password = `${import.meta.url}`;\nconst keep = 42;',
        'const password = `[REDACTED]`;\nconst keep = 42;'],
      ['const password = `${(() => { const await = 2; return await; })()}`;\nconst keep = 42;',
        'const password = `[REDACTED]`;\nconst keep = 42;'],
      ['const password = `${await}`;\nconst keep = 42;',
        'const password = `[REDACTED]`;\nconst keep = 42;'],
      ['const password = `${await foo()}`;\nconst keep = 42;',
        'const password = `[REDACTED]`;\nconst keep = 42;'],
      ['const password = `${f(await)} ${((await) => await)(2)} ${({await})}`;\nconst keep = 42;',
        'const password = `[REDACTED]`;\nconst keep = 42;'],
      ['const password = `${010} SYNTHETIC_VALUE`;\nconst keep = 42;',
        'const password = `[REDACTED]`;\nconst keep = 42;'],
      ['const password = `${(() => { with (obj) { return value; } })()} SYNTHETIC_VALUE`;\nconst keep = 42;',
        'const password = `[REDACTED]`;\nconst keep = 42;'],
      ["'DB_PASSWORD=`${foo}`' 'DB_PASSWORD=`${bar}`'", "'DB_PASSWORD=`[REDACTED]`' 'DB_PASSWORD=`[REDACTED]`'"],
    ]) {
      expect(redactSecrets(raw)).toBe(expected);
      expect(JSON.parse(redactSecrets(JSON.stringify({ source: raw })))).toEqual({ source: expected });
      expect(redactSecrets(expected)).toBe(expected);
    }
    for (const suffix of ['\n💡 Follow-up\nKeep this requirement.', '\n"unfinished', '\n/* unfinished',
      ' + "unfinished', ' + /* unfinished', '\nconst keep = 42;']) {
      const raw = 'password=`${SYNTHETIC_VALUE}`' + suffix;
      const expected = 'password=`[REDACTED]`' + suffix;
      expect(redactSecrets(raw)).toBe(expected);
      expect(JSON.parse(redactSecrets(JSON.stringify({ source: raw })))).toEqual({ source: expected });
      expect(redactSecrets(expected)).toBe(expected);
    }
    for (const padding of [255, 256, 257, 511, 513]) {
      const raw = 'password=`${foo /*' + ' '.repeat(padding) + '*/ ?? `SYNTHETIC_VALUE`}`\n💡 Follow-up';
      const expected = 'password=`[REDACTED]`\n💡 Follow-up';
      expect(redactSecrets(raw)).toBe(expected);
      expect(JSON.parse(redactSecrets(JSON.stringify({ source: raw })))).toEqual({ source: expected });
    }
    for (const raw of ['password=`${(SYNTHETIC_VALUE}`', 'password=`${x}\\`SYNTHETIC_VALUE',
      'password=`${import.foo} SYNTHETIC_VALUE`', 'password=`${await f(, )} SYNTHETIC_VALUE`']) {
      expect(redactSecrets(raw)).toBe('password=`[REDACTED]');
    }
    for (const member of ['in', 'return', 'await', '`in`', ' /* member */ in']) {
      const raw = 'func login(password: String = "\\(obj.' + member + ' / 2) SYNTHETIC_VALUE") {}\nlet keep = 42;';
      const expected = 'func login(password: String = "[REDACTED]") {}\nlet keep = 42;';
      expect(redactSecrets(raw)).toBe(expected);
      expect(JSON.parse(redactSecrets(JSON.stringify({ source: raw })))).toEqual({ source: expected });
      expect(redactSecrets(expected)).toBe(expected);
    }
    const unfinishedTemplates = 'DB_PASSWORD=`${'.repeat(1000) + 'SYNTHETIC_VALUE';
    expect(redactSecrets(unfinishedTemplates)).toBe('DB_PASSWORD=`[REDACTED]');
    const boundedInterpolations = "'" + 'DB_PASSWORD="\\(\n'.repeat(4000) + "'";
    expect(redactSecrets(boundedInterpolations)).toBe("'DB_PASSWORD=\"[REDACTED]'");
    const unfinishedInterpolations = 'func f(x: String = "\\(\n'.repeat(4000);
    expect(redactSecrets(unfinishedInterpolations)).toBe(unfinishedInterpolations);
    const incompleteInterpolation = String.raw`func login(password: String = "\(value ?? "SYNTHETIC_VALUE")`;
    expect(redactSecrets(incompleteInterpolation)).not.toContain("SYNTHETIC_VALUE");
    const truncatedDefault = 'function login(password: string = "SYNTHETIC_VALUE';
    expect(redactSecrets(truncatedDefault)).not.toContain("SYNTHETIC_VALUE");
    expect(JSON.parse(redactSecrets(JSON.stringify({ signature: truncatedDefault })))).toEqual({ signature: redactSecrets(truncatedDefault) });
  });
});

// 감사 부차 지적: git은 세그먼트 단위로도 ref를 거부한다. 끝만 검사하면 승인 단계까지 통과한 뒤 터진다.
describe("브랜치 이름 세그먼트 검증", () => {
  it("숨김 세그먼트와 중간 .lock 세그먼트를 거부한다", () => {
    expect(BranchNameSchema.safeParse("feature/.hidden").success).toBe(false);
    expect(BranchNameSchema.safeParse("feature.lock/next").success).toBe(false);
    expect(BranchNameSchema.safeParse("refactoring/PROJECT-123").success).toBe(true);
  });

  it("baseRef가 '-'로 시작하면 git 옵션 주입으로 보고 거부한다", () => {
    expect(CreateTopicInputSchema.safeParse({ title: "옵션 주입", baseRef: "--force" }).success).toBe(false);
    expect(CreateTopicInputSchema.safeParse({ title: "정상 참조", baseRef: "develop" }).success).toBe(true);
  });
});

// 2026-09-14 S11: 허용 오차 교정 재제출("코드 변경 없음 — 원장 공란")이 $6.35 짜리 본 턴 보고와 남은 단계를 적은 결정 요청을
// 통째로 덮어써 엔진이 구현 완료로 보고 리뷰로 넘겼다. 교정은 본 턴 결과 위에 병합한다.
describe("mergeCorrectionResult — 교정 재제출을 본 턴 결과 위에 병합", () => {
  const original: AgentResult = {
    kind: "IMPLEMENTATION", summary: "P3 완료. 남은 단계 P3.5·P3.6.",
    findings: [
      { id: "TODO-1", title: "이연", severity: "LOW", disposition: "DEFERRED_OUT_OF_SCOPE", rationale: "범위 밖", evidenceRefs: [], requiresUserDecision: false },
      { id: "F-1", title: "고침", severity: "MEDIUM", disposition: "RESOLVED_BY_FIX", rationale: "본 턴", evidenceRefs: [], requiresUserDecision: false },
    ],
    evidenceRefs: ["cover-A-post.log errors=0", "gate4 OK"], requestedUserDecision: "남은 단계 P3.5·P3.6 — 계속 진행 요청",
  };
  it("교정이 비운 쟁점·증거·요청 결정을 보존하고 요약은 뒤에 붙인다", () => {
    const corrected: AgentResult = {
      kind: "IMPLEMENTATION", summary: "원장 6행 재기재(코드 변경 없음)", findings: [], evidenceRefs: ["git diff -- Tests/A.swift"],
    };
    const { result, preserved } = mergeCorrectionResult(original, corrected);
    expect(preserved).toEqual(["findings 2건", "evidence 2건", "요청 결정", "summary"]);
    expect(result.findings.map((finding) => finding.id)).toEqual(["TODO-1", "F-1"]);
    expect(result.evidenceRefs).toEqual(["git diff -- Tests/A.swift", "cover-A-post.log errors=0", "gate4 OK"]);
    expect(result.requestedUserDecision).toBe(original.requestedUserDecision);
    expect(result.summary).toBe(`원장 6행 재기재(코드 변경 없음)${CORRECTION_SUMMARY_SEPARATOR}P3 완료. 남은 단계 P3.5·P3.6.`);
  });
  it("교정이 같은 id 를 다시 적으면 교정이 우선하고, 본 턴 요약을 담고 있으면 덧붙이지 않는다", () => {
    const corrected: AgentResult = {
      kind: "IMPLEMENTATION", summary: "P3 완료. 남은 단계 P3.5·P3.6. (원장 보완)",
      findings: [{ id: "F-1", title: "고침", severity: "MEDIUM", disposition: "AGREED_ACTION", rationale: "되돌림", evidenceRefs: [], requiresUserDecision: false }],
      evidenceRefs: ["cover-A-post.log errors=0", "gate4 OK"], requestedUserDecision: "다른 결정",
    };
    const { result, preserved } = mergeCorrectionResult(original, corrected);
    expect(preserved).toEqual(["findings 1건"]);
    expect(result.findings.map((finding) => [finding.id, finding.disposition])).toEqual([["F-1", "AGREED_ACTION"], ["TODO-1", "DEFERRED_OUT_OF_SCOPE"]]);
    expect(result.requestedUserDecision).toBe("다른 결정");
    expect(result.summary).toBe(corrected.summary);
  });
  it("keeps unique earlier summaries without growing on an identical continuation", () => {
    const correction = { ...original, summary: "Same report" };
    const first = mergeCorrectionResult(original, correction).result;
    expect(mergeCorrectionResult(first, correction).result.summary).toBe(first.summary);
  });
  it("본 턴에 요청 결정이 없었고 교정도 없으면 요청 결정 필드를 만들지 않는다", () => {
    const { result } = mergeCorrectionResult({ ...original, requestedUserDecision: undefined }, { kind: "IMPLEMENTATION", summary: "x", findings: [], evidenceRefs: [] });
    expect("requestedUserDecision" in result).toBe(false);
  });
});

// 2026-09-14 Codex 감사 R07·R01② — 요청 결정의 명시적 해소, 계약을 어긴 원본의 필드 구제.
describe("mergeCorrectionResult — resolvesRequestedDecision / salvageResultFields", () => {
  const base = { kind: "IMPLEMENTATION" as const, summary: "s", findings: [], evidenceRefs: [] };
  it("교정이 resolvesRequestedDecision:true 를 적으면 본 턴의 요청 결정을 복원하지 않는다", () => {
    const original: AgentResult = { ...base, requestedUserDecision: "범위 밖 변경을 유지할까?" };
    const corrected: AgentResult = { ...base, summary: "전부 되돌렸다", resolvesRequestedDecision: true };
    const merged = mergeCorrectionResult(original, corrected);
    expect(merged.result.requestedUserDecision).toBeUndefined();
    expect(merged.result.resolvesRequestedDecision).toBe(true); // 중첩 병합까지 해소 표식 유지(F08)
    expect(merged.preserved).not.toContain("요청 결정");
    const outer = mergeCorrectionResult({ ...base, requestedUserDecision: "원래 질문(실패 원본)" }, merged.result);
    expect(outer.result.requestedUserDecision).toBeUndefined();
  });
  it("salvageResultFields 는 개별로 유효한 필드만 건진다(깨진 쟁점은 버리고 유효한 결정·증거·상태는 남긴다)", () => {
    const raw = { kind: "FIX", summary: "실제 작업", requestedUserDecision: "ORIGINAL-DECISION", evidenceRefs: ["PROOF", 3],
      findings: [{ id: "ok", title: "t", severity: "LOW", disposition: "AGREED_NO_ACTION", rationale: "r", evidenceRefs: [], requiresUserDecision: false }, { id: "broken" }],
      status: "in_progress", remainingSteps: ["P4", 7] };
    const salvaged = salvageResultFields(raw, "IMPLEMENTATION");
    expect(salvaged).toMatchObject({ kind: "IMPLEMENTATION", summary: "실제 작업", requestedUserDecision: "ORIGINAL-DECISION", evidenceRefs: ["PROOF"], status: "in_progress", remainingSteps: ["P4"] });
    expect(salvaged.findings.map((finding) => finding.id)).toEqual(["ok"]);
    const merged = mergeCorrectionResult(salvaged, { ...base, summary: "kind 만 고침" });
    expect(merged.result.requestedUserDecision).toBe("ORIGINAL-DECISION");
    expect(merged.result.evidenceRefs).toContain("PROOF");
  });
  it("salvageResultFields 는 해소 표식(게이트·단수·복수 id)도 개별 유효성으로 건진다(2026-09-21 사전 검증 #1)", () => {
    const raw = { kind: "IMPLEMENTATION", summary: "A·B 해소", findings: [{ id: "broken" }], evidenceRefs: [], status: "completed",
      resolvesRequestedDecision: true, resolvedRequestId: " Q-a ", resolvedRequestIds: ["Q-b", "", 7, " Q-a", null] };
    const salvaged = salvageResultFields(raw, "IMPLEMENTATION");
    expect(salvaged.resolvesRequestedDecision).toBe(true);
    expect(salvaged.resolvedRequestId).toBe("Q-a");
    expect(salvaged.resolvedRequestIds).toEqual(["Q-b", "Q-a"]);
    // 표식이 true 가 아니거나 id 가 문자열이 아니면 건지지 않는다.
    const none = salvageResultFields({ kind: "IMPLEMENTATION", summary: "x", resolvesRequestedDecision: "yes", resolvedRequestId: 3, resolvedRequestIds: "Q-a" }, "IMPLEMENTATION");
    expect(none.resolvesRequestedDecision).toBeUndefined();
    expect(none.resolvedRequestId).toBeUndefined();
    expect(none.resolvedRequestIds).toBeUndefined();
  });
  it("resolutionIds 는 단수·복수를 합쳐 공백을 지우고 순서를 지키며 중복을 없앤다", () => {
    expect(resolutionIds({})).toEqual([]);
    expect(resolutionIds({ resolvedRequestId: " Q-1 " })).toEqual(["Q-1"]);
    expect(resolutionIds({ resolvedRequestId: "Q-1", resolvedRequestIds: ["Q-2", " Q-1", "", "Q-3", "Q-2"] })).toEqual(["Q-1", "Q-2", "Q-3"]);
  });
  it("mergeCorrectionResult 는 교정이 해소 표식을 되풀이하지 않아도 원본의 표식·id 를 보존한다(합집합·중복 제거) — 본 턴 질문 복원(R07)은 교정 자신의 표식만 본다", () => {
    const original: AgentResult = { ...base, requestedUserDecision: "B?", resolvesRequestedDecision: true, resolvedRequestIds: ["Q-a", "Q-c"] };
    // 교정이 표식을 되풀이하지 않음 → 원본 표식·id 보존; 교정의 id 는 표식이 없으니 세지 않는다(R01); 본 턴 질문은 복원된다(R07 은 교정 자신의 표식만).
    const merged = mergeCorrectionResult(original, { ...base, summary: "kind 만 고침", resolvedRequestId: "Q-c", resolvedRequestIds: ["Q-d"] });
    expect(merged.result.resolvesRequestedDecision).toBe(true);
    expect(merged.result.resolvedRequestIds).toEqual(["Q-a", "Q-c"]);
    expect(merged.result.resolvedRequestId).toBeUndefined();
    expect(merged.result.requestedUserDecision).toBe("B?");   // 원본의 표식은 앞 요청을 닫은 것 — 본 턴 질문은 복원된다
    expect(merged.preserved).toContain("해소 표식");
    // 교정이 스스로 표식을 적으면(R07) 질문은 복원하지 않고, id 는 합집합(교정 먼저)·중복 제거.
    const r07 = mergeCorrectionResult(original, { ...base, summary: "전부 되돌림", resolvesRequestedDecision: true, resolvedRequestId: "Q-c", resolvedRequestIds: ["Q-d"] });
    expect(r07.result.requestedUserDecision).toBeUndefined();
    expect(r07.result.resolvedRequestIds).toEqual(["Q-c", "Q-d", "Q-a"]);
    expect(r07.preserved).not.toContain("해소 표식");
    // 둘 다 표식이 없으면 아무것도 만들어 내지 않는다.
    const plain = mergeCorrectionResult({ ...base, requestedUserDecision: "B?" }, { ...base, summary: "x" });
    expect(plain.result.resolvesRequestedDecision).toBeUndefined();
    expect(plain.result.resolvedRequestIds).toBeUndefined();
    // 표식 없는 응답의 id 는 다른 응답의 표식과 결합하지 않는다(host-review R01): 원본 {false, A} + 교정 {true, B} → B 만, 반대 방향은 A 만.
    const r01 = mergeCorrectionResult({ ...base, resolvedRequestId: "Q-a" }, { ...base, summary: "x", resolvesRequestedDecision: true, resolvedRequestIds: ["Q-b"] });
    expect(r01.result.resolvedRequestIds).toEqual(["Q-b"]);
    const r01b = mergeCorrectionResult({ ...base, resolvesRequestedDecision: true, resolvedRequestIds: ["Q-a"] }, { ...base, summary: "x", resolvedRequestIds: ["Q-b"] });
    expect(r01b.result.resolvedRequestIds).toEqual(["Q-a"]);
    expect(r01b.result.resolvesRequestedDecision).toBe(true);
  });
  it("병합 합집합은 한 번 응답 한도(100)를 넘을 수 있다 — 저장 계약은 상한이 없고 한도는 파서가 응답마다 본다(host-review R02, F10 과 같은 분리)", () => {
    const many = Array.from({ length: 100 }, (_, index) => `Q-${String(index).padStart(8, "0")}`);
    const merged = mergeCorrectionResult(
      { ...base, resolvesRequestedDecision: true, resolvedRequestIds: many },
      { ...base, summary: "kind 만 고침", resolvesRequestedDecision: true, resolvedRequestId: "Q-extra" },
    );
    expect(merged.result.resolvedRequestIds).toHaveLength(101);
    expect(AgentResultSchema.safeParse(merged.result).success).toBe(true);
  });
});
