import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { redactSecrets } from "../shared/workflow.js";
import { VERIFICATION_PROFILE_IDS, VERIFICATION_PROFILE_LABELS, type VerificationProfileId } from "../shared/planChecks.js";
import type { ArtifactStore } from "./artifacts.js";
import type { ConsensusDatabase } from "./database.js";
import {
  collectStaticInputs, collectSwiftParseInputs, inputSHA, loadStaticProfile, loadSwiftParseProfile, sha, STATIC_PROFILE_ID, STATIC_SCRIPT,
  swiftParseToolSHA, toolSHA, type InputFile, type StaticProfile, type SwiftParseProfile,
} from "./verificationInputs.js";
import { executeVerification } from "./verificationRunner.js";

export const VERIFICATION_TIMEOUT_MS = 60_000;
const LEASE_MS = VERIFICATION_TIMEOUT_MS + 30_000;
const runSchema = z.object({
  id: z.string().uuid(), topicId: z.string(), cacheKey: z.string(),
  // 프로필이 하나뿐이던 시절의 기록에는 없다 — 그때의 유일한 프로필(swift-concurrency-policy)이다.
  profileId: z.enum(VERIFICATION_PROFILE_IDS).default(STATIC_PROFILE_ID),
  // 프로세스를 띄운 주체 — engine(수락 경계 게이트, 서버 프로세스가 직접 실행) · mediator-cli(중재자 CLI 가 실행하고 결과를 등록, 서버는 실행하지 않음).
  // 엔진 실행 이전의 기록은 모두 CLI 실행이다.
  executor: z.enum(["engine", "mediator-cli"]).default("mediator-cli"),
  status: z.enum(["running", "succeeded", "failed", "cancelled", "timed_out", "stale"]),
  // planSHA256 은 실행 시점 토픽 계획의 기록이다 — 계획 없이 시작한 ticket 토픽은 null(검사 실행의 조건이 아니다, CR 흐름 단순화 v3.10 (19')).
  scopeGeneration: z.number(), planEpoch: z.number(), planSHA256: z.string().nullable(),
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
// no-targets: 이 프로필이 지금 트리에서 검사할 입력이 없다(swift-parse 인데 바뀐 Swift 파일이 없다) — 실행·기록하지 않는다. 정적 검사는 입력에 등록 스크립트가
// 늘 있어 이 값이 나오지 않는다(중재자 API 의 prepare 는 정적 검사만 준비한다).
export type PreparedProfileVerification = PreparedVerification | { disposition: "no-targets"; profileId: VerificationProfileId };

// 등록 프로필의 실행 정의 — 프로필 설정(호스트가 등록·해석), 검사 입력, 도구 신원, 실행 명세는 코드에 고정한다. 계획은 프로필 id 만 고른다 — 서버는 임의 명령을
// 실행하지 않는다(engine-history §14 정적 검사 원칙, 2026-10-06 개정). 프로필 종류가 이 닫힌 표뿐이라 빌드·시뮬레이터 같은 무거운 게이트는 표현할 수 없다.
interface ProfileContext { worktree: string; dataDirectory: string; changedPaths: () => Promise<string[]> }
interface ProfileRuntime<P> {
  load(context: ProfileContext): Promise<P>;
  inputs(root: string, context: ProfileContext, previous?: readonly InputFile[]): Promise<InputFile[]>;
  toolSHA(profile: P, worktree: string): Promise<string>;
  command(profile: P, snapshot: string, files: readonly InputFile[]): VerificationCommand;
  // 입력이 없어도 복사본에 있어야 하는 디렉터리 — 복사본 재해시(inputs)가 그 디렉터리를 걷는다.
  skeleton: string[];
}
const environment = (snapshot: string) => ({ PATH: "/nonexistent", HOME: join(snapshot, ".home"), LANG: "C", LC_ALL: "C" });
const PROFILES: { [K in VerificationProfileId]: ProfileRuntime<K extends "swift-parse" ? SwiftParseProfile : StaticProfile> } = {
  "swift-concurrency-policy": {
    skeleton: ["Modules", "SampleApp"],
    load: (context) => loadStaticProfile(context.dataDirectory, context.worktree),
    // Git의 tracked/ignored 구분과 무관하게 검사기가 실제로 읽는 파일 전체(Modules·SampleApp 의 Swift + 등록된 검사 스크립트).
    inputs: (root) => collectStaticInputs(root),
    toolSHA: (profile, worktree) => toolSHA(profile, worktree),
    command: (profile, snapshot) => {
      const python = `'${profile.python.replaceAll("'", "'\\''")}'`;
      return {
        command: profile.bash,
        args: ["--noprofile", "--norc", "-c", `python3() { ${python} -I -S -B "$@"; }\nreadonly -f python3\nsource ${STATIC_SCRIPT}`],
        cwd: snapshot, environment: environment(snapshot), timeoutMs: VERIFICATION_TIMEOUT_MS,
      };
    },
  },
  "swift-parse": {
    skeleton: [],
    load: () => loadSwiftParseProfile(),
    // 복사본의 재해시는 원본에서 고른 경로 목록 그대로 한다 — 복사본에는 Git 이 없다.
    inputs: async (root, context, previous) => collectSwiftParseInputs(root, previous ? previous.map((file) => file.path) : await context.changedPaths()),
    toolSHA: (profile) => swiftParseToolSHA(profile),
    command: (profile, snapshot, files) => ({
      command: profile.frontend, args: ["-frontend", "-parse", "-diagnostic-style=llvm", ...files.map((file) => file.path)],
      cwd: snapshot, environment: environment(snapshot), timeoutMs: VERIFICATION_TIMEOUT_MS,
    }),
  },
};
function runtime(profileId: VerificationProfileId): ProfileRuntime<StaticProfile | SwiftParseProfile> {
  return PROFILES[profileId] as ProfileRuntime<StaticProfile | SwiftParseProfile>;
}

// 한 프로필의 결과 — 엔진의 수락 경계 게이트와 리뷰 영수증이 읽는다.
export type VerificationOutcome =
  | { status: "succeeded"; run: VerificationRun; reused: boolean }
  | { status: "no-targets" }
  | { status: Exclude<VerificationRun["status"], "running" | "succeeded">; run: VerificationRun; log: { stdout: string; stderr: string } | null };

// 실행 드라이버(엔진·중재자 CLI 공통) — prepare(같은 입력의 성공은 재사용, 진행 중이면 그 실행을 기다림) → 실행 → 완료 등록. 엔진은 서비스를 직접,
// CLI 는 인증 API 로 부른다. beforeComplete: CLI 가 완료 등록 전에 결과를 보류 파일로 남긴다(등록 응답 유실 복구).
export interface VerificationApi {
  prepare(): Promise<PreparedProfileVerification>;
  list(): Promise<VerificationRun[]>;
  complete(runId: string, completion: VerificationCompletion): Promise<VerificationRun>;
}
export async function driveVerification(api: VerificationApi, signal?: AbortSignal,
  beforeComplete?: (run: VerificationRun, completion: VerificationCompletion) => Promise<void>): Promise<{ reused: boolean; run: VerificationRun } | { noTargets: true }> {
  let prepared: PreparedProfileVerification;
  while (true) {
    if (signal?.aborted) throw new Error("검사 대기가 취소되었습니다.");
    prepared = await api.prepare();
    if (prepared.disposition !== "busy") break;
    const busy = prepared.run.id;
    const deadline = Date.now() + LEASE_MS + 5_000;
    while (Date.now() < deadline) {
      await wait(300, signal);
      const current = (await api.list()).find((run) => run.id === busy);
      if (!current) throw new Error("대기 중인 검사 기록이 사라졌습니다.");
      if (current.status === "running") continue;
      if (current.status === "failed") return { reused: false, run: current };
      break;
    }
  }
  if (prepared.disposition === "no-targets") return { noTargets: true };
  if (prepared.disposition === "reused") return { reused: true, run: prepared.run };
  if (!prepared.execution) throw new Error("검사 실행 명세가 없습니다.");
  const completion = await executeVerification(prepared.execution, signal);
  await beforeComplete?.(prepared.run, completion);
  return { reused: false, run: await api.complete(prepared.run.id, completion) };
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("검사 대기가 취소되었습니다.");
  await new Promise<void>((resolveWait, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolveWait(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("검사 대기가 취소되었습니다.")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

// 서버는 입력 정본과 결과를 관리하고, 계획이 선언한 프로필은 엔진이 수락 경계에서 직접 실행한다(ensure — 2026-10-06 사용자 결정). 중재자 CLI 는 같은 드라이버로
// 정적 검사를 직접 돌릴 수 있다. 어느 쪽이든 실행 명세는 프로필 표가 정한다.
export class VerificationService {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly database: ConsensusDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly dataDirectory: string,
    private readonly clock = () => Date.now(),
    // 작업 트리에서 바뀐 경로(HEAD 대비, untracked 포함) — swift-parse 의 검사 대상. GitService.changedPaths.
    private readonly git?: { changedPaths(worktreePath: string): Promise<string[]> },
  ) {}

  list(topicId: string): VerificationRun[] {
    this.database.getTopic(topicId);
    return this.database.verificationRecords(topicId).flatMap((raw) => {
      const parsed = runSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
  }

  prepare(topicId: string): Promise<PreparedVerification>;
  prepare(topicId: string, profileId: VerificationProfileId, executor: VerificationRun["executor"]): Promise<PreparedProfileVerification>;
  prepare(topicId: string, profileId: VerificationProfileId = STATIC_PROFILE_ID, executor: VerificationRun["executor"] = "mediator-cli"): Promise<PreparedProfileVerification> {
    return this.serial(topicId, async (): Promise<PreparedProfileVerification> => {
      await this.expire(topicId);
      const context = await this.context(topicId, profileId);
      if (context.files.length === 0) return { disposition: "no-targets", profileId };
      for (const run of this.list(topicId)) {
        if (run.cacheKey !== context.cacheKey) continue;
        if (run.status === "running") {
          return { disposition: "busy", run };
        }
        if (run.status === "succeeded" && await this.validLog(run)) {
          await this.assertContext(topicId, profileId, context.cacheKey);
          this.metric(topicId, "hit", run);
          return { disposition: "reused", run };
        }
      }
      const id = randomUUID();
      const snapshot = this.snapshot(id);
      await mkdir(snapshot, { recursive: true, mode: 0o700 });
      try {
        for (const path of [...context.runtime.skeleton, ".home"]) await mkdir(join(snapshot, path), { recursive: true });
        for (const file of context.files) {
          const target = join(snapshot, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.content, { mode: file.mode });
          await chmod(target, file.mode);
        }
        if (inputSHA(await context.runtime.inputs(snapshot, context.profileContext, context.files)) !== context.inputSHA256) throw new Error("검사 입력 복사본이 다릅니다.");
        await this.assertContext(topicId, profileId, context.cacheKey);
        const run: VerificationRun = {
          id, topicId, cacheKey: context.cacheKey, profileId, executor, status: "running", scopeGeneration: context.topic.scopeGeneration,
          planEpoch: context.topic.planEpoch, planSHA256: context.topic.planSHA256 ?? null,
          inputSHA256: context.inputSHA256, toolSHA256: context.toolSHA256, startedAt: this.clock(),
        };
        this.database.saveVerification(run);
        this.metric(topicId, "miss", run);
        return { disposition: "run", run, execution: context.runtime.command(context.profile, snapshot, context.files) };
      } catch (error) {
        await rm(snapshot, { recursive: true, force: true });
        throw error;
      }
    });
  }

  // 엔진의 실행(수락 경계 게이트) — 같은 입력의 성공은 재사용하고, 아니면 이 프로세스에서 실행해 기록한다. 실패면 로그(가린 출력)를 함께 돌려준다.
  async ensure(topicId: string, profileId: VerificationProfileId, signal?: AbortSignal): Promise<VerificationOutcome> {
    const driven = await driveVerification({
      prepare: () => this.prepare(topicId, profileId, "engine"),
      list: async () => this.list(topicId),
      complete: (runId, completion) => this.complete(topicId, runId, completion),
    }, signal);
    if ("noTargets" in driven) return { status: "no-targets" };
    const { run } = driven;
    if (run.status === "succeeded") return { status: "succeeded", run, reused: driven.reused };
    if (run.status === "running") throw new Error(`검사 실행 ${run.id} 이 끝나지 않았습니다.`);
    return { status: run.status, run, log: await this.log(run) };
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
          const context = await this.context(topicId, run.profileId);
          if (context.cacheKey !== run.cacheKey) throw new Error("검사 중 입력·도구·승인 범위가 바뀌었습니다.");
          if (inputSHA(await context.runtime.inputs(this.snapshot(run.id), context.profileContext, context.files)) !== run.inputSHA256) status = "stale";
        } catch { status = "stale"; }
      }
      const topic = this.database.getTopic(topicId);
      const log = await this.artifacts.write(topicId, `verification-log-${run.id}`, 1, JSON.stringify({
        profileId: run.profileId, runId, inputSHA256: run.inputSHA256, toolSHA256: run.toolSHA256,
        ...input, status, stdout: redactSecrets(input.stdout), stderr: redactSecrets(input.stderr),
      }), { scopeGeneration: run.scopeGeneration });
      // 산출물을 기록하는 동안 주제 변경이 끼어들면 성공을 재사용하지 않는다.
      if (status === "succeeded") {
        const current = this.database.getTopic(topicId);
        if (current.scopeGeneration !== run.scopeGeneration || current.planEpoch !== run.planEpoch || (current.planSHA256 ?? null) !== run.planSHA256 ||
            (current.workflowMode === "planned" && current.approvedPlanSHA256 !== run.planSHA256)) status = "stale";
      }
      const finished: VerificationRun = { ...run, status, finishedAt: this.clock(), durationMs: input.durationMs,
        logSHA256: log.sha256, completionSHA256 };
      this.database.saveVerification(finished);
      this.database.appendEvent({ topicId, actor: "system", kind: "system", state: topic.state,
        body: `정적 검사 ${run.profileId}: ${status}. 실행 기록 ${run.id}`,
        payload: { verificationMetrics: { runId: run.id, profileId: run.profileId, status, durationMs: input.durationMs } },
      });
      await rm(this.snapshot(run.id), { recursive: true, force: true });
      return finished;
    });
  }

  // 리뷰 영수증 — 계획이 선언한 프로필(declared)마다 지금 트리의 결과를, 선언되지 않은 프로필은 지금 트리의 성공 기록이 있을 때만 싣는다. 영수증은 그 검사만
  // 증명한다(단위 테스트·빌드·런타임·finding 해결이 아니다). 프로필 미등록·입력 변경·정본 손상은 재사용 근거가 아니다 — 선언된 프로필이면 그 사실을 적는다.
  async receipts(topicId: string, declared: readonly VerificationProfileId[] = []): Promise<{ text: string; readablePaths: string[] }> {
    const lines: string[] = [];
    const readablePaths: string[] = [];
    for (const profileId of VERIFICATION_PROFILE_IDS) {
      const required = declared.includes(profileId);
      const runs = this.list(topicId).filter((run) => run.profileId === profileId);
      if (!required && !runs.some((run) => run.status === "succeeded")) continue;
      try {
        const context = await this.context(topicId, profileId);
        if (context.files.length === 0) {
          if (required) lines.push(`- ${profileId}: 지금 트리에 검사할 입력이 없습니다(${VERIFICATION_PROFILE_LABELS[profileId]} — 대상 0개).`);
          continue;
        }
        const run = runs.find((entry) => entry.cacheKey === context.cacheKey && entry.status !== "running");
        if (run?.status === "succeeded" && await this.validLog(run)) {
          const artifact = await this.artifacts.verifiedRevision(topicId, `verification-log-${run.id}`, run.logSHA256!);
          await this.assertContext(topicId, profileId, context.cacheKey);
          const by = run.executor === "engine" ? "엔진이 이 작업 트리에서 실행" : "중재자 CLI 가 실행해 등록(서버 실행·독립 재검증 아님)";
          lines.push(`- ${profileId}: 성공(${VERIFICATION_PROFILE_LABELS[profileId]}, ${by}, 입력 파일 ${context.files.length}개) run=${run.id}, `
            + `입력 SHA-256=${run.inputSHA256}, 도구 SHA-256=${run.toolSHA256}, 로그 ${artifact!.path}`);
          readablePaths.push(artifact!.path);
        } else if (required) {
          lines.push(`- ${profileId}: 지금 트리의 성공 기록이 없습니다${run ? `(마지막 결과 ${run.status}, run=${run.id})` : ""}.`);
        }
      } catch (error) {
        if (required) lines.push(`- ${profileId}: 결과를 확인하지 못했습니다(${error instanceof Error ? error.message : String(error)}).`);
      }
    }
    if (lines.length === 0) return { text: "", readablePaths: [] };
    return { text: "호스트 실행 검사 영수증(지금 작업 트리 기준 — 리뷰어가 다시 실행하지 않습니다):\n" + lines.join("\n")
      + "\n이 영수증은 해당 검사만 증명하며 단위 테스트·빌드·런타임 또는 finding 해결을 대신하지 않습니다.", readablePaths };
  }

  private async context(topicId: string, profileId: VerificationProfileId) {
    // planned 는 승인된 현재 계획 아래에서만 검사한다. ticket 은 계획 없이 시작하므로 계획 승인을 실행 조건으로 두지 않는다(CR 흐름 단순화 v3.10 (19')).
    const topic = this.database.getTopic(topicId);
    if (topic.workflowMode === "planned" && (!topic.planSHA256 || topic.approvedPlanSHA256 !== topic.planSHA256)) throw new Error("승인된 현재 계획이 필요합니다.");
    const profileRuntime = runtime(profileId);
    const git = this.git;
    const profileContext: ProfileContext = { worktree: topic.worktreePath, dataDirectory: this.dataDirectory,
      changedPaths: async () => {
        if (!git) throw new Error(`${profileId} 검사 대상(바뀐 파일)을 계산할 Git 이 연결되지 않았습니다.`);
        return git.changedPaths(topic.worktreePath);
      } };
    const profile = await profileRuntime.load(profileContext);
    const files = await profileRuntime.inputs(topic.worktreePath, profileContext);
    const inputSHA256 = inputSHA(files);
    const toolSHA256 = await profileRuntime.toolSHA(profile, topic.worktreePath);
    const current = this.database.getTopic(topicId);
    if (current.scopeGeneration !== topic.scopeGeneration || current.planEpoch !== topic.planEpoch ||
        current.planSHA256 !== topic.planSHA256 || current.workflowMode !== topic.workflowMode ||
        (topic.workflowMode === "planned" && current.approvedPlanSHA256 !== topic.planSHA256) ||
        current.worktreePath !== topic.worktreePath) throw new Error("검사 준비 중 승인 범위가 바뀌었습니다.");
    // 프로필 객체는 그대로 해시한다 — 단일 프로필 시절 기록의 cacheKey(프로필 id 를 따로 넣지 않음)가 그대로 재사용된다.
    const cacheKey = sha(JSON.stringify({ topicId, scope: topic.scopeGeneration, epoch: topic.planEpoch,
      plan: topic.planSHA256, worktree: topic.worktreePath, profile, inputSHA256, toolSHA256 }));
    return { topic, profile, profileContext, runtime: profileRuntime, files, inputSHA256, toolSHA256, cacheKey };
  }

  private async assertContext(topicId: string, profileId: VerificationProfileId, expected: string) {
    if ((await this.context(topicId, profileId)).cacheKey !== expected) throw new Error("검사 중 입력·도구·승인 범위가 바뀌었습니다.");
  }

  private async validLog(run: VerificationRun): Promise<boolean> {
    if (!run.logSHA256) return false;
    try { return !!await this.artifacts.verifiedRevision(run.topicId, `verification-log-${run.id}`, run.logSHA256); }
    catch { return false; }
  }

  private async log(run: VerificationRun): Promise<{ stdout: string; stderr: string } | null> {
    if (!run.logSHA256) return null;
    try {
      const artifact = await this.artifacts.verifiedRevision(run.topicId, `verification-log-${run.id}`, run.logSHA256);
      if (!artifact) return null;
      const parsed = z.object({ stdout: z.string(), stderr: z.string() }).safeParse(JSON.parse(artifact.content));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }

  private snapshot(id: string) { return join(this.dataDirectory, "verification-snapshots", id); }
  private metric(topicId: string, cache: string, run: VerificationRun) {
    this.database.appendEvent({ topicId, actor: "system", kind: "system", state: this.database.getTopic(topicId).state,
      body: `정적 검사 결과 조회: ${cache}`, payload: { verificationMetrics: { cache, runId: run.id, profileId: run.profileId } } });
  }
  private async serial<T>(topicId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(topicId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.queues.set(topicId, current);
    try { return await current; }
    finally { if (this.queues.get(topicId) === current) this.queues.delete(topicId); }
  }
}
