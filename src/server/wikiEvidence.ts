export interface MemoryEvidenceDependency { sourceId: string; contentHash: string }
export type MemoryEvidenceStatus = "current" | "changed" | "unavailable" | "missing";
export interface MemoryReaderOptions {
  resolveEvidenceStatus?: (dependencies: readonly MemoryEvidenceDependency[]) => MemoryEvidenceStatus | Promise<MemoryEvidenceStatus>;
}

export async function wikiEvidenceNotice(content: string, options: MemoryReaderOptions): Promise<string | null> {
  const blocks = [...content.matchAll(/^```wiki-evidence\s*\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length === 0 && !/^```wiki-evidence\b/m.test(content)) return null;
  let status: MemoryEvidenceStatus = "unavailable";
  try {
    if (blocks.length !== 1 || [...content.matchAll(/^```wiki-evidence\b/gm)].length !== 1) throw new Error("Expected one evidence block");
    const parsed: unknown = JSON.parse(blocks[0][1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid evidence object");
    const dependencies = (parsed as { dependencies?: unknown }).dependencies;
    if (!Array.isArray(dependencies) || dependencies.length === 0 || dependencies.length > 64) throw new Error("Invalid dependency list");
    const seen = new Set<string>();
    for (const dependency of dependencies) {
      if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)
        || Object.keys(dependency).sort().join(",") !== "contentHash,sourceId"
        || !/^[a-f0-9]{64}$/.test(dependency.sourceId) || !/^[a-f0-9]{64}$/.test(dependency.contentHash)
        || seen.has(dependency.sourceId)) throw new Error("Invalid dependency");
      seen.add(dependency.sourceId);
    }
    const resolved = await options.resolveEvidenceStatus?.(dependencies);
    if (resolved && ["current", "changed", "unavailable", "missing"].includes(resolved)) status = resolved;
  } catch {
    // A malformed reference or failed check must not turn an old conclusion into a current decision.
  }
  const messages: Record<MemoryEvidenceStatus, string> = {
    current: "원문 내용이 기록한 해시와 같습니다. 결정의 유효성·작성자·플랫폼은 별도로 확인하세요.",
    changed: "원문이 바뀌었습니다. 이 문서의 결론을 적용하기 전에 원문을 다시 확인하세요.",
    unavailable: "원문 상태를 확인할 수 없습니다. 이 문서를 최신 결정의 근거로 단정하지 마세요.",
    missing: "연결된 원문이 없습니다. 출처를 확인하기 전에는 이 문서를 최신 결정의 근거로 쓰지 마세요.",
  };
  return `외부 근거: ${status} — ${messages[status]}`;
}
