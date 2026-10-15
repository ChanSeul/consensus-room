import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AppCallTimeout, AppConnectionReset, nativeApps } from "../src/server/adapters/nativeApps";
import { nativeFigma } from "../src/server/adapters/nativeFigma";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(callable = true, text = "original node") {
  const root = mkdtempSync(join(tmpdir(), "native-figma-test-")); roots.push(root);
  const command = join(root, "app-server");
  const log = join(root, "calls.jsonl");
  const auth = join(root, "auth.json"); writeFileSync(auth, "fixture");
  // An actual child process implements the documented transport, without starting any provider model.
  writeFileSync(command, `#!/usr/bin/env node
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
 if(message.id===undefined)return;
 let result={};
 if(message.method==='thread/start')result={thread:{id:'reader'}};
 if(message.method==='app/installed')result={apps:[{id:'connector_68df038e0ba48191908c8434991bbac2',enabled:true,callable:${callable}}]};
 if(message.method==='mcpServerStatus/list')result={data:[{name:'codex_apps',tools:{
  'figma.get_design_context':{name:'figma.get_design_context',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},
  'figma.get_metadata':{name:'figma.get_metadata',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},
  'figma.get_screenshot':{name:'figma.get_screenshot',inputSchema:{type:'object'},annotations:{readOnlyHint:false}},
  'figma.delete_file':{name:'figma.delete_file',inputSchema:{type:'object'},annotations:{readOnlyHint:false}}
 }}]};
 if(message.method==='mcpServer/tool/call'&&message.params.arguments.nodeId==='exit')process.exit(3);
 if(message.method==='mcpServer/tool/call'&&message.params.arguments.nodeId==='hang')return;
 if(message.method==='mcpServer/tool/call'&&message.params.arguments.nodeId==='refused'){console.log(JSON.stringify({id:message.id,error:{code:-32000,message:'refused'}}));return;}
 if(message.method==='mcpServer/tool/call')result={content:[{type:'text',text:${JSON.stringify(text)}}],structuredContent:{version:7}};
 console.log(JSON.stringify({id:message.id,result}));
});
`); chmodSync(command, 0o700);
  return { root, command, log, auth };
}

it("exposes only approved node reads, records the exact native result before returning it, and never starts a model", async () => {
  const { root, command, log, auth } = fixture(); const observations: unknown[] = [];
  const bridge = await nativeFigma(command, auth, root, { cwd: root, prompt: "read", figmaFileKeys: ["Approved"],
    onFigmaResult: event => { observations.push(event); } });
  const call = (method: string, params = {}) => fetch(bridge.url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  try {
    const list = await (await call("tools/list")).json();
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["get_metadata", "get_design_context"]);
    for (const args of [{ fileKey: "Foreign", nodeId: "1:2" }, { fileKey: "Approved" }, { fileKey: "Approved", nodeId: "" }]) {
      expect((await call("tools/call", { name: "get_metadata", arguments: args })).status).toBe(403);
    }
    expect((await call("tools/call", { name: "delete_file", arguments: { fileKey: "Approved", nodeId: "1:2" } })).status).toBe(403);
    const response = await call("tools/call", { name: "get_metadata", arguments: { fileKey: "Approved", nodeId: "1:2" } });
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(observations).toEqual([{ tool: "mcp__figma-native__get_metadata", input: { fileKey: "Approved", nodeId: "1:2" },
      content: result.result, isError: false }]);
    bridge.assertCaptured();
    const requests = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === "mcpServer/tool/call")).toHaveLength(1);
    expect(requests.some(request => request.method === "turn/start")).toBe(false);
  } finally { await bridge.close(); }
  await expect(fetch(bridge.url, { method: "POST" })).rejects.toThrow();
});

it("fails before model access when the official app is not connected", async () => {
  const { root, command, auth } = fixture(false);
  await expect(nativeFigma(command, auth, root, { cwd: root, prompt: "read", figmaFileKeys: ["Approved"], onFigmaResult: () => {} }))
    .rejects.toThrow("연결되지 않았습니다");
});

it("does not return unrecorded source content when the evidence sink fails", async () => {
  const { root, command, auth } = fixture();
  const bridge = await nativeFigma(command, auth, root, { cwd: root, prompt: "read", figmaFileKeys: ["Approved"],
    onFigmaResult: () => { throw Error("capture failed"); } });
  try {
    const response = await fetch(bridge.url, { method: "POST", body: JSON.stringify({ id: 1, method: "tools/call",
      params: { name: "get_metadata", arguments: { fileKey: "Approved", nodeId: "1:2" } } }) });
    expect(response.status).toBe(502); expect(await response.text()).toBe("");
    expect(() => bridge.assertCaptured()).toThrow("capture failed");
  } finally { await bridge.close(); }
});

it("cancels the transport and rejects further reads", async () => {
  const { root, command, auth } = fixture(); const controller = new AbortController();
  const bridge = await nativeFigma(command, auth, root, { cwd: root, prompt: "read", signal: controller.signal,
    figmaFileKeys: ["Approved"], onFigmaResult: () => {} });
  controller.abort(); await bridge.close();
  expect(() => bridge.assertCaptured()).toThrow("취소");
  await expect(fetch(bridge.url, { method: "POST" })).rejects.toThrow();
});

it("preserves Unicode line separators inside a model-free MCP response",async()=>{
  const text="Policy\u2028Hidden-tab note\u2029Formula";
  const {root,command,log,auth}=fixture(true,text);
  const client=await nativeApps(command,auth,root,{connector_68df038e0ba48191908c8434991bbac2:["figma.get_metadata"]});
  try{
    expect((await client.call("figma.get_metadata",{fileKey:"Approved",nodeId:"1:2"})).content[0].text).toBe(text);
    const requests=readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(requests.some(request=>request.method==="turn/start")).toBe(false);
  }finally{await client.close();}
});

it("reports a connection closed only when it ended, not when one call was refused", async () => {
  const { root, command, auth } = fixture();
  const client = await nativeApps(command, auth, root, { connector_68df038e0ba48191908c8434991bbac2: ["figma.get_metadata"] });
  try {
    await expect(client.call("figma.get_metadata", { fileKey: "Approved", nodeId: "refused" })).rejects.toThrow("공식 앱 연결");
    expect(client.closed).toBe(false);
    await client.call("figma.get_metadata", { fileKey: "Approved", nodeId: "1:2" });
    await expect(client.call("figma.get_metadata", { fileKey: "Approved", nodeId: "exit" })).rejects.toThrow("앱 연결이 종료됐습니다");
    expect(client.closed).toBe(true);
  } finally { await client.close(); }
  const stopped = await nativeApps(command, auth, root, { connector_68df038e0ba48191908c8434991bbac2: ["figma.get_metadata"] });
  await stopped.close();
  expect(stopped.closed).toBe(true);
});

it("times out an unanswered request alone, and a reset ends the requests still waiting with its reason", async () => {
  const { root, command, auth } = fixture();
  const client = await nativeApps(command, auth, root, { connector_68df038e0ba48191908c8434991bbac2: ["figma.get_metadata"] });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const stuck = client.call("figma.get_metadata", { fileKey: "Approved", nodeId: "hang" });
    stuck.catch(() => {});
    vi.advanceTimersByTime(60_000);
    const waiting = client.call("figma.get_metadata", { fileKey: "Approved", nodeId: "hang" });
    waiting.catch(() => {});
    vi.advanceTimersByTime(60_000);
    await expect(stuck).rejects.toBeInstanceOf(AppCallTimeout);
    expect(client.closed).toBe(false);
    vi.useRealTimers();
    await client.close(new AppConnectionReset("응답 시간 초과로 연결을 재설정하면서 중단됐습니다."));
    await expect(waiting).rejects.toThrow("재설정");
    expect(client.closed).toBe(true);
    await expect(client.call("figma.get_metadata", { fileKey: "Approved", nodeId: "1:2" })).rejects.toThrow("재설정");
  } finally { vi.useRealTimers(); await client.close(); }
});
