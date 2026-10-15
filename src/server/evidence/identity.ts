import { createHash } from "node:crypto";

export const evidenceHash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
// Key order is fixed to en-US collation, never the process locale: under ko_KR, Hangul keys (Jira custom field names)
// sorted first and the same source hashed differently after a restart (2026-10-15). en-US is the order every stored hash
// was written in (store snapshot/unit hashes and source ids recompute unchanged), so pinning it changes no persisted key.
export const compareEvidenceStrings = new Intl.Collator("en-US").compare;
export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => compareEvidenceStrings(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJSON(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
