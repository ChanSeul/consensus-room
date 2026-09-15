// 구조 검사 — 계획을 **최신 plan 산출물**에서 곧장 읽는 곳은 계획 단계 허용 목록뿐이다(2026-09-15 사전 감사 2차).
//
// 왜: 구현·리뷰·수정·계획 개정 기준·허용 오차 개정이 최신 산출물을 읽으면, 저장만 되고 승인되지 않은 개정본(개정 턴이 저장과 기록 사이에서 끊김)이
// 감사·ACK·사용자 승인 없이 구현 프롬프트·읽기 경로·승인 계획이 됐다. 그 경로들은 core.requireCurrentPlanArtifact(현재 계획 sha 의 산출물 한 건에서
// 본문과 경로를 함께)로만 읽는다. 새 경로가 최신 산출물을 곧장 읽으면 여기서 막힌다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const RAW_PLAN_READ = /readLatest\([^)]*"plan"\)|verifiedPath\([^)]*"plan"\)|requireStoredPlan\(/g;

// 허용 목록 — 계획 단계(초안·감사·ACK·계획 재개)는 방금 저장한 최신 계획이 곧 대상이다. core.ts 는 requireStoredPlan 정의(내부 readLatest) 한 곳.
const ALLOWED: Record<string, number> = {
  "src/server/engine/core.ts": 2,      // requireStoredPlan 정의 + 그 안의 readLatest
  "src/server/engine/planning.ts": 3,  // 이전 계획 문맥 · 계획 재개(storedPlanForResume) · ACK
  "src/server/app.ts": 1,              // 화면 표시용 현재 계획 — 현재 sha 결속본이 없을 때(계획 전)만 최신 저장본
};

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

describe("계획 읽기 경로 구조 검사(2026-09-15 감사 2차)", () => {
  it("최신 plan 산출물을 곧장 읽는 곳은 계획 단계 허용 목록뿐이다 — 구현·리뷰·수정·계획 개정 기준·허용 오차 개정은 requireCurrentPlanArtifact 로 읽는다", () => {
    const found: Record<string, number> = {};
    for (const path of sources(join(ROOT, "src"))) {
      const count = [...readFileSync(path, "utf8").matchAll(RAW_PLAN_READ)].length;
      if (count > 0) found[relative(ROOT, path)] = count;
    }
    expect(found, "새 경로가 최신 plan 산출물을 곧장 읽습니다 — 승인 계획 sha 에 결속된 core.requireCurrentPlanArtifact 를 쓰세요").toEqual(ALLOWED);
  });

  it("전달·진단·허용 오차 개정 경로는 결속된 계획 읽기를 쓴다", () => {
    for (const file of ["src/server/engine/delivery.ts", "src/server/engine/diagnoses.ts", "src/server/workflow.ts"]) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).toContain("requireCurrentPlanArtifact(");
    }
  });
});
