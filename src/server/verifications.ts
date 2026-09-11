import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { redactSecrets } from "../shared/workflow.js";
import type { ArtifactStore } from "./artifacts.js";
import type { ConsensusDatabase } from "./database.js";
import { collectStaticInputs, inputSHA, loadStaticProfile, sha, STATIC_PROFILE_ID, STATIC_SCRIPT, toolSHA } from "./verificationInputs.js";

export const VERIFICATION_TIMEOUT_MS = 60_000;
const LEASE_MS = VERIFICATION_TIMEOUT_MS + 30_000;
const runSchema = z.object({
  id: z.string().uuid(), topicId: z.string(), cacheKey: z.string(),
  status: z.enum(["running", "succeeded", "failed", "cancelled", "timed_out", "stale"]),
  scopeGeneration: z.number(), planEpoch: z.number(), planSHA256: z.string(),
  inputSHA256: z.string(), toolSHA256: z.string(), startedAt: z.number(),
  finishedAt: z.number().optional(), durationMs: z.number().optional(), logSHA256: z.string().optional(),
  completionSHA256: z.string().optional(),
});
export type VerificationRun = z.infer<typeof runSchema>;
export const completeVerificationSchema = z.object({
  status: z.enum(["succeeded", "failed", "cancelled", "timed_out"]),
  exitCode: z.number().int().nullable(), durationMs: z.number().finite().nonnegative(),
  stdout: z.string().max(200_000), stderr: z.string().max(200_000),
}).strict().refine((value) => value.status !== "succeeded" || value.exitCode === 0, "성공 결과는 exitCode 0이어야 합니다.");
export type VerificationCompletion = z.infer<typeof completeVerificationSchema>;
export type VerificationCommand = {
  command: string; args: string[]; cwd: string; environment: Record<string, string>; timeoutMs: number;
};
export type PreparedVerification = { disposition: "run" | "busy" | "reused"; run: VerificationRun; execution?: VerificationCommand };

// 서버는 입력 정본과 결과만 관리한다. 실제 프로세스는 중재자 CLI가 실행한다.
export class VerificationService {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly database: ConsensusDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly dataDirectory: string,
    private readonly clock = () => Date.now(),
  ) {}

  list(topicId: string): VerificationRun[] {
    this.database.getTopic(topicId);
    return this.database.verificationRecords(topicId).flatMap((raw) => {
      const parsed = runSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
  }

  prepare(topicId: string): Promise<PreparedVerification> {
    return this.serial(topicId, async () => {
      await this.expire(topicId);
      const context = await this.context(topicId);
      for (const run of this.list(topicId)) {
        if (run.cacheKey !== context.cacheKey) continue;
        if (run.status === "running") {
          return { disposition: "busy", run };
        }
        if (run.status === "succeeded" && await this.validLog(run)) {
          await this.assertContext(topicId, context.cacheKey);
          this.metric(topicId, "hit", run);
          return { disposition: "reused", run };
        }
      }
      const id = randomUUID();
      const snapshot = this.snapshot(id);
      await mkdir(snapshot, { recursive: true, mode: 0o700 });
      try {
        for (const path of ["Modules", "SampleApp", ".home"]) await mkdir(join(snapshot, path), { recursive: true });
        for (const file of context.files) {
          const target = join(snapshot, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.content, { mode: file.mode });
          await chmod(target, file.mode);
        }
        if (inputSHA(await collectStaticInputs(snapshot)) !== context.inputSHA256) throw new Error("검사 입력 복사본이 다릅니다.");
        await this.assertContext(topicId, context.cacheKey);
        const run: VerificationRun = {
          id, topicId, cacheKey: context.cacheKey, status: "running", scopeGeneration: context.topic.scopeGeneration,
          planEpoch: context.topic.planEpoch, planSHA256: context.topic.planSHA256!,
          inputSHA256: context.inputSHA256, toolSHA256: context.toolSHA256, startedAt: this.clock(),
        };
        this.database.saveVerification(run);
        this.metric(topicId, "miss", run);
        const python = `'${context.profile.python.replaceAll("'", "'\\''")}'`;
        return { disposition: "run", run, execution: {
          command: context.profile.bash,
          args: ["--noprofile", "--norc", "-c", `python3() { ${python} -I -S -B "$@"; }\nreadonly -f python3\nsource ${STATIC_SCRIPT}`],
          cwd: snapshot, environment: { PATH: "/nonexistent", HOME: join(snapshot, ".home"), LANG: "C", LC_ALL: "C" },
          timeoutMs: VERIFICATION_TIMEOUT_MS,
        } };
      } catch (error) {
        await rm(snapshot, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async recoverExpired(topicId?: string): Promise<void> {
    const ids = topicId ? [topicId] : this.database.listTopics().map((topic) => topic.id);
    for (const id of ids) await this.serial(id, () => this.expire(id));
  }

  private async expire(topicId: string): Promise<void> {
    for (const run of this.list(topicId)) {
      if (run.status === "running" && this.clock() - run.startedAt >= LEASE_MS) {
        this.database.saveVerification({ ...run, status: "timed_out", finishedAt: this.clock() });
        await rm(this.snapshot(run.id), { recursive: true, force: true });
      }
    }
  }

  complete(topicId: string, runId: string, raw: unknown): Promise<VerificationRun> {
    const input = completeVerificationSchema.parse(raw);
    const completionSHA256 = sha(JSON.stringify(input));
    return this.serial(topicId, async () => {
      const run = this.list(topicId).find((entry) => entry.id === runId);
      if (!run) throw new Error("검사 실행 기록을 찾을 수 없습니다.");
      if (run.status !== "running") {
        // 서버가 리스를 회수한 실행에는 등록된 완료 본문이 없다. 만료 상태만 돌려주고 결과는 쓰지 않는다.
        if (run.status === "timed_out" && !run.completionSHA256) return run;
        if (run.completionSHA256 === completionSHA256) return run;
        throw new Error("이미 종료된 검사에 다른 결과를 등록할 수 없습니다.");
      }
      let status: VerificationRun["status"] = input.status;
      if (this.clock() - run.startedAt >= LEASE_MS || input.durationMs >= VERIFICATION_TIMEOUT_MS) status = "timed_out";
      if (status === "succeeded") {
        try {
          await this.assertContext(topicId, run.cacheKey);
          if (inputSHA(await collectStaticInputs(this.snapshot(run.id))) !== run.inputSHA256) status = "stale";
        } catch { status = "stale"; }
      }
      const topic = this.database.getTopic(topicId);
      const log = await this.artifacts.write(topicId, `verification-log-${run.id}`, 1, JSON.stringify({
        profileId: STATIC_PROFILE_ID, runId, inputSHA256: run.inputSHA256, toolSHA256: run.toolSHA256,
        ...input, status, stdout: redactSecrets(input.stdout), stderr: redactSecrets(input.stderr),
      }), { scopeGeneration: run.scopeGeneration });
      // 산출물을 기록하는 동안 주제 변경이 끼어들면 성공을 재사용하지 않는다.
      if (status === "succeeded") {
        const current = this.database.getTopic(topicId);
        if (current.scopeGeneration !== run.scopeGeneration || current.planEpoch !== run.planEpoch ||
            current.approvedPlanSHA256 !== run.planSHA256 || current.planSHA256 !== run.planSHA256) status = "stale";
      }
      const finished: VerificationRun = { ...run, status, finishedAt: this.clock(), durationMs: input.durationMs,
        logSHA256: log.sha256, completionSHA256 };
      this.database.saveVerification(finished);
      this.database.appendEvent({ topicId, actor: "system", kind: "system", state: topic.state,
        body: `정적 검사 ${STATIC_PROFILE_ID}: ${status}. 실행 기록 ${run.id}`,
        payload: { verificationMetrics: { runId: run.id, status, durationMs: input.durationMs } },
      });
      await rm(this.snapshot(run.id), { recursive: true, force: true });
      return finished;
    });
  }

  async receipts(topicId: string): Promise<{ text: string; readablePaths: string[] }> {
    try {
      const context = await this.context(topicId);
      for (const run of this.list(topicId)) {
        if (run.status === "succeeded" && run.cacheKey === context.cacheKey && await this.validLog(run)) {
          const artifact = await this.artifacts.verifiedRevision(topicId, `verification-log-${run.id}`, run.logSHA256!);
          await this.assertContext(topicId, context.cacheKey);
          return { text: `중재자 CLI가 기록한 정적 검사 성공(서버 실행 또는 독립 재검증을 뜻하지 않음): ${STATIC_PROFILE_ID}\n` +
            `run=${run.id}, 입력 SHA-256=${run.inputSHA256}, 도구 SHA-256=${run.toolSHA256}\n로그: ${artifact!.path}\n` +
            "이 영수증은 이 정적 검사만 증명하며 단위 테스트·빌드·런타임 또는 finding 해결을 대신하지 않습니다.",
            readablePaths: [artifact!.path] };
        }
      }
    } catch { /* 프로필 미등록·입력 변경·정본 손상은 재사용 근거가 아니다. */ }
    return { text: "", readablePaths: [] };
  }

  private async context(topicId: string) {
    const topic = this.database.getTopic(topicId);
    if (!topic.planSHA256 || topic.approvedPlanSHA256 !== topic.planSHA256) throw new Error("승인된 현재 계획이 필요합니다.");
    const profile = await loadStaticProfile(this.dataDirectory, topic.worktreePath);
    const files = await collectStaticInputs(topic.worktreePath);
    const inputSHA256 = inputSHA(files);
    const toolSHA256 = await toolSHA(profile, topic.worktreePath);
    const current = this.database.getTopic(topicId);
    if (current.scopeGeneration !== topic.scopeGeneration || current.planEpoch !== topic.planEpoch ||
        current.planSHA256 !== topic.planSHA256 || current.approvedPlanSHA256 !== topic.planSHA256 ||
        current.worktreePath !== topic.worktreePath) throw new Error("검사 준비 중 승인 범위가 바뀌었습니다.");
    const cacheKey = sha(JSON.stringify({ topicId, scope: topic.scopeGeneration, epoch: topic.planEpoch,
      plan: topic.planSHA256, worktree: topic.worktreePath, profile, inputSHA256, toolSHA256 }));
    return { topic, profile, files, inputSHA256, toolSHA256, cacheKey };
  }

  private async assertContext(topicId: string, expected: string) {
    if ((await this.context(topicId)).cacheKey !== expected) throw new Error("검사 중 입력·도구·승인 범위가 바뀌었습니다.");
  }

  private async validLog(run: VerificationRun): Promise<boolean> {
    if (!run.logSHA256) return false;
    try { return !!await this.artifacts.verifiedRevision(run.topicId, `verification-log-${run.id}`, run.logSHA256); }
    catch { return false; }
  }

  private snapshot(id: string) { return join(this.dataDirectory, "verification-snapshots", id); }
  private metric(topicId: string, cache: string, run: VerificationRun) {
    this.database.appendEvent({ topicId, actor: "system", kind: "system", state: this.database.getTopic(topicId).state,
      body: `정적 검사 결과 조회: ${cache}`, payload: { verificationMetrics: { cache, runId: run.id } } });
  }
  private async serial<T>(topicId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(topicId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.queues.set(topicId, current);
    try { return await current; }
    finally { if (this.queues.get(topicId) === current) this.queues.delete(topicId); }
  }
}
