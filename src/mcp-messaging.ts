/**
 * MCP stdio server for messaging.
 * Proxies send_message / list_channels tool calls to the main Express server's HTTP API.
 */

import readline from "node:readline";

const BASE_URL = process.env.GOTO_ASSISTANT_URL || "http://localhost:3000";

function respond(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function makeResult(id: number | string, content: Array<{ type: string; text: string }>) {
  return { jsonrpc: "2.0", id, result: { content } };
}

function makeError(id: number | string, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const TOOLS = [
  {
    name: "send_message",
    description: "Send a message via a connected messaging channel (e.g. WhatsApp). Use list_channels to see available channels.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: 'Messaging channel (e.g. "whatsapp")' },
        message: { type: "string", description: "Text message to send" },
        to: { type: "string", description: 'Recipient — phone number (e.g. "+60123456789") or "self" (default: self)' },
      },
      required: ["channel", "message"],
    },
  },
  {
    name: "list_channels",
    description: "List available messaging channels.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function handleToolCall(id: number | string, name: string, args: Record<string, unknown>) {
  if (name === "list_channels") {
    try {
      const res = await fetch(`${BASE_URL}/api/messaging/channels`);
      if (!res.ok) {
        respond(makeResult(id, [{ type: "text", text: `Error: HTTP ${res.status} from server` }]));
        return;
      }
      const data = await res.json() as { channels: string[] };
      respond(makeResult(id, [{ type: "text", text: JSON.stringify(data) }]));
    } catch (err) {
      respond(makeResult(id, [{ type: "text", text: `Error connecting to server: ${(err as Error).message}` }]));
    }
    return;
  }

  if (name === "send_message") {
    const { channel, message, to } = args as { channel: string; message: string; to?: string };
    if (!channel || !message) {
      respond(makeResult(id, [{ type: "text", text: "Error: channel and message are required" }]));
      return;
    }
    try {
      const res = await fetch(`${BASE_URL}/api/messaging/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, message, to }),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        respond(makeResult(id, [{ type: "text", text: `Error: ${(data as { error?: string }).error || `HTTP ${res.status}`}` }]));
        return;
      }
      respond(makeResult(id, [{ type: "text", text: JSON.stringify(data) }]));
    } catch (err) {
      respond(makeResult(id, [{ type: "text", text: `Error connecting to server: ${(err as Error).message}` }]));
    }
    return;
  }

  respond(makeError(id, -32601, `Unknown tool: ${name}`));
}

function handleMessage(line: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const id = msg.id as number | string | undefined;
  const method = msg.method;
  const params = msg.params as Record<string, unknown> | undefined;

  if (typeof method !== "string") {
    if (id !== undefined) {
      respond(makeError(id, -32600, "Invalid request: missing method"));
    }
    return;
  }

  if (method === "initialize") {
    respond({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "goto-assistant-messaging", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return; // no response needed
  }

  if (method === "tools/list") {
    respond({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    if (id === undefined) return; // notifications don't get responses
    const toolName = params?.name as string | undefined;
    if (!toolName) {
      respond(makeError(id, -32602, "Invalid params: missing tool name"));
      return;
    }
    const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;
    // .catch: tool errors are returned as content text per MCP spec, not as JSON-RPC errors
    handleToolCall(id, toolName, toolArgs).catch((err) => {
      respond(makeResult(id, [{ type: "text", text: `Internal error: ${(err as Error).message}` }]));
    });
    return;
  }

  // Unknown method
  if (id !== undefined) {
    respond(makeError(id, -32601, `Method not found: ${method}`));
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", handleMessage);
rl.on("close", () => process.exit(0));
