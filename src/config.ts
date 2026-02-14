import fs from "node:fs";
import path from "node:path";

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface Config {
  provider: "claude" | "openai";
  claude: { apiKey: string; model: string; baseUrl: string };
  openai: { apiKey: string; model: string; baseUrl: string };
  server: { port: number };
}

export const DATA_DIR = process.env.GOTO_DATA_DIR || path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const MCP_CONFIG_PATH = path.join(DATA_DIR, "mcp.json");
export const MEMORY_FILE_PATH = path.join(DATA_DIR, "memory.json");
export const MEMORY_SERVER_NAME = "memory";

export function isConfigured(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

export function loadConfig(): Config {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config: Config = JSON.parse(raw);

  // Environment variables override config file values
  if (process.env.ANTHROPIC_API_KEY) {
    config.claude.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.OPENAI_API_KEY) {
    config.openai.apiKey = process.env.OPENAI_API_KEY;
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
