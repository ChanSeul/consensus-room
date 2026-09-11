import { z } from "zod";
import type { Topic } from "../../shared/contracts.js";
import type { EngineCore } from "./core.js";
import { StaleArtifactError } from "../artifacts.js";

const cursorSchema = z.object({
  sessionId: z.string().min(1), scopeGeneration: z.number().int(), planEpoch: z.number().int(),
  planSHA256: z.string().regex(/^[a-f0-9]{64}$/), sequence: z.number().int().nonnegative(),
});

// 커서는 모델 응답이 아닌, 검증된 산출물을 저장한 서버가 기록한다.
export async function preparePlanningContext(core: EngineCore, topic: Topic, markdown: string, sha256: string) {
  const { database, artifacts, git } = core.dependencies;
  const sequence = core.latestSequence(topic.id);
  const current = await artifacts.verifiedRevision(topic.id, "plan", sha256);
  if (!current || current.content !== markdown) throw new Error("계획 정본이 프롬프트와 다릅니다.");
  const sessionId = topic.participants.find((entry) => entry.role === "codex")?.sessionId;
  let text = markdown;
  let since = 0;
  let mode: "full" | "delta" = "full";
  const readablePaths = [current.path];
  try {
    const raw = await artifacts.readLatest(topic.id, "codex-planning-cursor");
    const cursor = raw ? cursorSchema.parse(JSON.parse(raw)) : null;
    if (cursor && cursor.sessionId === sessionId && !sessionId?.startsWith("pending:") &&
        cursor.scopeGeneration === topic.scopeGeneration && cursor.planEpoch === topic.planEpoch && cursor.sequence <= sequence) {
      const previous = await artifacts.verifiedRevision(topic.id, "plan", cursor.planSHA256);
      if (previous) {
        const patch = cursor.planSHA256 === sha256 ? "(계획 변경 없음)" : await git.diffPlanFiles(topic.worktreePath, previous.path, current.path);
        const delta = `이 세션에 전달했던 계획에서 바뀐 부분입니다. 변경하지 않은 내용은 앞선 계획을 유지합니다.\n이전 SHA-256: ${cursor.planSHA256}\n현재 SHA-256: ${sha256}\n이전 정본: ${previous.path}\n현재 정본: ${current.path}\n기억이 부족하면 읽기가 허용된 정본을 확인하세요.\n${patch}`;
        if (Buffer.byteLength(delta) < Buffer.byteLength(markdown)) {
          text = delta;
          since = cursor.sequence;
          mode = "delta";
          readablePaths.push(previous.path);
        }
      }
    }
  } catch {
    // 구버전·손상·Git 실패는 원문을 보내 복구한다. 현재 정본 검증 실패는 위에서 차단한다.
  }
  return {
    text, mode, inputSequence: sequence, readablePaths: [...new Set(readablePaths)],
    timeline: database.getPromptTimeline(topic.id, topic.scopeGeneration, since),
    async accept(signal: AbortSignal, prompt: string) {
      core.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
      const now = database.getTopic(topic.id);
      const acceptedSession = now.participants.find((entry) => entry.role === "codex")?.sessionId;
      if (!acceptedSession || acceptedSession.startsWith("pending:") || now.planEpoch !== topic.planEpoch ||
          now.planSHA256 !== sha256 || (sessionId && !sessionId.startsWith("pending:") && acceptedSession !== sessionId)) return;
      try {
        await core.writeArtifact(topic, "codex-planning-cursor", 1, JSON.stringify({
          sessionId: acceptedSession, scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch,
          planSHA256: sha256, sequence,
        }), signal, () => !core.newUserInputSince(topic, sequence));
      } catch (error) {
        if (error instanceof StaleArtifactError) {
          core.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
          if (core.newUserInputSince(topic, sequence)) return;
        }
        throw error;
      }
      core.event(topic.id, "system", "system", "계획 프롬프트 전송량을 기록했습니다.", {
        promptMetrics: { mode, bytes: Buffer.byteLength(prompt), planBytes: Buffer.byteLength(text) },
      });
    },
  };
}
