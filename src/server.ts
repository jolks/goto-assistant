import express, { type Express } from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import path from "node:path";
import { isConfigured, loadConfig, saveConfig, getMaskedConfig, type Config } from "./config.js";
import { createConversation, getConversation, updateSessionId, updateTitle, listConversations, saveMessage, getMessages, deleteConversation } from "./sessions.js";
import { routeMessage } from "./agents/router.js";

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
    const config = req.body as Config;
    if (!config.provider || !config.server?.port) {
      res.status(400).json({ error: "Invalid config" });
      return;
    }
    saveConfig(config);
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

  return app;
}

export function createServer(app: Express) {
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", async (raw: Buffer) => {
      let msg: { type: string; text: string; conversationId?: string };
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
        // Save user message
        saveMessage(conversationId, "user", msg.text);

        // Set title from first message on new conversations
        if (isNewConversation) {
          const title = msg.text.length > 100 ? msg.text.slice(0, 100) + "..." : msg.text;
          updateTitle(conversationId, title);
        }

        let responseText = "";
        const result = await routeMessage(
          msg.text,
          config,
          (chunk) => {
            responseText += chunk;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "chunk", text: chunk }));
            }
          },
          resumeSessionId
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
