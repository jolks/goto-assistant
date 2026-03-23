import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isConfigured, loadConfig, saveConfig, maskApiKey, getMaskedConfig, loadMcpServers, saveMcpServers, getMaskedMcpServers, isMaskedValue, unmaskMcpServers, syncMessagingMcpServer, syncEpisodicMcpServer, syncBrokerConfig, getAgentMcpServers, isResponsesAPICapable, MESSAGING_SERVER_NAME, EPISODIC_SERVER_NAME, BROKER_SERVER_NAME, AGENT_MCP_CONFIG_PATH, DATA_DIR, MCP_CONFIG_PATH, type Config, type McpServerConfig } from "../src/config.js";
import { CONFIG_PATH, testConfig, cleanupConfigFiles } from "./helpers.js";

const BROKER_DATA_DIR = path.join(DATA_DIR, "mcp-broker");
const BROKER_SERVERS_PATH = path.join(BROKER_DATA_DIR, "servers.json");

function cleanupBrokerFiles() {
  if (fs.existsSync(BROKER_SERVERS_PATH)) fs.unlinkSync(BROKER_SERVERS_PATH);
  if (fs.existsSync(BROKER_DATA_DIR)) fs.rmdirSync(BROKER_DATA_DIR);
  if (fs.existsSync(AGENT_MCP_CONFIG_PATH)) fs.unlinkSync(AGENT_MCP_CONFIG_PATH);
}

describe("config", () => {
  beforeEach(() => {
    cleanupConfigFiles();
    cleanupBrokerFiles();
  });

  afterEach(() => {
    cleanupConfigFiles();
    cleanupBrokerFiles();
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

    it("skips saveMcpServers when entry is already up-to-date", () => {
      saveConfig({ ...testConfig, whatsapp: { enabled: true } });
      syncMessagingMcpServer(); // first call writes
      const spy = vi.spyOn(fs, "writeFileSync");
      syncMessagingMcpServer(); // second call should skip
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("skips saveMcpServers when removing already-absent entry", () => {
      saveConfig({ ...testConfig, whatsapp: { enabled: false } });
      // Ensure no messaging entry exists
      saveMcpServers({});
      const spy = vi.spyOn(fs, "writeFileSync");
      syncMessagingMcpServer();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("no-ops when not configured and no config passed", () => {
      // No config file on disk, no config passed
      syncMessagingMcpServer();
      expect(fs.existsSync(MCP_CONFIG_PATH)).toBe(false);
    });
  });

  describe("isResponsesAPICapable", () => {
    it("returns true for undefined (direct OpenAI default)", () => {
      expect(isResponsesAPICapable(undefined)).toBe(true);
    });

    it("returns true for direct OpenAI", () => {
      expect(isResponsesAPICapable("https://api.openai.com/v1")).toBe(true);
    });

    it("returns false for LiteLLM proxy", () => {
      expect(isResponsesAPICapable("https://litellm.example.com")).toBe(false);
    });

    it("returns false for Kilo gateway", () => {
      expect(isResponsesAPICapable("https://api.kilo.ai/api/gateway")).toBe(false);
    });

    it("returns false for Gemini gateway", () => {
      expect(isResponsesAPICapable("https://generativelanguage.googleapis.com/v1beta/openai")).toBe(false);
    });

    it("returns false for localhost", () => {
      expect(isResponsesAPICapable("http://localhost:11434/v1")).toBe(false);
    });

    it("returns false for spoofed OpenAI subdomain", () => {
      expect(isResponsesAPICapable("https://api.openai.com.evil.com/v1")).toBe(false);
    });

    it("returns true for Azure OpenAI", () => {
      expect(isResponsesAPICapable("https://myresource.openai.azure.com/openai/v1/")).toBe(true);
    });

    it("returns true for Azure OpenAI with different resource", () => {
      expect(isResponsesAPICapable("https://contoso.openai.azure.com/openai/v1/")).toBe(true);
    });

    it("returns false for spoofed Azure suffix", () => {
      expect(isResponsesAPICapable("https://openai.azure.com.evil.com/v1")).toBe(false);
    });

    it("returns false for spoofed Azure no dot prefix", () => {
      expect(isResponsesAPICapable("https://fakeopenai.azure.com/v1")).toBe(false);
    });
  });

  describe("syncEpisodicMcpServer", () => {
    it("adds episodic-memory entry to mcp.json", () => {
      saveConfig(testConfig);
      syncEpisodicMcpServer();
      const servers = loadMcpServers();
      expect(servers[EPISODIC_SERVER_NAME]).toBeDefined();
      expect(servers[EPISODIC_SERVER_NAME].command).toBe("node");
    });

    it("entry point path exists on disk", () => {
      saveConfig(testConfig);
      syncEpisodicMcpServer();
      const servers = loadMcpServers();
      const entryPoint = servers[EPISODIC_SERVER_NAME].args[0];
      expect(fs.existsSync(entryPoint)).toBe(true);
    });

    it("sets GOTO_DATA_DIR env var from DATA_DIR", () => {
      saveConfig(testConfig);
      syncEpisodicMcpServer();
      const servers = loadMcpServers();
      expect(servers[EPISODIC_SERVER_NAME].env?.GOTO_DATA_DIR).toBe(DATA_DIR);
    });

    it("sets MCP_CRON_DB_PATH from cron config --db-path arg", () => {
      saveMcpServers({
        cron: { command: "npx", args: ["-y", "mcp-cron", "--db-path", "/custom/results.db"] },
      });
      saveConfig(testConfig);
      syncEpisodicMcpServer();
      const servers = loadMcpServers();
      expect(servers[EPISODIC_SERVER_NAME].env?.MCP_CRON_DB_PATH).toBe("/custom/results.db");
    });

    it("falls back to ~/.mcp-cron/results.db when cron has no --db-path", () => {
      saveMcpServers({
        cron: { command: "npx", args: ["-y", "mcp-cron"] },
      });
      saveConfig(testConfig);
      syncEpisodicMcpServer();
      const servers = loadMcpServers();
      expect(servers[EPISODIC_SERVER_NAME].env?.MCP_CRON_DB_PATH).toContain(".mcp-cron/results.db");
    });

    it("preserves other MCP servers in mcp.json", () => {
      saveMcpServers({ memory: { command: "npx", args: ["-y", "server-memory"] } });
      saveConfig(testConfig);
      syncEpisodicMcpServer();
      const servers = loadMcpServers();
      expect(servers.memory).toBeDefined();
      expect(servers[EPISODIC_SERVER_NAME]).toBeDefined();
    });

    it("skips saveMcpServers when entry is already up-to-date", () => {
      saveConfig(testConfig);
      syncEpisodicMcpServer(); // first call writes
      const spy = vi.spyOn(fs, "writeFileSync");
      syncEpisodicMcpServer(); // second call should skip
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("updates entry when cron config --db-path changes", () => {
      saveMcpServers({
        cron: { command: "npx", args: ["-y", "mcp-cron", "--db-path", "/old/results.db"] },
      });
      saveConfig(testConfig);
      syncEpisodicMcpServer();
      let servers = loadMcpServers();
      expect(servers[EPISODIC_SERVER_NAME].env?.MCP_CRON_DB_PATH).toBe("/old/results.db");

      // Change cron --db-path
      servers.cron = { command: "npx", args: ["-y", "mcp-cron", "--db-path", "/new/results.db"] };
      saveMcpServers(servers);
      syncEpisodicMcpServer();
      servers = loadMcpServers();
      expect(servers[EPISODIC_SERVER_NAME].env?.MCP_CRON_DB_PATH).toBe("/new/results.db");
    });
  });

  describe("syncBrokerConfig", () => {
    it("adds broker entry to mcp.json", () => {
      saveConfig(testConfig);
      syncBrokerConfig();
      const servers = loadMcpServers();
      expect(servers[BROKER_SERVER_NAME]).toBeDefined();
      expect(servers[BROKER_SERVER_NAME].command).toBe("npx");
      expect(servers[BROKER_SERVER_NAME].args).toEqual(["-y", "mcp-broker", "serve"]);
      expect(servers[BROKER_SERVER_NAME].env?.MCP_BROKER_HOME).toBe(BROKER_DATA_DIR);
    });

    it("preserves other MCP servers", () => {
      saveMcpServers({ memory: { command: "npx", args: ["-y", "server-memory"] } });
      saveConfig(testConfig);
      syncBrokerConfig();
      const servers = loadMcpServers();
      expect(servers.memory).toBeDefined();
      expect(servers[BROKER_SERVER_NAME]).toBeDefined();
    });

    it("no-ops when not configured", () => {
      syncBrokerConfig();
      expect(fs.existsSync(MCP_CONFIG_PATH)).toBe(false);
    });

    it("writes only user-added servers to broker servers.json", () => {
      saveMcpServers({
        cron: { command: "npx", args: ["-y", "mcp-cron", "--mcp-config-path", "./data/mcp.json"] },
        memory: { command: "npx", args: ["-y", "server-memory"] },
        filesystem: { command: "npx", args: ["-y", "server-filesystem", "."] },
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      });
      saveConfig(testConfig);
      syncBrokerConfig();
      const content = JSON.parse(fs.readFileSync(BROKER_SERVERS_PATH, "utf-8"));
      expect(content.mcpServers.filesystem).toBeDefined();
      expect(content.mcpServers.github).toBeDefined();
      expect(content.mcpServers.cron).toBeUndefined();
      expect(content.mcpServers.memory).toBeUndefined();
      expect(content.mcpServers[BROKER_SERVER_NAME]).toBeUndefined();
    });

    it("sets servers.json permissions to 0600 (may contain API keys)", () => {
      saveMcpServers({ filesystem: { command: "npx", args: ["-y", "server-filesystem", "."], env: { API_KEY: "secret" } } });
      saveConfig(testConfig);
      syncBrokerConfig();
      const stats = fs.statSync(BROKER_SERVERS_PATH);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("cleans up servers.json when all user servers removed", () => {
      saveMcpServers({ filesystem: { command: "npx", args: ["-y", "server-filesystem", "."] } });
      saveConfig(testConfig);
      syncBrokerConfig();
      expect(fs.existsSync(BROKER_SERVERS_PATH)).toBe(true);

      saveMcpServers({ cron: { command: "npx", args: ["-y", "mcp-cron"] } });
      syncBrokerConfig();
      expect(fs.existsSync(BROKER_SERVERS_PATH)).toBe(false);
    });

    it("writes agent-facing servers to mcp-agent.json", () => {
      saveMcpServers({
        cron: { command: "npx", args: ["-y", "mcp-cron", "--mcp-config-path", "./data/mcp.json"] },
        filesystem: { command: "npx", args: ["-y", "server-filesystem", "."] },
      });
      saveConfig(testConfig);
      syncBrokerConfig();
      const content = JSON.parse(fs.readFileSync(AGENT_MCP_CONFIG_PATH, "utf-8"));
      expect(content.mcpServers.cron).toBeDefined();
      expect(content.mcpServers[BROKER_SERVER_NAME]).toBeDefined();
      expect(content.mcpServers.filesystem).toBeUndefined();
    });

    it("updates cron --mcp-config-path in mcp.json", () => {
      saveMcpServers({
        cron: { command: "npx", args: ["-y", "mcp-cron", "--mcp-config-path", "./data/mcp.json"] },
      });
      saveConfig(testConfig);
      syncBrokerConfig();
      const servers = loadMcpServers();
      const idx = servers.cron.args.indexOf("--mcp-config-path");
      expect(servers.cron.args[idx + 1]).toBe(AGENT_MCP_CONFIG_PATH);
    });

    it("updates cron args even when mcp-agent.json already has correct content", () => {
      saveMcpServers({
        cron: { command: "npx", args: ["-y", "mcp-cron", "--mcp-config-path", "./data/mcp.json"] },
      });
      saveConfig(testConfig);
      syncBrokerConfig();

      // Revert cron args (simulating setup page save)
      const servers = loadMcpServers();
      const idx = servers.cron.args.indexOf("--mcp-config-path");
      servers.cron.args[idx + 1] = "./data/mcp.json";
      saveMcpServers(servers);

      syncBrokerConfig();
      const updated = loadMcpServers();
      const idx2 = updated.cron.args.indexOf("--mcp-config-path");
      expect(updated.cron.args[idx2 + 1]).toBe(AGENT_MCP_CONFIG_PATH);
    });

    it("skips all writes when unchanged", () => {
      saveMcpServers({
        cron: { command: "npx", args: ["-y", "mcp-cron", "--mcp-config-path", AGENT_MCP_CONFIG_PATH] },
      });
      saveConfig(testConfig);
      syncBrokerConfig(); // first call writes
      const spy = vi.spyOn(fs, "writeFileSync");
      syncBrokerConfig(); // second call should skip
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("getAgentMcpServers", () => {
    it("returns only built-in + broker when broker is present", () => {
      saveMcpServers({
        cron: { command: "npx", args: ["-y", "mcp-cron"] },
        memory: { command: "npx", args: ["-y", "server-memory"] },
        [BROKER_SERVER_NAME]: { command: "npx", args: ["-y", "mcp-broker", "serve"] },
        filesystem: { command: "npx", args: ["-y", "server-filesystem", "."] },
      });
      const servers = getAgentMcpServers();
      expect(servers.cron).toBeDefined();
      expect(servers.memory).toBeDefined();
      expect(servers[BROKER_SERVER_NAME]).toBeDefined();
      expect(servers.filesystem).toBeUndefined();
    });

    it("returns all servers when broker is absent (fallback)", () => {
      saveMcpServers({
        cron: { command: "npx", args: ["-y", "mcp-cron"] },
        filesystem: { command: "npx", args: ["-y", "server-filesystem", "."] },
      });
      const servers = getAgentMcpServers();
      expect(servers.cron).toBeDefined();
      expect(servers.filesystem).toBeDefined();
    });
  });

  describe("broker integration — full sync flow", () => {
    it("syncs servers through add, update, and remove lifecycle", () => {
      saveConfig(testConfig);

      saveMcpServers({
        cron: { command: "npx", args: ["-y", "mcp-cron", "--mcp-config-path", "./data/mcp.json"] },
        memory: { command: "npx", args: ["-y", "server-memory"] },
        filesystem: { command: "npx", args: ["-y", "server-filesystem", "."] },
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      });

      // Initial sync: broker added, user servers extracted, agent config written
      syncBrokerConfig();
      let servers = loadMcpServers();
      expect(servers[BROKER_SERVER_NAME]).toBeDefined();
      let brokerConfig = JSON.parse(fs.readFileSync(BROKER_SERVERS_PATH, "utf-8"));
      expect(Object.keys(brokerConfig.mcpServers).sort()).toEqual(["filesystem", "github"]);
      let agentServers = getAgentMcpServers();
      expect(Object.keys(agentServers).sort()).toEqual([BROKER_SERVER_NAME, "cron", "memory"]);

      // Add a new user server
      servers = loadMcpServers();
      servers.slack = { command: "npx", args: ["-y", "server-slack"] };
      saveMcpServers(servers);
      syncBrokerConfig();
      brokerConfig = JSON.parse(fs.readFileSync(BROKER_SERVERS_PATH, "utf-8"));
      expect(Object.keys(brokerConfig.mcpServers).sort()).toEqual(["filesystem", "github", "slack"]);

      // Remove all user servers
      servers = loadMcpServers();
      delete servers.filesystem;
      delete servers.github;
      delete servers.slack;
      saveMcpServers(servers);
      syncBrokerConfig();
      expect(fs.existsSync(BROKER_SERVERS_PATH)).toBe(false);

      agentServers = getAgentMcpServers();
      expect(agentServers[BROKER_SERVER_NAME]).toBeDefined();
      expect(agentServers.cron).toBeDefined();
      expect(agentServers.memory).toBeDefined();
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
