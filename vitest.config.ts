import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    // SQLite-backed indexing tests are consistently slower on Windows CI;
    // keep a finite ceiling without failing on normal filesystem variance.
    testTimeout: 15_000,
  },
});
