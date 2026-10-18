#!/usr/bin/env node
// 공통 실행 런타임 CLI 의 설치본 산출물(엔진 개편 E2e.md 규칙 6) — src/server/runtime/cli.ts 를 node 기본 모듈만 외부로 둔 단일 ESM 파일로 묶는다.
// 운영 도구 설치기가 host-review 통과를 확인한 clean 커밋에서 부른다. 산출물은 소스 체크아웃·tsx·node_modules 없이 실행된다(설치본이 소스에
// 상대 경로로 기대지 않는다). 저장소 파일을 실행 중에 읽는 모듈(new URL(…, import.meta.url))이 묶음에 들어오면 실패한다 — 번들 밖 경로가 된다.
// 공통 작업 지식(src/server/workerKnowledgeSource.ts)은 실행 중 docs/mediation/policy.md 를 읽는 모듈이라, 빌드 시점에 같은 파서로 뽑은 구간을 돌려주는
// 가상 모듈로 바꿔 묶는다. 설치기는 이 파일을 빌드 입력(RUNTIME_INPUTS)으로 함께 푼다.
//   node scripts/build-agent-runtime.mjs --out /absolute/agent-runtime.mjs
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { extractWorkerKnowledge } from "../src/shared/workerKnowledge.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !isAbsolute(args[1])) {
  console.error("사용법: node scripts/build-agent-runtime.mjs --out <절대 경로>");
  process.exit(2);
}
const outfile = args[1];

const knowledgeSource = resolve(root, "src/server/workerKnowledgeSource.ts");
const knowledgeInput = "cr-bundled:worker-knowledge";
const knowledge = extractWorkerKnowledge(await readFile(resolve(root, "docs/mediation/policy.md"), "utf8"));
// 소스 모듈과 같은 이름·형태(loadWorkerKnowledge(signal?))를 내보낸다. 취소된 턴은 소스 경로처럼 signal 의 사유로 실패한다.
const bundledKnowledge = {
  name: "bundled-worker-knowledge",
  setup(build) {
    build.onResolve({ filter: /^\.\/workerKnowledgeSource\.js$/ }, args =>
      resolve(args.resolveDir, "workerKnowledgeSource.ts") === knowledgeSource ? { path: "worker-knowledge", namespace: "cr-bundled" } : undefined);
    build.onLoad({ filter: /^worker-knowledge$/, namespace: "cr-bundled" }, () => ({ loader: "js", contents:
      `export async function loadWorkerKnowledge(signal) { signal?.throwIfAborted(); return ${JSON.stringify(knowledge)}; }\n` }));
  },
};

const result = await build({
  absWorkingDir: root,
  // 설치기는 검토한 커밋의 바이트를 임시 폴더에 풀고 node_modules 만 링크한다(tools/work-admission/install.py). 링크를 실제 경로로 풀면 번들 주석에
  // 소스 체크아웃까지의 상대 경로가 들어가 임시 폴더마다 바이트가 달라진다 — 링크 경로 그대로 쓴다.
  preserveSymlinks: true,
  entryPoints: ["src/server/runtime/cli.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // CommonJS dependencies also use their module's filename/directory during
  // initialization. In this self-contained ESM bundle those refer to the bundle.
  banner: { js: "import { createRequire as __agentRuntimeRequire } from 'node:module'; "
    + "import { fileURLToPath as __agentRuntimeFilePath } from 'node:url'; "
    + "import { dirname as __agentRuntimeDirname } from 'node:path'; "
    + "const require = __agentRuntimeRequire(import.meta.url); "
    + "const __filename = __agentRuntimeFilePath(import.meta.url), __dirname = __agentRuntimeDirname(__filename);" },
  plugins: [bundledKnowledge],
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

// 공통 작업 지식은 내장 본문으로 바뀌었어야 한다 — 소스 모듈이 묶이거나 가상 모듈이 빠지면 설치본이 정본을 전달하지 못한다.
const inputs = Object.keys(result.metafile.inputs);
if (!inputs.includes(knowledgeInput) || inputs.some(input => resolve(root, input) === knowledgeSource)) {
  console.error("설치본이 공통 작업 지식을 빌드 시점 본문으로 내장하지 않았습니다.");
  process.exit(1);
}
// 실행 중 저장소 파일을 읽는 모듈이 묶였는지 — 번들 위치 기준 상대 경로가 되어 설치본에서 깨진다.
for (const input of inputs) {
  if (input.startsWith("node_modules/") || input === knowledgeInput) continue;
  const source = await readFile(resolve(root, input), "utf8");
  if (/new URL\(\s*["'][^"']+["']\s*,\s*import\.meta\.url\s*\)/.test(source)) {
    console.error(`설치본이 저장소 파일에 기대는 모듈을 묶었습니다: ${relative(root, resolve(root, input))}`);
    process.exit(1);
  }
}
const bundle = await readFile(outfile, "utf8");
if (bundle.includes(root)) {
  console.error("설치본에 저장소 절대 경로가 들어 있습니다.");
  process.exit(1);
}
