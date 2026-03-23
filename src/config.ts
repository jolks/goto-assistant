import fs from "node:fs";
import path from "node:path";

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface WhatsAppConfig {
  enabled: boolean;
}

export interface Config {
  provider: "claude" | "openai";
  claude: { apiKey: string; model: string; baseUrl: string };
  openai: { apiKey: string; model: string; baseUrl: string };
  server: { port: number };
  whatsapp?: WhatsAppConfig;
  configVersion?: number;
}

export const DATA_DIR = process.env.GOTO_DATA_DIR || path.join(process.cwd(), "data");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const MCP_CONFIG_PATH = path.join(DATA_DIR, "mcp.json");
export const MEMORY_FILE_PATH = path.join(DATA_DIR, "memory.json");
export const SEMANTIC_MEMORY_SERVER_NAME = "memory";
export const MAX_AGENT_TURNS = 30;
export const MAX_HISTORY_MESSAGES = 100;
export const RECENT_IMAGE_WINDOW = 10;
export const MCP_PROTOCOL_VERSION = "2024-11-05";

export function isConfigured(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

export function loadConfig(): Config {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config: Config = JSON.parse(raw);

  // Default whatsapp config if missing
  if (!config.whatsapp) {
    config.whatsapp = { enabled: false };
  }

  // Environment variables override config file values
  if (process.env.ANTHROPIC_API_KEY) {
    config.claude.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.OPENAI_API_KEY) {
    config.openai.apiKey = process.env.OPENAI_API_KEY;
  }
  if (process.env.PORT) {
    config.server.port = Number(process.env.PORT);
  }

  return config;
}

export function saveConfig(config: Config): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function loadMcpServers(): Record<string, McpServerConfig> {
  if (!fs.existsSync(MCP_CONFIG_PATH)) return {};
  const raw = fs.readFileSync(MCP_CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  return parsed.mcpServers ?? {};
}

export function saveMcpServers(servers: Record<string, McpServerConfig>): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers: servers }, null, 2));
}

export function isMaskedValue(value: string): boolean {
  return value.includes("****");
}

/**
 * Restore masked env values from existing on-disk servers and app config.
 *
 * Pass 1: if the same env key exists in the existing server, use the real value.
 * Pass 2: if the value is still masked and looks like a known API key env var,
 *         resolve it from config.json (handles provider switches where the key
 *         name changed, e.g. ANTHROPIC_API_KEY → OPENAI_API_KEY).
 */
export function unmaskMcpServers(
  incoming: Record<string, McpServerConfig>,
  existing: Record<string, McpServerConfig>,
  config?: Config
): Record<string, McpServerConfig> {
  // Map known env key names to their real values from config
  const configKeyMap: Record<string, string> = {};
  if (config) {
    if (config.claude.apiKey) configKeyMap["ANTHROPIC_API_KEY"] = config.claude.apiKey;
    if (config.openai.apiKey) configKeyMap["OPENAI_API_KEY"] = config.openai.apiKey;
    // MCP_CRON_AI_API_KEY is used with proxy — it should match the active provider's key
    const activeKey = config[config.provider]?.apiKey;
    if (activeKey) configKeyMap["MCP_CRON_AI_API_KEY"] = activeKey;
  }

  return Object.fromEntries(
    Object.entries(incoming).map(([name, server]) => {
      if (!server.env) return [name, server];

      const mergedEnv = Object.fromEntries(
        Object.entries(server.env).map(([k, v]) => {
          if (!isMaskedValue(v)) return [k, v];

          // Pass 1: restore from existing on-disk server
          const existingServer = existing[name];
          if (existingServer?.env?.[k]) {
            return [k, existingServer.env[k]];
          }

          // Pass 2: resolve from app config (handles provider switches)
          if (configKeyMap[k]) {
            return [k, configKeyMap[k]];
          }

          return [k, v];
        })
      );

      return [name, { ...server, env: mergedEnv }];
    })
  );
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

export function getMaskedConfig(config: Config): Config {
  return {
    ...config,
    claude: { ...config.claude, apiKey: maskApiKey(config.claude.apiKey) },
    openai: { ...config.openai, apiKey: maskApiKey(config.openai.apiKey) },
  };
}

export const CRON_SERVER_NAME = "cron";
export const MESSAGING_SERVER_NAME = "messaging";
export const EPISODIC_SERVER_NAME = "episodic-memory";
export const BROKER_SERVER_NAME = "broker";
export const TIME_SERVER_NAME = "time";
const BROKER_DATA_DIR = path.join(DATA_DIR, "mcp-broker");
const BROKER_SERVERS_PATH = path.join(BROKER_DATA_DIR, "servers.json");
const BUILTIN_SERVER_NAMES = new Set([CRON_SERVER_NAME, SEMANTIC_MEMORY_SERVER_NAME, MESSAGING_SERVER_NAME, EPISODIC_SERVER_NAME, BROKER_SERVER_NAME, TIME_SERVER_NAME]);

/**
 * Auto-manage the messaging MCP server entry in mcp.json.
 * Adds when any messaging channel is enabled; removes when none are.
 * Updates GOTO_ASSISTANT_URL when the port changes.
 */
export function syncMessagingMcpServer(config?: Config): void {
  const cfg = config ?? (isConfigured() ? loadConfig() : undefined);
  if (!cfg) return;

  const servers = loadMcpServers();
  const hasMessagingChannel = cfg.whatsapp?.enabled === true;
  const port = cfg.server.port;
  const url = `http://localhost:${port}`;

  if (hasMessagingChannel) {
    // Always resolve to dist/ — works in both dev (src/../dist/) and prod (dist/../dist/)
    const entryPoint = path.resolve(import.meta.dirname, "..", "dist", "mcp-messaging.js");
    const desired: McpServerConfig = { command: "node", args: [entryPoint], env: { GOTO_ASSISTANT_URL: url } };
    // Key order is deterministic (both objects built programmatically).
    // Hand-edited mcp.json with different key order causes a harmless re-write.
    if (JSON.stringify(servers[MESSAGING_SERVER_NAME]) === JSON.stringify(desired)) return;
    servers[MESSAGING_SERVER_NAME] = desired;
  } else {
    if (!(MESSAGING_SERVER_NAME in servers)) return;
    delete servers[MESSAGING_SERVER_NAME];
  }

  saveMcpServers(servers);
}

/**
 * Auto-manage the episodic-memory MCP server entry in mcp.json.
 * Always adds the entry (episodic memory is universally useful).
 * Resolves MCP_CRON_DB_PATH from cron config's --db-path arg or default.
 */
export function syncEpisodicMcpServer(): void {
  if (!isConfigured()) return;

  const servers = loadMcpServers();

  // Resolve cron DB path from cron config's --db-path arg, fall back to default
  let cronDbPath = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".mcp-cron",
    "results.db"
  );
  const cronConfig = servers[CRON_SERVER_NAME];
  if (cronConfig) {
    const dbIdx = cronConfig.args.indexOf("--db-path");
    if (dbIdx !== -1 && cronConfig.args[dbIdx + 1]) {
      cronDbPath = cronConfig.args[dbIdx + 1];
    }
  }

  const entryPoint = path.resolve(import.meta.dirname, "..", "dist", "mcp-episodic.js");
  const desired: McpServerConfig = {
    command: "node",
    args: [entryPoint],
    env: {
      GOTO_DATA_DIR: DATA_DIR,
      MCP_CRON_DB_PATH: cronDbPath,
    },
  };

  if (JSON.stringify(servers[EPISODIC_SERVER_NAME]) === JSON.stringify(desired)) return;
  servers[EPISODIC_SERVER_NAME] = desired;
  saveMcpServers(servers);
}

/**
 * Return the MCP servers that should be passed to agents.
 * When broker is present: returns only built-in + broker servers (user servers go through broker).
 * When broker is absent: returns all servers (graceful fallback).
 */
export function getAgentMcpServers(servers?: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const allServers = servers ?? loadMcpServers();
  if (!(BROKER_SERVER_NAME in allServers)) return allServers;

  const agentServers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(allServers)) {
    if (BUILTIN_SERVER_NAMES.has(name)) {
      agentServers[name] = config;
    }
  }
  return agentServers;
}

export const AGENT_MCP_CONFIG_PATH = path.join(DATA_DIR, "mcp-agent.json");

/**
 * Sync all broker-related config: add broker to mcp.json, write user servers
 * to broker's servers.json, write agent-facing config to mcp-agent.json,
 * and update cron's --mcp-config-path to point to mcp-agent.json.
 */
export function syncBrokerConfig(servers?: Record<string, McpServerConfig>): void {
  if (!isConfigured()) return;
  if (!servers) servers = loadMcpServers();

  // 1. Ensure broker entry exists in mcp.json
  const desiredBroker: McpServerConfig = {
    command: "npx",
    args: ["-y", "mcp-broker", "serve"],
    env: { MCP_BROKER_HOME: BROKER_DATA_DIR },
  };
  if (JSON.stringify(servers[BROKER_SERVER_NAME]) !== JSON.stringify(desiredBroker)) {
    servers[BROKER_SERVER_NAME] = desiredBroker;
    saveMcpServers(servers);
  }

  // 2. Write user-added servers to broker's servers.json
  const userServers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (!BUILTIN_SERVER_NAMES.has(name)) {
      userServers[name] = config;
    }
  }
  if (Object.keys(userServers).length === 0) {
    try { fs.unlinkSync(BROKER_SERVERS_PATH); } catch { /* already absent */ }
  } else {
    const desiredJson = JSON.stringify({ mcpServers: userServers }, null, 2);
    let current: string | undefined;
    try { current = fs.readFileSync(BROKER_SERVERS_PATH, "utf-8"); } catch { /* missing */ }
    if (current !== desiredJson) {
      fs.mkdirSync(BROKER_DATA_DIR, { recursive: true });
      fs.writeFileSync(BROKER_SERVERS_PATH, desiredJson, { mode: 0o600 });
    }
  }

  // 3. Update cron's --mcp-config-path to point to mcp-agent.json
  const cronConfig = servers[CRON_SERVER_NAME];
  if (cronConfig) {
    const idx = cronConfig.args.indexOf("--mcp-config-path");
    if (idx !== -1 && cronConfig.args[idx + 1] && cronConfig.args[idx + 1] !== AGENT_MCP_CONFIG_PATH) {
      cronConfig.args[idx + 1] = AGENT_MCP_CONFIG_PATH;
      saveMcpServers(servers);
    }
  }

  // 4. Write agent-facing servers to mcp-agent.json
  const agentServers = getAgentMcpServers(servers);
  const desiredAgent = JSON.stringify({ mcpServers: agentServers }, null, 2);
  let currentAgent: string | undefined;
  try { currentAgent = fs.readFileSync(AGENT_MCP_CONFIG_PATH, "utf-8"); } catch { /* missing */ }
  if (currentAgent !== desiredAgent) {
    fs.writeFileSync(AGENT_MCP_CONFIG_PATH, desiredAgent);
  }
}

/**
 * Hostnames known to support the OpenAI Responses API. All other custom base
 * URLs default to the Chat Completions API, which is the universally supported
 * format across third-party proxies (LiteLLM, Ollama, vLLM, Groq, etc.) and
 * translates correctly to non-OpenAI backends like Anthropic.
 */
export const RESPONSES_API_HOSTS = [
  "api.openai.com",
] as const;

/**
 * Returns true if baseUrl points to a server known to support the OpenAI
 * Responses API. When baseUrl is undefined/empty (direct OpenAI default) or
 * matches a known Responses API host, this returns true.
 */
export function isResponsesAPICapable(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  return RESPONSES_API_HOSTS.some((host) => baseUrl.includes(host));
}

export function getMaskedMcpServers(
  servers: Record<string, McpServerConfig>
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      {
        ...server,
        env: server.env
          ? Object.fromEntries(
              Object.entries(server.env).map(([k, v]) =>
                k.toLowerCase().includes("key") || k.toLowerCase().includes("secret")
                  ? [k, maskApiKey(v)]
                  : [k, v]
              )
            )
          : undefined,
      },
    ])
  );
}
