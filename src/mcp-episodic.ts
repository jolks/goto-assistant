/**
 * MCP stdio server for episodic memory.
 * Provides search and retrieval of past conversations and task execution results.
 */

import readline from "node:readline";
import { MCP_PROTOCOL_VERSION } from "./config.js";
import {
  searchEpisodes,
  getConversationContext,
  listRecentEpisodes,
} from "./episodic.js";

function respond(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function makeResult(id: number | string, content: Array<{ type: string; text: string }>, isError = false) {
  return { jsonrpc: "2.0", id, result: { content, ...(isError && { isError: true }) } };
}

function makeError(id: number | string, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const TOOLS = [
  {
    name: "search_episodes",
    description: "Search past conversations and task execution results using full-text search. Returns matching snippets with context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (natural language)" },
        source: {
          type: "string",
          enum: ["all", "conversations", "tasks"],
          description: "Filter by source type (default: all)",
        },
        time_range: {
          type: "object",
          properties: {
            after: { type: "string", description: "ISO 8601 timestamp — only results after this time" },
            before: { type: "string", description: "ISO 8601 timestamp — only results before this time" },
          },
          description: "Optional time range filter",
        },
        limit: { type: "number", description: "Maximum results to return (default: 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_conversation_context",
    description: "Retrieve messages from a specific conversation. Use after search_episodes to get full context around a match.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation ID from search results" },
        limit: { type: "number", description: "Maximum messages to return (default: 50)" },
        around_message_id: { type: "number", description: "Center the message window around this message ID" },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "list_recent_episodes",
    description: "Browse recent conversations and task results chronologically. Use for discovering recent activity without a specific search query.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["all", "conversations", "tasks"],
          description: "Filter by source type (default: all)",
        },
        limit: { type: "number", description: "Maximum results to return (default: 20)" },
        before: { type: "string", description: "ISO 8601 timestamp for pagination — return results before this time" },
      },
    },
  },
];

function handleToolCall(id: number | string, name: string, args: Record<string, unknown>) {
  try {
    if (name === "search_episodes") {
      const query = args.query as string;
      if (!query || typeof query !== "string") {
        respond(makeResult(id, [{ type: "text", text: "Error: query is required and must be a string" }], true));
        return;
      }
      const results = searchEpisodes(query, {
        source: (args.source as "all" | "conversations" | "tasks") ?? undefined,
        time_range: args.time_range as { after?: string; before?: string } | undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      respond(makeResult(id, [{ type: "text", text: JSON.stringify(results) }]));
      return;
    }

    if (name === "get_conversation_context") {
      const conversationId = args.conversation_id as string;
      if (!conversationId || typeof conversationId !== "string") {
        respond(makeResult(id, [{ type: "text", text: "Error: conversation_id is required and must be a string" }], true));
        return;
      }
      const context = getConversationContext(conversationId, {
        limit: typeof args.limit === "number" ? args.limit : undefined,
        around_message_id: typeof args.around_message_id === "number" ? args.around_message_id : undefined,
      });
      respond(makeResult(id, [{ type: "text", text: JSON.stringify(context) }]));
      return;
    }

    if (name === "list_recent_episodes") {
      const episodes = listRecentEpisodes({
        source: (args.source as "all" | "conversations" | "tasks") ?? undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        before: typeof args.before === "string" ? args.before : undefined,
      });
      respond(makeResult(id, [{ type: "text", text: JSON.stringify(episodes) }]));
      return;
    }

    respond(makeError(id, -32601, `Unknown tool: ${name}`));
  } catch (err) {
    respond(makeResult(id, [{ type: "text", text: `Internal error: ${(err as Error).message}` }], true));
  }
}

function handleMessage(line: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error(`[mcp-episodic] Malformed JSON-RPC input: ${line.slice(0, 200)}`);
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
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "goto-assistant-episodic", version: "1.0.0" },
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
    if (id === undefined) return;
    const toolName = params?.name as string | undefined;
    if (!toolName) {
      respond(makeError(id, -32602, "Invalid params: missing tool name"));
      return;
    }
    const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;
    handleToolCall(id, toolName, toolArgs);
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
