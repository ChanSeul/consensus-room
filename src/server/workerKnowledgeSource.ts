import { readFile } from "node:fs/promises";
import { extractWorkerKnowledge } from "../shared/workerKnowledge.js";

// 소스 실행(서버·tsx)에서는 호출마다 공개 정책 정본을 읽는다 — 정책이 바뀌면 다음 턴부터 그 본문이 실린다.
// 독립 번들(scripts/build-agent-runtime.mjs)은 이 모듈을 빌드 시점에 뽑은 같은 구간을 돌려주는 모듈로 바꿔 묶는다. 내보내는 loadWorkerKnowledge 의 이름·형태를 바꾸면 빌더도 함께 바꾼다.
const WORKER_KNOWLEDGE_SOURCE = new URL("../../docs/mediation/policy.md", import.meta.url);

export async function loadWorkerKnowledge(signal?: AbortSignal): Promise<string> {
  const text = await readFile(WORKER_KNOWLEDGE_SOURCE, { encoding: "utf8", signal }).catch((error: NodeJS.ErrnoException) => {
    if (error.name === "AbortError") throw signal?.reason ?? error;
    throw new Error(`공통 작업 지식 정본을 읽지 못했습니다(docs/mediation/policy.md): ${error.message}`, { cause: error });
  });
  return extractWorkerKnowledge(text);
}
