#!/usr/bin/env node
/**
 * Fake MCP server for cron tests.
 * Reads JSON-RPC messages from stdin, responds on stdout.
 * Supports: initialize, notifications/initialized, tools/call (list_tasks, get_task, etc.)
 *
 * Behavior is controlled via environment variables:
 * - FAKE_DELAY_MS: delay before responding (for timeout tests)
 * - FAKE_TASKS: JSON array of tasks to return from list_tasks
 * - FAKE_TOOL_RESPONSE: JSON to return from any tools/call
 */

let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop(); // keep incomplete line in buffer
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {
      // ignore parse errors
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  const delayMs = parseInt(process.env.FAKE_DELAY_MS || "0", 10);
  if (delayMs > 0) {
    setTimeout(() => process.stdout.write(msg + "\n"), delayMs);
  } else {
    process.stdout.write(msg + "\n");
  }
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications have no id — just acknowledge silently
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp-cron", version: "1.0.0" },
      });
      break;

    case "tools/call":
      handleToolCall(id, params?.name, params?.arguments || {});
      break;

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

function handleToolCall(id, toolName, args) {
  // Allow custom response via env
  if (process.env.FAKE_TOOL_RESPONSE) {
    try {
      const custom = JSON.parse(process.env.FAKE_TOOL_RESPONSE);
      respond(id, { content: [{ type: "text", text: JSON.stringify(custom) }] });
      return;
    } catch {
      // fall through to default handling
    }
  }

  switch (toolName) {
    case "list_tasks": {
      const tasks = process.env.FAKE_TASKS || "[]";
      respond(id, { content: [{ type: "text", text: tasks }] });
      break;
    }
    case "get_task":
      respond(id, { content: [{ type: "text", text: JSON.stringify({ id: args.id, name: "test task" }) }] });
      break;
    case "add_task":
    case "add_ai_task":
      respond(id, { content: [{ type: "text", text: JSON.stringify({ id: "new1", ...args }) }] });
      break;
    case "update_task":
      respond(id, { content: [{ type: "text", text: JSON.stringify({ ok: true, ...args }) }] });
      break;
    case "remove_task":
      respond(id, { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] });
      break;
    case "run_task":
      respond(id, { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] });
      break;
    case "enable_task":
    case "disable_task":
      respond(id, { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] });
      break;
    case "get_task_result":
      respond(id, { content: [{ type: "text", text: JSON.stringify([]) }] });
      break;
    default:
      respondError(id, -32602, `Unknown tool: ${toolName}`);
  }
}
