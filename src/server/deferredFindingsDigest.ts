import type { DeferredFinding, Topic } from "../shared/contracts.js";

const INDEX_PREFIX = "<!-- consensus-room:deferred-findings-index:v1 ";
const INDEX_SUFFIX = " -->";

export function renderDeferredFindingsDigest(topic: Pick<Topic, "id" | "scopeGeneration">, findings: readonly DeferredFinding[]): string {
  const prefix = ["# 이연 쟁점 원문(서버 보존, 읽기 전용)", "",
    `주제 ${topic.id} · 범위 세대 ${topic.scopeGeneration} · ${findings.length}건. 계획·감사 프롬프트의 이연 쟁점 목록이 가리키는 근거 전문이다.`, "", ""].join("\n");
  const sections = findings.map(finding => `## ${finding.id} [${finding.severity}] ${finding.title}\n\n출처 ${finding.source} · 토픽 ${finding.topicId} · 기록 ${finding.recordedAt}\n\n${finding.rationale}\n`);
  let offset = Buffer.byteLength(prefix);
  const starts = sections.map(section => { const start = offset; offset += Buffer.byteLength(section) + 1; return start; });
  // Relative offsets exclude this header's variable length. The artifact hash pins the header and text together.
  return `${INDEX_PREFIX}${JSON.stringify(starts)}${INDEX_SUFFIX}\n${prefix}${sections.join("\n")}`;
}

export function deferredFindingSections(body: string): { contentOffset: number; starts: number[] } {
  const fallback = { contentOffset: 0, starts: [] };
  const end = body.indexOf("\n"), header = body.slice(0, end);
  if (end < 0 || !header.startsWith(INDEX_PREFIX) || !header.endsWith(INDEX_SUFFIX)) return fallback;
  try {
    const values: unknown = JSON.parse(header.slice(INDEX_PREFIX.length, -INDEX_SUFFIX.length));
    if (!Array.isArray(values)) return fallback;
    const contentOffset = Buffer.byteLength(body.slice(0, end + 1)), bytes = Buffer.from(body);
    const starts: number[] = [];
    let previous = -1;
    for (const value of values) {
      const start = contentOffset + value;
      if (!Number.isSafeInteger(value) || value <= previous || value < 0 || start >= bytes.length ||
          (bytes[start]! & 0xc0) === 0x80) return fallback;
      starts.push(start);
      previous = value;
    }
    return { contentOffset, starts };
  } catch { return fallback; }
}
