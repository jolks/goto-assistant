import { isConfigured, loadConfig, saveConfig, loadMcpServers, saveMcpServers, MCP_CONFIG_PATH, type McpServerConfig } from "./config.js";

export const CURRENT_CONFIG_VERSION = 2;

type Migration = (servers: Record<string, McpServerConfig>) => void;

const migrations: Record<number, Migration> = {
  1: (servers) => {
    if (!("time" in servers)) {
      servers.time = { command: "uvx", args: ["mcp-server-time"] };
    }
  },
  2: (servers) => {
    const cron = servers.cron;
    if (!cron) return;
    const idx = cron.args.indexOf("./data/mcp.json");
    if (idx !== -1) {
      cron.args[idx] = MCP_CONFIG_PATH;
    }
  },
};

export function runMigrations(): void {
  if (!isConfigured()) return;

  const config = loadConfig();
  const currentVersion = config.configVersion ?? 0;

  if (currentVersion >= CURRENT_CONFIG_VERSION) return;

  const servers = loadMcpServers();

  for (let v = currentVersion + 1; v <= CURRENT_CONFIG_VERSION; v++) {
    const migrate = migrations[v];
    if (migrate) migrate(servers);
  }

  saveMcpServers(servers);
  config.configVersion = CURRENT_CONFIG_VERSION;
  saveConfig(config);
}
