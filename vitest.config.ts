import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "src/server/**/*.ts",
        "src/shared/**/*.ts",
        "src/worker/**/*.ts",
        "src/web/**/*.{ts,tsx}",
      ],
      exclude: [
        "src/server/index.ts",
        "src/server/backup.ts",
        "src/web/main.tsx",
      ],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 75 },
    },
  },
});
