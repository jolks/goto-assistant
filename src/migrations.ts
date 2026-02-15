import { isConfigured, loadConfig, saveConfig, loadMcpServers, saveMcpServers, type McpServerConfig } from "./config.js";

export const CURRENT_CONFIG_VERSION = 1;

type Migration = (servers: Record<string, McpServerConfig>) => void;

const migrations: Record<number, Migration> = {
  1: (servers) => {
    if (!("time" in servers)) {
      servers.time = { command: "uvx", args: ["mcp-server-time"] };
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
