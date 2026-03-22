import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import os from "node:os";

const MCP_SERVER_PATH = path.resolve(import.meta.dirname, "..", "dist", "mcp-episodic.js");
const distExists = fs.existsSync(MCP_SERVER_PATH);

let tmpDir: string;
let sessionsDbPath: string;
let cronDbPath: string;

/** Send a JSON-RPC message and wait for a response with matching id. */
function rpc(proc: ChildProcess, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MCP response timeout (id=${message.id})`));
    }, 5000);

    let buffer = "";

    function onData(chunk: Buffer) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === message.id) {
            cleanup();
            resolve(msg);
            return;
          }
        } catch {
          // ignore non-JSON
        }
      }
    }

    function cleanup() {
      clearTimeout(timer);
      proc.stdout!.off("data", onData);
    }

    proc.stdout!.on("data", onData);
    proc.stdin!.write(JSON.stringify(message) + "\n");
  });
}

/** Send a JSON-RPC notification (no response expected). */
function notify(proc: ChildProcess, message: Record<string, unknown>): void {
  proc.stdin!.write(JSON.stringify(message) + "\n");
}

/** Perform the MCP handshake (initialize + notifications/initialized). */
async function handshake(proc: ChildProcess): Promise<void> {
  await rpc(proc, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    },
  });
  notify(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
}

function spawnServer(): ChildProcess {
  return spawn("node", [MCP_SERVER_PATH], {
    env: {
      ...process.env,
      GOTO_DATA_DIR: tmpDir,
      MCP_CRON_DB_PATH: cronDbPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe.skipIf(!distExists)("mcp-episodic", () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-test-"));
    sessionsDbPath = path.join(tmpDir, "sessions.db");
    cronDbPath = path.join(tmpDir, "cron-results.db");

    // Create sessions DB with test data
    const sdb = new Database(sessionsDbPath);
    sdb.pragma("journal_mode = WAL");
    sdb.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        sdk_session_id TEXT,
        title TEXT,
        mode INTEGER NOT NULL DEFAULT 0,
        channel_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    sdb.prepare("INSERT INTO conversations (id, provider, title, updated_at) VALUES (?, ?, ?, ?)").run("conv-test-1", "claude", "Deployment discussion", "2026-03-14T10:00:00Z");
    sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv-test-1", "user", "How do I deploy to production?");
    sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv-test-1", "assistant", "Run the deployment pipeline");
    sdb.close();

    // Create cron DB with test data
    const cdb = new Database(cronDbPath);
    cdb.pragma("journal_mode = WAL");
    cdb.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        type TEXT NOT NULL,
        command TEXT DEFAULT '',
        prompt TEXT DEFAULT '',
        schedule TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        command TEXT DEFAULT '',
        prompt TEXT DEFAULT '',
        output TEXT DEFAULT '',
        error TEXT DEFAULT '',
        exit_code INTEGER DEFAULT 0,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        duration TEXT DEFAULT ''
      );
    `);
    cdb.prepare("INSERT INTO tasks (id, name, description, type, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("task-test-1", "Nightly backup", "Database backup", "shell_command", "0 0 * * *", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    cdb.prepare("INSERT INTO results (task_id, output, exit_code, start_time, end_time, duration) VALUES (?, ?, ?, ?, ?, ?)").run("task-test-1", "Backup completed", 0, "2026-03-14T00:00:00Z", "2026-03-14T00:05:00Z", "5m0s");
    cdb.close();
  });

  afterAll(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("responds to initialize with protocol version and capabilities", async () => {
    const proc = spawnServer();
    try {
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      expect(res.result).toEqual({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "goto-assistant-episodic", version: "1.0.0" },
      });
    } finally {
      proc.kill();
    }
  });

  it("tools/list returns all 4 tools", async () => {
    const proc = spawnServer();
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/list",
      });
      const tools = (res.result as { tools: Array<{ name: string }> }).tools;
      const names = tools.map((t) => t.name);
      expect(names).toEqual(["search_episodes", "get_conversation_context", "list_recent_episodes"]);
    } finally {
      proc.kill();
    }
  });

  it("search_episodes returns matching conversation messages", async () => {
    const proc = spawnServer();
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "search_episodes", arguments: { query: "deploy production" } },
      });
      const content = (res.result as { content: Array<{ text: string }> }).content;
      const results = JSON.parse(content[0].text);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe("conversation_message");
    } finally {
      proc.kill();
    }
  });

  it("search_episodes returns matching task results", async () => {
    const proc = spawnServer();
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "search_episodes", arguments: { query: "backup", source: "tasks" } },
      });
      const content = (res.result as { content: Array<{ text: string }> }).content;
      const results = JSON.parse(content[0].text);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe("task_result");
    } finally {
      proc.kill();
    }
  });

  it("get_conversation_context returns messages for a conversation", async () => {
    const proc = spawnServer();
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "get_conversation_context", arguments: { conversation_id: "conv-test-1" } },
      });
      const content = (res.result as { content: Array<{ text: string }> }).content;
      const ctx = JSON.parse(content[0].text);
      expect(ctx.conversation_id).toBe("conv-test-1");
      expect(ctx.title).toBe("Deployment discussion");
      expect(ctx.messages.length).toBe(2);
    } finally {
      proc.kill();
    }
  });

  it("list_recent_episodes returns chronological activity", async () => {
    const proc = spawnServer();
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "list_recent_episodes", arguments: {} },
      });
      const content = (res.result as { content: Array<{ text: string }> }).content;
      const episodes = JSON.parse(content[0].text);
      expect(episodes.length).toBeGreaterThan(0);
    } finally {
      proc.kill();
    }
  });

  it("unknown tool returns JSON-RPC error", async () => {
    const proc = spawnServer();
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "nonexistent_tool", arguments: {} },
      });
      expect(res.error).toBeDefined();
      expect((res.error as { message: string }).message).toContain("Unknown tool: nonexistent_tool");
    } finally {
      proc.kill();
    }
  });
});
