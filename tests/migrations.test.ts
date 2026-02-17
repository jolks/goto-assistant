import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.GOTO_DATA_DIR = "tests/data";
});

import fs from "node:fs";
import { saveConfig, loadConfig, saveMcpServers, loadMcpServers, DATA_DIR, MCP_CONFIG_PATH, type Config } from "../src/config.js";
import { runMigrations, CURRENT_CONFIG_VERSION } from "../src/migrations.js";
import path from "node:path";

const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const baseConfig: Config = {
  provider: "claude",
  claude: { apiKey: "sk-ant-test123456", model: "claude-sonnet-4-5-20250929", baseUrl: "" },
  openai: { apiKey: "sk-openai-test789", model: "gpt-4o", baseUrl: "" },
  server: { port: 3000 },
};

describe("migrations", () => {
  beforeEach(() => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    if (fs.existsSync(MCP_CONFIG_PATH)) fs.unlinkSync(MCP_CONFIG_PATH);
  });

  afterEach(() => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    if (fs.existsSync(MCP_CONFIG_PATH)) fs.unlinkSync(MCP_CONFIG_PATH);
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
