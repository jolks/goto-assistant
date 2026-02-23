import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "tests/setup.ts",
    fileParallelism: false,
    env: { GOTO_DATA_DIR: "tests/data" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      reporter: ["text", "html", "lcov"],
    },
  },
});
