import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { explore } from "../src/server/exploreCli";

const directories: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "consensus-explore-"));
  directories.push(root);
  writeFileSync(join(root, "a.ts"), Array.from({ length: 40 }, (_, i) => i === 20 ? "const target = true;" : `// ${i}`).join("\n"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: root });
  return root;
}
function commit(root: string): void {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture update"], { cwd: root });
}
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("읽기 전용 rg 탐색", () => {
  it("위치·앞뒤 문맥·hash와 제한 메타데이터를 반환한다", async () => {
    const root = fixture();
    const result = await explore(root, "target");
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0]).toMatchObject({ file: "a.ts", line: 21 });
    expect(result.locations[0].content.split("\n")).toHaveLength(11);
    expect(result.locations[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result).toMatchObject({ omitted: false, limits: { locations: 20, contextLines: 5, bytes: 16 * 1024 } });
  });

  it("20개 위치와 16KiB 이후에는 생략을 표시한다", async () => {
    const root = fixture();
    writeFileSync(join(root, "many.ts"), Array.from({ length: 30 }, (_, i) => `target ${i}`).join("\n"));
    commit(root);
    const result = await explore(root, "target");
    expect(result.locations.length).toBeLessThanOrEqual(20);
    expect(result.omitted).toBe(true);
  });

  it("저장소 밖 경로와 심볼릭 링크 범위를 거부한다", async () => {
    const root = fixture();
    await expect(explore(root, "target", "../outside")).rejects.toThrow("저장소 밖");
    symlinkSync(join(root, "a.ts"), join(root, "link.ts"));
    await expect(explore(root, "target", "link.ts")).rejects.toThrow("심볼릭 링크");
  });

  it("저장소 root 자체 symlink와 단일 파일 범위를 안전하게 처리한다", async () => {
    const root = fixture();
    const link = join(tmpdir(), `consensus-explore-link-${Date.now()}`);
    symlinkSync(root, link);
    await expect(explore(link, "target")).rejects.toThrow("심볼릭 링크");
    expect((await explore(root, "target", "a.ts")).locations[0]).toMatchObject({ file: "a.ts", line: 21 });
    rmSync(link, { force: true });
  });

  it("전체 JSON 직렬화도 16KiB를 넘기지 않는다", async () => {
    const root = fixture();
    writeFileSync(join(root, "large.ts"), Array.from({ length: 200 }, () => `target ${"x".repeat(600)}`).join("\n"));
    commit(root);
    const result = await explore(root, "target");
    expect(Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`, "utf8")).toBeLessThanOrEqual(16 * 1024);
  });

  it("작업 트리 변경 뒤에도 검증한 HEAD snapshot만 반환한다", async () => {
    const root = fixture();
    writeFileSync(join(root, "a.ts"), "const target = changed;\n");
    expect((await explore(root, "target")).locations[0].content).not.toContain("changed");
  });

  it("출력 한도를 넘기는 검색어는 실행 전에 거부한다", async () => {
    await expect(explore(fixture(), "x".repeat(20_000))).rejects.toThrow("결과 한도");
  });
});
