import { ACTIVE_WORKFLOW_STATES } from "../shared/workflow.js";
import type { Topic } from "../shared/contracts.js";
import { isTopicGroup, workEntry } from "../shared/topicStructure.js";
import type { ConsensusDatabase } from "./database.js";

const conflict = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 409 }); };
export function assertTask(topic: Topic): void {
  if (isTopicGroup(topic)) conflict("Root·중간 주제는 목표와 진행률을 관리합니다. 계획·구현은 말단 실행 주제에서 시작하세요.");
}
export function assertEntryReady(db: ConsensusDatabase, topic: Topic): void {
  const entry = workEntry(topic);
  if (!entry.goal) conflict("중재 세션에서 Goal을 확정한 뒤 계획을 시작하세요.");
  if (entry.mode === "sources") {
    db.evidence.assertReady(topic, false);
    const evidence = db.evidence.topic(topic);
    if (!entry.sourceIds.length || entry.sourceIds.some(id => !evidence.sources.some(source => source.id === id)))
      conflict("시작 Source가 현재 근거에서 빠졌습니다. 원문 연결을 확인하세요.");
    if (entry.evidenceDigest !== evidence.digest) conflict("Goal의 근거가 바뀌었습니다. 현재 원문으로 Goal을 다시 확정하세요.");
  }
}
export function assertTopicParent(db: ConsensusDatabase, parentId: string | null | undefined): void {
  if (!parentId) return;
  const parent = db.getTopic(parentId);
  if (!isTopicGroup(parent)) conflict("하위 주제는 관리 주제(topicKind: group) 아래에 만들 수 있습니다.");
  if (parent.state !== "DRAFT" || db.runningAction(parent.id)) conflict("부모 주제의 논의와 Goal 확정을 먼저 마쳐 주세요.");
  assertEntryReady(db, parent);
}
export function hierarchyContext(db: ConsensusDatabase, topic: Topic): string {
  const parents: Topic[] = [];
  let id = topic.parentTopicId;
  const seen = new Set([topic.id]);
  while (id) {
    if (seen.has(id)) conflict("주제 계층에 순환이 있습니다.");
    seen.add(id);
    const parent = db.getTopic(id); parents.unshift(parent); id = parent.parentTopicId;
  }
  const context = parents.map((parent, index) => `${index === 0 ? "Root" : `Sub ${index}`}: ${parent.title}\nGoal: ${workEntry(parent).goal ?? "미정"}`).join("\n\n");
  return [context && `큰 그림과 상위 목표(이 주제의 구현 범위를 넓히는 지시가 아닙니다):\n${context}`,
    `현재 말단 주제의 Goal:\n${workEntry(topic).goal ?? topic.title}`].filter(Boolean).join("\n\n");
}

// 기존의 독립 실행 주제를 사용자가 지정한 큰 그림에 처음 연결한다.
// 기존 부모 이동, 관리 주제 입양, 작업 중인 주제 변경은 허용하지 않는다.
export function adoptTopics(db: ConsensusDatabase, parentId: string, topicIds: string[], workGroupIds: string[], assertIdle: (id: string) => void): Topic[] {
  let adoptedTopicIds: string[] = [], attachedGroups = false;
  const result = db.workGroups.atomic(() => {
    assertTopicParent(db, parentId);
    assertIdle(parentId);
    const parent = db.getTopic(parentId);
    const groups = workGroupIds.map(id => db.workGroups.get(id));
    for (const group of groups) {
      if (group.repositoryPath !== parent.repositoryPath || (group.parentTopicId && group.parentTopicId !== parentId))
        conflict("작업 묶음의 저장소 또는 기존 부모가 다릅니다.");
      if (Object.keys(group.pending ?? {}).length) conflict("준비 중인 단계가 있어 계층을 변경할 수 없습니다.");
    }
    const ids = [...new Set([...topicIds, ...groups.flatMap(group => Object.values(group.links).map(link => link.topicId))])];
    const topics = ids.map(id => db.getTopic(id));
    for (const topic of topics) {
      if (isTopicGroup(topic) || topic.repositoryPath !== parent.repositoryPath || (topic.parentTopicId && topic.parentTopicId !== parentId))
        conflict("같은 저장소의 부모 없는 실행 주제만 연결할 수 있습니다.");
      if (ACTIVE_WORKFLOW_STATES.has(topic.state)) conflict("실행 중인 주제는 계층에 연결할 수 없습니다.");
      assertIdle(topic.id);
      const group = db.workGroups.forTopic(topic.id);
      if (group && !workGroupIds.includes(group.id)) conflict("단계 주제는 작업 묶음 전체를 함께 연결해야 합니다.");
    }
    for (const group of groups) db.workGroups.attachParent(group.id, parentId);
    const changed = topics.filter(topic => !topic.parentTopicId);
    for (const topic of changed) db.updateTopic(topic.id, { parentTopicId: parentId });
    adoptedTopicIds = changed.map(topic => topic.id);
    attachedGroups = groups.some(group => !group.parentTopicId);
    return ids.map(id => db.getTopic(id));
  });
  if (adoptedTopicIds.length || attachedGroups) db.appendEvent({ topicId: parentId, actor: "user", kind: "note", state: db.getTopic(parentId).state,
    body: "기존 하위 작업을 큰 그림에 연결했습니다. 계획·승인·완료 결과는 그대로 보존합니다.",
    payload: { adoptedTopicIds, workGroupIds } });
  return result;
}
