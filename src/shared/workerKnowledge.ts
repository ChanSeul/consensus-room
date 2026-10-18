// 공개 정책(docs/mediation/policy.md)에서 작업자에게 전달할 공통 지식 구간을 뽑는다. 리더(서버)와 번들 빌더(scripts/build-agent-runtime.mjs)가
// 같은 함수를 쓴다 — 빌더는 Node 가 이 파일을 직접 불러오므로 import 와 타입 전용이 아닌 TS 문법(enum 등)을 쓰지 않는다.
export const WORKER_KNOWLEDGE_START = "<!-- cr-worker-knowledge:start -->";
export const WORKER_KNOWLEDGE_END = "<!-- cr-worker-knowledge:end -->";

// 경계는 그 줄 전체가 표식인 standalone 줄만이다. 정확히 한 쌍, start 가 먼저, 본문이 비어 있지 않아야 한다. 어긋나면 조용히 빼지 않고 실패한다.
export function extractWorkerKnowledge(text: string): string {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    if (line === WORKER_KNOWLEDGE_START) starts.push(index);
    else if (line === WORKER_KNOWLEDGE_END) ends.push(index);
  });
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(`공통 작업 지식 구간 표식은 정확히 한 쌍이어야 합니다(start ${starts.length}개, end ${ends.length}개).`);
  }
  if (starts[0] > ends[0]) throw new Error("공통 작업 지식 구간의 end 표식이 start 표식보다 앞에 있습니다.");
  const body = lines.slice(starts[0] + 1, ends[0]).join("\n");
  if (!body.trim()) throw new Error("공통 작업 지식 구간이 비어 있습니다.");
  return body;
}
