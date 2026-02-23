import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { isConfigured, loadConfig, saveConfig, maskApiKey, getMaskedConfig, loadMcpServers, saveMcpServers, getMaskedMcpServers, isMaskedValue, unmaskMcpServers, syncMessagingMcpServer, MESSAGING_SERVER_NAME, DATA_DIR, MCP_CONFIG_PATH, type Config, type McpServerConfig } from "../src/config.js";
import { CONFIG_PATH, testConfig, cleanupConfigFiles } from "./helpers.js";

describe("config", () => {
  beforeEach(() => {
    cleanupConfigFiles();
  });

  afterEach(() => {
    cleanupConfigFiles();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.PORT;
  });

  it("uses tests/data as DATA_DIR", () => {
    expect(DATA_DIR).toContain("tests/data");
  });

  it("uses GOTO_DATA_DIR directly without prepending cwd", () => {
    expect(DATA_DIR).toBe(process.env.GOTO_DATA_DIR);
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
    expect(loaded.claude.apiKey).toBe("sk-ant-test123456");
    expect(loaded.claude.model).toBe("claude-sonnet-4-5-20250929");
    expect(loaded.server.port).toBe(3000);
  });

  it("environment variables override config values", () => {
    saveConfig(testConfig);
    process.env.ANTHROPIC_API_KEY = "env-override-key";
    const loaded = loadConfig();
    expect(loaded.claude.apiKey).toBe("env-override-key");
  });

  it("PORT environment variable overrides config port", () => {
    saveConfig(testConfig);
    process.env.PORT = "4000";
    const loaded = loadConfig();
    expect(loaded.server.port).toBe(4000);
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

  it("isMaskedValue detects masked values", () => {
    expect(isMaskedValue("sk-a****3456")).toBe(true);
    expect(isMaskedValue("****")).toBe(true);
    expect(isMaskedValue("sk-ant-real-key-12345")).toBe(false);
    expect(isMaskedValue("")).toBe(false);
  });

  it("unmaskMcpServers restores masked env values from existing servers", () => {
    const existing: Record<string, McpServerConfig> = {
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron"],
        env: { ANTHROPIC_API_KEY: "sk-ant-real-secret-key", SOME_PATH: "/usr/bin" },
      },
    };
    const incoming: Record<string, McpServerConfig> = {
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron"],
        env: { ANTHROPIC_API_KEY: "sk-a****-key", SOME_PATH: "/usr/bin" },
      },
    };
    const result = unmaskMcpServers(incoming, existing);
    expect(result.cron.env!.ANTHROPIC_API_KEY).toBe("sk-ant-real-secret-key");
    expect(result.cron.env!.SOME_PATH).toBe("/usr/bin");
  });

  it("unmaskMcpServers keeps new values when not masked", () => {
    const existing: Record<string, McpServerConfig> = {
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron"],
        env: { ANTHROPIC_API_KEY: "sk-ant-old-key-12345" },
      },
    };
    const incoming: Record<string, McpServerConfig> = {
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron"],
        env: { ANTHROPIC_API_KEY: "sk-ant-brand-new-key" },
      },
    };
    const result = unmaskMcpServers(incoming, existing);
    expect(result.cron.env!.ANTHROPIC_API_KEY).toBe("sk-ant-brand-new-key");
  });

  it("unmaskMcpServers handles new servers not in existing", () => {
    const existing: Record<string, McpServerConfig> = {};
    const incoming: Record<string, McpServerConfig> = {
      newserver: {
        command: "npx",
        args: ["-y", "new-server"],
        env: { API_KEY: "sk-new-key-value" },
      },
    };
    const result = unmaskMcpServers(incoming, existing);
    expect(result.newserver.env!.API_KEY).toBe("sk-new-key-value");
  });

  it("unmaskMcpServers handles servers without env", () => {
    const existing: Record<string, McpServerConfig> = {
      memory: { command: "npx", args: ["-y", "server-memory"] },
    };
    const incoming: Record<string, McpServerConfig> = {
      memory: { command: "npx", args: ["-y", "server-memory"] },
    };
    const result = unmaskMcpServers(incoming, existing);
    expect(result.memory.env).toBeUndefined();
  });

  it("unmaskMcpServers resolves masked OPENAI_API_KEY from config after provider switch", () => {
    // Existing on disk has ANTHROPIC_API_KEY (old provider)
    const existing: Record<string, McpServerConfig> = {
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron"],
        env: { ANTHROPIC_API_KEY: "sk-ant-real-key-12345" },
      },
    };
    // Frontend switched to OpenAI and sent masked OpenAI key
    const incoming: Record<string, McpServerConfig> = {
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron"],
        env: { OPENAI_API_KEY: "sk-o****t789" },
      },
    };
    // Config has the real OpenAI key
    const config: Config = {
      provider: "openai",
      claude: { apiKey: "sk-ant-real-key-12345", model: "claude-sonnet-4-5-20250929", baseUrl: "" },
      openai: { apiKey: "sk-openai-test789", model: "gpt-4o", baseUrl: "" },
      server: { port: 3000 },
    };
    const result = unmaskMcpServers(incoming, existing, config);
    expect(result.cron.env!.OPENAI_API_KEY).toBe("sk-openai-test789");
  });

  it("unmaskMcpServers resolves masked MCP_CRON_AI_API_KEY from active provider", () => {
    const existing: Record<string, McpServerConfig> = {
      cron: { command: "npx", args: ["-y", "mcp-cron"], env: {} },
    };
    const incoming: Record<string, McpServerConfig> = {
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron"],
        env: { MCP_CRON_AI_API_KEY: "sk-a****3456" },
      },
    };
    const config: Config = {
      provider: "claude",
      claude: { apiKey: "sk-ant-test123456", model: "claude-sonnet-4-5-20250929", baseUrl: "http://proxy" },
      openai: { apiKey: "", model: "", baseUrl: "" },
      server: { port: 3000 },
    };
    const result = unmaskMcpServers(incoming, existing, config);
    expect(result.cron.env!.MCP_CRON_AI_API_KEY).toBe("sk-ant-test123456");
  });

  describe("syncMessagingMcpServer", () => {
    it("adds messaging entry when WhatsApp is enabled", () => {
      saveConfig({ ...testConfig, whatsapp: { enabled: true } });
      syncMessagingMcpServer();
      const servers = loadMcpServers();
      expect(servers[MESSAGING_SERVER_NAME]).toBeDefined();
      expect(servers[MESSAGING_SERVER_NAME].command).toBe("node");
      expect(servers[MESSAGING_SERVER_NAME].env?.GOTO_ASSISTANT_URL).toBe("http://localhost:3000");
    });

    it("entry point path exists on disk", () => {
      saveConfig({ ...testConfig, whatsapp: { enabled: true } });
      syncMessagingMcpServer();
      const servers = loadMcpServers();
      const entryPoint = servers[MESSAGING_SERVER_NAME].args[0];
      expect(fs.existsSync(entryPoint)).toBe(true);
    });

    it("removes messaging entry when WhatsApp is disabled", () => {
      saveConfig({ ...testConfig, whatsapp: { enabled: true } });
      syncMessagingMcpServer();
      expect(loadMcpServers()[MESSAGING_SERVER_NAME]).toBeDefined();

      saveConfig({ ...testConfig, whatsapp: { enabled: false } });
      syncMessagingMcpServer();
      expect(loadMcpServers()[MESSAGING_SERVER_NAME]).toBeUndefined();
    });

    it("removes messaging entry when whatsapp config is missing", () => {
      saveConfig({ ...testConfig, whatsapp: { enabled: true } });
      syncMessagingMcpServer();
      expect(loadMcpServers()[MESSAGING_SERVER_NAME]).toBeDefined();

      saveConfig(testConfig); // testConfig has no whatsapp field
      syncMessagingMcpServer();
      expect(loadMcpServers()[MESSAGING_SERVER_NAME]).toBeUndefined();
    });

    it("updates GOTO_ASSISTANT_URL when port changes", () => {
      saveConfig({ ...testConfig, whatsapp: { enabled: true }, server: { port: 4000 } });
      syncMessagingMcpServer();
      const servers = loadMcpServers();
      expect(servers[MESSAGING_SERVER_NAME].env?.GOTO_ASSISTANT_URL).toBe("http://localhost:4000");
    });

    it("preserves other MCP servers", () => {
      saveMcpServers({ memory: { command: "npx", args: ["-y", "server-memory"] } });
      saveConfig({ ...testConfig, whatsapp: { enabled: true } });
      syncMessagingMcpServer();
      const servers = loadMcpServers();
      expect(servers.memory).toBeDefined();
      expect(servers[MESSAGING_SERVER_NAME]).toBeDefined();
    });

    it("accepts config parameter instead of reading from disk", () => {
      const cfg = { ...testConfig, whatsapp: { enabled: true } as const, server: { port: 5000 } };
      saveConfig(cfg); // needed so isConfigured() is true if fallback used, but we pass config directly
      syncMessagingMcpServer(cfg);
      const servers = loadMcpServers();
      expect(servers[MESSAGING_SERVER_NAME].env?.GOTO_ASSISTANT_URL).toBe("http://localhost:5000");
    });

    it("no-ops when not configured and no config passed", () => {
      // No config file on disk, no config passed
      syncMessagingMcpServer();
      expect(fs.existsSync(MCP_CONFIG_PATH)).toBe(false);
    });
  });

  it("unmaskMcpServers prefers existing server value over config for same key", () => {
    // If the cron env was manually set to a different key than config, preserve it
    const existing: Record<string, McpServerConfig> = {
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron"],
        env: { ANTHROPIC_API_KEY: "sk-ant-custom-manual-key" },
      },
    };
    const incoming: Record<string, McpServerConfig> = {
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron"],
        env: { ANTHROPIC_API_KEY: "sk-a****-key" },
      },
    };
    const result = unmaskMcpServers(incoming, existing, testConfig);
    // Pass 1 (existing server) takes precedence over pass 2 (config)
    expect(result.cron.env!.ANTHROPIC_API_KEY).toBe("sk-ant-custom-manual-key");
  });
});
