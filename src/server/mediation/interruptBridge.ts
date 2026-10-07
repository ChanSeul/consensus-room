import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { MediatorInterrupt, MediatorSession } from "../../shared/mediatorInterrupts.js";
import { interruptMessage, resolveCodexTransport, sendCodexInterrupt, type CodexTransport } from "./codexInterrupt.js";

type Delivery = { interrupt: MediatorInterrupt; claim: string };
type Route = { kind: "channel"; server: Server } | CodexTransport;
export function claudeChannelNotification(item: MediatorInterrupt) {
  return { method: "notifications/claude/channel" as const, params: { content: interruptMessage(item),
    meta: { interrupt_id: item.id, topic_id: item.topicId, source_role: item.sourceRole } } };
}
export async function runInterruptBridge(): Promise<void> {
  const provider = z.enum(["claude", "codex"]).parse(process.argv[2]);
  const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} 설정이 필요합니다.`); return value; };
  const base = new URL(required("CONSENSUS_ROOM_URL"));
  if (!(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) && base.protocol === "http:") || base.username || base.password || base.search || base.hash)
    throw new Error("CONSENSUS_ROOM_URL은 토큰 없는 localhost HTTP 주소여야 합니다.");
  const token = required("CONSENSUS_ROOM_TOKEN"), topicId = required("CONSENSUS_ROOM_TOPIC_ID");
  const identity = /^([A-Za-z0-9][A-Za-z0-9._:-]*)@([0-9]+)$/.exec(required("CONSENSUS_MEDIATOR"));
  if (!identity) throw new Error("CONSENSUS_MEDIATOR 형식: 참여자@배정버전");
  const session: MediatorSession = { provider, sessionId: required("CONSENSUS_MEDIATOR_SESSION_ID") };
  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());
  const headers = { "x-consensus-token": token, "x-consensus-actor": "mediator", "x-consensus-mediator": identity[1], "x-consensus-mediator-version": identity[2], "content-type": "application/json" };
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(new URL(`/api/${path}`, base), { headers, method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { code?: string };
      throw Object.assign(new Error(`중재 인터럽트 API ${response.status}`), { status: response.status, code: failure.code,
        fatal: [401, 403].includes(response.status) || Boolean(failure.code && /MEDIATOR/.test(failure.code)) });
    }
    return await response.json() as T;
  };
  let subscriptionTopicId = topicId, checkedAt = 0;
  const requestInterrupt = async <T>(item: MediatorInterrupt, operation: string, body: unknown): Promise<T> => {
    try { return await request<T>(`topics/${item.topicId}/interrupts/${item.id}/${operation}`, body); }
    catch (error) {
      const failure = error as { status?: number; code?: string };
      if (item.topicId !== subscriptionTopicId && failure.status === 409
        && ["STALE_MEDIATOR_ASSIGNMENT", "MEDIATOR_SESSION_MISMATCH"].includes(failure.code ?? "")) {
        // Do not retry the revoked child or adopt another identity. Only a still-authorized
        // parent subscription can continue receiving its other children.
        await request(`topics/${encodeURIComponent(subscriptionTopicId)}/interrupts/connection?${new URLSearchParams(session)}`);
        throw Object.assign(error as Error, { fatal: false, childReassigned: true });
      }
      throw error;
    }
  };
  const received = new Map<string, Delivery>();
  const wait = (ms: number) => new Promise<void>(resolve => {
    if (abort.signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms); abort.signal.addEventListener("abort", finish, { once: true });
  });
  const receipt = (delivery: Delivery, state: "sent" | "acknowledged" | "failed" | "unknown", error?: string, transportUnavailable = false) => requestInterrupt(
    delivery.interrupt, "receipt", { ...session, claim: delivery.claim, state, ...(error ? { error } : {}), transportUnavailable });
  let mcp: Server | null = null;
  if (provider === "claude") {
    mcp = new Server({ name: "consensus-room", version: "1.0.0" }, { capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: "Consensus Room의 현재 중재자에게 개입 요청을 전달합니다. 알림 ID를 확인하고 consensus_interrupt_ack로 수신을 확인하세요. resume의 현재 상태와 기존 권한을 기준으로 중재하며, 알림 자체를 재개 승인으로 취급하지 마세요." });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "consensus_interrupt_ack", description: "이미 받은 중재 개입 요청의 수신을 확인합니다. 작업 상태나 승인을 변경하지 않습니다.", inputSchema: { type: "object", properties: { interruptId: { type: "string" } }, required: ["interruptId"], additionalProperties: false } }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (params.name !== "consensus_interrupt_ack") throw new Error("알 수 없는 도구");
      const { interruptId } = z.object({ interruptId: z.string() }).strict().parse(params.arguments);
      const delivery = received.get(interruptId); if (!delivery) throw new Error("이 채널에서 전달한 현재 요청이 아닙니다.");
      await receipt(delivery, "acknowledged");
      return { content: [{ type: "text", text: "중재자 수신 확인을 기록했습니다." }] };
    });
    const initialized = new Promise<void>(resolve => { mcp!.oninitialized = resolve; });
    mcp.onclose = () => abort.abort();
    await mcp.connect(new StdioServerTransport()); await initialized;
  }
  const reportConnection = (error: string | null) => request(`topics/${encodeURIComponent(subscriptionTopicId)}/interrupts/connection`, { ...session, available: error === null, error });
  // The connection check is the one place that decides how this session is reached; delivery uses only its result.
  // When nothing reaches the session, each claimed request records the cause as a pre-send failure (no attempt spent).
  let route: Route | Error = new Error("중재 세션 연결을 아직 확인하지 않았습니다.");
  const deliver = async (target: Route, delivery: Delivery): Promise<void> => {
    if (target.kind !== "channel") return sendCodexInterrupt(target, session.sessionId, delivery.interrupt);
    received.set(delivery.interrupt.id, delivery);
    try { await target.server.notification(claudeChannelNotification(delivery.interrupt)); }
    catch { throw Object.assign(new Error("Claude 채널 전송 결과를 확인할 수 없습니다."), { uncertain: true }); }
  };
  try {
    while (!abort.signal.aborted) {
      try {
        if (Date.now() - checkedAt >= 30_000) {
          // The server resolves the assignment's scope; never adopt a different identity/version.
          const connection = await request<{ subscriptionTopicId: string }>(`topics/${encodeURIComponent(subscriptionTopicId)}/interrupts/connection?${new URLSearchParams(session)}`);
          subscriptionTopicId = connection.subscriptionTopicId;
          route = mcp ? { kind: "channel", server: mcp } : await resolveCodexTransport(session.sessionId, process.env.CONSENSUS_CODEX_SOCKET)
            .catch((failure: unknown) => failure instanceof Error ? failure : new Error("중재 세션 연결 실패"));
          await reportConnection(route instanceof Error ? route.message : null); checkedAt = Date.now();
        }
        const query = new URLSearchParams({ ...session, waitMs: "25000", descendants: "true" });
        const { items } = await request<{ items: MediatorInterrupt[] }>(`topics/${encodeURIComponent(subscriptionTopicId)}/interrupts?${query}`);
        for (const item of items) {
          if (abort.signal.aborted) break;
          let delivery: Delivery;
          try { delivery = await requestInterrupt<Delivery>(item, "claim", session); }
          catch (error) { if ((error as { status?: number }).status === 409 && !(error as { fatal?: boolean }).fatal) continue; throw error; }
          const failure: unknown = route instanceof Error ? Object.assign(new Error(route.message), { transportUnavailable: true })
            : await deliver(route, delivery).then(() => null, (error: unknown) => error);
          if (failure === null) {
            // A lost receipt never causes another send in this process. The server expires it to unknown.
            await receipt(delivery, "sent"); continue;
          }
          const { uncertain, transportUnavailable } = failure as { uncertain?: boolean; transportUnavailable?: boolean };
          const message: string = failure instanceof Error ? failure.message : "전송 실패";
          await receipt(delivery, uncertain ? "unknown" : "failed", message, transportUnavailable === true);
          if (transportUnavailable && !(route instanceof Error)) {
            // The resolved route stopped reaching the session: report it and decide the route again before the next claim.
            route = new Error(message); checkedAt = 0;
            await reportConnection(message); break;
          }
        }
      } catch (error) {
        if (abort.signal.aborted) break;
        if ((error as { fatal?: boolean }).fatal) throw error;
        if ((error as { childReassigned?: boolean }).childReassigned) continue;
        process.stderr.write("중재 인터럽트 연결을 확인하지 못했습니다. 5초 뒤 다시 연결합니다.\n");
        await wait(5000);
      }
    }
  } finally { await mcp?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInterruptBridge().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "인터럽트 연결 실패"}\n`); process.exitCode = 1; });
}
