import { describe, it, expect, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { Attachment } from "../src/agents/router.js";

// Capture what gets passed to query()
let capturedPrompt: unknown = null;

// Mock the Claude Agent SDK — default yields a success result
const mockQuery = vi.fn().mockImplementation(({ prompt }: { prompt: unknown }) => {
  capturedPrompt = prompt;
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: "result", subtype: "success", session_id: "sess-1", result: "response" };
    },
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

const { runClaude } = await import("../src/agents/claude.js");

const config: Config = {
  provider: "claude",
  claude: { apiKey: "sk-ant-test", model: "claude-sonnet-4-5-20250929", baseUrl: "" },
  openai: { apiKey: "", model: "", baseUrl: "" },
  server: { port: 3000 },
};

const mcpServers = {};

describe("claude prompt construction", () => {
  it("passes plain string prompt when no attachments", async () => {
    await runClaude("hello", config, mcpServers, vi.fn());
    expect(capturedPrompt).toBe("hello");
  });

  it("passes string prompt with file paths when attachments are present", async () => {
    const attachments: Attachment[] = [{
      filename: "test.png",
      mimeType: "image/png",
      data: Buffer.from("fake"),
      filePath: "/data/uploads/abc/test.png",
    }];
    await runClaude("describe this", config, mcpServers, vi.fn(), { attachments });

    // Must be a string — the SDK's AsyncIterable path doesn't support image content blocks
    expect(typeof capturedPrompt).toBe("string");
  });

  it("includes file paths and Read tool instruction in prompt", async () => {
    const attachments: Attachment[] = [{
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      data: Buffer.from("fake-image"),
      filePath: "/data/uploads/uuid1/photo.jpg",
    }];
    await runClaude("what is this?", config, mcpServers, vi.fn(), { attachments });

    const prompt = capturedPrompt as string;
    expect(prompt).toContain("what is this?");
    expect(prompt).toContain("/data/uploads/uuid1/photo.jpg");
    expect(prompt).toContain("Read tool");
  });

  it("includes multiple file paths for multiple attachments", async () => {
    const attachments: Attachment[] = [
      { filename: "a.png", mimeType: "image/png", data: Buffer.from("a"), filePath: "/uploads/id1/a.png" },
      { filename: "b.jpg", mimeType: "image/jpeg", data: Buffer.from("b"), filePath: "/uploads/id2/b.jpg" },
    ];
    await runClaude("compare these", config, mcpServers, vi.fn(), { attachments });

    const prompt = capturedPrompt as string;
    expect(prompt).toContain("compare these");
    expect(prompt).toContain("/uploads/id1/a.png");
    expect(prompt).toContain("/uploads/id2/b.jpg");
    expect(prompt).toContain("2 image(s)");
  });
});

describe("claude max turns handling", () => {
  it("sends a user-friendly message when max turns is exceeded", async () => {
    mockQuery.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "result", subtype: "error_max_turns", session_id: "sess-max" };
      },
    }));

    const chunks: string[] = [];
    const result = await runClaude("do something complex", config, mcpServers, (text) => chunks.push(text));

    expect(chunks.join("")).toContain("reached the maximum number of tool-use turns");
    expect(result.sessionId).toBe("sess-max");
  });

  it("still returns sessionId from init when max turns has no session_id", async () => {
    mockQuery.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-init" };
        yield { type: "result", subtype: "error_max_turns" };
      },
    }));

    const chunks: string[] = [];
    const result = await runClaude("complex task", config, mcpServers, (text) => chunks.push(text));

    expect(chunks.join("")).toContain("reached the maximum number of tool-use turns");
    expect(result.sessionId).toBe("sess-init");
  });
});

describe("claude assistant message streaming", () => {
  it("calls onChunk for text content blocks in assistant messages", async () => {
    mockQuery.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "assistant",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        };
        yield { type: "result", subtype: "success", session_id: "sess-2" };
      },
    }));

    const chunks: string[] = [];
    await runClaude("hi", config, mcpServers, (text) => chunks.push(text));

    expect(chunks).toContain("Hello ");
    expect(chunks).toContain("world");
  });

  it("skips non-text content blocks (e.g. tool_use)", async () => {
    mockQuery.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "read_graph" },
            { type: "text", text: "only this" },
          ],
        };
        yield { type: "result", subtype: "success", session_id: "sess-3" };
      },
    }));

    const chunks: string[] = [];
    await runClaude("hi", config, mcpServers, (text) => chunks.push(text));

    expect(chunks).toEqual(["only this"]);
  });
});

describe("claude result text emission", () => {
  it("emits result text via onChunk on success", async () => {
    mockQuery.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "result", subtype: "success", session_id: "sess-4", result: "Final answer" };
      },
    }));

    const chunks: string[] = [];
    await runClaude("question", config, mcpServers, (text) => chunks.push(text));

    expect(chunks).toContain("Final answer");
  });

  it("returns sessionId from init event when result has none", async () => {
    mockQuery.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-from-init" };
        yield { type: "result", subtype: "success", result: "done" };
      },
    }));

    const chunks: string[] = [];
    const result = await runClaude("hi", config, mcpServers, (text) => chunks.push(text));

    expect(result.sessionId).toBe("sess-from-init");
    expect(chunks).toContain("done");
  });
});
