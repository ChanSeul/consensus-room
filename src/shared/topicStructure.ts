import { z } from "zod";
import type { Topic } from "./contracts.js";
import { EvidenceSourceInputSchema } from "./externalEvidence.js";

export const GoalTextSchema = z.string().trim().min(1).max(12000);
export const WorkEntryInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("goal"), goal: GoalTextSchema }).strict(),
  z.object({ mode: z.literal("sources"), sources: z.array(EvidenceSourceInputSchema).min(1).max(64) }).strict(),
  z.object({ mode: z.literal("brainstorm") }).strict(),
]);
export const WorkEntrySchema = z.object({
  mode: z.enum(["goal", "sources", "brainstorm"]),
  goal: GoalTextSchema.nullable(),
  sourceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(64),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export type WorkEntry = z.infer<typeof WorkEntrySchema>;
export const SetTopicGoalSchema = z.object({
  goal: GoalTextSchema,
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const ENTRY_COPY = {
  goal: { label: "Goal에서 시작", steps: ["Goal", "Plan", "구현·검토"], description: "정해진 목표로 바로 계획을 시작합니다." },
  sources: { label: "Source에서 시작", steps: ["Source 확인", "Goal", "Plan", "구현·검토"], description: "Jira·Figma·Slack 등 원문에서 요구사항과 목표를 정합니다." },
  brainstorm: { label: "브레인스토밍에서 시작", steps: ["브레인스토밍", "Goal", "Plan", "구현·검토"], description: "아이디어를 논의하고 목표를 정한 뒤 계획합니다." },
} as const;

// 과거 주제는 저장 이력을 바꾸지 않고 기존 제목·논의 상태로 읽는다.
export function workEntry(topic: Topic): WorkEntry {
  return topic.workEntry ?? { mode: topic.state.startsWith("BRAINSTORM") ? "brainstorm" : "goal",
    goal: topic.state.startsWith("BRAINSTORM") ? null : topic.title, sourceIds: [], evidenceDigest: null };
}
export function isTopicGroup(topic: Topic): boolean { return topic.topicKind === "group"; }

export interface TopicNode { topic: Topic; children: TopicNode[]; leaves: number; closed: number }
// 한 번 구성한 트리를 사이드바와 진행률에 함께 쓴다. 종료한 말단도 분모에 남긴다.
export function topicForest(topics: readonly Topic[]): TopicNode[] {
  const nodes = new Map(topics.map(topic => [topic.id, { topic, children: [], leaves: 0, closed: 0 } as TopicNode]));
  const roots: TopicNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.topic.parentTopicId ? nodes.get(node.topic.parentTopicId) : null;
    if (parent) parent.children.push(node); else roots.push(node);
  }
  const count = (node: TopicNode): void => {
    node.children.forEach(count);
    node.leaves = node.children.length ? node.children.reduce((sum, child) => sum + child.leaves, 0) : isTopicGroup(node.topic) ? 0 : 1;
    node.closed = node.children.length ? node.children.reduce((sum, child) => sum + child.closed, 0) : !isTopicGroup(node.topic) && node.topic.state === "CLOSED" ? 1 : 0;
  };
  roots.forEach(count);
  return roots;
}
export function topicAncestors(topic: Topic, topics: readonly Topic[]): Topic[] {
  const byId = new Map(topics.map(item => [item.id, item]));
  const parents: Topic[] = [], seen = new Set([topic.id]);
  let parentId = topic.parentTopicId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    parents.unshift(parent); parentId = parent.parentTopicId;
  }
  return parents;
}
