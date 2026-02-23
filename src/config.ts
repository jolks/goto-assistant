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
export const MEMORY_SERVER_NAME = "memory";
export const MAX_AGENT_TURNS = 30;

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

export const MESSAGING_SERVER_NAME = "messaging";

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
    servers[MESSAGING_SERVER_NAME] = {
      command: "node",
      args: [entryPoint],
      env: { GOTO_ASSISTANT_URL: url },
    };
  } else {
    delete servers[MESSAGING_SERVER_NAME];
  }

  saveMcpServers(servers);
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
