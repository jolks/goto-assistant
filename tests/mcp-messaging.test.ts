import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MCP_SERVER_PATH = path.resolve(import.meta.dirname, "..", "dist", "mcp-messaging.js");
const distExists = fs.existsSync(MCP_SERVER_PATH);

/** Spawn the MCP messaging server with a given GOTO_ASSISTANT_URL. */
function spawnServer(url: string): ChildProcess {
  return spawn("node", [MCP_SERVER_PATH], {
    env: { ...process.env, GOTO_ASSISTANT_URL: url },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

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

describe.skipIf(!distExists)("mcp-messaging", () => {
  let mockServer: http.Server;
  let mockPort: number;
  // Track requests received by the mock server
  let lastRequest: { method: string; url: string; body: Record<string, unknown> } | undefined;
  let mockResponse: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };

  beforeAll(async () => {
    // Start a mock HTTP server to handle proxied requests
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        lastRequest = {
          method: req.method!,
          url: req.url!,
          body: body ? JSON.parse(body) : {},
        };
        res.writeHead(mockResponse.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(mockResponse.body));
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, () => {
        mockPort = (mockServer.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    mockServer.close();
  });

  afterEach(() => {
    lastRequest = undefined;
    mockResponse = { status: 200, body: {} };
  });

  it("responds to initialize with protocol version and capabilities", async () => {
    const proc = spawnServer(`http://localhost:${mockPort}`);
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
        serverInfo: { name: "goto-assistant-messaging", version: "1.0.0" },
      });
    } finally {
      proc.kill();
    }
  });

  it("tools/list returns send_message and list_channels", async () => {
    const proc = spawnServer(`http://localhost:${mockPort}`);
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/list",
      });
      const tools = (res.result as { tools: Array<{ name: string }> }).tools;
      const names = tools.map((t) => t.name);
      expect(names).toEqual(["send_message", "list_channels"]);
    } finally {
      proc.kill();
    }
  });

  it("list_channels proxies to GET /api/messaging/channels", async () => {
    mockResponse = { status: 200, body: { channels: ["whatsapp"] } };
    const proc = spawnServer(`http://localhost:${mockPort}`);
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "list_channels", arguments: {} },
      });
      expect(lastRequest?.method).toBe("GET");
      expect(lastRequest?.url).toBe("/api/messaging/channels");
      const content = (res.result as { content: Array<{ text: string }> }).content;
      expect(JSON.parse(content[0].text)).toEqual({ channels: ["whatsapp"] });
    } finally {
      proc.kill();
    }
  });

  it("send_message proxies to POST /api/messaging/send", async () => {
    mockResponse = { status: 200, body: { ok: true, channel: "whatsapp", partsSent: 1 } };
    const proc = spawnServer(`http://localhost:${mockPort}`);
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "send_message",
          arguments: { channel: "whatsapp", message: "hello", to: "+60123456789" },
        },
      });
      expect(lastRequest?.method).toBe("POST");
      expect(lastRequest?.url).toBe("/api/messaging/send");
      expect(lastRequest?.body).toEqual({ channel: "whatsapp", message: "hello", to: "+60123456789" });
      const content = (res.result as { content: Array<{ text: string }> }).content;
      expect(JSON.parse(content[0].text)).toEqual({ ok: true, channel: "whatsapp", partsSent: 1 });
    } finally {
      proc.kill();
    }
  });

  it("send_message returns error when neither message nor media provided", async () => {
    const proc = spawnServer(`http://localhost:${mockPort}`);
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "send_message", arguments: { channel: "whatsapp" } },
      });
      const content = (res.result as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toContain("message or media is required");
      // Should not have made an HTTP request
      expect(lastRequest).toBeUndefined();
    } finally {
      proc.kill();
    }
  });

  it("send_message returns error when channel is a non-string type", async () => {
    const proc = spawnServer(`http://localhost:${mockPort}`);
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "send_message", arguments: { channel: 123, message: "hi" } },
      });
      const content = (res.result as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toContain("channel is required and must be a string");
      // Should not have made an HTTP request
      expect(lastRequest).toBeUndefined();
    } finally {
      proc.kill();
    }
  });

  it("send_message forwards HTTP error from server", async () => {
    mockResponse = { status: 400, body: { error: 'Unknown channel: "telegram"' } };
    const proc = spawnServer(`http://localhost:${mockPort}`);
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "send_message",
          arguments: { channel: "telegram", message: "hi" },
        },
      });
      const content = (res.result as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toContain('Unknown channel: "telegram"');
    } finally {
      proc.kill();
    }
  });

  it("send_message with media proxies correctly to HTTP endpoint", async () => {
    mockResponse = { status: 200, body: { ok: true, channel: "whatsapp", partsSent: 1 } };
    const proc = spawnServer(`http://localhost:${mockPort}`);
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "send_message",
          arguments: { channel: "whatsapp", message: "Check this out", media: "/tmp/photo.jpg" },
        },
      });
      expect(lastRequest?.method).toBe("POST");
      expect(lastRequest?.url).toBe("/api/messaging/send");
      expect(lastRequest?.body).toEqual({ channel: "whatsapp", message: "Check this out", media: "/tmp/photo.jpg" });
      const content = (res.result as { content: Array<{ text: string }> }).content;
      expect(JSON.parse(content[0].text)).toEqual({ ok: true, channel: "whatsapp", partsSent: 1 });
    } finally {
      proc.kill();
    }
  });

  it("send_message with media only (no message) proxies correctly", async () => {
    mockResponse = { status: 200, body: { ok: true, channel: "whatsapp", partsSent: 1 } };
    const proc = spawnServer(`http://localhost:${mockPort}`);
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "send_message",
          arguments: { channel: "whatsapp", media: "https://example.com/photo.png" },
        },
      });
      expect(lastRequest?.body).toEqual({ channel: "whatsapp", media: "https://example.com/photo.png" });
      const content = (res.result as { content: Array<{ text: string }> }).content;
      expect(JSON.parse(content[0].text)).toEqual({ ok: true, channel: "whatsapp", partsSent: 1 });
    } finally {
      proc.kill();
    }
  });

  it("unknown tool returns JSON-RPC error", async () => {
    const proc = spawnServer(`http://localhost:${mockPort}`);
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

  it("returns -32602 error when tools/call has no tool name", async () => {
    const proc = spawnServer(`http://localhost:${mockPort}`);
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { arguments: {} },
      });
      expect(res.error).toBeDefined();
      expect((res.error as { code: number }).code).toBe(-32602);
      expect((res.error as { message: string }).message).toContain("missing tool name");
    } finally {
      proc.kill();
    }
  });

  it("returns -32600 error when method is missing", async () => {
    const proc = spawnServer(`http://localhost:${mockPort}`);
    try {
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 42,
      });
      expect(res.error).toBeDefined();
      expect((res.error as { code: number }).code).toBe(-32600);
      expect((res.error as { message: string }).message).toContain("missing method");
    } finally {
      proc.kill();
    }
  });

  it("unknown method returns JSON-RPC error", async () => {
    const proc = spawnServer(`http://localhost:${mockPort}`);
    try {
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 99,
        method: "some/unknown/method",
      });
      expect(res.error).toBeDefined();
      expect((res.error as { code: number }).code).toBe(-32601);
    } finally {
      proc.kill();
    }
  });

  it("handles server connection failure gracefully", async () => {
    // Point to a port nothing is listening on
    const proc = spawnServer("http://localhost:1");
    try {
      await handshake(proc);
      const res = await rpc(proc, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "send_message",
          arguments: { channel: "whatsapp", message: "hi" },
        },
      });
      const content = (res.result as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toContain("Error connecting to server");
    } finally {
      proc.kill();
    }
  });
});
