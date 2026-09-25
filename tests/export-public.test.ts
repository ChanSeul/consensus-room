import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// 2026-09-14 Codex 3차 R3-09 — 공개 export 는 source ref 를 딱 한 번 해석한다. 첫 해석과 blob 읽기 사이에 HEAD 가 움직여도
// 허용 목록·blob·출처 표시가 같은 OID 를 쓴다(움직인 뒤 커밋의 '공개에서 뺀 파일' 내용이 옛 허용 목록으로 나가지 않는다).
const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }).trim();
}

// 공개본에는 export 스크립트가 없다(개인 운영 도구) — 스크립트가 있는 체크아웃에서만 검사한다.
const exportScript = join(process.cwd(), "scripts", "export-public.py");
describe("scripts/export-public.py — source ref 단일 해석", () => {
  it.skipIf(!existsSync(exportScript))("첫 rev-parse 직후 HEAD 가 B 로 움직여도 A 의 허용 목록과 A 의 blob 만 내보낸다", () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-export-"));
    temporaryDirectories.push(root);
    const repository = join(root, "repo");
    mkdirSync(join(repository, "scripts"), { recursive: true });
    git(root, ["init", "--initial-branch=main", repository]);
    git(repository, ["config", "user.name", "Consensus Room Test"]);
    git(repository, ["config", "user.email", "consensus-room@example.invalid"]);
    writeFileSync(join(repository, "scripts", "export-public.py"), readFileSync(exportScript));
    writeFileSync(join(repository, "visible.txt"), "public fixture");
    writeFileSync(join(repository, "formerly-public.txt"), "old public fixture");
    writeFileSync(join(repository, "scripts", "public-export.json"), JSON.stringify({ files: ["visible.txt", "formerly-public.txt"], approved_assets: {} }));
    git(repository, ["add", "."]); git(repository, ["commit", "-m", "A public allowlist"]);
    const a = git(repository, ["rev-parse", "HEAD"]);
    writeFileSync(join(repository, "formerly-public.txt"), "B_INTERNAL_FIXTURE_WITHDRAWN_FROM_PUBLIC");
    writeFileSync(join(repository, "scripts", "public-export.json"), JSON.stringify({ files: ["visible.txt"], approved_assets: {} }));
    git(repository, ["add", "."]); git(repository, ["commit", "-m", "B withdraw file"]);
    const b = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["reset", "--hard", a]);
    // git 래퍼: 첫 `rev-parse --verify` 뒤에 HEAD 를 B 로 옮긴다(감사 재현과 같은 방식).
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const binDirectory = join(root, "bin"); mkdirSync(binDirectory);
    const marker = join(root, "moved");
    writeFileSync(join(binDirectory, "git"), `#!/usr/bin/env python3
import subprocess, sys, pathlib
real = ${JSON.stringify(realGit)}
args = sys.argv[1:]
p = subprocess.run([real, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
sys.stdout.buffer.write(p.stdout); sys.stderr.buffer.write(p.stderr)
if args[:2] == ["rev-parse", "--verify"]:
    marker = pathlib.Path(${JSON.stringify(marker)})
    if not marker.exists():
        marker.write_text("moved")
        subprocess.run([real, "reset", "--hard", ${JSON.stringify(b)}], check=True, stdout=subprocess.DEVNULL, cwd=${JSON.stringify(repository)})
sys.exit(p.returncode)
`);
    chmodSync(join(binDirectory, "git"), 0o755);
    const output = join(root, "output");
    const env = { ...process.env, PATH: `${binDirectory}:${process.env.PATH ?? ""}` };
    const stdout = execFileSync("python3", [join(repository, "scripts", "export-public.py"), output, "--source-sha", "HEAD"], { encoding: "utf8", env, cwd: repository });
    expect(existsSync(marker)).toBe(true);                       // HEAD 는 실제로 B 로 움직였다
    expect(stdout).toContain(`from ${a} `);                     // 출처 표시도 첫 해석 OID
    expect(readFileSync(join(output, "visible.txt"), "utf8")).toBe("public fixture");
    // A 의 허용 목록에 있는 파일은 A 의 내용으로 나간다 — B 의 내부 픽스처가 섞이지 않는다.
    expect(readFileSync(join(output, "formerly-public.txt"), "utf8")).toBe("old public fixture");
  });
});

// host-review a7a9ce86 F-008 — 공개 목록이 목록 안 코드의 상대 import 와 런타임에 읽는 저장소 파일(new URL(…, import.meta.url))을 전부 담는다.
// 빠지면 공개본의 타입 검사·서버 실행이 깨진다(E1 의 mediation.ts·roleAssignments.ts·roles.ts·정책 문서가 빠졌던 사례).
const manifest = join(process.cwd(), "scripts", "public-export.json");
describe("scripts/public-export.json — 공개 목록의 의존 완결성", () => {
  it.skipIf(!existsSync(manifest))("목록 안 TS 파일의 상대 import 와 import.meta.url 자산이 모두 목록에 있다", () => {
    const listed = new Set((JSON.parse(readFileSync(manifest, "utf8")) as { files: string[] }).files);
    const missing: string[] = [];
    for (const file of listed) {
      if (!/\.(ts|tsx|mts)$/.test(file)) continue;
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const imports = [...source.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)].map(match => match[1]);
      const assets = [...source.matchAll(/new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)].map(match => match[1]);
      for (const specifier of imports) {
        const base = normalize(join(dirname(file), specifier)).replace(/\.js$/, "");
        const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
        if (!candidates.some(candidate => listed.has(candidate))) missing.push(`${file} → ${specifier}`);
      }
      for (const specifier of assets) {
        const target = normalize(join(dirname(file), specifier));
        if (!listed.has(target)) missing.push(`${file} → ${specifier}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
