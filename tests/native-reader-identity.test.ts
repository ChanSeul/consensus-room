import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ call: vi.fn(), close: vi.fn(async () => {}), closed: false }));
// Every auth.json the reader opens is recorded; one outside the temporary fixtures is refused without being read, so a
// default path that still points at the user's real Codex home fails the test instead of reading that account.
const authReads = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  const { tmpdir: temporary } = await import("node:os");
  return { ...fs, readFile: (async (path: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
    if (String(path).endsWith("auth.json")) {
      authReads.push(String(path));
      if (!String(path).startsWith(temporary())) throw Object.assign(Error(`test refused auth outside fixtures: ${String(path)}`), { code: "EACCES" });
    }
    return (fs.readFile as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFile };
});
vi.mock("../src/server/adapters/nativeApps", async original =>
  ({ ...await original<typeof import("../src/server/adapters/nativeApps")>(), nativeApps: vi.fn(async () => transport) }));
import { AppCallTimeout, AppConnectionReset, nativeApps } from "../src/server/adapters/nativeApps";
import { NativeAppReader } from "../src/server/evidence/nativeReader";
function pending() {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, fail) => { reject = fail; }); promise.catch(() => {});
  return { promise, reject };
}
function latch<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(done => done()); vi.clearAllMocks(); vi.unstubAllEnvs(); authReads.length = 0; transport.closed = false; transport.call.mockReset(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "identity-")), authPath = join(directory, "auth.json");
  writeFileSync(authPath, '{"fixture":"first"}');
  const config = (value: unknown) => writeFileSync(join(directory, "evidence-apps.json"), JSON.stringify(value));
  config({ googleDriveLinkId: "link_work", accountIds: { slack: "U123" } });
  const metric = vi.fn(), onCall = vi.fn();
  const reader = new NativeAppReader(directory, authPath, metric);
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return { reader, config, authPath, metric, onCall, signal: new AbortController().signal };
}
// Identity API -> validated page identity. Cursor/snapshot consumers must reject generation changes; no paid model calls.
it("coalesces pending identities but verifies pinned accounts again on the next page", async () => {
  const f = fixture(), started = latch<void>(), held = latch<unknown>();
  transport.call.mockImplementation(async () => { started.resolve(); return held.promise; });
  const first = f.reader.identity("slack", f.signal, f.onCall);
  await started.promise;
  const second = f.reader.identity("slack", f.signal, f.onCall);
  // config/auth IO completion is observable via the identity reuse metric, not a sleep.
  const reused = latch<void>(); f.metric.mockImplementation((_p, name) => { if (name === "identityReuse") reused.resolve(); });
  try {
    await reused.promise; held.resolve({ user: { id: "U123" } });
    expect((await first).account).toBe("U123"); expect((await second).account).toBe("U123");
    expect(transport.call).toHaveBeenCalledTimes(1); expect(f.onCall).toHaveBeenCalledTimes(1);
    await f.reader.identity("slack", f.signal, f.onCall);
    expect(transport.call).toHaveBeenCalledTimes(2);
  } finally { held.resolve({ user: { id: "U123" } }); await f.reader.close(); }
});
it("reuses explicit sheets binding and rejects auth/config changes before publication", async () => {
  const f = fixture();
  try {
    const first = await f.reader.identity("sheets", f.signal, f.onCall);
    expect(await f.reader.identity("sheets", f.signal, f.onCall)).toBe(first);
    expect(transport.call).not.toHaveBeenCalled();
    f.config({ googleDriveLinkId: "link_other" });
    await expect(f.reader.validateIdentity("sheets", first, f.signal)).rejects.toThrow("계정이 바뀌었습니다");
    const next = await f.reader.identity("sheets", f.signal, f.onCall);
    expect(next.account).toBe("link_other");
    writeFileSync(f.authPath, '{"fixture":"second"}');
    await expect(f.reader.validateIdentity("sheets", next, f.signal)).rejects.toThrow("계정이 바뀌었습니다");
    expect(f.metric).toHaveBeenCalledWith("sheets", "identityInvalidations", 1);
  } finally { await f.reader.close(); }
});
it("rejects a late read after configuration changes and invalidates its collection identity", async () => {
  const f = fixture(), started = latch<void>(), held = latch<unknown>();
  transport.call.mockResolvedValueOnce({ user: { id: "U123" } });
  const identity = await f.reader.identity("slack", f.signal, f.onCall);
  transport.call.mockImplementationOnce(async () => { started.resolve(); return held.promise; });
  const read = f.reader.call("slack", "slack.slack_read_channel", {}, f.signal);
  try {
    await started.promise; f.config({ accountIds: { slack: "U456" } }); held.resolve({ messages: [] });
    await expect(read).rejects.toThrow("계정이 바뀌었습니다");
    await expect(f.reader.validateIdentity("slack", identity, f.signal)).rejects.toThrow("계정이 바뀌었습니다");
  } finally { held.resolve({ messages: [] }); await f.reader.close(); }
});
// One read's failure -> the other reads of that provider. Only a lost connection or an account problem invalidates the
// identity they verified (2026-10-15: a timed-out Jira read failed another root as "수집 중 연결 계정이 바뀌었습니다").
it("keeps the shared connection and other reads' identity when one read fails, is refused or is cancelled", async () => {
  // (A timeout replaces the connection but keeps the identity: the next test.)
  const f = fixture();
  transport.call.mockResolvedValueOnce({ user: { id: "U123" } });
  const identity = await f.reader.identity("slack", f.signal, f.onCall);
  try {
    transport.call.mockRejectedValueOnce(Error("공식 앱 연결을 확인하세요."));
    await expect(f.reader.call("slack", "slack.slack_read_channel", {}, f.signal)).rejects.toThrow("공식 앱 연결");
    transport.call.mockResolvedValueOnce({ isError: true });
    await expect(f.reader.call("slack", "slack.slack_read_channel", {}, f.signal)).rejects.toThrow("MCP 원문 조회 실패");
    const cancel = new AbortController(), started = latch<void>(), held = latch<unknown>();
    transport.call.mockImplementationOnce(async () => { started.resolve(); return held.promise; });
    const cancelled = f.reader.call("slack", "slack.slack_read_channel", {}, cancel.signal);
    await started.promise; cancel.abort(); held.resolve({ messages: [] });
    await expect(cancelled).rejects.toThrow();
    // A failed identity read of the same provider is that read's failure too.
    transport.call.mockRejectedValueOnce(Error("공식 앱 연결을 확인하세요."));
    await expect(f.reader.identity("slack", f.signal, f.onCall)).rejects.toThrow("공식 앱 연결");
    await expect(f.reader.validateIdentity("slack", identity, f.signal)).resolves.toBeUndefined();
    expect(f.metric).not.toHaveBeenCalledWith("slack", "identityInvalidations", 1);
    expect(transport.close).not.toHaveBeenCalled();
    transport.call.mockResolvedValueOnce({ messages: [] });
    await expect(f.reader.call("slack", "slack.slack_read_channel", {}, f.signal)).resolves.toEqual({ messages: [] });
    expect(nativeApps).toHaveBeenCalledTimes(1);
  } finally { await f.reader.close(); }
});
it("replaces an ended connection and invalidates the identity verified through it", async () => {
  const f = fixture();
  transport.call.mockResolvedValueOnce({ user: { id: "U123" } });
  const identity = await f.reader.identity("slack", f.signal, f.onCall);
  try {
    transport.call.mockImplementationOnce(async () => { transport.closed = true; throw Error("앱 연결이 종료됐습니다(exit 1)."); });
    await expect(f.reader.call("slack", "slack.slack_read_channel", {}, f.signal)).rejects.toThrow("종료");
    await expect(f.reader.validateIdentity("slack", identity, f.signal)).rejects.toThrow("계정이 바뀌었습니다");
    expect(transport.close).toHaveBeenCalledTimes(1);
    transport.closed = false; transport.call.mockResolvedValueOnce({ messages: [] });
    await f.reader.call("slack", "slack.slack_read_channel", {}, f.signal);
    expect(nativeApps).toHaveBeenCalledTimes(2);
  } finally { await f.reader.close(); }
});
it("invalidates when the connection cannot open or the account differs from the pinned one", async () => {
  const f = fixture();
  try {
    vi.mocked(nativeApps).mockRejectedValueOnce(Error("공식 앱이 연결되지 않았습니다."));
    await expect(f.reader.identity("slack", f.signal, f.onCall)).rejects.toThrow("연결되지 않았습니다");
    expect(f.metric).toHaveBeenCalledWith("slack", "identityInvalidations", 1);
    f.metric.mockClear();
    transport.call.mockResolvedValueOnce({ user: { id: "U999" } });
    await expect(f.reader.identity("slack", f.signal, f.onCall)).rejects.toThrow("설정된 계정과 MCP 연결 계정이 다릅니다");
    expect(f.metric).toHaveBeenCalledWith("slack", "identityInvalidations", 1);
  } finally { await f.reader.close(); }
});
it("replaces a connection after a timeout without touching the identity, and late failures of it change nothing", async () => {
  const f = fixture();
  // Two connections in turn: the first stops answering, the second is the one the next call opens.
  const connection = () => {
    const value = { call: vi.fn(), closed: false, close: vi.fn(async (_reason?: Error) => { value.closed = true; }) };
    return value;
  };
  const first = connection(), second = connection();
  vi.mocked(nativeApps).mockResolvedValueOnce(first as never).mockResolvedValueOnce(second as never);
  first.call.mockResolvedValueOnce({ user: { id: "U123" } });
  const identity = await f.reader.identity("slack", f.signal, f.onCall);
  // Two reads still wait on the first connection when another of its requests times out.
  const together = pending(), late = pending();
  // The reads start concurrently, so each answer is keyed by its own argument rather than by call order.
  first.call.mockImplementation(async (_name: string, args: { read?: string }) => {
    if (args.read === "together") return together.promise;
    if (args.read === "late") return late.promise;
    throw new AppCallTimeout("앱 연결 응답 시간이 지났습니다.");
  });
  const stopped = f.reader.call("slack", "slack.slack_read_channel", { read: "together" }, f.signal);
  const lateRead = f.reader.call("slack", "slack.slack_read_thread", { read: "late" }, f.signal);
  try {
    await vi.waitFor(() => expect(first.call).toHaveBeenCalledTimes(3));
    await expect(f.reader.call("slack", "slack.slack_read_channel", { read: "stuck" }, f.signal)).rejects.toBeInstanceOf(AppCallTimeout);
    expect(first.close).toHaveBeenCalledTimes(1);
    const reason = first.close.mock.calls[0][0] as Error;
    expect(reason).toBeInstanceOf(AppConnectionReset); expect(reason.message).toContain("응답 시간 초과로 연결을 재설정");
    // The failed call is not retried; the next call opens the second connection, and the identity stays valid.
    expect(first.call).toHaveBeenCalledTimes(4);
    second.call.mockResolvedValueOnce({ messages: [] });
    await expect(f.reader.call("slack", "slack.slack_read_channel", {}, f.signal)).resolves.toEqual({ messages: [] });
    expect(nativeApps).toHaveBeenCalledTimes(2);
    await expect(f.reader.validateIdentity("slack", identity, f.signal)).resolves.toBeUndefined();
    // Failures of the old connection arriving now — one stopped by the reset (nativeApps rejects waiting requests with
    // its reason), one ending on its own — leave the new connection and the identity alone.
    together.reject(reason); late.reject(Error("앱 연결이 종료됐습니다(exit 1)."));
    await expect(stopped).rejects.toThrow("재설정"); await expect(lateRead).rejects.toThrow("종료");
    expect(second.close).not.toHaveBeenCalled();
    expect(f.metric).not.toHaveBeenCalledWith("slack", "identityInvalidations", 1);
    await expect(f.reader.validateIdentity("slack", identity, f.signal)).resolves.toBeUndefined();
    second.call.mockResolvedValueOnce({ messages: [] });
    await f.reader.call("slack", "slack.slack_read_channel", {}, f.signal);
    expect(nativeApps).toHaveBeenCalledTimes(2);
  } finally { together.reject(Error("end")); late.reject(Error("end")); await f.reader.close(); }
});
// Default auth path -> the Codex home the Codex adapter uses (CODEX_HOME, else ~/.codex). The reader hashes that file for
// its identity generation and hands the same path to the app-server connection.
function codexHome(content: string) {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  writeFileSync(join(home, "auth.json"), content);
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
it("reads auth.json from CODEX_HOME when no auth path is given, and an auth change there invalidates the identity", async () => {
  const f = fixture(), home = codexHome('{"fixture":"codex-home"}');
  vi.stubEnv("CODEX_HOME", home);
  const reader = new NativeAppReader(join(f.authPath, ".."), undefined, f.metric);
  transport.call.mockResolvedValueOnce({ user: { id: "U123" } });
  try {
    const identity = await reader.identity("slack", f.signal, f.onCall);
    expect(identity.account).toBe("U123");
    expect(vi.mocked(nativeApps).mock.calls[0][1]).toBe(join(home, "auth.json"));
    expect(authReads.every(path => path === join(home, "auth.json"))).toBe(true);
    writeFileSync(join(home, "auth.json"), '{"fixture":"codex-home-2"}');
    await expect(reader.validateIdentity("slack", identity, f.signal)).rejects.toThrow("계정이 바뀌었습니다");
  } finally { await reader.close(); }
});
it("falls back to ~/.codex/auth.json without CODEX_HOME, and an explicit auth path wins over CODEX_HOME", async () => {
  const f = fixture();
  vi.stubEnv("CODEX_HOME", undefined);
  const fallback = new NativeAppReader(join(f.authPath, ".."), undefined, f.metric);
  try {
    await expect(fallback.identity("sheets", f.signal, f.onCall)).rejects.toThrow("test refused auth outside fixtures");
    expect(authReads).toEqual([join(homedir(), ".codex", "auth.json")]);
  } finally { await fallback.close(); }
  authReads.length = 0;
  vi.stubEnv("CODEX_HOME", codexHome('{"fixture":"other-home"}'));
  const explicit = new NativeAppReader(join(f.authPath, ".."), f.authPath, f.metric);
  transport.call.mockResolvedValueOnce({ user: { id: "U123" } });
  try {
    await explicit.identity("slack", f.signal, f.onCall);
    expect(vi.mocked(nativeApps).mock.calls[0][1]).toBe(f.authPath);
    expect(new Set(authReads)).toEqual(new Set([f.authPath]));
  } finally { await explicit.close(); }
});
