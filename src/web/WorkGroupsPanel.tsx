import { useEffect, useState } from "react";
import type { WorkGroupInput, WorkGroupView } from "../shared/workGroups";
import { hasBudgetLimits, OBSERVE_USAGE } from "../shared/budgets";
import { BudgetPanel } from "./BudgetPanel";
import { api } from "./api";

// 저장된 묶음을 개정 입력으로 되돌린다 — 질문·묶음 예산을 빠뜨리면 기존 질문 삭제로 거부되거나 입력이 달라져 재적용이 성립하지 않는다.
const inputOf = (
  group: WorkGroupView,
  contracts: string = group.contracts,
): WorkGroupInput => ({
  title: group.title,
  goal: group.goal,
  contracts,
  stages: group.stages,
  ...(group.budgetPolicy ? { budgetPolicy: group.budgetPolicy } : {}),
  ...(group.questions ? { questions: group.questions } : {}),
});
// 미착수 단계 하나의 완료 조건·단계 예산만 바꾼 개정 입력(host-review F010) — 나머지는 저장된 입력 그대로 다시 보낸다(기존 revise API).
const withStagePlan = (
  group: WorkGroupView,
  stageId: string,
  data: FormData,
): WorkGroupInput => {
  const number = (name: string) => Number(data.get(name));
  const budget = BUDGET_FIELDS.every(([name]) => !String(data.get(name) ?? "").trim()) ? OBSERVE_USAGE : {
    execution: {
      inputTokens: number("input"),
      outputTokens: number("output"),
      durationMs: number("minutes") * 60000,
    },
    total: {
      inputTokens: number("totalInput"),
      outputTokens: number("totalOutput"),
      durationMs: number("totalMinutes") * 60000,
    },
  };
  const input = inputOf(group);
  return {
    ...input,
    stages: input.stages.map((stage) =>
      stage.id === stageId
        ? {
            ...stage,
            acceptance: String(data.get("acceptance") ?? "").trim(),
            budget,
          }
        : stage,
    ),
  };
};
const BUDGET_FIELDS = [
  ["input", "실행당 입력 토큰"],
  ["output", "실행당 출력 토큰"],
  ["minutes", "실행당 시간(분)"],
  ["totalInput", "단계 누적 입력 토큰"],
  ["totalOutput", "단계 누적 출력 토큰"],
  ["totalMinutes", "단계 누적 시간(분)"],
] as const;
const MINUTE_FIELDS = new Set<string>(["minutes", "totalMinutes"]);
const budgetDefault = (
  budget: WorkGroupView["stages"][number]["budget"],
  name: (typeof BUDGET_FIELDS)[number][0],
) => {
  if (!budget || !hasBudgetLimits(budget)) return undefined;
  return {
    input: budget.execution.inputTokens,
    output: budget.execution.outputTokens,
    minutes: budget.execution.durationMs / 60000,
    totalInput: budget.total.inputTokens,
    totalOutput: budget.total.outputTokens,
    totalMinutes: budget.total.durationMs / 60000,
  }[name];
};
const short = (oid: string | null | undefined) => (oid ? oid.slice(0, 7) : null);
const stageStatus = (state: string | null | undefined) =>
  state === "CLOSED"
    ? "완료"
    : state === "USER_DECISION_REQUIRED"
      ? "결정 대기"
      : state === "BLOCKED_ON_EVIDENCE"
        ? "외부 근거 대기"
        : state
          ? "진행 중"
          : "대기";

export function WorkGroupsPanel({
  onTopic,
  topicIds,
}: {
  onTopic: (id: string) => void;
  topicIds?: readonly string[];
}) {
  const [groups, setGroups] = useState<WorkGroupView[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const refresh = async () => setGroups(await api.listWorkGroups());
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .listWorkGroups()
        .then((groups) => {
          if (!cancelled) setGroups(groups);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  const perform = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const openStage = (groupId: string, stageId?: string) =>
    void perform(async () => {
      const topic = await api.nextWorkStage(groupId, stageId);
      onTopic(topic.id);
    });
  const visibleGroups = topicIds ? groups.filter(group => (group.parentTopicId && topicIds.includes(group.parentTopicId)) || Object.values(group.links).some(link => topicIds.includes(link.topicId))) : groups;
  if (visibleGroups.length === 0 && !error) return null;
  return (
    <section className="work-groups" aria-label="단계별 작업">
      {error && <p role="alert">{error}</p>}
      {visibleGroups.map((group) => {
        const integration = group.stages.at(-1)!;
        const verified = group.stageStates[integration.id] === "CLOSED";
        const questions = (group.questions ?? []).filter(
          (question) => !question.resolution,
        );
        const title = (stageId: string) =>
          group.stages.find((stage) => stage.id === stageId)?.title ?? stageId;
        return (
          <details key={group.id}>
            <summary>
              {group.title} · {Object.keys(group.links).length}/
              {group.stages.length}단계 연결
              {group.delivered
                ? " · 묶음 전달 완료"
                : verified
                  ? " · 통합 검증 완료(전달 전)"
                  : ""}
            </summary>
            <p>{group.goal}</p>
            {group.replanPending.length > 0 && (
              <p role="status">
                재계획 대기: {group.replanPending.map(title).join(", ")} — 개정은
                저장됐지만 이 단계들의 재계획 전환이 끝나지 않아 진행을
                막았습니다.{" "}
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(() =>
                      api.reviseWorkGroup(
                        group.id,
                        inputOf(group),
                        group.version,
                      ),
                    )
                  }
                >
                  개정 다시 적용
                </button>
              </p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void perform(() =>
                  api.reviseWorkGroup(
                    group.id,
                    inputOf(group, String(data.get("contracts"))),
                    group.version,
                  ),
                );
              }}
            >
              <label>
                공통 계약
                <textarea
                  name="contracts"
                  required
                  defaultValue={group.contracts}
                />
              </label>
              <button disabled={busy}>계약 변경 · 미완료 단계 재계획</button>
            </form>
            {questions.length > 0 && (
              <>
                <p>미정 질문</p>
                <ul>
                  {questions.map((question) => (
                    <li key={question.id}>
                      {question.stageId ? title(question.stageId) : "묶음 전체"}{" "}
                      · {question.text}
                      {question.blocksStart ? " · 착수 차단" : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <ol>
              {group.stages.map((stage) => {
                const link = group.links[stage.id],
                  state = group.stageStates[stage.id],
                  delivery = group.delivery[stage.id];
                return (
                  <li key={stage.id}>
                    {stage.title} · {stageStatus(state)}
                    {!stage.acceptance
                      ? " · 대략 단계(완료 조건 미정)"
                      : ""}
                    {group.readyStages.includes(stage.id) ? " · 준비됨" : ""}
                    {group.replanPending.includes(stage.id)
                      ? " · 재계획 대기"
                      : ""}
                    {delivery &&
                      ` · 커밋 ${short(delivery.committedOID) ?? "없음"} · 푸시 ${short(delivery.pushedOID) ?? "전"}`}{" "}
                    {link && (
                      <button onClick={() => onTopic(link.topicId)}>
                        토픽 열기
                      </button>
                    )}
                    {/* 닫힌 단계의 결과 커밋을 아직 push 하지 않았으면 여기서 전달한다 — 허용 여부는 서버 push 가 판정한다(host-review F002). */}
                    {link &&
                      state === "CLOSED" &&
                      delivery?.committedOID &&
                      delivery.pushedOID !== delivery.committedOID && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void perform(() =>
                              api.runAction(link.topicId, "push"),
                            )
                          }
                        >
                          닫힌 단계 푸시
                        </button>
                      )}
                    {/* 미착수 단계는 완료 조건·단계 예산을 정해 준비할 수 있다(host-review F010). 연결된 단계는 개정 규칙이 막으므로 두지 않는다. */}
                    {!link && (
                      <details>
                        <summary>완료 조건·예산 정하기</summary>
                        <form
                          key={group.version}
                          aria-label={`${stage.title} 준비`}
                          onSubmit={(event) => {
                            event.preventDefault();
                            const data = new FormData(event.currentTarget);
                            void perform(() =>
                              api.reviseWorkGroup(
                                group.id,
                                withStagePlan(group, stage.id, data),
                                group.version,
                              ),
                            );
                          }}
                        >
                          <label>
                            완료 조건
                            <textarea
                              name="acceptance"
                              required
                              defaultValue={stage.acceptance ?? ""}
                            />
                          </label>
                          {BUDGET_FIELDS.map(([name, label]) => (
                            <label key={name}>
                              {label}
                              {/* 시간은 API 로 만든 예산(밀리초)이 분 단위로 나누어떨어지지 않을 수 있어 소수를 받는다 — 범위 검사는 서버 스키마가 한다. */}
                              <input
                                name={name}
                                type="number"
                                min={MINUTE_FIELDS.has(name) ? undefined : "1"}
                                step={MINUTE_FIELDS.has(name) ? "any" : "1"}
                                defaultValue={budgetDefault(stage.budget, name)}
                              />
                            </label>
                          ))}
                          <button disabled={busy}>단계 준비 저장</button>
                        </form>
                      </details>
                    )}
                    {link &&
                      state !== "CLOSED" &&
                      group.selectableStages.length > 0 && (
                        <p>
                          이 단계가 외부 결정을 기다리는 동안 먼저 열 수 있는
                          단계:{" "}
                          {group.selectableStages.map((stageId) => (
                            <button
                              key={stageId}
                              disabled={busy}
                              onClick={() => openStage(group.id, stageId)}
                            >
                              {title(stageId)} 골라 열기
                            </button>
                          ))}
                        </p>
                      )}
                  </li>
                );
              })}
            </ol>
            <button
              disabled={
                busy || Object.keys(group.links).length === group.stages.length
              }
              onClick={() => openStage(group.id)}
            >
              다음 단계 열기
            </button>
            <BudgetPanel
              account={group.budget}
              busy={busy}
              onSubmit={(_action, body) =>
                void perform(async () => {
                  const result = await api.grantWorkGroup(group.id, body);
                  if (result.resumeBlocked) setError(result.resumeBlocked);
                  if (result.resumedTopicId) onTopic(result.resumedTopicId);
                })
              }
            />
          </details>
        );
      })}
    </section>
  );
}
