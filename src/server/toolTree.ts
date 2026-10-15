// 워크트리 안의 단계 도구 트리(gitignore 된 `DerivedData/<stage>-logs/{scripts,bootstrap,stages,selftest}`)는 러너가 고치지 않는다
// (2026-09-14 사용자 지시 "러너는 앱 코드만"). 프롬프트 문구만으로는 권한이 아니다(Codex 감사 R02) — 어댑터는 이 경로들을
// 쓰기 거부에 넣고, 엔진은 턴 전후의 다이제스트를 대조해 바뀌었으면 턴을 실패시킨다(git 은 ignored 파일을 보지 않으므로 별도 검사).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";

export const TOOL_TREE_SUBDIRECTORIES = ["scripts", "bootstrap", "stages", "selftest"] as const;
// 러너 안내(엔진 결함 example-tool-tree, 2026-10-14): 쓰기 거부는 턴 시작 때 있는 폴더만 넣으므로, 러너가 없던 폴더에 보조 파일을 만들면 다이제스트 대조로만
// 잡혀 사유를 모른 채 턴이 멈췄다. 쓰기 턴 입력에 이 보호 목록을 미리 싣는다. 문구는 위 목록에서 만든다 — 목록을 따로 적지 않는다.
export const TOOL_TREE_RUNNER_NOTE = `앱 밖 도구 트리: 작업 트리의 \`DerivedData/<이름>-logs/\` 아래 ${TOOL_TREE_SUBDIRECTORIES.map(sub => `\`${sub}/\``).join("·")}`
  + " 에는 파일을 만들거나 고치거나 지우지 마세요. 엔진이 턴 전후로 이 폴더들을 대조해 바뀌었으면 턴을 실패시킵니다. 보조 스크립트와 임시 산출물은 이 폴더들 밖에 두세요.";
const SKIP = new Set(["__pycache__", ".DS_Store"]);

export function toolTreeDirectories(workspace: string): string[] {
  const derived = join(workspace, "DerivedData");
  if (!existsSync(derived)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(derived, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith("-logs")) continue;
    for (const sub of TOOL_TREE_SUBDIRECTORIES) {
      const path = join(derived, entry.name, sub);
      if (existsSync(path)) result.push(path);
    }
  }
  return result.sort();
}

export interface ToolTreeDigest { directories: string[]; files: number; sha256: string }

// 경로·종류·모드·내용의 다이제스트. 심링크는 따라가지 않고 대상 문자열을 내용으로 본다(외부 코드 진입 경로도 변경으로 잡힌다).
export function digestToolTrees(workspace: string): ToolTreeDigest {
  const directories = toolTreeDirectories(workspace);
  const lines: string[] = [];
  const walk = (root: string, dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name) || entry.name.endsWith(".pyc")) continue;
      const path = join(dir, entry.name);
      const st = lstatSync(path);
      const rel = relative(workspace, path);
      if (st.isSymbolicLink()) { lines.push(`${rel}\0link\0${readlinkSync(path)}\0${linkTargetKind(path)}`); continue; }
      if (st.isDirectory()) { walk(root, path); continue; }
      if (!st.isFile()) { lines.push(`${rel}\0other`); continue; }
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      lines.push(`${rel}\0${(st.mode & 0o111) ? "x" : "-"}\0${hash}`);
    }
  };
  for (const directory of directories) walk(directory, directory);
  return { directories, files: lines.length, sha256: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

// 심링크는 **대상 문자열**과 대상 종류를 해시한다 — 링크 자신의 경로를 해시하면 대상을 바꿔도 지문이 같았다(F04).
function linkTargetKind(path: string): string {
  try { return statSync(path).isDirectory() ? "dir" : "file"; } catch { return "dangling"; }
}
