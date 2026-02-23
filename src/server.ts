import express, { type Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import path from "node:path";
import multer from "multer";
import { isConfigured, loadConfig, saveConfig, getMaskedConfig, loadMcpServers, saveMcpServers, getMaskedMcpServers, unmaskMcpServers, syncMessagingMcpServer, MCP_CONFIG_PATH, type Config, type McpServerConfig } from "./config.js";
import { startWhatsApp, stopWhatsApp, getWhatsAppStatus, getWhatsAppQrDataUri } from "./whatsapp.js";
import { listChannels, sendMessage } from "./messaging.js";
import { restartCronServer, callCronTool, isCronRunning } from "./cron.js";
import { CURRENT_CONFIG_VERSION } from "./migrations.js";
import { createConversation, getConversation, updateSessionId, updateTitle, listConversations, saveMessage, getMessages, deleteConversation } from "./sessions.js";
import { routeMessage, type Attachment } from "./agents/router.js";
import { saveUpload, getUpload, ALLOWED_IMAGE_TYPES, UPLOADS_DIR } from "./uploads.js";
import { SETUP_SYSTEM_PROMPT, TASK_SYSTEM_PROMPT, TASK_CREATE_SYSTEM_PROMPT } from "./prompts.js";

/** Re-read config from disk and restart mcp-cron + WhatsApp as needed. */
function reloadServices(config?: Config): void {
  const cfg = config ?? (isConfigured() ? loadConfig() : undefined);
  // Sync messaging MCP server entry in mcp.json (before cron restart so cron picks it up)
  // Note: WhatsApp channel registration happens inside whatsapp.ts on connection open/close
  syncMessagingMcpServer(cfg);
  restartCronServer().catch((err) =>
    console.error("Failed to restart mcp-cron:", err)
  );
  if (cfg?.whatsapp?.enabled) {
    startWhatsApp().catch((err) =>
      console.error("Failed to start WhatsApp:", err)
    );
  } else {
    stopWhatsApp().catch((err) =>
      console.error("Failed to stop WhatsApp:", err)
    );
  }
}

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Setup redirect middleware: if not configured, redirect to setup page
  app.use((req, res, next) => {
    if (
      !isConfigured() &&
      !req.path.startsWith("/setup") &&
      !req.path.startsWith("/api/") &&
      !req.path.endsWith(".css") &&
      !req.path.endsWith(".js") &&
      req.path !== "/health"
    ) {
      res.redirect("/setup.html");
      return;
    }
    next();
  });

  // Static files
  app.use(express.static(path.join(import.meta.dirname, "..", "public")));

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", configured: isConfigured() });
  });

  // List models for setup page
  app.post("/api/models", async (req, res) => {
    const { provider, apiKey, baseUrl } = req.body;

    if (provider === "claude") {
      // Anthropic doesn't have a list models endpoint; return known models
      res.json({
        models: [
          { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
          { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
          { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
        ],
      });
      return;
    }

    if (provider === "openai") {
      try {
        const url = `${baseUrl || "https://api.openai.com"}/v1/models`;
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!response.ok) {
          res.status(400).json({ error: "Failed to fetch models. Check your API key." });
          return;
        }
        const data = (await response.json()) as { data: Array<{ id: string }> };
        const models = data.data
          .map((m) => ({ id: m.id, name: m.id }))
          .sort((a, b) => a.id.localeCompare(b.id));
        res.json({ models });
      } catch {
        res.status(500).json({ error: "Failed to connect to OpenAI API" });
      }
      return;
    }

    res.status(400).json({ error: "Invalid provider" });
  });

  // Save config from setup page
  app.post("/api/setup", (req, res) => {
    const { mcpServers, ...rest } = req.body;
    const incoming = rest as Partial<Config>;
    if (!incoming.provider || !incoming.server?.port) {
      res.status(400).json({ error: "Invalid config" });
      return;
    }
    // Merge with existing config to preserve fields not sent (e.g. API key when editing)
    const existing = isConfigured() ? loadConfig() : { provider: "", claude: { apiKey: "", model: "", baseUrl: "" }, openai: { apiKey: "", model: "", baseUrl: "" }, server: { port: 3000 }, whatsapp: { enabled: false } };
    const config: Config = {
      provider: incoming.provider,
      claude: { ...existing.claude, ...incoming.claude },
      openai: { ...existing.openai, ...incoming.openai },
      server: incoming.server,
      whatsapp: incoming.whatsapp ?? existing.whatsapp,
      configVersion: CURRENT_CONFIG_VERSION,
    };
    saveConfig(config);
    if (mcpServers) {
      const existingMcp = loadMcpServers();
      const mergedMcp = unmaskMcpServers(mcpServers, existingMcp, config);
      saveMcpServers(mergedMcp);
    }
    reloadServices(config);
    res.json({ ok: true });
  });

  // Get masked config for settings page
  app.get("/api/config", (_req, res) => {
    if (!isConfigured()) {
      res.json({ configured: false, mcpConfigPath: MCP_CONFIG_PATH });
      return;
    }
    const config = loadConfig();
    res.json({ configured: true, config: getMaskedConfig(config), mcpConfigPath: MCP_CONFIG_PATH });
  });

  // MCP servers endpoints
  app.get("/api/mcp-servers", (_req, res) => {
    const servers = loadMcpServers();
    res.json({ mcpServers: getMaskedMcpServers(servers) });
  });

  app.post("/api/mcp-servers", (req, res) => {
    const { mcpServers } = req.body;
    if (!mcpServers || typeof mcpServers !== "object") {
      res.status(400).json({ error: "Invalid mcpServers" });
      return;
    }
    const existing = loadMcpServers();
    const appConfig = isConfigured() ? loadConfig() : undefined;
    const merged = unmaskMcpServers(mcpServers as Record<string, McpServerConfig>, existing, appConfig);
    saveMcpServers(merged);
    res.json({ ok: true });
  });

  // List conversations
  app.get("/api/conversations", (_req, res) => {
    const conversations = listConversations();
    res.json({ conversations });
  });

  // Get messages for a conversation
  app.get("/api/conversations/:id/messages", (req, res) => {
    const messages = getMessages(req.params.id);
    res.json({ messages });
  });

  // Delete a conversation
  app.delete("/api/conversations/:id", (req, res) => {
    deleteConversation(req.params.id);
    res.json({ ok: true });
  });

  // File upload
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
  app.post("/api/upload", upload.single("file"), (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      res.status(400).json({ error: `Unsupported file type: ${file.mimetype}. Allowed: ${ALLOWED_IMAGE_TYPES.join(", ")}` });
      return;
    }
    const meta = saveUpload(file.buffer, file.originalname, file.mimetype);
    res.json({ fileId: meta.fileId, filename: meta.filename, mimeType: meta.mimeType, size: meta.size });
  });

  // Serve uploaded files
  app.get("/api/uploads/:fileId", (req, res) => {
    const result = getUpload(req.params.fileId);
    if (!result) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.setHeader("Content-Type", result.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${result.filename}"`);
    res.send(result.data);
  });

  // --- Task management endpoints (proxy to mcp-cron) ---

  function cronProxy(
    method: "get" | "post" | "put" | "delete",
    routePath: string,
    toolName: string,
    buildArgs?: (req: import("express").Request) => Record<string, unknown>
  ) {
    app[method](routePath, async (req, res) => {
      try {
        const result = await callCronTool(toolName, buildArgs ? buildArgs(req) : { id: req.params.id });
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
      }
    });
  }

  app.get("/api/tasks", async (_req, res) => {
    try {
      if (!isCronRunning()) { res.json([]); return; }
      const result = await callCronTool("list_tasks");
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
    }
  });

  cronProxy("get", "/api/tasks/:id", "get_task");

  app.post("/api/tasks", async (req, res) => {
    try {
      const { type, ...rest } = req.body;
      const result = await callCronTool(type === "AI" ? "add_ai_task" : "add_task", rest);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
    }
  });

  cronProxy("put", "/api/tasks/:id", "update_task", (req) => ({ id: req.params.id, ...req.body }));
  cronProxy("delete", "/api/tasks/:id", "remove_task");
  cronProxy("post", "/api/tasks/:id/run", "run_task");
  cronProxy("post", "/api/tasks/:id/enable", "enable_task");
  cronProxy("post", "/api/tasks/:id/disable", "disable_task");
  cronProxy("get", "/api/tasks/:id/results", "get_task_result", (req) => ({
    id: req.params.id,
    limit: parseInt(req.query.limit as string) || 1,
  }));

  // --- Messaging endpoints ---

  app.get("/api/messaging/channels", (_req, res) => {
    res.json({ channels: listChannels() });
  });

  app.post("/api/messaging/send", async (req, res) => {
    const { channel, message, to } = req.body;
    if (!channel || typeof channel !== "string") {
      res.status(400).json({ error: "channel is required" });
      return;
    }
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }
    if (to !== undefined && typeof to !== "string") {
      res.status(400).json({ error: "to must be a string" });
      return;
    }
    try {
      const partsSent = await sendMessage(channel, message, to);
      res.json({ ok: true, channel, partsSent });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.status(400).json({ error: msg, channels: listChannels() });
    }
  });

  // --- Reload services (re-read config from disk, restart cron + WhatsApp) ---

  // No auth — this is a self-hosted personal tool; all endpoints are unauthenticated.
  app.post("/api/reload", (_req, res) => {
    reloadServices();
    res.json({ ok: true });
  });

  // --- WhatsApp endpoints ---

  app.get("/api/whatsapp/status", (_req, res) => {
    if (!isConfigured()) {
      res.json({ enabled: false, status: "disconnected" });
      return;
    }
    const config = loadConfig();
    res.json({
      enabled: config.whatsapp?.enabled ?? false,
      status: getWhatsAppStatus(),
    });
  });

  app.get("/api/whatsapp/qr", async (_req, res) => {
    const qr = await getWhatsAppQrDataUri();
    res.json({ qr });
  });

  app.post("/api/whatsapp/connect", async (_req, res) => {
    try {
      await startWhatsApp();
      res.json({ ok: true, status: getWhatsAppStatus() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to start WhatsApp" });
    }
  });

  app.post("/api/whatsapp/disconnect", async (_req, res) => {
    try {
      await stopWhatsApp();
      res.json({ ok: true, status: "disconnected" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to stop WhatsApp" });
    }
  });

  return app;
}

export function createServer(app: Express) {
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", async (raw: Buffer) => {
      let msg: {
        type: string;
        text: string;
        conversationId?: string;
        attachments?: Array<{ fileId: string; filename: string; mimeType: string }>;
        setupMode?: boolean;
        taskMode?: boolean;
        taskContext?: string;
      };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", text: "Invalid JSON" }));
        return;
      }

      if (msg.type !== "message" || !msg.text) {
        ws.send(JSON.stringify({ type: "error", text: "Invalid message format" }));
        return;
      }

      if (!isConfigured()) {
        ws.send(JSON.stringify({ type: "error", text: "Not configured. Visit /setup.html" }));
        return;
      }

      const config = loadConfig();
      const mcpServers = loadMcpServers();

      // Determine conversation mode: 0 = chat, 1 = setup, 2 = task
      const mode = msg.taskMode ? 2 : msg.setupMode ? 1 : 0;

      // Get or create conversation
      let conversationId = msg.conversationId;
      let resumeSessionId: string | undefined;
      let isNewConversation = false;

      if (conversationId) {
        const existing = getConversation(conversationId);
        if (existing?.sdk_session_id) {
          resumeSessionId = existing.sdk_session_id;
        }
      }

      if (!conversationId) {
        const conv = createConversation(config.provider, mode);
        conversationId = conv.id;
        isNewConversation = true;
      }

      try {
        // Save user message (with attachment metadata if present)
        const msgAttachments = msg.attachments;
        if (msgAttachments && msgAttachments.length > 0) {
          saveMessage(conversationId, "user", JSON.stringify({
            text: msg.text,
            attachments: msgAttachments.map(a => ({ fileId: a.fileId, filename: a.filename, mimeType: a.mimeType })),
          }));
        } else {
          saveMessage(conversationId, "user", msg.text);
        }

        // Set title from first message on new conversations
        if (isNewConversation) {
          const title = msg.text.length > 100 ? msg.text.slice(0, 100) + "..." : msg.text;
          updateTitle(conversationId, title);
        }

        // Resolve attachment data from disk
        let attachments: Attachment[] | undefined;
        if (msgAttachments && msgAttachments.length > 0) {
          attachments = [];
          for (const att of msgAttachments) {
            const upload = getUpload(att.fileId);
            if (upload) {
              attachments.push({
                filename: upload.filename,
                mimeType: upload.mimeType,
                data: upload.data,
                filePath: path.resolve(UPLOADS_DIR, att.fileId, upload.filename),
              });
            }
          }
        }

        // Load conversation history (excluding current message) for providers that need it
        const allMessages = getMessages(conversationId);
        const history = allMessages.slice(0, -1); // exclude the message we just saved

        let systemPromptOverride: string | undefined;
        if (mode === 1) {
          systemPromptOverride = SETUP_SYSTEM_PROMPT;
        } else if (mode === 2) {
          systemPromptOverride = msg.taskContext
            ? TASK_SYSTEM_PROMPT + msg.taskContext
            : TASK_CREATE_SYSTEM_PROMPT;
        }

        let responseText = "";
        const result = await routeMessage(
          msg.text,
          config,
          mcpServers,
          (chunk) => {
            responseText += chunk;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "chunk", text: chunk }));
            }
          },
          { resumeSessionId, attachments, history, systemPromptOverride }
        );

        // Save assistant message
        if (responseText) {
          saveMessage(conversationId, "assistant", responseText);
        }

        // Save SDK session ID for resume
        if (result.sessionId) {
          updateSessionId(conversationId, result.sessionId);
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "done", conversationId }));
        }
      } catch (err) {
        const errorText = err instanceof Error ? err.message : "Unknown error";
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", text: errorText }));
        }
      }
    });
  });

  return server;
}
