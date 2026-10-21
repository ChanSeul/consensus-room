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

// 공개 export 의 사내 티켓 키(CR Engine Advisor 자문 62) — 검토된 표의 키만 키 전체로 바꾸고, 표에 없는 키가 남으면 목적지에 쓰기 전에 멈춘다.
// 이 검사 파일도 공개 대상이라 키 문자열은 실행 중에 접두어와 숫자를 이어 만든다(본문에 키가 그대로 있으면 실제 export 가 이 파일에서 멈춘다).
describe("scripts/export-public.py — 사내 티켓 키", () => {
  const dev = (digits: string) => `${["DEV", "SCRUM"].join("")}-${digits}`;
  const qa = (digits: string) => `${["DS", "QA"].join("")}-${digits}`;
  const internalKey = new RegExp(`(?:${["DEV", "SCRUM"].join("")}|${["DS", "QA"].join("")})-\\d`);
  const run = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-export-keys-"));
    temporaryDirectories.push(root);
    const repository = join(root, "repo");
    mkdirSync(join(repository, "scripts"), { recursive: true });
    git(root, ["init", "--initial-branch=main", repository]);
    git(repository, ["config", "user.name", "Consensus Room Test"]);
    git(repository, ["config", "user.email", "consensus-room@example.invalid"]);
    writeFileSync(join(repository, "scripts", "export-public.py"), readFileSync(exportScript));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(repository, name), body);
    writeFileSync(join(repository, "scripts", "public-export.json"), JSON.stringify({ files: Object.keys(files), approved_assets: {} }));
    git(repository, ["add", "."]); git(repository, ["commit", "-m", "fixture"]);
    const output = join(root, "output");
    try {
      execFileSync("python3", [join(repository, "scripts", "export-public.py"), output], { encoding: "utf8", cwd: repository, stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true as const, output, read: (name: string) => readFileSync(join(output, name), "utf8") };
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      return { ok: false as const, output, status: failure.status, stderr: String(failure.stderr ?? "") };
    }
  };

  it.skipIf(!existsSync(exportScript))("검토된 키는 키 전체로 가짜 키가 되고, 출력에 사내 키가 남지 않는다", () => {
    const result = run({ "a.txt": `// 2026-10-19 ${dev("17493")} follow-up\nsourceId: "jira:${dev("1")}"\nrefactoring/${dev("9071")}-g1\n`
      + `토픽(${dev("17106")} 매물등록 통합)\n` });
    expect(result.ok, result.ok ? "" : result.stderr).toBe(true);
    if (!result.ok) return;
    expect(result.read("a.txt")).toBe('// 2026-10-19 PROJECT-456 follow-up\nsourceId: "jira:PROJECT-1"\nrefactoring/PROJECT-123-g1\n토픽(PROJECT-123 샘플 기능 통합)\n');
    expect(result.read("a.txt")).not.toMatch(internalKey);
  });

  it.skipIf(!existsSync(exportScript))("표에 없는 두 접두어의 키와 검토된 키를 앞부분으로 포함한 더 긴 키는 export 를 멈추고 목적지를 만들지 않는다", () => {
    for (const key of [dev("24680"), qa("5"), dev("12"), dev("90712"), dev("174930")]) {
      // 첫 파일은 깨끗하고 뒤 파일에만 키가 있어도 아무것도 쓰지 않는다 — 검사는 목적지 쓰기 전에 끝난다.
      const result = run({ "clean.txt": "public fixture\n", "leak.txt": `메모 ${key} 참고\n` });
      expect(result.ok, key).toBe(false);
      if (result.ok) continue;
      expect(result.status, key).not.toBe(0);
      expect(result.stderr, key).toContain("leak.txt");
      expect(result.stderr, key).toContain(key);
      expect(existsSync(result.output), key).toBe(false);
    }
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
