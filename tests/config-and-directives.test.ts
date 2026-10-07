import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/server/config";
import { isMissingSessionError } from "../src/server/engine/delivery";
import { agentRunError, parseAgentResult } from "../src/server/adapters/resultParser";
import { replanDirective } from "../src/shared/workflow";
import { appliedExecutionSettings } from "../src/shared/execution";

const temporaryDirectories: string[] = [];
const savedEnv = process.env.CONSENSUS_ROOM_DATA_DIR;

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.CONSENSUS_ROOM_DATA_DIR;
  else process.env.CONSENSUS_ROOM_DATA_DIR = savedEnv;
});

describe("설정 초기화에서 구현 모델 보존", () => {
  it.each([
    [undefined, undefined, "claude-fable-5-1", "xhigh"],
    ["claude-opus-5-5", "high", "claude-opus-5-5", "high"],
  ])("계획 환경변수 %s/%s와 별개로 구현은 Sonnet 5.5를 쓴다", (model, effort, expectedModel, expectedEffort) => {
    vi.stubEnv("CONSENSUS_ROOM_CLAUDE_MODEL", model);
    vi.stubEnv("CONSENSUS_ROOM_CLAUDE_EFFORT", effort);
    const settings = loadConfig({ dataDirectory: tmpdir() }).defaultAgentSettings.claude;
    expect(appliedExecutionSettings(settings, false)).toEqual({ model: expectedModel, effort: expectedEffort });
    expect(appliedExecutionSettings(settings, true)).toEqual({ model: "claude-sonnet-5-5", effort: "xhigh" });
  });

  it("명시적으로 주어진 설정에는 기본 구현 모델을 추가하지 않는다", () => {
    const explicit = {
      claude: { model: "claude-opus-5-5", effort: "high" as const },
      codex: { model: "gpt-6-astra", effort: "xhigh" as const },
    };
    const settings = loadConfig({ dataDirectory: tmpdir(), defaultAgentSettings: explicit }).defaultAgentSettings;
    expect(settings).toEqual(explicit);
    expect(appliedExecutionSettings(settings.claude, true)).toEqual(explicit.claude);
  });
});

describe("데이터 디렉터리 환경변수 방어(2026-09-08 빈 DB 사고)", () => {
  it("환경변수가 없는 디렉터리를 가리키면 새로 만들지 않고 기동을 거부한다", () => {
    process.env.CONSENSUS_ROOM_DATA_DIR = "/Users/example/Library/Application";
    expect(() => loadConfig()).toThrow("빈 데이터 디렉터리를 새로 만들지 않습니다");
  });

  it("환경변수가 있는 디렉터리를 가리키면 그대로 쓴다", () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-config-"));
    temporaryDirectories.push(root);
    process.env.CONSENSUS_ROOM_DATA_DIR = root;
    expect(loadConfig().dataDirectory).toBe(root);
  });

  it("코드 override 는 테스트용 임시 경로라 검사하지 않는다", () => {
    process.env.CONSENSUS_ROOM_DATA_DIR = "/definitely/missing/dir";
    const root = mkdtempSync(join(tmpdir(), "consensus-room-config-"));
    temporaryDirectories.push(root);
    expect(loadConfig({ dataDirectory: join(root, "not-yet") }).dataDirectory).toBe(join(root, "not-yet"));
  });
});

describe("상시 참조 문서 설정", () => {
  it.each([undefined, "", "  "])("환경변수가 없거나 비어 있으면(%j) 싣지 않는다", value => {
    vi.stubEnv("CONSENSUS_ROOM_STANDING_REFERENCE", value);
    expect(loadConfig({ dataDirectory: tmpdir() }).standingReferencePath).toBeNull();
  });

  it("정규화된 절대 경로는 지시문 링크와 같은 문자열 그대로 쓴다", () => {
    const path = "/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/shared/design-philosophy.md";
    vi.stubEnv("CONSENSUS_ROOM_STANDING_REFERENCE", path);
    expect(loadConfig({ dataDirectory: tmpdir() }).standingReferencePath).toBe(path);
  });

  it.each(["docs/design-philosophy.md", "/Users/someone/../design-philosophy.md", "/Users/someone/docs/"])("정규화된 절대 경로가 아니면 기동을 거부한다(%s)", value => {
    vi.stubEnv("CONSENSUS_ROOM_STANDING_REFERENCE", value);
    expect(() => loadConfig({ dataDirectory: tmpdir() })).toThrow("정규화된 절대 경로");
  });
});

describe("재계획 지시 판정(2026-09-07 'REPLAN 아님' 사고)", () => {
  it("줄 머리 또는 본문 끝의 REPLAN 만 지시로 본다", () => {
    expect(replanDirective("REPLAN — 전제가 바뀌었다")).toBe(true);
    expect(replanDirective("설명 한 줄\nREPLAN\n이유")).toBe(true);
    expect(replanDirective("핵심 전제가 바뀌었다. REPLAN")).toBe(true);
    expect(replanDirective("핵심 전제가 바뀌었다. REPLAN   \n")).toBe(true);
  });

  it("문장 가운데 언급이나 부정('REPLAN 아님')은 지시가 아니다", () => {
    expect(replanDirective("# [d03] 종결 3회차 — REPLAN 아님, 처분 변경 없음")).toBe(false);
    expect(replanDirective("이 결정은 REPLAN 을 요구하지 않는다.")).toBe(false);
    expect(replanDirective("replan 소문자는 무시")).toBe(false);
    expect(replanDirective("PREPLANNED 도 아니다")).toBe(false);
  });
});

describe("구현 세션 유실 판정", () => {
  // E3-3b: 문구가 아니라 어댑터가 관측으로 분류한 코드(session-missing — 모델 턴 없음 관측이 필요조건)로만 본다.
  it("어댑터가 session-missing 으로 분류한 실패만 유실로 본다 — 같은 문구를 담은 일반 Error 는 유실이 아니다", () => {
    const result = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: "ff30" });
    expect(isMissingSessionError(agentRunError("claude", 1, "No conversation found with session ID: ff30\n", result))).toBe(true);
    // 모델 턴이 있었던 실패(num_turns 3)는 관측 형태가 아니다 — unknown.
    expect(isMissingSessionError(agentRunError("claude", 1, "No conversation found with session ID: ff30\n",
      JSON.stringify({ type: "result", is_error: true, num_turns: 3 })))).toBe(false);
    expect(isMissingSessionError(new Error("Claude 실행 실패(1): No conversation found with session ID: ff30"))).toBe(false);
    expect(isMissingSessionError(new Error("Claude 실행 실패(1): rate limited"))).toBe(false);
    expect(isMissingSessionError("문자열 오류")).toBe(false);
  });
});

describe("결과 파서 — 구조화 출력의 null 선택 필드", () => {
  it("toleranceLedger: null 인 정상 응답을 받아들인다(Codex 지적 1)", () => {
    const candidate = {
      kind: "ACK", summary: "확인", planMarkdown: null, planEdits: null, planSHA256: null,
      findings: [], evidenceRefs: [], requestedUserDecision: null, memoryUpdates: null, toleranceLedger: null,
    };
    expect(parseAgentResult([candidate], "").kind).toBe("ACK");
    expect(parseAgentResult([{ ...candidate, toleranceLedger: [{ ruleId: "T-1", file: "a", note: "" }] }], "").toleranceLedger).toHaveLength(1);
  });
});
