import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 90,
        statements: 90,
        // Branches are where the recovery paths live — the torn tail, the
        // corrupt checkpoint, the deferred compaction. Ungated, they were the
        // one dimension free to rot. Set below the current 89% so the gate
        // catches a regression rather than tripping on a rounding change.
        branches: 85,
      },
    },
  },
});
