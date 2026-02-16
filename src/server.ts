import express, { type Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import path from "node:path";
import multer from "multer";
import { isConfigured, loadConfig, saveConfig, getMaskedConfig, loadMcpServers, saveMcpServers, getMaskedMcpServers, type Config, type McpServerConfig } from "./config.js";
import { CURRENT_CONFIG_VERSION } from "./migrations.js";
import { createConversation, getConversation, updateSessionId, updateTitle, listConversations, saveMessage, getMessages, deleteConversation } from "./sessions.js";
import { routeMessage, type Attachment } from "./agents/router.js";
import { saveUpload, getUpload, ALLOWED_IMAGE_TYPES, UPLOADS_DIR } from "./uploads.js";

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
    const existing = isConfigured() ? loadConfig() : { provider: "", claude: { apiKey: "", model: "", baseUrl: "" }, openai: { apiKey: "", model: "", baseUrl: "" }, server: { port: 3000 } };
    const config: Config = {
      provider: incoming.provider,
      claude: { ...existing.claude, ...incoming.claude },
      openai: { ...existing.openai, ...incoming.openai },
      server: incoming.server,
      configVersion: CURRENT_CONFIG_VERSION,
    };
    saveConfig(config);
    if (mcpServers) {
      saveMcpServers(mcpServers);
    }
    res.json({ ok: true });
  });

  // Get masked config for settings page
  app.get("/api/config", (_req, res) => {
    if (!isConfigured()) {
      res.json({ configured: false });
      return;
    }
    const config = loadConfig();
    res.json({ configured: true, config: getMaskedConfig(config) });
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
    saveMcpServers(mcpServers as Record<string, McpServerConfig>);
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

  return app;
}

const SETUP_SYSTEM_PROMPT = `You are helping the user configure their goto-assistant.

There are two config files you can read and modify using your filesystem tools:

**./data/config.json** — Main app config:
- provider: "claude" or "openai"
- claude: { apiKey, model, baseUrl }
- openai: { apiKey, model, baseUrl }
- server: { port }

**./data/mcp.json** — MCP server config:
- mcpServers: { name: { command, args (string array), env (optional object) } }

Default MCP servers have been configured:
- **cron** (mcp-cron): Scheduled task execution
- **memory** (@modelcontextprotocol/server-memory): Persistent knowledge graph
- **filesystem** (@modelcontextprotocol/server-filesystem): File system access
- **time** (mcp-server-time): Current time information

**IMPORTANT — cron server must stay in sync with config.json:**
The cron server in mcp.json has args that mirror the provider settings in config.json. When the provider, model, API key, or base URL changes, you MUST update both files:
- \`--ai-provider\`: "anthropic" for claude, "openai" for openai. If baseUrl is set (LiteLLM proxy), always use "openai".
- \`--ai-model\`: must match the model in config.json for the active provider.
- \`--ai-base-url\`: add this flag when baseUrl is set, remove it when empty.
- \`env\` object: the key must be ANTHROPIC_API_KEY for claude, OPENAI_API_KEY for openai, or MCP_CRON_AI_API_KEY when using a base URL proxy. The value must be the API key for the active provider.

When switching providers, ask the user for the new API key if one isn't already saved in config.json for that provider.

Help the user modify their configuration. When done, tell them they can close this chat panel.
Note: Changes to config.json and mcp.json take effect on the next conversation. Only server port changes require a restart.`;

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
        const conv = createConversation(config.provider);
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

        const systemPromptOverride = msg.setupMode ? SETUP_SYSTEM_PROMPT : undefined;

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
          resumeSessionId,
          attachments,
          history,
          systemPromptOverride
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
