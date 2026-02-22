import { describe, it, expect, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { Attachment, HistoryMessage } from "../src/agents/router.js";

// Capture what gets passed to run()
let capturedInput: unknown = null;

// Mock uploads module to return fake image data
vi.mock("../src/uploads.js", () => ({
  getUpload: vi.fn().mockImplementation((fileId: string) => {
    if (fileId === "abc") {
      return { data: Buffer.from("fake-img"), filename: "img.png", mimeType: "image/png" };
    }
    return null;
  }),
  UPLOADS_DIR: "tests/data/uploads",
  ALLOWED_IMAGE_TYPES: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  saveUpload: vi.fn(),
}));

// Mock MaxTurnsExceededError class
class MockMaxTurnsExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaxTurnsExceededError";
  }
}

// Mock @openai/agents before importing runOpenAI
const mockRun = vi.fn().mockImplementation((_agent: unknown, input: unknown) => {
  capturedInput = input;
  return {
    [Symbol.asyncIterator]: async function* () {
      // yield nothing — we just care about the input
    },
  };
});

vi.mock("@openai/agents", () => {
  return {
    Agent: vi.fn().mockImplementation(() => ({})),
    MCPServerStdio: vi.fn().mockImplementation(() => ({
      connect: vi.fn(),
      close: vi.fn(),
    })),
    run: mockRun,
    shellTool: vi.fn().mockImplementation(() => ({ type: "shell", name: "shell" })),
    MaxTurnsExceededError: MockMaxTurnsExceededError,
  };
});

const { runOpenAI } = await import("../src/agents/openai.js");

const config: Config = {
  provider: "openai",
  claude: { apiKey: "", model: "", baseUrl: "" },
  openai: { apiKey: "sk-test", model: "gpt-4o", baseUrl: "" },
  server: { port: 3000 },
};

const mcpServers = {};

describe("openai input construction", () => {
  it("passes plain string when no history and no attachments", async () => {
    await runOpenAI("hello", config, mcpServers, vi.fn());
    expect(capturedInput).toBe("hello");
  });

  it("passes message array when history is present", async () => {
    const history: HistoryMessage[] = [
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ];
    await runOpenAI("follow up", config, mcpServers, vi.fn(), { history });

    expect(Array.isArray(capturedInput)).toBe(true);
    const messages = capturedInput as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: "user", content: "previous question" });
    expect(messages[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "previous answer" }] });
    expect(messages[2]).toEqual({ role: "user", content: "follow up" });
  });

  it("passes structured array with image blocks when attachments present (no history)", async () => {
    const attachments: Attachment[] = [{
      filename: "test.png",
      mimeType: "image/png",
      data: Buffer.from("fake-image"),
    }];
    await runOpenAI("describe this", config, mcpServers, vi.fn(), { attachments });

    expect(Array.isArray(capturedInput)).toBe(true);
    const messages = capturedInput as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");

    const content = messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("input_image");
    expect((content[0].image as string).startsWith("data:image/png;base64,")).toBe(true);
    expect(content[1]).toEqual({ type: "input_text", text: "describe this" });
  });

  it("passes history + image attachments together", async () => {
    const history: HistoryMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const attachments: Attachment[] = [{
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      data: Buffer.from("jpeg-data"),
    }];
    await runOpenAI("what is this?", config, mcpServers, vi.fn(), { attachments, history });

    const messages = capturedInput as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: "user", content: "hi" });
    expect(messages[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "hello" }] });

    const content = messages[2].content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("input_image");
    expect(content[1]).toEqual({ type: "input_text", text: "what is this?" });
  });

  it("re-includes images from uploads for history messages with attachments", async () => {
    const history: HistoryMessage[] = [
      { role: "user", content: JSON.stringify({ text: "look at this", attachments: [{ fileId: "abc", filename: "img.png", mimeType: "image/png" }] }) },
      { role: "assistant", content: "I see an image" },
    ];
    await runOpenAI("and this?", config, mcpServers, vi.fn(), { history });

    const messages = capturedInput as Array<Record<string, unknown>>;
    // User message should have image + text content blocks
    expect(messages[0].role).toBe("user");
    const content = messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("input_image");
    expect((content[0].image as string).startsWith("data:image/png;base64,")).toBe(true);
    expect(content[1]).toEqual({ type: "input_text", text: "look at this" });

    expect(messages[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "I see an image" }] });
    expect(messages[2]).toEqual({ role: "user", content: "and this?" });
  });
});

describe("openai max turns handling", () => {
  it("sends a user-friendly message when MaxTurnsExceededError is thrown", async () => {
    mockRun.mockImplementationOnce(() => {
      throw new MockMaxTurnsExceededError("Max turns (30) exceeded");
    });

    const chunks: string[] = [];
    await runOpenAI("do something complex", config, mcpServers, (text) => chunks.push(text));

    expect(chunks.join("")).toContain("reached the maximum number of tool-use turns");
  });

  it("re-throws non-MaxTurnsExceededError errors", async () => {
    mockRun.mockImplementationOnce(() => {
      throw new Error("API connection failed");
    });

    await expect(
      runOpenAI("hello", config, mcpServers, vi.fn())
    ).rejects.toThrow("API connection failed");
  });
});
