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
