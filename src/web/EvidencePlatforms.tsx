import type { ReactNode } from "react";
import type { EvidenceProvider } from "../shared/externalEvidence";

const platforms: Array<{ provider: EvidenceProvider; label: string }> = [
  { provider: "jira", label: "Jira" },
  { provider: "confluence", label: "Confluence" },
  { provider: "slack", label: "Slack" },
  { provider: "figma", label: "Figma" },
  { provider: "sheets", label: "Google Sheets" },
  { provider: "document", label: "Backend API·웹 문서" },
];

export function EvidencePlatforms<T>({ items, provider, children }: {
  items: T[];
  provider: (item: T) => EvidenceProvider;
  children: (item: T) => ReactNode;
}) {
  return <>{platforms.map(platform => {
    const group = items.filter(item => provider(item) === platform.provider);
    return group.length > 0 && <details key={platform.provider} className="evidence-platform" aria-label={`${platform.label} 자료`} open>
      <summary>{platform.label} <span>{group.length}개</span></summary>
      <div className="evidence-platform-items">{group.map(children)}</div>
    </details>;
  })}</>;
}
