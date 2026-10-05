import type { TimelineEvent, Topic, WorkflowState } from "./contracts.js";

// A waiting state describes why work stopped, never where execution resumes.
export const RETRY_POINTS = ["DRAFT", "BRAINSTORM_READY", "BRAINSTORMING", "CLAUDE_PLAN", "CODEX_AUDIT",
  "CLAUDE_REVISION", "CODEX_CLOSEOUT", "CONSENSUS_ACK", "IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX", "CODEX_FINAL_REVIEW"] as const;
export type RetryPoint = typeof RETRY_POINTS[number];
export type ResumePoint = RetryPoint | "READY_TO_DELIVER";
export const isRetryPoint = (value: unknown): value is RetryPoint => RETRY_POINTS.some(point => point === value);
export const isResumePoint = (value: unknown): value is ResumePoint => isRetryPoint(value) || value === "READY_TO_DELIVER";
export const isStopped = (state: WorkflowState): boolean =>
  state === "FAILED" || state === "USER_DECISION_REQUIRED" || state === "BLOCKED_ON_EVIDENCE";

export function failureResumePoint(state: WorkflowState, previous: WorkflowState | null): ResumePoint | null {
  return isResumePoint(state) ? state : isResumePoint(previous) ? previous : null;
}

export interface StopRecord {
  version: 1;
  reason: "failure" | "resource" | "evidence" | "decision";
  resumeAt: ResumePoint | null;
  scopeGeneration: number;
  planEpoch: number;
  planSHA256: string | null;
  sourceSequence: number;
}
export const RESOURCE_PAUSE_KEYS = ["planningPause", "budgetPause", "revisionPause", "reviewPause", "admissionRefused"] as const;

export function currentStopEvent(topic: Topic, resume: WorkflowState | null, timeline: readonly TimelineEvent[]): TimelineEvent | undefined {
  const events = timeline.filter(event => event.scopeGeneration === topic.scopeGeneration);
  const transition = events.filter(event => event.actor === "system" && event.payload?.to !== undefined).at(-1)?.sequence ?? 0;
  return events.findLast(event => {
    if (event.actor !== "system" || event.sequence < transition || event.payload?.resumeState !== resume) return false;
    const record = event.payload.stop as StopRecord | undefined;
    return !record || (record.version === 1 && record.scopeGeneration === topic.scopeGeneration &&
      record.planEpoch === topic.planEpoch && record.planSHA256 === topic.planSHA256 && record.resumeAt === resume);
  });
}

// Legacy payloads are adapted at this boundary. Consumers never infer a stop from
// localized prose, and a prior plan's stop cannot authorize a new plan's retry.
export function stopRecord(topic: Topic, resume: WorkflowState | null, event?: Pick<TimelineEvent, "sequence" | "payload">): StopRecord {
  const payload = event?.payload;
  return { version: 1, reason: topic.state === "FAILED" ? "failure"
    : RESOURCE_PAUSE_KEYS.some(key => Boolean(payload?.[key])) ? "resource"
    : topic.state === "BLOCKED_ON_EVIDENCE" ? "evidence" : "decision",
    resumeAt: isResumePoint(resume) ? resume : null, scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch,
    planSHA256: topic.planSHA256, sourceSequence: event?.sequence ?? 0 };
}

// These flags belong to a cycle, not to lifetime review/revision/usage allowances.
export function resetCycle(scope: "plan" | "implementation") {
  return { fixPassUsed: false, secondFixPassUsed: false, reviewedHead: null, reviewedDiffSHA256: null, reviewedTreeOID: null,
    ...(scope === "plan" ? { closeoutRevisionUsed: false } : {}) };
}
