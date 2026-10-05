import { writeSync } from "node:fs";
import { redactSecrets } from "../shared/workflow.js";

// The last error boundary must not depend on the database that may have failed.
// Persisted running records remain unfinished for startup recovery, never successful.
export function reportBackgroundFailure(context: string, error: unknown): void {
  try {
    const message = redactSecrets(error instanceof Error ? error.stack ?? error.message : String(error));
    writeSync(2, `[background:${context}] ${message.slice(0, 16_000)}\n`);
  } catch { /* Even a broken diagnostic sink cannot reject an unowned task. */ }
}

export async function runBackgroundTask(context: string, work: () => void | Promise<void>,
  recover: (error: unknown) => void | Promise<void>, settle: () => void | Promise<void> = () => {}): Promise<void> {
  try {
    await work();
  } catch (error) {
    try { await recover(error); }
    catch (recoveryError) {
      reportBackgroundFailure(`${context}:work`, error);
      reportBackgroundFailure(`${context}:recovery`, recoveryError);
    }
  } finally {
    try { await settle(); }
    catch (error) { reportBackgroundFailure(`${context}:settlement`, error); }
  }
}
