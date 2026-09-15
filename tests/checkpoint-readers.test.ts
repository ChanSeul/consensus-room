// 구조 검사 — 누적 checkpoint 를 읽는 곳은 손상(CheckpointCorrupt)을 삼키지 않는다(2026-09-15 사전 감사 5차 #3).
//
// 왜: 손상 checkpoint 를 이름 없는 catch 나 `.catch(() => …)` 로 없는 것처럼 다루면 그 checkpoint 에 기대는 판단(열린 요청·반박·작업 이관)이 "없음" 으로
// 통과한다. 감사 4차가 재개·진단 경로를 막았지만 등록 결속(captureBinding)·계획 변경 승계(captureCarry)·직전 작업 승계(previousWorkCheckpoint)의 삼킴이 남아,
// 진단 전용 수정의 수정 불필요 종결이 열린 요청 검사를 통과해 요청을 해소하지 않은 채 커밋까지 갔다. 읽는 곳은 손상을 멈춤(interrupt)·409(DiagnosisConflict)·
// 명시적 판단(`instanceof CheckpointCorrupt`)으로만 다룬다. 새 읽기 경로가 생기면 허용 목록이 바뀌어 여기서 멈춘다 — 손상 처리를 확인한 뒤 목록을 고친다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
// 줄바꿈된 호출 체인(`this.core.checkpoints` ⏎ `.recoverFor(`)도 읽기다 — 줄 단위로만 맞추면 놓쳤다(감사 6차 #7·#8).
const CHECKPOINT_READ = /checkpoints\s*\.\s*(?:latest|byRevision|recoverFor)\s*\(/g;

// 읽는 곳(파일별 개수).
const ALLOWED: Record<string, number> = {
  "src/server/engine/delivery.ts": 5,     // 계획 변경 첫 전달 판정 · runWork 복구 · 직전 작업 checkpoint · 저장 수정 결과 재사용 판정 · 진단 0건 계약 종결
  "src/server/engine/diagnoses.ts": 2,    // 등록·적용 결속(captureBinding) · 계획 변경 승계(captureCarry)
  "src/server/engine/fixContracts.ts": 3, // 최종 리뷰 대조 보고(수락 계약·옛 수락) · 옛 토픽 이관(ensureOpen)
};

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

// 읽기마다 (1) 같은 문장에 붙인 `.catch(` 가 CheckpointCorrupt 를 판단하는지, (2) 감싼 가장 가까운 try 의 catch 가 이름을 받아 CheckpointCorrupt 를 판단하는지
// 본다(finally 뿐인 try 는 바깥 try 를 본다). 들여쓰기 2칸 서식을 전제로 조상 블록을 줄 들여쓰기로 찾는다.
function swallowedReads(text: string): Array<{ line: number; reason: string }> {
  const lines = text.split("\n");
  const indent = (line: string) => line.length - line.trimStart().length;
  const closing = (from: number, level: number) => lines.findIndex((line, at) => at > from && line.trim() !== "" && indent(line) === level && line.trimStart().startsWith("}"));
  const found: Array<{ line: number; reason: string }> = [];
  const readLines = new Set([...text.matchAll(CHECKPOINT_READ)].map((match) => text.slice(0, match.index).split("\n").length - 1));
  lines.forEach((line, index) => {
    if (!readLines.has(index)) return;
    let statement = line;
    for (let next = index + 1; !/;\s*$/.test(statement) && next < lines.length; next += 1) statement += `\n${lines[next]}`;
    if (statement.includes(".catch(") && !statement.includes("CheckpointCorrupt")) found.push({ line: index + 1, reason: ".catch 가 손상을 판단하지 않는다" });
    let min = indent(line);
    for (let back = index - 1; back >= 0; back -= 1) {
      const candidate = lines[back];
      if (candidate.trim() === "" || indent(candidate) >= min) continue;
      min = indent(candidate);
      if (/^\s*try \{\s*$/.test(candidate)) {
        const close = closing(index, min);
        const head = close >= 0 ? lines[close].trim() : "";
        if (head.startsWith("} finally")) continue;
        if (/^\} catch \{/.test(head)) {
          found.push({ line: index + 1, reason: "이름 없는 catch 가 손상을 삼킨다" });
        } else if (/^\} catch \(\w+[^)]*\) \{/.test(head)) {
          const end = closing(close, min);
          if (!lines.slice(close + 1, end < 0 ? undefined : end).join("\n").includes("CheckpointCorrupt")) {
            found.push({ line: index + 1, reason: "catch 가 CheckpointCorrupt 를 판단하지 않는다" });
          }
        }
        break;
      }
      if (min <= 2) break;
    }
  });
  return found;
}

describe("checkpoint 읽기 경로 구조 검사(2026-09-15 감사 5차 #3)", () => {
  it("누적 checkpoint 를 읽는 곳은 허용 목록뿐이다 — 새 경로는 손상(CheckpointCorrupt) 처리를 확인한 뒤 목록에 더한다", () => {
    const found: Record<string, number> = {};
    for (const path of sources(join(ROOT, "src"))) {
      const count = [...readFileSync(path, "utf8").matchAll(CHECKPOINT_READ)].length;
      if (count > 0) found[relative(ROOT, path)] = count;
    }
    expect(found, "checkpoint 를 읽는 새 경로가 생겼습니다 — 손상을 삼키지 않는지 확인하고 ALLOWED 를 고치세요").toEqual(ALLOWED);
  });

  it("checkpoint 읽기는 손상을 삼키지 않는다 — 이름 없는 catch·CheckpointCorrupt 를 판단하지 않는 catch·.catch 로 감싸지 않는다", () => {
    const violations = Object.keys(ALLOWED).flatMap((file) =>
      swallowedReads(readFileSync(join(ROOT, file), "utf8")).map((violation) => `${file}:${violation.line} ${violation.reason}`));
    expect(violations).toEqual([]);
  });

  it("검사기는 삼키는 읽기를 실제로 잡는다(이름 없는 catch·판단 없는 catch·.catch) — 손상을 판단하는 catch·.catch 와 try 밖 읽기는 통과한다", () => {
    const bare = ["  async a() {", "    try {", "      return await this.core.checkpoints.latest(id);", "    } catch {", "      return null;", "    }", "  }"].join("\n");
    const blind = ["  async b() {", "    try {", "      return await this.core.checkpoints.latest(id);", "    } catch (error) {", "      return null;", "    }", "  }"].join("\n");
    const chained = ["  async c() {", "    return await this.core.checkpoints.recoverFor(id, work).catch(() => true);", "  }"].join("\n");
    const judged = ["  async d() {", "    try {", "      return await this.core.checkpoints.latest(id);", "    } catch (error) {",
      "      if (!(error instanceof CheckpointCorrupt)) throw error;", "      throw new DiagnosisConflict(error.message);", "    }", "  }"].join("\n");
    const judgedChain = ["  async e() {", "    return await this.core.checkpoints.recoverFor(id, work)",
      "      .catch((error: unknown) => { if (error instanceof CheckpointCorrupt) return true; throw error; });", "  }"].join("\n");
    const outside = ["  async f() {", "    const latest = await this.core.checkpoints.latest(id);", "    return latest;", "  }"].join("\n");
    const wrapped = ["  async g() {", "    const recovered = await this.core.checkpoints", "      .recoverFor(id, work).catch(() => null);", "  }"].join("\n");
    expect([bare, blind, chained, judged, judgedChain, outside, wrapped].map((text) => swallowedReads(text).map((violation) => violation.reason)))
      .toEqual([["이름 없는 catch 가 손상을 삼킨다"], ["catch 가 CheckpointCorrupt 를 판단하지 않는다"], [".catch 가 손상을 판단하지 않는다"], [], [], [],
        [".catch 가 손상을 판단하지 않는다"]]);
  });
});
