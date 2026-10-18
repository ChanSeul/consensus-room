import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { createRoomConfig, defaultConfigPath, readRoomConfig, writeInitialConfig } from "./config.js";
import { doctor } from "./doctor.js";
import { openRoom, restartRoom, roomStatus, startRoom, stopRoom } from "./lifecycle.js";
import { RoomClient } from "./client.js";
import { claudeMcpConfig, configureWorkers, connectMediator, createTopic, mediatorBriefing, prepareParticipants, runBridge, verifyMediator } from "./mediation.js";
import { redactSecrets } from "../shared/workflow.js";

const help = `Consensus Room — 개인 설정과 기존 API를 사용하는 로컬 CLI

npm run cr -- <명령> [--config /absolute/path/room.json]

init          --repository PATH --claude-model MODEL --codex-model MODEL
              [--data-dir PATH --port NUMBER --claude-effort medium --codex-effort medium]
              [--implementation-model MODEL --implementation-effort medium]
doctor        준비조건과 선택 연결을 점검합니다. 모델 호출은 하지 않습니다.
start         웹을 빌드하고 별도 프로세스로 시작합니다.
status        현재 방의 프로세스 신원과 응답을 확인합니다.
stop/restart  실행 중 작업과 유지보수 잠금을 확인한 뒤 종료/재시작합니다.
open          인증 URL을 출력하지 않고 기본 브라우저에서 엽니다.
configure     설정의 계획자·구현자·리뷰어를 배정합니다. 기존 변경은 --replace 필요.
connect       --provider claude|codex --session ID --participant NAME --model MODEL --effort EFFORT
              [--topic ID --replace] 실제 중재 대화를 배정합니다. 대화를 만들지 않습니다.
topic         --title TEXT --mode ticket|planned [--goal TEXT --parent ID --group --request-id ID]
participants  --topic ID (planned의 누락된 참여자만 준비)
bridge        --topic ID (연결된 중재자의 인터럽트 연결을 전경에서 유지)
briefing      --topic ID (기존 중재 대화에 전달할 진입 지침 출력)
mcp-config    --topic ID [--output PATH] (Claude 채널용 MCP JSON, 토큰 없음)
api           GET|POST|PUT|PATCH|DELETE /api/PATH [--body JSON | --body-file PATH]
              [--as mediator|user --request-id ID] 변경 기본 신원은 mediator입니다.

doctor --json으로 기계 판독 결과를 얻습니다. 계정 로그인/모델 사용 권한은 별도로 준비하세요.
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    config: { type: "string" }, repository: { type: "string" }, "data-dir": { type: "string" }, port: { type: "string" },
    "claude-model": { type: "string" }, "codex-model": { type: "string" }, "claude-effort": { type: "string" }, "codex-effort": { type: "string" },
    "implementation-model": { type: "string" }, "implementation-effort": { type: "string" },
    provider: { type: "string" }, session: { type: "string" }, participant: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
    topic: { type: "string" }, title: { type: "string" }, goal: { type: "string" }, mode: { type: "string" }, parent: { type: "string" },
    body: { type: "string" }, "body-file": { type: "string" }, as: { type: "string" }, "request-id": { type: "string" }, output: { type: "string" },
    replace: { type: "boolean", default: false }, group: { type: "boolean", default: false }, json: { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
  } });
  const command = positionals[0];
  if (!command || command === "help" || values.help) { process.stdout.write(help); return; }
  const required = (name: keyof typeof values): string => {
    const value = values[name]; if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} 값이 필요합니다.`); return value.trim();
  };
  const configFile = resolve(values.config ?? defaultConfigPath());
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (command === "init") {
    const initValues: Record<string, string | undefined> = { repository: values.repository, "claude-model": values["claude-model"], "codex-model": values["codex-model"] };
    if (process.stdin.isTTY && Object.values(initValues).some(value => !value?.trim())) {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (const [name, prompt] of [["repository", "작업할 Git 저장소 절대 경로"], ["claude-model", "본인 계정에서 사용할 Claude 모델"], ["codex-model", "본인 계정에서 사용할 Codex 모델"]]) {
          if (!initValues[name]?.trim()) initValues[name] = (await readline.question(`${prompt}: `)).trim();
        }
      } finally { readline.close(); }
    }
    for (const name of Object.keys(initValues)) if (!initValues[name]?.trim()) throw new Error(`init에 --${name} 값이 필요합니다. 모델은 본인 계정에서 선택하세요.`);
    const config = createRoomConfig({ repositoryPath: initValues.repository!, dataDirectory: values["data-dir"],
      port: values.port === undefined ? undefined : Number(values.port), claudeModel: initValues["claude-model"]!, codexModel: initValues["codex-model"]!,
      claudeEffort: values["claude-effort"], codexEffort: values["codex-effort"], implementationModel: values["implementation-model"], implementationEffort: values["implementation-effort"] });
    writeInitialConfig(configFile, config);
    print({ configFile, repositoryPath: config.repositoryPath, dataDirectory: config.dataDirectory, next: "doctor → start → configure → connect", modelAccess: "미검증: 본인 CLI 로그인과 모델 사용 권한을 확인하세요." });
    return;
  }
  const config = readRoomConfig(configFile);
  const api = new RoomClient(config);
  switch (command) {
    case "doctor": {
      const checks = await doctor(config);
      if (values.json) print(checks);
      else for (const check of checks) process.stdout.write(`[${check.status}] ${check.check}: ${check.detail}${check.remedy ? `\n  ${check.remedy}` : ""}\n`);
      if (checks.some(check => check.status === "fail")) process.exitCode = 1;
      return;
    }
    case "status": print(await roomStatus(config)); return;
    case "start": print(await startRoom(config)); return;
    case "restart": print(await restartRoom(config)); return;
    case "stop": await stopRoom(config); print({ state: "stopped" }); return;
    case "open": await openRoom(config); return;
    case "configure": print(await configureWorkers(api, config, values.replace)); return;
    case "connect": {
      const provider = required("provider"); if (provider !== "claude" && provider !== "codex") throw new Error("provider는 claude 또는 codex입니다.");
      print(await connectMediator(api, config, { provider, participant: required("participant"), sessionId: required("session"),
        model: required("model"), effort: required("effort"), topicId: values.topic, replace: values.replace }));
      return;
    }
    case "topic": {
      const mode = required("mode"); if (mode !== "ticket" && mode !== "planned") throw new Error("mode는 ticket 또는 planned입니다.");
      print(await createTopic(api, { title: required("title"), goal: values.goal, mode, parentTopicId: values.parent, group: values.group, requestId: values["request-id"] })); return;
    }
    case "participants": await prepareParticipants(api, required("topic")); print({ topicId: values.topic, prepared: true }); return;
    case "bridge": await runBridge(api, config, required("topic")); return;
    case "briefing": {
      process.stdout.write(await mediatorBriefing(api, config, configFile, required("topic")));
      return;
    }
    case "mcp-config": {
      const binding = await verifyMediator(api, config, required("topic"));
      if (binding.provider !== "claude") throw new Error("mcp-config는 Claude 중재자용입니다. Codex는 bridge를 사용하세요.");
      const result = claudeMcpConfig(configFile, required("topic"));
      if (values.output) { writeFileSync(resolve(values.output), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 }); print({ written: resolve(values.output) }); }
      else print(result);
      return;
    }
    case "api": {
      if (positionals.length !== 3) throw new Error("api METHOD /api/PATH 형식으로 실행하세요.");
      if (values.body !== undefined && values["body-file"] !== undefined) throw new Error("body와 body-file 중 하나만 선택하세요.");
      const actor = values.as ?? (positionals[1].toUpperCase() === "GET" ? "user" : "mediator");
      if (actor !== "user" && actor !== "mediator") throw new Error("as는 user 또는 mediator입니다.");
      const text = values["body-file"] ? readFileSync(resolve(values["body-file"]), "utf8") : values.body;
      print(await api.request(positionals[1], positionals[2], text === undefined ? undefined : JSON.parse(text), { actor, requestId: values["request-id"] })); return;
    }
    default: throw new Error(`알 수 없는 명령: ${command}. help를 확인하세요.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${redactSecrets(error instanceof Error ? error.message : "명령 실행 실패")}\n`); process.exitCode = 1; });
}
