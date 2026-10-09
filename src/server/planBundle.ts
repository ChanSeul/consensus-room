import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { Topic } from "../shared/contracts.js";
import type { PlanBundleCapture, PlanBundleSnapshot } from "../shared/planningControl.js";
import type { ArtifactStore } from "./artifacts.js";
import type { ConsensusDatabase } from "./database.js";
import type { GitService } from "./git.js";
import type { StoredArtifact } from "./types.js";

// 계획 묶음(planned 모드) — planner 가 자기 도구로 쓰고 고치는 토픽 산출물 폴더의 plan/*.md 다. 엔진은 묶음을 해석하지 않고, planner 가 턴을 끝낼 때
// 폴더를 버전으로 확정(스냅샷·변경분)할 뿐이다. 스냅샷은 기존 계획 산출물(kind plan)로 저장해 승인·구현자의 계획 읽기(planSHA256 결속)를 그대로 쓴다.
const PLAN_FILE = "plan.md";

export interface PlanFile { path: string; content: string }
export type ArtifactWriter = (kind: string, revision: number, content: string) => Promise<StoredArtifact>;
type BundleTopic = Pick<Topic, "id" | "scopeGeneration" | "planSHA256">;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

// 묶음의 정규 직렬화 — 스냅샷 본문이자 버전의 입력이다. 파일이 plan.md 하나면 그 내용 그대로라, 기존 계획(plan_sha256 = 계획 산출물 내용의 sha256)을
// plan/plan.md 로 옮겨도 버전이 같다. 그 밖에는 상대 경로의 바이트 순서로 파일마다 경로·바이트 수 머리줄 뒤에 내용을 잇는다. 바이트 수가 경계를 정하므로
// 내용 안의 머리줄 모양 문자열이 다른 파일 경계로 읽히지 않는다.
export function serializePlanBundle(files: readonly PlanFile[]): string {
  const sorted = [...files].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (sorted.length === 1 && sorted[0]!.path === PLAN_FILE) return sorted[0]!.content;
  return sorted.map((file) => `<!-- plan-file ${JSON.stringify(file.path)} ${Buffer.byteLength(file.content)} -->\n${file.content}\n`).join("");
}

export function planBundleVersion(files: readonly PlanFile[]): string {
  return sha256(serializePlanBundle(files));
}

export class PlanBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanBundleError";
  }
}

export class PlanBundle {
  // generationDirectory 는 토픽 범위 세대의 산출물 폴더를 정한다(ArtifactStore 의 배치를 그대로 쓴다 — 이 클래스가 폴더 배치를 다시 계산하지 않는다).
  constructor(
    private readonly generationDirectory: (topicId: string, scopeGeneration: number) => string,
    private readonly artifacts: ArtifactStore,
    private readonly git: GitService,
    private readonly database: ConsensusDatabase,
  ) {}

  // planner 의 작업 폴더(없으면 만든다). 범위 세대마다 따로 두어, 사용자 범위 변경 뒤의 계획이 옛 세대 파일을 이어받지 않는다.
  async directory(topic: Pick<Topic, "id" | "scopeGeneration">): Promise<string> {
    const path = join(this.generationDirectory(topic.id, topic.scopeGeneration), "plan");
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  // 작업 폴더의 .md 파일(하위 폴더 포함). 심볼릭 링크는 폴더 밖 파일을 스냅샷에 끌어올 수 있어 읽지 않고 멈춘다.
  async read(topic: Pick<Topic, "id" | "scopeGeneration">): Promise<PlanFile[]> {
    const root = await this.directory(topic);
    const files: PlanFile[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new PlanBundleError(`계획 폴더에 심볼릭 링크가 있어 읽지 않았습니다: ${path}`);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push({ path: relative(root, path).split(sep).join("/"), content: await readFile(path, "utf8") });
        }
      }
    };
    await walk(root);
    return files;
  }

  // 현재 계획 — topic.planSHA256 에 결속한 스냅샷. 계획이 없으면 null 이다(ticket → planned 전환은 이 값으로 첫 작성·같은 계획 수정을 고른다).
  async current(topic: BundleTopic): Promise<PlanBundleSnapshot | null> {
    if (!topic.planSHA256) return null;
    const snapshot = await this.artifacts.verifiedRevision(topic.id, "plan", topic.planSHA256);
    if (!snapshot) throw new PlanBundleError(`현재 계획 버전 ${topic.planSHA256} 의 스냅샷이 없습니다.`);
    return { version: topic.planSHA256, snapshotPath: snapshot.path };
  }

  // 작업 폴더를 버전으로 확정한다 — 현재 버전과 같으면 새로 쓰지 않는다. 다르면 스냅샷과 직전 현재 버전 대비 변경분을 산출물로 남긴다.
  // topic 의 현재 버전(planSHA256)은 바꾸지 않는다 — 상태 전이와 한 transaction 으로 호출자가 바꾼다. write 는 실행 중인 턴이 쓰는 산출물 저장
  // (현재성 검사 포함, core.writeArtifact)이고, 없으면 검사 없이 저장한다.
  async capture(topic: BundleTopic, options: { write?: ArtifactWriter } = {}): Promise<PlanBundleCapture> {
    const files = await this.read(topic);
    if (files.length === 0) throw new PlanBundleError(`계획 폴더에 .md 파일이 없습니다: ${await this.directory(topic)}`);
    const content = serializePlanBundle(files);
    const version = sha256(content);
    const previous = await this.current(topic);
    if (previous?.version === version) return { ...previous, previous: version, diffPath: null, changed: false };
    const write: ArtifactWriter = options.write
      ?? ((kind, revision, body) => this.artifacts.write(topic.id, kind, revision, body, { scopeGeneration: topic.scopeGeneration }));
    const snapshot = await write("plan", this.database.latestArtifactRevision(topic.id, "plan") + 1, content);
    let diffPath: string | null = null;
    if (previous) {
      const patch = await this.git.diffPlanFiles(dirname(snapshot.path), previous.snapshotPath, snapshot.path);
      const diff = await write("plan-diff", this.database.latestArtifactRevision(topic.id, "plan-diff") + 1,
        `# 계획 변경분 ${previous.version} → ${version}\n\n${patch}`);
      diffPath = diff.path;
    }
    return { version, snapshotPath: snapshot.path, previous: previous?.version ?? null, diffPath, changed: true };
  }

  // 기존 토픽 이행 — 현재 계획 산출물을 작업 폴더의 plan.md 로 바이트 그대로 옮긴다. 묶음 버전이 기존 planSHA256 과 같아 승인 결속(approved == current)도
  // 이행 전과 같은 의미다. 스냅샷은 그 산출물 자체라 새로 쓰지 않는다. 폴더가 이미 이 버전이면 아무것도 하지 않고, 다른 내용이면 덮어쓰지 않고 멈춘다.
  async migrateLegacyPlan(topic: BundleTopic): Promise<{ version: string | null; migrated: boolean }> {
    if (!topic.planSHA256) return { version: null, migrated: false };
    // 기동 이행은 토픽 행을 parse 하지 않는다 — 범위 세대를 직접 넘긴다(옛 상태로 저장된 행도 이 경로를 지난다).
    const snapshot = await this.artifacts.verifiedRevision(topic.id, "plan", topic.planSHA256, topic.scopeGeneration);
    if (!snapshot) throw new PlanBundleError(`현재 계획 버전 ${topic.planSHA256} 의 스냅샷이 없습니다.`);
    const files = await this.read(topic);
    if (files.length > 0) {
      if (planBundleVersion(files) === topic.planSHA256) return { version: topic.planSHA256, migrated: false };
      throw new PlanBundleError(`계획 폴더가 현재 계획(${topic.planSHA256})과 다른 내용을 담고 있어 이행하지 않았습니다: ${await this.directory(topic)}`);
    }
    await writeFile(join(await this.directory(topic), PLAN_FILE), snapshot.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { version: topic.planSHA256, migrated: true };
  }
}
