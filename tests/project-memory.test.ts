import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryConflictError, ProjectMemoryStore } from "../src/server/memoryStore";
import { ProjectMemoryReader } from "../src/server/projectMemory";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeMemoryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-memory-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "claude-only"));
  mkdirSync(join(root, "codex-only"));
  writeFileSync(join(root, "MEMORY.md"), document("project-memory-index", "shared", "# Project Memory Index"));
  return root;
}

function document(
  name: string,
  platform: "shared" | "claude" | "codex",
  body: string,
  type: "user" | "feedback" | "project" | "reference" = "reference",
): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} 설명`,
    "metadata:",
    `  platform: ${platform}`,
    `  type: ${type}`,
    "---",
    "",
    `# ${name}`,
    "",
    body,
    "",
  ].join("\n");
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("Duse iOS 프로젝트 메모리 읽기", () => {
  it("라우터와 현재 주제에 맞는 공용·자기 역할 문서만 프롬프트에 붙인다", async () => {
    const root = makeMemoryRoot();
    writeFileSync(join(root, "context-router.md"), document("context-router", "shared", [
      "- 숏폼: [미디어 계약](shortform-media-contract.md)",
      "- Codex 리뷰: [리뷰 실행](codex-only/review.md)",
      "- Claude 리뷰: [리뷰 실행](claude-only/review.md)",
    ].join("\n")));
    writeFileSync(join(root, "shortform-media-contract.md"), document("shortform-media-contract", "shared", "숏폼 카드 재생 계약"));
    writeFileSync(join(root, "codex-only", "review.md"), document("review", "codex", "Codex 전용 리뷰 절차"));
    writeFileSync(join(root, "claude-only", "review.md"), document("review", "claude", "Claude 전용 리뷰 절차"));

    const prompt = await new ProjectMemoryReader(root).buildPrompt("숏폼 코드 리뷰 계획을 검토해 주세요.", "codex");

    expect(prompt).toContain("메모리 문서 시작: context-router.md");
    expect(prompt).toContain("메모리 문서 시작: shortform-media-contract.md");
    expect(prompt).toContain("메모리 문서 시작: codex-only/review.md");
    expect(prompt).not.toContain("메모리 문서 시작: claude-only/review.md");
    expect(prompt).toMatch(/SHA-256: [a-f0-9]{64}/);
  });

  it("메모리 루트가 없으면 에이전트에 파일 접근 권한을 열지 않고 사용 규칙만 전달한다", async () => {
    const root = join(makeMemoryRoot(), "missing");
    const prompt = await new ProjectMemoryReader(root).buildPrompt("계획", "claude");

    expect(prompt).toContain("이번 턴에 제공된 스냅샷: 없음");
    expect(prompt).toContain("모델 프로세스에는 메모리 폴더 접근 권한이 없습니다");
  });

  // Codex는 이번 작업에서 메모리를 2회 갱신했지만 Claude는 0회였다(2026-08-30 실측). 규칙이 역할 대칭인데도
  // "memoryUpdates가 없어도 정상"이라는 문장이 사실상 옵트아웃이었다. 판단 자체를 필수 단계로 만든다.
  it("두 역할 모두에게 턴 종료 전 메모리 판단을 필수 단계로 요구한다", async () => {
    const root = join(makeMemoryRoot(), "missing");

    for (const role of ["claude", "codex"] as const) {
      const prompt = await new ProjectMemoryReader(root).buildPrompt("계획", role);

      expect(prompt).toContain("턴을 마치기 전에");
      expect(prompt).toContain("반드시 한 번 판단하세요");
      // 날조 방지 가드는 남아 있어야 한다 — 채우기 위한 기록은 메모리를 오염시킨다.
      expect(prompt).toContain("채우려고 없는 교훈을 만들지 마세요");
      expect(prompt).not.toContain("memoryUpdates가 없어도 정상입니다");
    }
  });

  it("라우터에 없는 문서는 MEMORY.md를 본문이 아닌 카탈로그로만 써서 찾는다", async () => {
    const root = makeMemoryRoot();
    writeFileSync(join(root, "context-router.md"), document("context-router", "shared", "일반 라우터"));
    writeFileSync(join(root, "MEMORY.md"), document(
      "project-memory-index",
      "shared",
      "- [Swift Concurrency 취소 감사](cancellationerror-audit-canon.md) - 취소 원장과 검증 절차",
    ));
    writeFileSync(join(root, "cancellationerror-audit-canon.md"), document(
      "cancellationerror-audit-canon",
      "shared",
      "감사 원장 정본",
    ));

    const prompt = await new ProjectMemoryReader(root).buildPrompt("Swift Concurrency 취소 감사", "claude");

    expect(prompt).toContain("메모리 문서 시작: cancellationerror-audit-canon.md");
    expect(prompt).not.toContain("메모리 문서 시작: MEMORY.md");
  });

  // MEMORY.md는 한 줄에 여러 문서를 ` · `로 묶는다. 줄 전체를 모든 링크의 문맥으로 쓰면 한 문서에 맞은 키워드가
  // 같은 줄의 다른 문서까지 끌어와 라우팅 상한을 채운다(2026-09-14, sample-ios 인덱스를 140줄 아래로 묶기 전 확인).
  it("MEMORY.md에서 ` · `로 묶은 문서는 자기 조각의 문맥으로만 고른다", async () => {
    const root = makeMemoryRoot();
    const grouped = ["sim-keyboard", "shell-split", "secret-leak"];
    writeFileSync(join(root, "context-router.md"), document("context-router", "shared", "일반 라우터"));
    writeFileSync(join(root, "MEMORY.md"), document(
      "project-memory-index",
      "shared",
      "- 도구 함정: [시뮬레이터 · 키보드 오염](sim-keyboard.md) · [셸 단어 분리](shell-split.md) · [시크릿 유출](secret-leak.md)",
    ));
    for (const name of grouped) {
      writeFileSync(join(root, `${name}.md`), document(name, "shared", `${name} 본문`));
    }
    const reader = new ProjectMemoryReader(root);

    const shell = await reader.buildPrompt("셸 단어 분리 규칙", "claude");
    expect(shell).toContain("메모리 문서 시작: shell-split.md");
    expect(shell).not.toContain("메모리 문서 시작: sim-keyboard.md");
    expect(shell).not.toContain("메모리 문서 시작: secret-leak.md");

    // 링크 이름 안의 ` · `는 구분자가 아니다.
    const keyboard = await reader.buildPrompt("키보드 오염 재현", "claude");
    expect(keyboard).toContain("메모리 문서 시작: sim-keyboard.md");
    expect(keyboard).not.toContain("메모리 문서 시작: shell-split.md");

    // 첫 링크 앞의 주제 라벨은 묶인 문서가 모두 공유한다.
    const label = await reader.buildPrompt("도구 함정 정리", "claude");
    for (const name of grouped) {
      expect(label).toContain(`메모리 문서 시작: ${name}.md`);
    }
  });

  it("` · `로 묶지 않은 여러 링크 줄은 줄 전체를 모든 링크의 문맥으로 쓴다", async () => {
    const root = makeMemoryRoot();
    writeFileSync(join(root, "context-router.md"), document(
      "context-router",
      "shared",
      "- 결제: [환불 규칙](refund-rule.md), [영수증 규칙](receipt-rule.md) — 정산 전에 둘 다 읽는다",
    ));
    writeFileSync(join(root, "refund-rule.md"), document("refund-rule", "shared", "환불"));
    writeFileSync(join(root, "receipt-rule.md"), document("receipt-rule", "shared", "영수증"));

    const prompt = await new ProjectMemoryReader(root).buildPrompt("정산 점검", "claude");

    expect(prompt).toContain("메모리 문서 시작: refund-rule.md");
    expect(prompt).toContain("메모리 문서 시작: receipt-rule.md");
  });

  it("라우터 링크가 심볼릭 링크 파일이면 내용을 전달하지 않는다", async () => {
    const root = makeMemoryRoot();
    const outside = mkdtempSync(join(tmpdir(), "consensus-room-memory-outside-"));
    temporaryDirectories.push(outside);
    writeFileSync(join(outside, "secret.md"), document("secret", "shared", "외부 내용"));
    writeFileSync(join(root, "context-router.md"), document("context-router", "shared", "- 리뷰: [외부](secret.md)"));
    symlinkSync(join(outside, "secret.md"), join(root, "secret.md"));

    const prompt = await new ProjectMemoryReader(root).buildPrompt("외부 리뷰", "codex");

    expect(prompt).not.toContain("메모리 문서 시작: secret.md");
    expect(prompt).not.toContain("외부 내용");
  });

  it("메모리에 민감값 모양의 문자열이 있어도 원문을 모델에 보내지 않는다", async () => {
    const root = makeMemoryRoot();
    writeFileSync(join(root, "context-router.md"), document(
      "context-router",
      "shared",
      "- 인증: [계약](auth-rule.md)",
    ));
    writeFileSync(join(root, "auth-rule.md"), document(
      "auth-rule",
      "shared",
      "검증용 token=do-not-send-this-value",
    ));

    const prompt = await new ProjectMemoryReader(root).buildPrompt("인증 계약", "codex");

    expect(prompt).not.toContain("do-not-send-this-value");
    expect(prompt).toContain("token=[REDACTED]");
    expect(prompt).toContain("민감값 가림: 예");
  });
});

// 계획 제어의 허용 색인(E3-5)이 읽는 목록 — 선택(select)이 고르지 않은 문서도 찾을 수 있어야 하므로 관련도·문서 수 한도 없이 링크 대상 전부를 돌려준다.
// 역할·경로·용량·가림 규칙은 선택과 같다. 버전은 가린 본문의 해시라 계획 제어 조각의 hash 와 같은 값이다.
describe("Duse iOS 프로젝트 메모리 허용 색인", () => {
  function indexedRoot() {
    const root = makeMemoryRoot();
    const outside = mkdtempSync(join(tmpdir(), "consensus-room-memory-outside-"));
    temporaryDirectories.push(outside);
    const routerLine = "- 공용: [인증 계약](auth-rule.md), [라우터 자신](context-router.md)";
    const groupedLine = "- 도구: [인증](auth-rule.md) · [무관 문서](unrelated.md) · [목록 자신](MEMORY.md)";
    writeFileSync(join(root, "context-router.md"), document("context-router", "shared", [
      "- 숏폼: [미디어 계약](shortform-media-contract.md)", routerLine,
    ].join("\n")));
    writeFileSync(join(root, "MEMORY.md"), document("project-memory-index", "shared", [
      groupedLine,
      "- 역할: [Claude 절차](claude-only/steps.md) · [Codex 절차](codex-only/steps.md)",
      "- 제외: [없는 문서](missing.md) · [외부](linked.md) · [큰 문서](huge.md)",
    ].join("\n")));
    const authRaw = document("auth-rule", "shared", "검증용 token=do-not-send-this-value");
    writeFileSync(join(root, "shortform-media-contract.md"), document("shortform-media-contract", "shared", "숏폼 카드 재생 계약"));
    writeFileSync(join(root, "auth-rule.md"), authRaw);
    writeFileSync(join(root, "unrelated.md"), document("unrelated", "shared", "관련 없는 기록"));
    writeFileSync(join(root, "claude-only", "steps.md"), document("steps", "claude", "Claude 전용 절차"));
    writeFileSync(join(root, "codex-only", "steps.md"), document("steps", "codex", "Codex 전용 절차"));
    writeFileSync(join(outside, "linked.md"), document("linked", "shared", "외부 내용"));
    symlinkSync(join(outside, "linked.md"), join(root, "linked.md"));
    writeFileSync(join(root, "huge.md"), "x".repeat(80_001));
    return { root, authRaw, routerLine, groupedLine };
  }

  it("이 역할이 읽을 수 있는 링크 대상 전부를 가린 본문의 버전·바이트·링크 문맥과 함께 돌려준다", async () => {
    const { root, authRaw, routerLine } = indexedRoot();
    const reader = new ProjectMemoryReader(root);

    const codex = await reader.index("codex");
    // 라우터 링크가 먼저, MEMORY.md 링크가 다음이다. 라우터·MEMORY.md 자신, 다른 역할 폴더, 없는 문서, 심볼릭 링크, 80KB 초과는 오르지 않는다.
    expect(codex.map((entry) => entry.path)).toEqual(["shortform-media-contract.md", "auth-rule.md", "unrelated.md", "codex-only/steps.md"]);
    expect((await reader.index("claude")).map((entry) => entry.path))
      .toEqual(["shortform-media-contract.md", "auth-rule.md", "unrelated.md", "claude-only/steps.md"]);

    const auth = codex.find((entry) => entry.path === "auth-rule.md")!;
    expect(auth.content).toContain("token=[REDACTED]");
    expect(auth.content).not.toContain("do-not-send-this-value");
    expect(auth.redacted).toBe(true);
    // 버전·바이트는 가린 본문 기준이다(원문 해시는 memoryUpdates 용 스냅숏 sha256 에만 쓴다).
    expect(auth.version).toBe(sha256(auth.content));
    expect(auth.version).not.toBe(sha256(authRaw));
    expect(auth.bytes).toBe(Buffer.byteLength(auth.content, "utf8"));
    // 두 곳에서 링크한 문서는 두 문맥을 모두 가진다. ` · `로 묶은 줄은 자기 조각만 문맥이다.
    expect(auth.contexts).toEqual([routerLine, "- 도구: [인증](auth-rule.md)"]);
    expect(codex.find((entry) => entry.path === "unrelated.md")!.contexts).toEqual(["- 도구: [무관 문서](unrelated.md)"]);
    const unrelated = codex.find((entry) => entry.path === "unrelated.md")!;
    expect(unrelated).toMatchObject({ redacted: false, version: sha256(unrelated.content) });
  });

  it("선택이 고르지 않은 문서도 목록에 올리고, 선택 결과는 바꾸지 않는다", async () => {
    const { root } = indexedRoot();
    const reader = new ProjectMemoryReader(root);
    const before = await reader.selectWithDiagnostics("숏폼 재생", "codex");

    const index = await reader.index("codex");

    expect(before.snapshots.map((snapshot) => snapshot.path)).toEqual(["context-router.md", "shortform-media-contract.md"]);
    expect(index.map((entry) => entry.path)).toContain("unrelated.md");
    expect(await reader.selectWithDiagnostics("숏폼 재생", "codex")).toEqual(before);
  });

  it("라우터가 없으면 MEMORY.md 링크가 있어도 빈 목록이다", async () => {
    const root = makeMemoryRoot();
    writeFileSync(join(root, "MEMORY.md"), document("project-memory-index", "shared", "- [규칙](rule.md)"));
    writeFileSync(join(root, "rule.md"), document("rule", "shared", "규칙"));

    expect(await new ProjectMemoryReader(root).index("claude")).toEqual([]);
    expect(await new ProjectMemoryReader(join(root, "missing")).index("claude")).toEqual([]);
  });
});

describe("Duse iOS 프로젝트 메모리 쓰기", () => {
  it("공용 문서와 자기 역할 문서를 현재 해시가 맞을 때만 바꾼다", async () => {
    const root = makeMemoryRoot();
    const sharedBefore = document("shared-rule", "shared", "이전 공용 규칙");
    const roleBefore = document("claude-rule", "claude", "이전 Claude 규칙");
    const sharedAfter = document("shared-rule", "shared", "새 공용 규칙");
    const roleAfter = document("claude-rule", "claude", "새 Claude 규칙");
    writeFileSync(join(root, "shared-rule.md"), sharedBefore);
    writeFileSync(join(root, "claude-only", "claude-rule.md"), roleBefore);

    const changes = await new ProjectMemoryStore(root).apply("claude", [
      { path: "shared-rule.md", expectedSHA256: sha256(sharedBefore), content: sharedAfter, reason: "공용 계약 갱신" },
      { path: "claude-only/claude-rule.md", expectedSHA256: sha256(roleBefore), content: roleAfter, reason: "Claude 절차 갱신" },
    ]);

    expect(readFileSync(join(root, "shared-rule.md"), "utf8")).toBe(sharedAfter);
    expect(readFileSync(join(root, "claude-only", "claude-rule.md"), "utf8")).toBe(roleAfter);
    expect(changes.map((change) => change.status)).toEqual(["written", "written"]);
  });

  it("Codex가 Claude 전용 문서를 바꾸려 하면 어떤 파일도 쓰지 않는다", async () => {
    const root = makeMemoryRoot();
    const sharedBefore = document("shared-rule", "shared", "이전 공용 규칙");
    const sharedAfter = document("shared-rule", "shared", "새 공용 규칙");
    const claudeBefore = document("claude-rule", "claude", "이전 Claude 규칙");
    writeFileSync(join(root, "shared-rule.md"), sharedBefore);
    writeFileSync(join(root, "claude-only", "claude-rule.md"), claudeBefore);

    await expect(new ProjectMemoryStore(root).apply("codex", [
      { path: "shared-rule.md", expectedSHA256: sha256(sharedBefore), content: sharedAfter, reason: "공용 변경" },
      { path: "claude-only/claude-rule.md", expectedSHA256: sha256(claudeBefore), content: claudeBefore, reason: "권한 밖 변경" },
    ])).rejects.toThrow("codex는 claude-only 경로");

    expect(readFileSync(join(root, "shared-rule.md"), "utf8")).toBe(sharedBefore);
  });

  it("스냅샷 뒤 파일이 바뀌면 덮어쓰지 않고, 이미 원하는 내용이면 재시도를 멱등 처리한다", async () => {
    const root = makeMemoryRoot();
    const first = document("shared-rule", "shared", "첫 내용");
    const changed = document("shared-rule", "shared", "다른 세션이 바꾼 내용");
    const desired = document("shared-rule", "shared", "원하는 내용");
    const path = join(root, "shared-rule.md");
    writeFileSync(path, changed);
    const store = new ProjectMemoryStore(root);

    await expect(store.apply("claude", [
      { path: "shared-rule.md", expectedSHA256: sha256(first), content: desired, reason: "오래된 제안" },
    ])).rejects.toBeInstanceOf(MemoryConflictError);
    expect(readFileSync(path, "utf8")).toBe(changed);

    writeFileSync(path, desired);
    const retry = await store.apply("claude", [
      { path: "shared-rule.md", expectedSHA256: sha256(first), content: desired, reason: "완료 직후 재시도" },
    ]);
    expect(retry[0].status).toBe("unchanged");
  });

  it("새 문서는 경로와 frontmatter platform·name이 맞아야 한다", async () => {
    const root = makeMemoryRoot();
    const store = new ProjectMemoryStore(root);

    await store.apply("codex", [{
      path: "codex-only/new-rule.md",
      expectedSHA256: null,
      content: document("new-rule", "codex", "새 규칙", "feedback"),
      reason: "검증된 반복 교훈",
    }]);
    expect(readFileSync(join(root, "codex-only", "new-rule.md"), "utf8")).toContain("새 규칙");
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toContain(
      "[new-rule](codex-only/new-rule.md) - new-rule 설명",
    );

    await expect(store.apply("codex", [{
      path: "wrong-name.md",
      expectedSHA256: null,
      content: document("different-name", "shared", "잘못된 문서"),
      reason: "잘못된 이름",
    }])).rejects.toThrow("파일명과 같아야");
  });

  it("자기 역할 폴더 안에서도 심볼릭 링크 디렉터리를 거쳐 밖에 쓰지 못한다", async () => {
    const root = makeMemoryRoot();
    const outside = mkdtempSync(join(tmpdir(), "consensus-room-memory-outside-"));
    temporaryDirectories.push(outside);
    symlinkSync(outside, join(root, "claude-only", "linked"));

    await expect(new ProjectMemoryStore(root).apply("claude", [{
      path: "claude-only/linked/new-rule.md",
      expectedSHA256: null,
      content: document("new-rule", "claude", "밖으로 나가면 안 됨"),
      reason: "경로 탈출 시도",
    }])).rejects.toThrow("심볼릭 링크를 거치는");
    expect(() => readFileSync(join(outside, "new-rule.md"), "utf8")).toThrow();
  });

  it("민감값 모양의 본문은 새 메모리에도 쓰지 않는다", async () => {
    const root = makeMemoryRoot();
    await expect(new ProjectMemoryStore(root).apply("claude", [{
      path: "secret-rule.md",
      expectedSHA256: null,
      content: document("secret-rule", "shared", "token=do-not-store-this-value"),
      reason: "민감값 차단 검사",
    }])).rejects.toThrow("민감값으로 보이는 내용을");
    expect(() => readFileSync(join(root, "secret-rule.md"), "utf8")).toThrow();
  });
});
