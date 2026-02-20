import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "tests/setup.ts",
    fileParallelism: false,
    env: { GOTO_DATA_DIR: "tests/data" },
  },
});
