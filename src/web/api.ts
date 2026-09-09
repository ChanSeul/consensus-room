import type {
  ActionResponse,
  AttachParticipantInput,
  ClientConfig,
  CreateTopicInput,
  MediationAutonomy,
  PostMessageInput,
  Topic,
  TopicActivity,
  TopicDetail,
  UpdateAgentSettingsInput,
  UpdateMediationAutonomyInput,
} from "../shared/contracts";

const API_ROOT = "/api";

export class ApiError extends Error {
  readonly status: number;
  readonly detail?: unknown;

  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

// 매 호출 새 키를 만들면 서버 중복 검사가 재시도를 걸러 낼 수 없다. 응답을 받지 못한 요청의 키만 남겨 두고,
// 서버가 결과를 알려 준 요청의 키는 버려서 다음 조작이 새 키를 쓰게 한다.
const unresolvedKeys = new Map<string, string>();

function idempotencyKeyFor(identity: string): string {
  const pending = unresolvedKeys.get(identity);
  if (pending) return pending;
  const key = crypto.randomUUID();
  unresolvedKeys.set(identity, key);
  return key;
}

// 같은 키를 붙잡아 둬야 하는 경우는 하나다 — 서버가 "그 요청이 아직 처리 중"이라고 답할 때.
// 결과가 이미 확정된 409(실패로 닫힌 요청, 중복 action 거부)에서도 키를 붙잡으면 다음 클릭이 과거 요청의
// 오류로 죽고 그 다음 클릭부터 동작하게 된다. 그런 409는 키를 놓아 새 요청으로 진행시킨다.
function resolvesKey(status: number, payload: unknown): boolean {
  if (status !== 409) return true;
  return !(payload && typeof payload === "object" && "status" in payload && payload.status === "running");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const identity = init?.method && init.method !== "GET"
    ? `${init.method} ${path} ${typeof init.body === "string" ? init.body : ""}`
    : null;
  if (identity && !headers.has("idempotency-key")) {
    headers.set("idempotency-key", idempotencyKeyFor(identity));
  }

  // fetch가 던지면 서버가 실행했는지 알 수 없으므로 키를 남긴 채로 실패를 올린다.
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (identity && resolvesKey(response.status, payload)) unresolvedKeys.delete(identity);

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String(payload.message)
        : payload && typeof payload === "object" && "error" in payload
          ? String(payload.error)
        : typeof payload === "string" && payload
          ? payload
          : `요청을 처리하지 못했습니다. (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }

  return payload as T;
}

function unwrapTopics(payload: Topic[] | { topics: Topic[] }): Topic[] {
  return Array.isArray(payload) ? payload : payload.topics;
}

export const api = {
  getConfig(): Promise<ClientConfig> {
    return request<ClientConfig>("/config");
  },

  getMediationAutonomy(): Promise<MediationAutonomy> {
    return request<MediationAutonomy>("/mediation-autonomy");
  },

  setMediationAutonomy(input: UpdateMediationAutonomyInput): Promise<MediationAutonomy> {
    return request<MediationAutonomy>("/mediation-autonomy", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  async listTopics(): Promise<Topic[]> {
    return unwrapTopics(await request<Topic[] | { topics: Topic[] }>("/topics"));
  },

  getTopic(topicId: string, afterSequence = 0): Promise<TopicDetail> {
    const suffix = afterSequence > 0 ? `?after=${afterSequence}` : "";
    return request<TopicDetail>(`/topics/${encodeURIComponent(topicId)}${suffix}`);
  },

  getActivity(topicId: string): Promise<TopicActivity> {
    return request<TopicActivity>(`/topics/${encodeURIComponent(topicId)}/activity`);
  },

  createTopic(input: CreateTopicInput): Promise<Topic> {
    return request<Topic>("/topics", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  attachParticipant(
    topicId: string,
    role: "claude" | "codex",
    input: AttachParticipantInput,
  ): Promise<Topic> {
    return request<Topic>(
      `/topics/${encodeURIComponent(topicId)}/participants/${role}`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },

  updateAgentSettings(
    topicId: string,
    role: "claude" | "codex",
    input: UpdateAgentSettingsInput,
  ): Promise<Topic> {
    return request<Topic>(
      `/topics/${encodeURIComponent(topicId)}/participants/${role}/settings`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },

  postMessage(topicId: string, input: PostMessageInput): Promise<ActionResponse> {
    return request<ActionResponse>(`/topics/${encodeURIComponent(topicId)}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  runAction(
    topicId: string,
    action: string,
    body: Record<string, unknown> = {},
  ): Promise<ActionResponse> {
    return request<ActionResponse>(
      `/topics/${encodeURIComponent(topicId)}/actions/${encodeURIComponent(action)}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
};

export function topicEventsUrl(topicId: string, afterSequence = 0): string {
  return `${API_ROOT}/topics/${encodeURIComponent(topicId)}/events?after=${afterSequence}`;
}
