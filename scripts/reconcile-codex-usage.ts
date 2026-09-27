import { parseArgs } from "node:util";
import { reconcileCodexPlanningUsage } from "../src/server/codexUsageReconciliation.js";

const { values } = parseArgs({ options: { database: { type: "string" }, home: { type: "string" }, transcript: { type: "string" },
  execution: { type: "string" }, apply: { type: "string" } }, strict: true, allowPositionals: false });
if (!values.database || !values.home || !values.transcript || !values.execution) {
  throw new Error("Required: --database PATH --home CODEX_HOME --transcript JSONL --execution ID. Preview first; --apply HASH applies that exact preview.");
}
const report = reconcileCodexPlanningUsage({ databasePath: values.database, codexHome: values.home, transcriptPath: values.transcript,
  executionId: values.execution, expectedHash: values.apply });
console.log(JSON.stringify({ hash: report.hash, applied: report.applied, reused: report.reused, executionId: report.executionId,
  sourceSHA256: report.sourceSHA256, proof: report.proof }, null, 2));
