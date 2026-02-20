import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH, MCP_CONFIG_PATH, DATA_DIR, type Config } from "../src/config.js";

export { CONFIG_PATH, MCP_CONFIG_PATH, DATA_DIR };

export const DB_PATH = path.join(DATA_DIR, "sessions.db");

export const testConfig: Config = {
  provider: "claude",
  claude: { apiKey: "sk-ant-test123456", model: "claude-sonnet-4-5-20250929", baseUrl: "" },
  openai: { apiKey: "sk-openai-test789", model: "gpt-4o", baseUrl: "" },
  server: { port: 3000 },
};

export function cleanupConfigFiles() {
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  if (fs.existsSync(MCP_CONFIG_PATH)) fs.unlinkSync(MCP_CONFIG_PATH);
}

export function cleanupDbFiles() {
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}
