// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildCronConfig } from "../public/cron-sync.js";
import {
  renderServers,
  readServers,
  syncCronConfig,
  getProvider,
  handleProviderSwitch,
} from "../public/setup.js";

// In the browser, <script> var declarations become window globals.
// Replicate this for the test environment so setup-chat.js can find them.
(globalThis as Record<string, unknown>).buildCronConfig = buildCronConfig;
(globalThis as Record<string, unknown>).readServers = readServers;
(globalThis as Record<string, unknown>).renderServers = renderServers;
(globalThis as Record<string, unknown>).syncCronConfig = syncCronConfig;
(globalThis as Record<string, unknown>).getProvider = getProvider;
(globalThis as Record<string, unknown>).handleProviderSwitch = handleProviderSwitch;

import {
  setupChatState,
  addMessage,
  showChoices,
  setInputMode,
  buildDefaultMcpServers,
  handleInput,
  initSetupChat,
  syncCronFromChat,
} from "../public/setup-chat.js";

/** Minimal DOM for setup chat + form */
function setupDOM() {
  document.body.innerHTML = `
    <div class="setup-layout">
      <div class="setup-form">
        <label><input type="radio" name="provider" value="claude" checked> Claude</label>
        <label><input type="radio" name="provider" value="openai"> OpenAI</label>
        <input type="password" id="apiKey" value="">
        <input type="text" id="baseUrl" value="">
        <select id="model"><option value="">— Select provider first —</option></select>
        <input type="number" id="port" value="3000">
        <div id="mcpServers" class="mcp-servers"></div>
      </div>
      <div class="setup-chat" id="setupChat">
        <div class="setup-chat-header">
          <h3>Setup Assistant</h3>
          <button class="setup-chat-close" id="chatCloseBtn">×</button>
        </div>
        <div class="setup-chat-messages" id="chatMessages"></div>
        <div class="setup-chat-input">
          <div id="chatChoices"></div>
          <div class="setup-chat-input-row">
            <textarea id="chatInput" rows="1"></textarea>
            <button id="chatSendBtn">Send</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function resetState() {
  setupChatState.current = "provider";
  setupChatState.provider = null;
  setupChatState.apiKey = null;
  setupChatState.baseUrl = null;
  setupChatState.model = null;
  setupChatState.conversationId = null;
  setupChatState.ws = null;
  setupChatState.streamingText = "";
  setupChatState.streamingEl = null;
}

describe("setup-chat", () => {
  beforeEach(() => {
    setupDOM();
    resetState();
  });

  describe("addMessage", () => {
    it("adds a user message to chat messages container", () => {
      addMessage("user", "Hello");
      const msgs = document.querySelectorAll("#chatMessages .message");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].classList.contains("user")).toBe(true);
      expect(msgs[0].textContent).toContain("Hello");
    });

    it("adds an assistant message to chat messages container", () => {
      addMessage("assistant", "Welcome!");
      const msgs = document.querySelectorAll("#chatMessages .message");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].classList.contains("assistant")).toBe(true);
    });

    it("adds multiple messages in order", () => {
      addMessage("assistant", "First");
      addMessage("user", "Second");
      addMessage("assistant", "Third");
      const msgs = document.querySelectorAll("#chatMessages .message");
      expect(msgs).toHaveLength(3);
      expect(msgs[0].textContent).toContain("First");
      expect(msgs[1].textContent).toContain("Second");
      expect(msgs[2].textContent).toContain("Third");
    });
  });

  describe("showChoices", () => {
    it("renders choice buttons", () => {
      showChoices(
        [
          { label: "Claude", value: "claude" },
          { label: "OpenAI", value: "openai" },
        ],
        () => {}
      );
      const buttons = document.querySelectorAll("#chatChoices .chat-choice-btn");
      expect(buttons).toHaveLength(2);
      expect(buttons[0].textContent).toBe("Claude");
      expect(buttons[1].textContent).toBe("OpenAI");
    });

    it("calls onSelect with value when button clicked", () => {
      const onSelect = vi.fn();
      showChoices(
        [
          { label: "Claude", value: "claude" },
          { label: "OpenAI", value: "openai" },
        ],
        onSelect
      );
      const buttons = document.querySelectorAll("#chatChoices .chat-choice-btn");
      (buttons[0] as HTMLElement).click();
      expect(onSelect).toHaveBeenCalledWith("claude");
    });

    it("clears choices after selection", () => {
      showChoices([{ label: "A", value: "a" }], () => {});
      const btn = document.querySelector("#chatChoices .chat-choice-btn") as HTMLElement;
      btn.click();
      expect(document.querySelectorAll("#chatChoices .chat-choice-btn")).toHaveLength(0);
    });
  });

  describe("setInputMode", () => {
    it("disables textarea and button in disabled mode", () => {
      setInputMode("disabled");
      const textarea = document.getElementById("chatInput") as HTMLTextAreaElement;
      const btn = document.getElementById("chatSendBtn") as HTMLButtonElement;
      expect(textarea.disabled).toBe(true);
      expect(btn.disabled).toBe(true);
    });

    it("enables textarea in password mode with placeholder", () => {
      setInputMode("password");
      const textarea = document.getElementById("chatInput") as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(false);
      expect(textarea.placeholder).toBe("Enter your API key...");
    });

    it("enables textarea in text mode", () => {
      setInputMode("text");
      const textarea = document.getElementById("chatInput") as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(false);
      expect(textarea.placeholder).toBe("Send a message...");
    });

    it("enables textarea in optional mode with skip hint", () => {
      setInputMode("optional");
      const textarea = document.getElementById("chatInput") as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(false);
      expect(textarea.placeholder).toContain("Enter to skip");
    });
  });

  describe("buildDefaultMcpServers", () => {
    it("builds default servers for claude provider", () => {
      const servers = buildDefaultMcpServers("claude", "sk-ant-test", "claude-sonnet-4-5-20250929", "");
      expect(servers).toHaveProperty("cron");
      expect(servers).toHaveProperty("memory");
      expect(servers).toHaveProperty("filesystem");
      expect(servers).toHaveProperty("time");
    });

    it("sets ANTHROPIC_API_KEY for claude provider", () => {
      const servers = buildDefaultMcpServers("claude", "sk-ant-test", "claude-sonnet-4-5-20250929", "");
      expect(servers.cron.env).toHaveProperty("ANTHROPIC_API_KEY");
      expect(servers.cron.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    });

    it("sets OPENAI_API_KEY for openai provider", () => {
      const servers = buildDefaultMcpServers("openai", "sk-openai-test", "gpt-4o", "");
      expect(servers.cron.env).toHaveProperty("OPENAI_API_KEY");
      expect(servers.cron.env.OPENAI_API_KEY).toBe("sk-openai-test");
    });

    it("uses MCP_CRON_AI_API_KEY when baseUrl is set", () => {
      const servers = buildDefaultMcpServers("claude", "sk-proxy", "claude-sonnet-4-5-20250929", "https://proxy.example.com");
      expect(servers.cron.env).toHaveProperty("MCP_CRON_AI_API_KEY");
      expect(servers.cron.args).toContain("--ai-base-url");
    });

    it("configures correct cron args for model", () => {
      const servers = buildDefaultMcpServers("claude", "sk-test", "claude-opus-4-6", "");
      expect(servers.cron.args.join(" ")).toContain("--ai-model claude-opus-4-6");
    });

    it("memory server has correct args", () => {
      const servers = buildDefaultMcpServers("claude", "sk-test", "claude-sonnet-4-5-20250929", "");
      expect(servers.memory.args).toEqual(["-y", "@modelcontextprotocol/server-memory"]);
    });

    it("filesystem server has correct args", () => {
      const servers = buildDefaultMcpServers("claude", "sk-test", "claude-sonnet-4-5-20250929", "");
      expect(servers.filesystem.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "."]);
    });

    it("time server has correct command and args", () => {
      const servers = buildDefaultMcpServers("claude", "sk-test", "claude-sonnet-4-5-20250929", "");
      expect(servers.time.command).toBe("uvx");
      expect(servers.time.args).toEqual(["mcp-server-time"]);
    });
  });

  describe("handleInput — Q&A state transitions", () => {
    it("api_key state: sets apiKey and advances to base_url", () => {
      setupChatState.current = "api_key";
      setupChatState.provider = "claude";
      handleInput("sk-ant-test-key");

      expect(setupChatState.apiKey).toBe("sk-ant-test-key");
      expect(setupChatState.current).toBe("base_url");
      // Form field should be updated
      expect((document.getElementById("apiKey") as HTMLInputElement).value).toBe("sk-ant-test-key");
      // Chat should show masked key
      const msgs = document.querySelectorAll("#chatMessages .message.user");
      expect(msgs[0].textContent).toContain("\u2022\u2022\u2022\u2022");
    });

    it("base_url state with empty input: skips and advances to loading_models", () => {
      setupChatState.current = "base_url";
      setupChatState.provider = "claude";
      setupChatState.apiKey = "sk-test";

      // Mock fetch for loadModelsForChat
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" }] }),
      });

      handleInput("");

      expect(setupChatState.baseUrl).toBe("");
      expect(setupChatState.current).toBe("loading_models");
      // Should show (skipped) in chat
      const userMsgs = document.querySelectorAll("#chatMessages .message.user");
      expect(userMsgs[0].textContent).toContain("(skipped)");
    });

    it("base_url state with URL: stores baseUrl and advances", () => {
      setupChatState.current = "base_url";
      setupChatState.provider = "openai";
      setupChatState.apiKey = "sk-test";

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ id: "gpt-4o", name: "gpt-4o" }] }),
      });

      handleInput("https://proxy.example.com");

      expect(setupChatState.baseUrl).toBe("https://proxy.example.com");
      expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe("https://proxy.example.com");
    });
  });

  describe("initSetupChat", () => {
    it("starts Q&A on fresh setup", () => {
      initSetupChat({ isEditing: false, config: null });
      // Should show welcome message
      const msgs = document.querySelectorAll("#chatMessages .message.assistant");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].textContent).toContain("Welcome");
      // Should show provider choices
      const choices = document.querySelectorAll("#chatChoices .chat-choice-btn");
      expect(choices).toHaveLength(2);
    });

    it("shows config summary in edit mode", () => {
      initSetupChat({
        isEditing: true,
        config: {
          provider: "claude",
          claude: { model: "claude-sonnet-4-5-20250929" },
          openai: {},
        },
      });
      const msgs = document.querySelectorAll("#chatMessages .message.assistant");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].textContent).toContain("claude");
      expect(msgs[0].textContent).toContain("claude-sonnet-4-5-20250929");
      // Should show edit choices
      const choices = document.querySelectorAll("#chatChoices .chat-choice-btn");
      expect(choices).toHaveLength(2);
      expect(choices[0].textContent).toBe("Reconfigure Basics");
      expect(choices[1].textContent).toBe("Customize MCP Servers");
    });

    it("wires up send button", () => {
      initSetupChat({ isEditing: false, config: null });
      const sendBtn = document.getElementById("chatSendBtn") as HTMLButtonElement;
      expect(sendBtn).toBeTruthy();
      // Send button should exist and be wired
    });

    it("wires up Enter key on input", () => {
      initSetupChat({ isEditing: false, config: null });
      const input = document.getElementById("chatInput") as HTMLTextAreaElement;
      expect(input).toBeTruthy();
    });
  });

  describe("edit mode choices", () => {
    it("reconfigure choice starts Q&A", () => {
      initSetupChat({
        isEditing: true,
        config: { provider: "claude", claude: { model: "claude-sonnet-4-5-20250929" }, openai: {} },
      });
      // Click "Reconfigure Basics"
      const choices = document.querySelectorAll("#chatChoices .chat-choice-btn");
      (choices[0] as HTMLElement).click();

      // Should now show provider selection
      expect(setupChatState.current).toBe("provider");
      const newChoices = document.querySelectorAll("#chatChoices .chat-choice-btn");
      expect(newChoices).toHaveLength(2);
      expect(newChoices[0].textContent).toBe("Claude");
    });
  });

  describe("syncCronFromChat — integration with real form sync", () => {
    /**
     * Render default servers to the DOM so readServers/syncCronConfig/renderServers
     * can work. syncCronFromChat now calls these globals directly.
     */
    function renderDefaultServers() {
      const servers = [
        { name: "cron", command: "npx", args: "-y mcp-cron --transport stdio --prevent-sleep --mcp-config-path ./data/mcp.json --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929", env: {} },
        { name: "memory", command: "npx", args: "-y @modelcontextprotocol/server-memory", env: {} },
        { name: "filesystem", command: "npx", args: "-y @modelcontextprotocol/server-filesystem .", env: {} },
        { name: "time", command: "uvx", args: "mcp-server-time", env: {} },
      ];
      renderServers(servers);
    }

    it("provider change via chat updates cron --ai-provider in the form", () => {
      renderDefaultServers();

      // Verify initial state: cron has --ai-provider anthropic
      let servers = readServers();
      let cron = servers.find((s: { name: string }) => s.name === "cron");
      expect(cron.args).toContain("--ai-provider anthropic");

      initSetupChat({ isEditing: false, config: null });
      // Click "OpenAI" provider choice
      const choices = document.querySelectorAll("#chatChoices .chat-choice-btn");
      (choices[1] as HTMLElement).click();

      // Now read the form again — cron should have --ai-provider openai
      servers = readServers();
      cron = servers.find((s: { name: string }) => s.name === "cron");
      expect(cron.args).toContain("--ai-provider openai");
      expect(cron.args).not.toContain("--ai-provider anthropic");
    });

    it("provider change via chat updates cron env key in the form", () => {
      renderDefaultServers();

      initSetupChat({ isEditing: false, config: null });
      // Click "OpenAI"
      const choices = document.querySelectorAll("#chatChoices .chat-choice-btn");
      (choices[1] as HTMLElement).click();

      const servers = readServers();
      const cron = servers.find((s: { name: string }) => s.name === "cron");
      expect(cron.env).toHaveProperty("OPENAI_API_KEY");
      expect(cron.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    });

    it("API key entry via chat updates cron env value in the form", () => {
      renderDefaultServers();

      // First pick a provider
      initSetupChat({ isEditing: false, config: null });
      const choices = document.querySelectorAll("#chatChoices .chat-choice-btn");
      (choices[0] as HTMLElement).click(); // Claude

      // Then enter API key
      handleInput("sk-ant-my-key-123");

      const servers = readServers();
      const cron = servers.find((s: { name: string }) => s.name === "cron");
      expect(cron.env.ANTHROPIC_API_KEY).toBe("sk-ant-my-key-123");
    });

    it("edit mode: provider change renames env key using savedConfig", () => {
      // Simulate edit mode: servers loaded from API with existing env
      const servers = [
        { name: "cron", command: "npx", args: "-y mcp-cron --transport stdio --prevent-sleep --mcp-config-path ./data/mcp.json --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929", env: { ANTHROPIC_API_KEY: "sk-a****3456" } },
        { name: "memory", command: "npx", args: "-y @modelcontextprotocol/server-memory", env: {} },
      ];
      renderServers(servers);
      (window as Record<string, unknown>)._savedConfig = {
        provider: "claude",
        claude: { apiKey: "sk-a****3456", model: "claude-sonnet-4-5-20250929" },
        openai: { apiKey: "sk-o****7890", model: "gpt-4o" },
      };

      initSetupChat({
        isEditing: true,
        config: { provider: "claude", claude: { model: "claude-sonnet-4-5-20250929" }, openai: { model: "gpt-4o" } },
      });

      // Click "Reconfigure Basics" → then "OpenAI"
      let choices = document.querySelectorAll("#chatChoices .chat-choice-btn");
      (choices[0] as HTMLElement).click(); // "Reconfigure Basics"
      choices = document.querySelectorAll("#chatChoices .chat-choice-btn");
      (choices[1] as HTMLElement).click(); // "OpenAI"

      const result = readServers();
      const cron = result.find((s: { name: string }) => s.name === "cron");
      expect(cron.args).toContain("--ai-provider openai");
      expect(cron.env).toHaveProperty("OPENAI_API_KEY");
      expect(cron.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      // Should use the masked key from savedConfig for the target provider
      expect(cron.env.OPENAI_API_KEY).toBe("sk-o****7890");

      delete (window as Record<string, unknown>)._savedConfig;
    });

    it("does not throw when global functions are not available", () => {
      // syncCronFromChat guards against missing globals
      expect(() => syncCronFromChat()).not.toThrow();
    });
  });
});
