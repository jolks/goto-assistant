import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { saveConfig, loadConfig, saveMcpServers, loadMcpServers, MCP_CONFIG_PATH } from "../src/config.js";
import { runMigrations, CURRENT_CONFIG_VERSION } from "../src/migrations.js";
import { testConfig as baseConfig, cleanupConfigFiles } from "./helpers.js";

describe("migrations", () => {
  beforeEach(() => {
    cleanupConfigFiles();
  });

  afterEach(() => {
    cleanupConfigFiles();
  });

  it("skips when not configured", () => {
    runMigrations();
    expect(fs.existsSync(MCP_CONFIG_PATH)).toBe(false);
  });

  it("adds time server to existing config without configVersion", () => {
    saveConfig(baseConfig);
    saveMcpServers({
      memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
    });

    runMigrations();

    const servers = loadMcpServers();
    expect(servers.time).toEqual({ command: "uvx", args: ["mcp-server-time"] });
    expect(servers.memory).toBeDefined();
  });

  it("bumps configVersion after migration", () => {
    saveConfig(baseConfig);
    saveMcpServers({});

    runMigrations();

    const config = loadConfig();
    expect(config.configVersion).toBe(CURRENT_CONFIG_VERSION);
  });

  it("does not overwrite existing custom time server", () => {
    saveConfig(baseConfig);
    const customTime = { command: "custom-cmd", args: ["--custom"] };
    saveMcpServers({ time: customTime });

    runMigrations();

    const servers = loadMcpServers();
    expect(servers.time).toEqual(customTime);
  });

  it("skips when configVersion is already current", () => {
    saveConfig({ ...baseConfig, configVersion: CURRENT_CONFIG_VERSION });
    saveMcpServers({});

    runMigrations();

    const servers = loadMcpServers();
    expect(servers.time).toBeUndefined();
  });

  it("does not re-add server after user removes it (version already bumped)", () => {
    saveConfig({ ...baseConfig, configVersion: CURRENT_CONFIG_VERSION });
    saveMcpServers({});

    // Simulate: user already went through migration, then removed time server
    // configVersion is current, so migration should not run again
    runMigrations();

    const servers = loadMcpServers();
    expect(servers.time).toBeUndefined();
  });

  it("replaces relative ./data/mcp.json with absolute MCP_CONFIG_PATH in cron args", () => {
    saveConfig({ ...baseConfig, configVersion: 1 });
    saveMcpServers({
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron", "--transport", "stdio", "--prevent-sleep", "--mcp-config-path", "./data/mcp.json", "--ai-provider", "anthropic"],
      },
    });

    runMigrations();

    const servers = loadMcpServers();
    expect(servers.cron.args).toContain(MCP_CONFIG_PATH);
    expect(servers.cron.args).not.toContain("./data/mcp.json");
  });

  it("leaves cron args unchanged when --mcp-config-path is already absolute", () => {
    saveConfig({ ...baseConfig, configVersion: 1 });
    saveMcpServers({
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron", "--mcp-config-path", "/custom/path/mcp.json"],
      },
    });

    runMigrations();

    const servers = loadMcpServers();
    expect(servers.cron.args).toContain("/custom/path/mcp.json");
  });
});
