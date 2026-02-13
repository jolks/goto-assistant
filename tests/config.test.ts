import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.GOTO_DATA_DIR = "tests/data";
});

import fs from "node:fs";
import path from "node:path";
import { isConfigured, loadConfig, saveConfig, maskApiKey, getMaskedConfig, loadMcpServers, saveMcpServers, getMaskedMcpServers, DATA_DIR, MCP_CONFIG_PATH, type Config, type McpServerConfig } from "../src/config.js";

const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const testConfig: Config = {
  provider: "claude",
  claude: { apiKey: "sk-ant-test123456", model: "claude-sonnet-4-5-20250929", baseUrl: "" },
  openai: { apiKey: "sk-openai-test789", model: "gpt-4o", baseUrl: "" },
  server: { port: 3000 },
};

describe("config", () => {
  beforeEach(() => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    if (fs.existsSync(MCP_CONFIG_PATH)) fs.unlinkSync(MCP_CONFIG_PATH);
  });

  afterEach(() => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    if (fs.existsSync(MCP_CONFIG_PATH)) fs.unlinkSync(MCP_CONFIG_PATH);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it("uses tests/data as DATA_DIR", () => {
    expect(DATA_DIR).toContain("tests/data");
  });

  it("isConfigured returns false when config file is missing", () => {
    expect(isConfigured()).toBe(false);
  });

  it("isConfigured returns true after saving config", () => {
    saveConfig(testConfig);
    expect(isConfigured()).toBe(true);
  });

  it("saveConfig creates data directory if needed", () => {
    if (fs.existsSync(DATA_DIR) && fs.readdirSync(DATA_DIR).length === 0) {
      fs.rmdirSync(DATA_DIR);
    }
    saveConfig(testConfig);
    expect(fs.existsSync(CONFIG_PATH)).toBe(true);
  });

  it("saveConfig does not write mcp.json", () => {
    saveConfig(testConfig);
    expect(fs.existsSync(MCP_CONFIG_PATH)).toBe(false);
  });

  it("loadConfig reads saved config", () => {
    saveConfig(testConfig);
    const loaded = loadConfig();
    expect(loaded.provider).toBe("claude");
    expect(loaded.claude.model).toBe("claude-sonnet-4-5-20250929");
    expect(loaded.server.port).toBe(3000);
  });

  it("environment variables override config values", () => {
    saveConfig(testConfig);
    process.env.ANTHROPIC_API_KEY = "env-override-key";
    const loaded = loadConfig();
    expect(loaded.claude.apiKey).toBe("env-override-key");
  });

  it("maskApiKey masks the middle of a key", () => {
    expect(maskApiKey("sk-ant-test123456")).toBe("sk-a****3456");
    expect(maskApiKey("short")).toBe("****");
  });

  it("getMaskedConfig masks API keys in config", () => {
    const masked = getMaskedConfig(testConfig);
    expect(masked.claude.apiKey).not.toBe(testConfig.claude.apiKey);
    expect(masked.claude.apiKey).toContain("****");
    expect(masked.openai.apiKey).toContain("****");
  });

  it("saveMcpServers writes mcp.json and loadMcpServers reads it", () => {
    const servers: Record<string, McpServerConfig> = {
      memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
    };
    saveMcpServers(servers);
    expect(fs.existsSync(MCP_CONFIG_PATH)).toBe(true);
    const loaded = loadMcpServers();
    expect(loaded).toEqual(servers);
  });

  it("loadMcpServers returns empty object when file does not exist", () => {
    expect(loadMcpServers()).toEqual({});
  });

  it("getMaskedMcpServers masks env vars containing 'key'", () => {
    const servers: Record<string, McpServerConfig> = {
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron"],
        env: { ANTHROPIC_API_KEY: "sk-secret-value", SOME_PATH: "/usr/bin" },
      },
    };
    const masked = getMaskedMcpServers(servers);
    expect(masked.cron.env!.ANTHROPIC_API_KEY).toContain("****");
    expect(masked.cron.env!.SOME_PATH).toBe("/usr/bin");
  });
});
