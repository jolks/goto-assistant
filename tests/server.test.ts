import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

// Mock agent modules to avoid real SDK calls
vi.mock("../src/agents/claude.js", () => ({
  runClaude: vi.fn().mockResolvedValue({ sessionId: null, conversationId: "" }),
}));
vi.mock("../src/agents/openai.js", () => ({
  runOpenAI: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/cron.js", () => ({
  startCronServer: vi.fn().mockResolvedValue(undefined),
  restartCronServer: vi.fn().mockResolvedValue(undefined),
  stopCronServer: vi.fn().mockResolvedValue(undefined),
  isCronRunning: vi.fn().mockReturnValue(false),
  callCronTool: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/whatsapp.js", () => ({
  startWhatsApp: vi.fn().mockResolvedValue(undefined),
  stopWhatsApp: vi.fn().mockResolvedValue(undefined),
  sendWhatsAppMessage: vi.fn().mockResolvedValue(1),
  getWhatsAppStatus: vi.fn().mockReturnValue("disconnected"),
  getWhatsAppQrDataUri: vi.fn().mockResolvedValue(null),
}));

import { createApp } from "../src/server.js";
import { stopCronServer, isCronRunning, callCronTool } from "../src/cron.js";
import { registerChannel, unregisterChannel, listChannels } from "../src/messaging.js";
import { saveConfig, saveMcpServers, MCP_CONFIG_PATH } from "../src/config.js";
import { CURRENT_CONFIG_VERSION } from "../src/migrations.js";
import { closeDb, createConversation, getConversation, saveMessage, getMessages } from "../src/sessions.js";
import { UPLOADS_DIR } from "../src/uploads.js";
import { CONFIG_PATH, testConfig, cleanupConfigFiles, cleanupDbFiles } from "./helpers.js";

describe("server", () => {
  beforeEach(() => {
    cleanupConfigFiles();
  });

  afterEach(async () => {
    await stopCronServer();
    closeDb();
    cleanupConfigFiles();
    cleanupDbFiles();
    if (fs.existsSync(UPLOADS_DIR)) fs.rmSync(UPLOADS_DIR, { recursive: true });
    // Clean up messaging channels
    for (const name of listChannels()) {
      unregisterChannel(name);
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

  it("POST /api/setup saves config with configVersion", async () => {
    const app = createApp();
    const res = await makeRequest(app, "POST", "/api/setup", true, testConfig);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(fs.existsSync(CONFIG_PATH)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    expect(saved.configVersion).toBe(CURRENT_CONFIG_VERSION);
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
    expect(body.mcpConfigPath).toBe(MCP_CONFIG_PATH);
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

  it("POST /api/mcp-servers preserves real API key when masked value is sent", async () => {
    // Pre-save servers with a real API key
    saveMcpServers({
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron"],
        env: { ANTHROPIC_API_KEY: "sk-ant-real-secret-key-123" },
      },
    });
    const app = createApp();

    // Simulate frontend sending back the masked value
    const res = await makeRequest(app, "POST", "/api/mcp-servers", true, {
      mcpServers: {
        cron: {
          command: "npx",
          args: ["-y", "mcp-cron"],
          env: { ANTHROPIC_API_KEY: "sk-a****-123" },
        },
      },
    });
    expect(res.status).toBe(200);

    // Verify the real key was preserved on disk
    const saved = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf-8"));
    expect(saved.mcpServers.cron.env.ANTHROPIC_API_KEY).toBe("sk-ant-real-secret-key-123");
  });

  it("POST /api/setup preserves real MCP API key when masked value is sent", async () => {
    saveConfig(testConfig);
    saveMcpServers({
      cron: {
        command: "npx",
        args: ["-y", "mcp-cron"],
        env: { OPENAI_API_KEY: "sk-openai-real-key-456" },
      },
    });
    const app = createApp();

    const payload = {
      ...testConfig,
      mcpServers: {
        cron: {
          command: "npx",
          args: ["-y", "mcp-cron"],
          env: { OPENAI_API_KEY: "sk-o****-456" },
        },
      },
    };
    const res = await makeRequest(app, "POST", "/api/setup", true, payload);
    expect(res.status).toBe(200);

    const saved = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf-8"));
    expect(saved.mcpServers.cron.env.OPENAI_API_KEY).toBe("sk-openai-real-key-456");
  });

  it("POST /api/mcp-servers resolves masked key from config after provider switch", async () => {
    // Temporarily clear env vars so loadConfig() uses file values
    const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const savedOpenaiKey = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      // Config has real keys for both providers
      saveConfig(testConfig);
      // Cron currently uses ANTHROPIC_API_KEY
      saveMcpServers({
        cron: {
          command: "npx",
          args: ["-y", "mcp-cron"],
          env: { ANTHROPIC_API_KEY: "sk-ant-test123456" },
        },
      });
      const app = createApp();

      // Frontend switched to OpenAI — env key changed, value is masked from config
      const res = await makeRequest(app, "POST", "/api/mcp-servers", true, {
        mcpServers: {
          cron: {
            command: "npx",
            args: ["-y", "mcp-cron"],
            env: { OPENAI_API_KEY: "sk-o****t789" },
          },
        },
      });
      expect(res.status).toBe(200);

      // Backend should resolve the real OpenAI key from config.json
      const saved = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf-8"));
      expect(saved.mcpServers.cron.env.OPENAI_API_KEY).toBe("sk-openai-test789");
    } finally {
      if (savedAnthropicKey) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
      if (savedOpenaiKey) process.env.OPENAI_API_KEY = savedOpenaiKey;
    }
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
    expect(body.mcpConfigPath).toBe(MCP_CONFIG_PATH);
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

  describe("task API endpoints", () => {
    beforeEach(() => {
      saveConfig(testConfig);
      vi.mocked(isCronRunning).mockReturnValue(false);
      vi.mocked(callCronTool).mockReset();
    });

    it("GET /api/tasks returns [] when cron not running", async () => {
      const app = createApp();
      const res = await makeRequest(app, "GET", "/api/tasks");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
      expect(callCronTool).not.toHaveBeenCalled();
    });

    it("GET /api/tasks calls list_tasks when cron running", async () => {
      vi.mocked(isCronRunning).mockReturnValue(true);
      vi.mocked(callCronTool).mockResolvedValue([{ id: "1", name: "test" }]);
      const app = createApp();
      const res = await makeRequest(app, "GET", "/api/tasks");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([{ id: "1", name: "test" }]);
      expect(callCronTool).toHaveBeenCalledWith("list_tasks");
    });

    it("GET /api/tasks returns 500 on callCronTool error", async () => {
      vi.mocked(isCronRunning).mockReturnValue(true);
      vi.mocked(callCronTool).mockRejectedValue(new Error("cron failed"));
      const app = createApp();
      const res = await makeRequest(app, "GET", "/api/tasks");
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("cron failed");
    });

    it("GET /api/tasks/:id calls get_task with correct id", async () => {
      vi.mocked(callCronTool).mockResolvedValue({ id: "abc", name: "my task" });
      const app = createApp();
      const res = await makeRequest(app, "GET", "/api/tasks/abc");
      expect(res.status).toBe(200);
      expect(callCronTool).toHaveBeenCalledWith("get_task", { id: "abc" });
    });

    it("POST /api/tasks with shell type calls add_task", async () => {
      vi.mocked(callCronTool).mockResolvedValue({ id: "new1" });
      const app = createApp();
      const res = await makeRequest(app, "POST", "/api/tasks", true, {
        type: "shell_command",
        name: "backup",
        command: "echo hello",
      });
      expect(res.status).toBe(200);
      expect(callCronTool).toHaveBeenCalledWith("add_task", { name: "backup", command: "echo hello" });
    });

    it("POST /api/tasks with AI type calls add_ai_task", async () => {
      vi.mocked(callCronTool).mockResolvedValue({ id: "new2" });
      const app = createApp();
      const res = await makeRequest(app, "POST", "/api/tasks", true, {
        type: "AI",
        name: "summary",
        prompt: "summarize today",
      });
      expect(res.status).toBe(200);
      expect(callCronTool).toHaveBeenCalledWith("add_ai_task", { name: "summary", prompt: "summarize today" });
    });

    it("PUT /api/tasks/:id calls update_task with merged id and body", async () => {
      vi.mocked(callCronTool).mockResolvedValue({ ok: true });
      const app = createApp();
      const res = await makeRequest(app, "PUT", "/api/tasks/t1", true, { name: "updated" });
      expect(res.status).toBe(200);
      expect(callCronTool).toHaveBeenCalledWith("update_task", { id: "t1", name: "updated" });
    });

    it("DELETE /api/tasks/:id calls remove_task", async () => {
      vi.mocked(callCronTool).mockResolvedValue({ ok: true });
      const app = createApp();
      const res = await makeRequest(app, "DELETE", "/api/tasks/t1");
      expect(res.status).toBe(200);
      expect(callCronTool).toHaveBeenCalledWith("remove_task", { id: "t1" });
    });

    it("POST /api/tasks/:id/run calls run_task", async () => {
      vi.mocked(callCronTool).mockResolvedValue({ ok: true });
      const app = createApp();
      const res = await makeRequest(app, "POST", "/api/tasks/t1/run");
      expect(res.status).toBe(200);
      expect(callCronTool).toHaveBeenCalledWith("run_task", { id: "t1" });
    });

    it("POST /api/tasks/:id/enable calls enable_task", async () => {
      vi.mocked(callCronTool).mockResolvedValue({ ok: true });
      const app = createApp();
      const res = await makeRequest(app, "POST", "/api/tasks/t1/enable");
      expect(res.status).toBe(200);
      expect(callCronTool).toHaveBeenCalledWith("enable_task", { id: "t1" });
    });

    it("POST /api/tasks/:id/disable calls disable_task", async () => {
      vi.mocked(callCronTool).mockResolvedValue({ ok: true });
      const app = createApp();
      const res = await makeRequest(app, "POST", "/api/tasks/t1/disable");
      expect(res.status).toBe(200);
      expect(callCronTool).toHaveBeenCalledWith("disable_task", { id: "t1" });
    });

    it("GET /api/tasks/:id/results calls get_task_result with default limit=1", async () => {
      vi.mocked(callCronTool).mockResolvedValue([]);
      const app = createApp();
      const res = await makeRequest(app, "GET", "/api/tasks/t1/results");
      expect(res.status).toBe(200);
      expect(callCronTool).toHaveBeenCalledWith("get_task_result", { id: "t1", limit: 1 });
    });

    it("GET /api/tasks/:id/results?limit=5 passes limit=5", async () => {
      vi.mocked(callCronTool).mockResolvedValue([]);
      const app = createApp();
      const res = await makeRequest(app, "GET", "/api/tasks/t1/results?limit=5");
      expect(res.status).toBe(200);
      expect(callCronTool).toHaveBeenCalledWith("get_task_result", { id: "t1", limit: 5 });
    });
  });

  describe("messaging API endpoints", () => {
    beforeEach(() => {
      saveConfig(testConfig);
    });

    it("GET /api/messaging/channels returns empty when no channels registered", async () => {
      const app = createApp();
      const res = await makeRequest(app, "GET", "/api/messaging/channels");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.channels).toEqual([]);
    });

    it("GET /api/messaging/channels returns registered channels", async () => {
      registerChannel("whatsapp", async () => 1);
      const app = createApp();
      const res = await makeRequest(app, "GET", "/api/messaging/channels");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.channels).toEqual(["whatsapp"]);
    });

    it("POST /api/messaging/send returns 400 when channel is missing", async () => {
      const app = createApp();
      const res = await makeRequest(app, "POST", "/api/messaging/send", true, { message: "hi" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("channel is required");
    });

    it("POST /api/messaging/send returns 400 when message is missing", async () => {
      const app = createApp();
      const res = await makeRequest(app, "POST", "/api/messaging/send", true, { channel: "whatsapp" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("message is required");
    });

    it("POST /api/messaging/send returns 400 for unknown channel", async () => {
      const app = createApp();
      const res = await makeRequest(app, "POST", "/api/messaging/send", true, {
        channel: "telegram",
        message: "hi",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Unknown channel: "telegram"');
      expect(body.channels).toEqual([]);
    });

    it("POST /api/messaging/send succeeds for registered channel", async () => {
      let captured: { message: string; to?: string } | undefined;
      registerChannel("whatsapp", async (message, to) => {
        captured = { message, to };
        return 2;
      });
      const app = createApp();
      const res = await makeRequest(app, "POST", "/api/messaging/send", true, {
        channel: "whatsapp",
        message: "hello world",
        to: "+60123456789",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.channel).toBe("whatsapp");
      expect(body.partsSent).toBe(2);
      expect(captured).toEqual({ message: "hello world", to: "+60123456789" });
    });

    it("POST /api/messaging/send defaults to self when to is omitted", async () => {
      let capturedTo: string | undefined;
      registerChannel("whatsapp", async (_message, to) => {
        capturedTo = to;
        return 1;
      });
      const app = createApp();
      const res = await makeRequest(app, "POST", "/api/messaging/send", true, {
        channel: "whatsapp",
        message: "hello",
      });
      expect(res.status).toBe(200);
      expect(capturedTo).toBeUndefined();
    });

    it("POST /api/messaging/send returns 400 when send function throws", async () => {
      registerChannel("whatsapp", async () => {
        throw new Error("WhatsApp is not connected");
      });
      const app = createApp();
      const res = await makeRequest(app, "POST", "/api/messaging/send", true, {
        channel: "whatsapp",
        message: "hello",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("WhatsApp is not connected");
    });
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
