import { describe, it, expect, vi } from "vitest";
import type { Config } from "../src/config.js";

// Mock the agent modules before importing router
vi.mock("../src/agents/claude.js", () => ({
  runClaude: vi.fn().mockResolvedValue({ sessionId: "claude-session-1", conversationId: "" }),
}));

vi.mock("../src/agents/openai.js", () => ({
  runOpenAI: vi.fn().mockResolvedValue(undefined),
}));

const { routeMessage } = await import("../src/agents/router.js");
const { runClaude } = await import("../src/agents/claude.js");
const { runOpenAI } = await import("../src/agents/openai.js");

const baseConfig: Config = {
  provider: "claude",
  claude: { apiKey: "sk-ant-test", model: "claude-sonnet-4-5-20250929", baseUrl: "" },
  openai: { apiKey: "sk-test", model: "gpt-4o", baseUrl: "" },
  server: { port: 3000 },
  mcpServers: {},
};

describe("router", () => {
  it("routes to Claude when provider is claude", async () => {
    const config = { ...baseConfig, provider: "claude" as const };
    const onChunk = vi.fn();
    const result = await routeMessage("hello", config, onChunk);

    expect(runClaude).toHaveBeenCalledWith("hello", config, onChunk, undefined);
    expect(result.sessionId).toBe("claude-session-1");
  });

  it("routes to OpenAI when provider is openai", async () => {
    const config = { ...baseConfig, provider: "openai" as const };
    const onChunk = vi.fn();
    const result = await routeMessage("hello", config, onChunk);

    expect(runOpenAI).toHaveBeenCalledWith("hello", config, onChunk);
    expect(result.sessionId).toBeNull();
  });

  it("throws on unknown provider", async () => {
    const config = { ...baseConfig, provider: "unknown" as "claude" };
    await expect(routeMessage("hello", config, vi.fn())).rejects.toThrow("Unknown provider");
  });
});
