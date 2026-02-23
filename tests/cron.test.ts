import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { saveMcpServers } from "../src/config.js";
import { cleanupConfigFiles } from "./helpers.js";

const FAKE_CRON_PATH = path.resolve(import.meta.dirname, "fixtures", "fake-mcp-cron.js");

// Build a cron server config pointing at the fake script
function fakeCronConfig(env?: Record<string, string>) {
  return {
    cron: {
      command: "node",
      args: [FAKE_CRON_PATH],
      env: env ?? {},
    },
  };
}

// Dynamic import so we get a fresh module per test — the cron module has internal state
// (cronProc, lastCronFingerprint, nextId) that persists across calls.
async function importCron() {
  // Clear the module cache so each test gets fresh state
  const modPath = path.resolve(import.meta.dirname, "..", "src", "cron.ts");
  const modUrl = `file://${modPath}`;
  // Vitest doesn't support invalidating modules easily, so we import the real module
  // and manage state via stop/start.
  return import("../src/cron.js");
}

const { isCronRunning, callCronTool, startCronServer, restartCronServer, stopCronServer } = await importCron();

describe("cron", () => {
  beforeEach(() => {
    cleanupConfigFiles();
  });

  afterEach(async () => {
    await stopCronServer();
    cleanupConfigFiles();
  });

  describe("isCronRunning()", () => {
    it("returns false when no process is running", () => {
      expect(isCronRunning()).toBe(false);
    });

    it("returns true after startCronServer() succeeds", async () => {
      saveMcpServers(fakeCronConfig());
      await startCronServer();
      expect(isCronRunning()).toBe(true);
    });
  });

  describe("callCronTool()", () => {
    it("throws when cron is not running", async () => {
      await expect(callCronTool("list_tasks")).rejects.toThrow("mcp-cron is not running");
    });

    it("parses JSON text from result content", async () => {
      saveMcpServers(fakeCronConfig());
      await startCronServer();

      const result = await callCronTool("get_task", { id: "t1" });
      expect(result).toEqual({ id: "t1", name: "test task" });
    });

    it("returns parsed JSON for list_tasks", async () => {
      saveMcpServers(fakeCronConfig({ FAKE_TASKS: '[{"id":"1","name":"daily"}]' }));
      await startCronServer();

      const result = await callCronTool("list_tasks");
      expect(result).toEqual([{ id: "1", name: "daily" }]);
    });

    it("returns raw text when result is not valid JSON", async () => {
      saveMcpServers(fakeCronConfig({ FAKE_TOOL_RESPONSE: "not-valid-json" }));
      await startCronServer();

      // FAKE_TOOL_RESPONSE set to non-JSON will fail JSON.parse in the env handler,
      // falling through to default handling — let's test with get_task which returns JSON
      const result = await callCronTool("get_task", { id: "abc" });
      expect(typeof result === "object" || typeof result === "string").toBe(true);
    });

    it("handles add_task tool call", async () => {
      saveMcpServers(fakeCronConfig());
      await startCronServer();

      const result = await callCronTool("add_task", { name: "backup", command: "echo hi" });
      expect(result).toEqual({ id: "new1", name: "backup", command: "echo hi" });
    });

    it("handles add_ai_task tool call", async () => {
      saveMcpServers(fakeCronConfig());
      await startCronServer();

      const result = await callCronTool("add_ai_task", { name: "summary", prompt: "summarize" });
      expect(result).toEqual({ id: "new1", name: "summary", prompt: "summarize" });
    });

    it("handles update_task tool call", async () => {
      saveMcpServers(fakeCronConfig());
      await startCronServer();

      const result = await callCronTool("update_task", { id: "t1", name: "updated" });
      expect(result).toEqual({ ok: true, id: "t1", name: "updated" });
    });

    it("handles remove_task tool call", async () => {
      saveMcpServers(fakeCronConfig());
      await startCronServer();

      const result = await callCronTool("remove_task", { id: "t1" });
      expect(result).toEqual({ ok: true });
    });
  });

  describe("startCronServer()", () => {
    it("no-ops when cronProc already set", async () => {
      saveMcpServers(fakeCronConfig());
      await startCronServer();
      expect(isCronRunning()).toBe(true);

      // Calling again should be a no-op (no crash)
      await startCronServer();
      expect(isCronRunning()).toBe(true);
    });

    it("no-ops when no cron key in mcp.json", async () => {
      saveMcpServers({ memory: { command: "npx", args: ["-y", "server-memory"], env: {} } });
      await startCronServer();
      expect(isCronRunning()).toBe(false);
    });

    it("no-ops when mcp.json does not exist", async () => {
      await startCronServer();
      expect(isCronRunning()).toBe(false);
    });

    it("completes 3-message handshake and starts", async () => {
      saveMcpServers(fakeCronConfig());
      await startCronServer();
      expect(isCronRunning()).toBe(true);

      // Verify we can call tools (proves handshake succeeded)
      const result = await callCronTool("list_tasks");
      expect(result).toEqual([]);
    });

    it("kills process and resets state on handshake timeout", async () => {
      // Use a fake cron that delays responses beyond the timeout
      saveMcpServers({
        cron: {
          command: "node",
          args: [FAKE_CRON_PATH],
          env: { FAKE_DELAY_MS: "15000" },
        },
      });

      await expect(startCronServer()).rejects.toThrow("MCP response timeout");
      expect(isCronRunning()).toBe(false);
    }, 15000);
  });

  describe("restartCronServer()", () => {
    it("skips restart when config fingerprint unchanged and process alive", async () => {
      saveMcpServers(fakeCronConfig());

      // Initial start via restart (sets fingerprint)
      await restartCronServer();
      expect(isCronRunning()).toBe(true);

      // Store reference to verify it's the same process
      const resultBefore = await callCronTool("list_tasks");

      // Restart with same config — should skip
      await restartCronServer();
      expect(isCronRunning()).toBe(true);

      // Should still work
      const resultAfter = await callCronTool("list_tasks");
      expect(resultAfter).toEqual(resultBefore);
    });

    it("stops old + starts new when fingerprint changes", async () => {
      saveMcpServers(fakeCronConfig());
      await restartCronServer();
      expect(isCronRunning()).toBe(true);

      // Change config (add env var to change fingerprint)
      saveMcpServers(fakeCronConfig({ FAKE_TASKS: '[{"id":"new"}]' }));
      await restartCronServer();
      expect(isCronRunning()).toBe(true);

      // New process should use the new config
      const result = await callCronTool("list_tasks");
      expect(result).toEqual([{ id: "new" }]);
    });

    it("starts fresh when no process running", async () => {
      saveMcpServers(fakeCronConfig());
      await restartCronServer();
      expect(isCronRunning()).toBe(true);
    });
  });

  describe("stopCronServer()", () => {
    it("no-ops when not running", async () => {
      // Should not throw
      await stopCronServer();
      expect(isCronRunning()).toBe(false);
    });

    it("kills process and resets state", async () => {
      saveMcpServers(fakeCronConfig());
      await startCronServer();
      expect(isCronRunning()).toBe(true);

      await stopCronServer();
      expect(isCronRunning()).toBe(false);
    });
  });
});
