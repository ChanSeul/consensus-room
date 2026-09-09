import { AgentResultSchema, type AgentResult } from "../shared/contracts.js";
import { redactSecrets } from "../shared/workflow.js";

export function safeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export function redactAgentResult(result: AgentResult): AgentResult {
  return AgentResultSchema.parse(redactValue(result));
}

export function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactValue(value) as Record<string, unknown>;
}

const AGENT_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export function agentEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of AGENT_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, redactValue(nested)]),
    );
  }
  return value;
}
