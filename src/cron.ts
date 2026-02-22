import { spawn, type ChildProcess } from "node:child_process";
import { loadMcpServers } from "./config.js";

let cronProc: ChildProcess | null = null;
// IDs 1-99 reserved for startup handshake (currently: 1=initialize, 2=list_tasks).
// callCronTool() allocates from 100+ to avoid collisions.
let nextId = 100;

/** Kill a process tree (npx spawns child processes that must also be terminated). */
function killProc(proc: ChildProcess): void {
  if (!proc.pid) return;
  // Kill the entire process group (npx + its children) via negative PID
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* already dead */ }
}

export function isCronRunning(): boolean {
  return cronProc !== null;
}

/**
 * Call an mcp-cron tool by name with the given arguments.
 * Returns the parsed JSON result, or raw string if not valid JSON.
 */
export async function callCronTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!cronProc) throw new Error("mcp-cron is not running");
  const id = nextId++;
  send(cronProc, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  const response = await waitForResponse(cronProc, id);
  const result = response.result as { content?: Array<{ type: string; text: string }> } | undefined;
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Send a JSON-RPC message to an MCP server over stdio.
 */
function send(proc: ChildProcess, message: Record<string, unknown>): void {
  proc.stdin!.write(JSON.stringify(message) + "\n");
}

/**
 * Wait for a JSON-RPC response with the given id.
 */
function waitForResponse(proc: ChildProcess, id: number, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MCP response timeout (id=${id})`));
    }, timeoutMs);

    let buffer = "";

    function onData(chunk: Buffer) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete line in buffer
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            cleanup();
            resolve(msg);
            return;
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    }

    function cleanup() {
      clearTimeout(timer);
      proc.stdout!.off("data", onData);
    }

    proc.stdout!.on("data", onData);
  });
}

/**
 * Spawn mcp-cron from mcp.json config, perform MCP handshake,
 * and call list_tasks to kick-start scheduled task execution.
 * The --prevent-sleep flag keeps the process alive.
 */
export async function startCronServer(): Promise<void> {
  if (cronProc) return;

  const servers = loadMcpServers();
  const cronConfig = servers["cron"];
  if (!cronConfig) return;

  const proc = spawn(cronConfig.command, cronConfig.args, {
    env: { ...process.env, ...cronConfig.env },
    stdio: ["pipe", "pipe", "ignore"],
    detached: true,
  });

  proc.on("exit", (code) => {
    if (cronProc === proc) {
      console.log(`mcp-cron exited (code ${code})`);
      cronProc = null;
    }
  });

  cronProc = proc;

  try {
    // 1. Initialize
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "goto-assistant", version: "1.0.0" },
      },
    });
    await waitForResponse(proc, 1);

    // 2. Initialized notification
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

    // 3. Call list_tasks to kick-start cron
    send(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_tasks", arguments: {} },
    });
    await waitForResponse(proc, 2);

    console.log("mcp-cron started in background");
  } catch (err) {
    cronProc = null;
    killProc(proc);
    throw err;
  }
}

let lastCronFingerprint: string | null = null;

export async function restartCronServer(): Promise<void> {
  const servers = loadMcpServers();
  const cronConfig = servers["cron"];
  const fingerprint = cronConfig ? JSON.stringify(cronConfig) : "";
  if (fingerprint === lastCronFingerprint && cronProc) return;
  lastCronFingerprint = fingerprint;
  await stopCronServer();
  await startCronServer();
}

export async function stopCronServer(): Promise<void> {
  if (!cronProc) return;
  const proc = cronProc;
  cronProc = null;
  lastCronFingerprint = null;
  killProc(proc);
}
