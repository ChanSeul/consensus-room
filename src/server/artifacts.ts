import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConsensusDatabase } from "./database.js";
import type { StoredArtifact } from "./types.js";

const PUBLIC_NAMES: Readonly<Record<string, string>> = {
  plan: "plan.md",
  consensus: "consensus.json",
  implementation: "implementation-report.md",
  codexReview: "codex-review.md",
};

export class ArtifactStore {
  constructor(
    private readonly topicsDirectory: string,
    private readonly database: ConsensusDatabase,
  ) {}

  async write(
    topicId: string,
    kind: string,
    revision: number,
    content: string,
    options?: { scopeGeneration?: number; accept?: () => boolean },
  ): Promise<StoredArtifact> {
    const scopeGeneration = options?.scopeGeneration ?? this.database.getTopic(topicId).scopeGeneration;
    const previousRevision = this.database.latestArtifactRevision(topicId, kind);
    const storedRevision = Math.max(revision, previousRevision + 1);
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    const topicDirectory = join(this.topicsDirectory, topicId);
    const generationDirectory = join(topicDirectory, `generation-${scopeGeneration}`);
    const blobsDirectory = join(topicDirectory, "artifacts");
    await mkdir(blobsDirectory, { recursive: true });
    const blobPath = join(blobsDirectory, sha256);
    await atomicWrite(blobPath, content);
    const publicName = PUBLIC_NAMES[kind];
    if (publicName) await mkdir(generationDirectory, { recursive: true });
    const publicPaths = publicName
      ? [join(generationDirectory, publicName), join(topicDirectory, publicName)]
      : [];
    const publicWrites = await Promise.all(publicPaths.map(async (path) => ({
      path,
      temporary: await prepareAtomicWrite(path, content),
    })));
    if (options?.accept && !options.accept()) {
      await Promise.all(publicWrites.map(({ temporary }) => unlink(temporary).catch(() => undefined)));
      throw new StaleArtifactError();
    }
    const artifact = {
      kind,
      revision: storedRevision,
      scopeGeneration,
      sha256,
      path: blobPath,
      createdAt: new Date().toISOString(),
    };
    // accept() 이후에는 await하지 않는다. 범위 변경이 이 commit boundary 사이에 끼어들 수 없다.
    // 원장(DB)이 정본이므로 먼저 기록한다 — 별칭 rename과 DB 사이에서 죽으면 "별칭만 새것"이 되는
    // 갈림을 "원장은 맞고 별칭만 낡음"으로 바꾼다. readLatest는 DB 경로(blob)를 읽으므로 별칭은
    // 사람용 사본일 뿐이다(2026-08-31 Codex 지적).
    this.database.addArtifact(topicId, artifact);
    for (const write of publicWrites) renameSync(write.temporary, write.path);
    return artifact;
  }

  // 최신 산출물의 **검증된 정본(blob)** 경로. 별칭(plan.md)은 저장 중단·rename 실패로 낡을 수 있는 사람용 사본이라
  // 에이전트의 복구 경로로 쓰지 않는다(2026-09-08 Codex 후속 지적 6). 반환 전에 원장 sha 로 내용을 검증한다.
  async verifiedPath(topicId: string, kind: string): Promise<string> {
    const artifact = this.database.latestArtifact(topicId, kind);
    if (!artifact) throw new Error(`저장된 ${kind} 산출물이 없습니다.`);
    await readVerified(artifact);
    return artifact.path;
  }

  async readLatest(topicId: string, kind: string): Promise<string | null> {
    const artifact = this.database.latestArtifact(topicId, kind);
    if (!artifact) return null;
    return readVerified(artifact);
  }

  async readPrevious(topicId: string, kind: string): Promise<string | null> {
    const artifact = this.database.artifactsForScope(topicId, kind)[1];
    return artifact ? readVerified(artifact) : null;
  }

  async verifiedRevision(topicId: string, kind: string, sha256: string): Promise<{ path: string; content: string } | null> {
    const artifact = this.database.artifactsForScope(topicId, kind).find((entry) => entry.sha256 === sha256);
    return artifact ? { path: artifact.path, content: await readVerified(artifact) } : null;
  }

  async clearCurrentAliases(topicId: string): Promise<void> {
    const topicDirectory = join(this.topicsDirectory, topicId);
    await Promise.all(Object.values(PUBLIC_NAMES).map((name) =>
      unlink(join(topicDirectory, name)).catch((error: unknown) => {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }),
    ));
  }
}

export class StaleArtifactError extends Error {
  constructor() {
    super("이전 범위의 늦은 산출물을 버렸습니다.");
    this.name = "StaleArtifactError";
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = await prepareAtomicWrite(path, content);
  await rename(temporary, path);
}

async function prepareAtomicWrite(path: string, content: string): Promise<string> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  return temporary;
}

// 승인·합의는 기록된 SHA-256에 걸려 있다. 파일이 기록과 다르면 변조든 손상이든 그 본문을 쓰면 안 된다 —
// 조용히 반환하면 승인한 계획과 다른 본문으로 구현이 시작될 수 있다(감사 ⑧).
async function readVerified(artifact: StoredArtifact): Promise<string> {
  const content = await readFile(artifact.path, "utf8");
  const actual = createHash("sha256").update(content, "utf8").digest("hex");
  if (actual !== artifact.sha256) {
    throw new Error(`아티팩트가 기록된 SHA-256과 다릅니다(변조 또는 손상): ${artifact.path}`);
  }
  return content;
}
