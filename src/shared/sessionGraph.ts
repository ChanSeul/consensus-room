export type GraphRole = "mediator" | "planner" | "plan-reviewer" | "runner" | "reviewer" | "host-reviewer" | "verifier" | "session";
export type GraphStatus = "running" | "idle" | "complete" | "blocked" | "unconnected" | "unknown";
export interface GraphNode {
  id: string;
  kind: "topic" | "session" | "source" | "stage";
  topicId: string | null;
  lane: string;
  label: string;
  subtitle: string;
  role?: GraphRole;
  status: GraphStatus;
  historical: boolean;
  sessionId?: string | null;
  provider?: string | null;
  sourceId?: string;
  workGroupId?: string;
  stageId?: string;
  url?: string;
  details: Array<{ label: string; value: string }>;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "hierarchy" | "flow" | "registered" | "delivered" | "communication" | "dependency";
  label: string;
  status?: "waiting" | "sending" | "sent" | "acknowledged" | "failed" | "unknown";
  detail?: string;
}
export interface SessionGraph {
  topicId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  lanes: Array<{ id: string; title: string }>;
  warnings: string[];
  checkedAt: string;
}
export const GRAPH_ROLES: Record<GraphRole, string> = {
  mediator: "중재자", planner: "플래너", "plan-reviewer": "계획 검토자", runner: "러너",
  reviewer: "코드 검토자", "host-reviewer": "Host reviewer", verifier: "검증자", session: "세션",
};
export const GRAPH_STATUS: Record<GraphStatus, string> = {
  running: "진행 중", idle: "대기", complete: "종료", blocked: "정지", unconnected: "미연결", unknown: "관측 없음",
};
