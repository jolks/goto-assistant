import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.hoisted(() => {
  process.env.GOTO_DATA_DIR = "tests/data";
});

// Mock agent modules to avoid real SDK calls
vi.mock("../src/agents/claude.js", () => ({
  runClaude: vi.fn().mockResolvedValue({ sessionId: null, conversationId: "" }),
}));
vi.mock("../src/agents/openai.js", () => ({
  runOpenAI: vi.fn().mockResolvedValue(undefined),
}));

import { createApp } from "../src/server.js";
import { saveConfig, DATA_DIR, MCP_CONFIG_PATH, type Config } from "../src/config.js";
import { closeDb, createConversation, getConversation, saveMessage, getMessages } from "../src/sessions.js";

const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const DB_PATH = path.join(DATA_DIR, "sessions.db");

const testConfig: Config = {
  provider: "claude",
  claude: { apiKey: "sk-ant-test123456", model: "claude-sonnet-4-5-20250929", baseUrl: "" },
  openai: { apiKey: "sk-test789", model: "gpt-4o", baseUrl: "" },
  server: { port: 3000 },
  mcpServers: {},
};

describe("server", () => {
  beforeEach(() => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    if (fs.existsSync(MCP_CONFIG_PATH)) fs.unlinkSync(MCP_CONFIG_PATH);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    if (fs.existsSync(MCP_CONFIG_PATH)) fs.unlinkSync(MCP_CONFIG_PATH);
    for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("GET /health returns 200", async () => {
    const app = createApp();
    const res = await makeRequest(app, "GET", "/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("GET / redirects to /setup.html when unconfigured", async () => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    const app = createApp();
    const res = await makeRequest(app, "GET", "/", false);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/setup.html");
  });

  it("serves static .js and .css files when unconfigured", async () => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    const app = createApp();
    const jsRes = await makeRequest(app, "GET", "/cron-sync.js", false);
    expect(jsRes.status).toBe(200);
    const cssRes = await makeRequest(app, "GET", "/style.css", false);
    expect(cssRes.status).toBe(200);
  });

  it("POST /api/setup saves config", async () => {
    const app = createApp();
    const res = await makeRequest(app, "POST", "/api/setup", true, testConfig);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(fs.existsSync(CONFIG_PATH)).toBe(true);
  });

  it("GET /api/config returns masked config when configured", async () => {
    saveConfig(testConfig);
    const app = createApp();
    const res = await makeRequest(app, "GET", "/api/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.config.claude.apiKey).toContain("****");
    expect(body.config.claude.apiKey).not.toBe(testConfig.claude.apiKey);
  });

  it("GET /api/config returns configured:false when not configured", async () => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    const app = createApp();
    const res = await makeRequest(app, "GET", "/api/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(false);
  });

  it("GET /api/conversations/:id/messages returns saved messages", async () => {
    saveConfig(testConfig);
    const app = createApp();
    const conv = createConversation("claude");
    saveMessage(conv.id, "user", "Hello");
    saveMessage(conv.id, "assistant", "Hi!");

    const res = await makeRequest(app, "GET", `/api/conversations/${conv.id}/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages.length).toBe(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toBe("Hello");
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[1].content).toBe("Hi!");
  });

  it("GET /api/conversations/:id/messages returns empty for unknown id", async () => {
    saveConfig(testConfig);
    const app = createApp();
    const res = await makeRequest(app, "GET", "/api/conversations/nonexistent/messages");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  it("DELETE /api/conversations/:id removes conversation and messages", async () => {
    saveConfig(testConfig);
    const app = createApp();
    const conv = createConversation("claude");
    saveMessage(conv.id, "user", "Hello");

    const res = await makeRequest(app, "DELETE", `/api/conversations/${conv.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(getConversation(conv.id)).toBeUndefined();
    expect(getMessages(conv.id)).toEqual([]);
  });
});

// Helper to make requests to Express app without starting a server
async function makeRequest(
  app: ReturnType<typeof createApp>,
  method: string,
  urlPath: string,
  followRedirects: boolean = true,
  body?: unknown
): Promise<Response> {
  const { createServer } = await import("node:http");
  const server = createServer(app);

  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const addr = server.address() as { port: number };
      try {
        const url = `http://localhost:${addr.port}${urlPath}`;
        const opts: RequestInit = {
          method,
          redirect: followRedirects ? "follow" : "manual",
        };
        if (body) {
          opts.headers = { "Content-Type": "application/json" };
          opts.body = JSON.stringify(body);
        }
        const res = await fetch(url, opts);
        resolve(res);
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}
