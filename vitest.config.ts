import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Tests commonly run real Git, SQLite and file I/O. This finite watchdog is
    // not a latency requirement; explicit test deadlines and hook limits remain separate.
    testTimeout: 30_000,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // 테스트가 호스트에 설치된 codex·claude CLI 에 기대지 않게 가짜 CLI 를 PATH 앞에 둔다(파일 주석 참조).
    setupFiles: ["tests/setup/hostExecutables.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
