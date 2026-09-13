import { useEffect, useState, type FormEvent } from "react";
import type { WorkGroup, WorkGroupInput } from "../shared/workGroups";
import type { BudgetAccount } from "../shared/budgets";
import { BudgetPanel } from "./BudgetPanel";
import { api } from "./api";

type GroupView = WorkGroup & {
  budget: BudgetAccount | null;
  stageStates: Record<string, string | null>;
};
export function WorkGroupsPanel({
  onTopic,
}: {
  onTopic: (id: string) => void;
}) {
  const [groups, setGroups] = useState<GroupView[]>([]),
    [open, setOpen] = useState(false),
    [count, setCount] = useState(2);
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
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget),
      text = (name: string) => String(f.get(name) ?? "");
    const vector = {
      inputTokens: Number(f.get("input")),
      outputTokens: Number(f.get("output")),
      durationMs: Number(f.get("minutes")) * 60000,
    };
    const total = {
      inputTokens: Number(f.get("totalInput")),
      outputTokens: Number(f.get("totalOutput")),
      durationMs: Number(f.get("totalMinutes")) * 60000,
    };
    const input: WorkGroupInput = {
      title: text("title"),
      goal: text("goal"),
      contracts: text("contracts"),
      stages: Array.from({ length: count }, (_, i) => ({
        id: `stage-${i + 1}`,
        kind: i === count - 1 ? "integration" : "work",
        title: text(`title${i}`),
        goal: text(`goal${i}`),
        acceptance: text(`acceptance${i}`),
        dependsOn: i ? [`stage-${i}`] : [],
        budget: { execution: vector, total },
      })),
    };
    void perform(async () => {
      await api.createWorkGroup(input);
      setOpen(false);
    });
  };
  return (
    <section className="work-groups" aria-label="단계별 작업">
      <button onClick={() => setOpen(!open)}>긴 작업을 단계로 나누기</button>
      {error && <p role="alert">{error}</p>}
      {open && (
        <form onSubmit={create}>
          <p>
            각 단계의 계획을 승인한 뒤 구현합니다. 마지막 단계는 전체 통합
            검증입니다.
          </p>
          <label>
            작업 이름
            <input name="title" required />
          </label>
          <label>
            전체 목표
            <textarea name="goal" required />
          </label>
          <label>
            모든 단계가 지킬 계약
            <textarea name="contracts" required />
          </label>
          <label>
            단계 수
            <input
              type="number"
              min="2"
              max="20"
              value={count}
              onChange={(e) =>
                setCount(Math.max(2, Math.min(20, Number(e.target.value))))
              }
            />
          </label>
          {Array.from({ length: count }, (_, i) => (
            <fieldset key={i}>
              <legend>
                {i + 1}단계{i === count - 1 ? " · 전체 통합 검증" : ""}
              </legend>
              <label>
                이름
                <input
                  name={`title${i}`}
                  required
                  defaultValue={i === count - 1 ? "전체 통합 검증" : ""}
                />
              </label>
              <label>
                목표
                <textarea name={`goal${i}`} required />
              </label>
              <label>
                완료 조건
                <textarea name={`acceptance${i}`} required />
              </label>
            </fieldset>
          ))}
          <fieldset>
            <legend>각 단계의 예산</legend>
            <p>
              실행당 상한과 단계 누적 상한을 각각 입력하세요. 작업 묶음에는 단계
              누적 상한의 합계가 적용됩니다.
            </p>
            {[
              ["input", "실행당 입력 토큰"],
              ["output", "실행당 출력 토큰"],
              ["minutes", "실행당 시간(분)"],
              ["totalInput", "단계 누적 입력 토큰"],
              ["totalOutput", "단계 누적 출력 토큰"],
              ["totalMinutes", "단계 누적 시간(분)"],
            ].map(([name, label]) => (
              <label key={name}>
                {label}
                <input name={name} type="number" min="1" step="1" required />
              </label>
            ))}
          </fieldset>
          <button disabled={busy}>작업 묶음 만들기</button>
        </form>
      )}
      {groups.map((group) => (
        <details key={group.id}>
          <summary>
            {group.title} · {Object.keys(group.links).length}/
            {group.stages.length}단계 연결
          </summary>
          <p>{group.goal}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void perform(() =>
                api.reviseWorkGroup(
                  group.id,
                  {
                    title: group.title,
                    goal: group.goal,
                    contracts: String(data.get("contracts")),
                    stages: group.stages,
                  },
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
          <ol>
            {group.stages.map((stage) => (
              <li key={stage.id}>
                {stage.title} ·{" "}
                {group.stageStates[stage.id] === "CLOSED"
                  ? "완료"
                  : group.links[stage.id]
                    ? "진행 중"
                    : "대기"}{" "}
                {group.links[stage.id] && (
                  <button
                    onClick={() => onTopic(group.links[stage.id].topicId)}
                  >
                    토픽 열기
                  </button>
                )}
              </li>
            ))}
          </ol>
          <button
            disabled={
              busy || Object.keys(group.links).length === group.stages.length
            }
            onClick={() =>
              void perform(async () => {
                const topic = await api.nextWorkStage(group.id);
                onTopic(topic.id);
              })
            }
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
      ))}
    </section>
  );
}
