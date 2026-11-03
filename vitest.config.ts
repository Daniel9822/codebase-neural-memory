import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    // SQLite-backed suites create and migrate independent databases. On Windows,
    // running too many file workers concurrently causes filesystem/SQLite
    // contention and flaky timeouts on slower CI and developer machines.
    maxWorkers: 2,
    // Keep finite ceilings while allowing Windows filesystem and native SQLite
    // variance, including asynchronous MCP transport teardown.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
