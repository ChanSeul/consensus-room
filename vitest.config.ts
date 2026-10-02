import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Tests commonly run real Git, SQLite and file I/O. This finite watchdog is
    // not a latency requirement; explicit test deadlines and hook limits remain separate.
    testTimeout: 30_000,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
