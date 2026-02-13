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
import { saveConfig, saveMcpServers, DATA_DIR, MCP_CONFIG_PATH, type Config } from "../src/config.js";
import { closeDb, createConversation, getConversation, saveMessage, getMessages } from "../src/sessions.js";
import { UPLOADS_DIR } from "../src/uploads.js";

const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const DB_PATH = path.join(DATA_DIR, "sessions.db");

const testConfig: Config = {
  provider: "claude",
  claude: { apiKey: "sk-ant-test123456", model: "claude-sonnet-4-5-20250929", baseUrl: "" },
  openai: { apiKey: "sk-test789", model: "gpt-4o", baseUrl: "" },
  server: { port: 3000 },
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
    if (fs.existsSync(UPLOADS_DIR)) fs.rmSync(UPLOADS_DIR, { recursive: true });
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

  it("POST /api/setup saves mcpServers to mcp.json when included", async () => {
    const app = createApp();
    const payload = { ...testConfig, mcpServers: { memory: { command: "npx", args: ["-y", "server-memory"] } } };
    const res = await makeRequest(app, "POST", "/api/setup", true, payload);
    expect(res.status).toBe(200);
    expect(fs.existsSync(MCP_CONFIG_PATH)).toBe(true);
    const mcpConfig = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf-8"));
    expect(mcpConfig.mcpServers.memory.command).toBe("npx");
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

  it("GET /api/config does not include mcpServers", async () => {
    saveConfig(testConfig);
    const app = createApp();
    const res = await makeRequest(app, "GET", "/api/config");
    const body = await res.json();
    expect(body.config).not.toHaveProperty("mcpServers");
  });

  it("GET /api/mcp-servers returns saved MCP servers", async () => {
    const servers = { memory: { command: "npx", args: ["-y", "server-memory"] } };
    saveMcpServers(servers);
    const app = createApp();
    const res = await makeRequest(app, "GET", "/api/mcp-servers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mcpServers.memory.command).toBe("npx");
  });

  it("GET /api/mcp-servers returns empty when no mcp.json", async () => {
    const app = createApp();
    const res = await makeRequest(app, "GET", "/api/mcp-servers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mcpServers).toEqual({});
  });

  it("POST /api/mcp-servers saves MCP servers", async () => {
    const app = createApp();
    const servers = { fs: { command: "npx", args: ["-y", "server-fs"] } };
    const res = await makeRequest(app, "POST", "/api/mcp-servers", true, { mcpServers: servers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(fs.existsSync(MCP_CONFIG_PATH)).toBe(true);
  });

  it("POST /api/setup preserves existing API key and model when omitted", async () => {
    // Temporarily clear env var so loadConfig() uses the file value as-is
    const savedEnvKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      saveConfig(testConfig);
      const app = createApp();

      // Second save omits apiKey and model (simulates editing MCP servers only)
      const partialConfig = {
        provider: "claude",
        claude: { baseUrl: "" },
        openai: {},
        server: { port: 3000 },
      };
      const res = await makeRequest(app, "POST", "/api/setup", true, partialConfig);
      expect(res.status).toBe(200);

      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      expect(saved.claude.apiKey).toBe(testConfig.claude.apiKey);
      expect(saved.claude.model).toBe(testConfig.claude.model);
    } finally {
      process.env.ANTHROPIC_API_KEY = savedEnvKey;
    }
  });

  it("POST /api/setup overwrites API key when provided", async () => {
    saveConfig(testConfig);
    const app = createApp();

    const updated = {
      provider: "claude",
      claude: { apiKey: "sk-ant-new-key-12345", model: "claude-opus-4-20250918", baseUrl: "" },
      openai: {},
      server: { port: 3000 },
    };
    const res = await makeRequest(app, "POST", "/api/setup", true, updated);
    expect(res.status).toBe(200);

    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    expect(saved.claude.apiKey).toBe("sk-ant-new-key-12345");
    expect(saved.claude.model).toBe("claude-opus-4-20250918");
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

  it("POST /api/upload accepts valid image and returns metadata", async () => {
    saveConfig(testConfig);
    const app = createApp();
    const res = await makeUploadRequest(app, "test.png", "image/png", Buffer.from("fake-png"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fileId).toBeTruthy();
    expect(body.filename).toBe("test.png");
    expect(body.mimeType).toBe("image/png");
    expect(body.size).toBe(8);
  });

  it("POST /api/upload rejects unsupported MIME type", async () => {
    saveConfig(testConfig);
    const app = createApp();
    const res = await makeUploadRequest(app, "doc.pdf", "application/pdf", Buffer.from("fake-pdf"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Unsupported file type");
  });

  it("GET /api/uploads/:fileId serves uploaded file", async () => {
    saveConfig(testConfig);
    const app = createApp();
    const imageData = Buffer.from("fake-image-bytes");
    const uploadRes = await makeUploadRequest(app, "photo.jpg", "image/jpeg", imageData);
    const { fileId } = await uploadRes.json();

    const res = await makeRequest(app, "GET", `/api/uploads/${fileId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(imageData)).toBe(true);
  });

  it("GET /api/uploads/:fileId returns 404 for unknown id", async () => {
    saveConfig(testConfig);
    const app = createApp();
    const res = await makeRequest(app, "GET", "/api/uploads/nonexistent");
    expect(res.status).toBe(404);
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

// Helper to make multipart upload requests
async function makeUploadRequest(
  app: ReturnType<typeof createApp>,
  filename: string,
  mimeType: string,
  data: Buffer
): Promise<Response> {
  const { createServer } = await import("node:http");
  const server = createServer(app);

  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const addr = server.address() as { port: number };
      try {
        const form = new FormData();
        form.append("file", new Blob([data], { type: mimeType }), filename);
        const res = await fetch(`http://localhost:${addr.port}/api/upload`, {
          method: "POST",
          body: form,
        });
        resolve(res);
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}
