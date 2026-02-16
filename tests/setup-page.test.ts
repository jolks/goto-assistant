// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from "vitest";
import { buildCronConfig, escapeHtml } from "../public/cron-sync.js";
import {
  defaultServers,
  getProvider,
  renderServers,
  readServers,
  syncCronConfig,
  handleProviderSwitch,
} from "../public/setup.js";

// In the browser, cron-sync.js var declarations become window globals.
// Replicate this for the test environment so setup.js can find them.
(globalThis as Record<string, unknown>).escapeHtml = escapeHtml;

interface Server {
  name: string;
  command: string;
  args: string;
  env: Record<string, string>;
}

/** Set up the minimal DOM expected by setup.js functions */
function setupDOM() {
  document.body.innerHTML = `
    <div class="radio-group">
      <label><input type="radio" name="provider" value="claude" checked> Claude</label>
      <label><input type="radio" name="provider" value="openai"> OpenAI</label>
    </div>
    <input type="password" id="apiKey" value="">
    <input type="text" id="baseUrl" value="">
    <select id="model"><option value="">— Select provider first —</option></select>
    <div id="mcpServers" class="mcp-servers"></div>
  `;
}

function setProvider(value: string) {
  const radio = document.querySelector(
    `input[name="provider"][value="${value}"]`
  ) as HTMLInputElement;
  radio.checked = true;
}

function setField(id: string, value: string) {
  (document.getElementById(id) as HTMLInputElement).value = value;
}

function setModel(value: string, label?: string) {
  const select = document.getElementById("model") as HTMLSelectElement;
  select.innerHTML = `<option value="${value}">${label || value}</option>`;
}

function cloneServers(servers: Server[]): Server[] {
  return servers.map((s) => ({ ...s, env: { ...s.env } }));
}

describe("setup page", () => {
  beforeEach(() => {
    setupDOM();
  });

  // -- Foundation --

  describe("getProvider", () => {
    it("returns claude when claude radio is checked", () => {
      setProvider("claude");
      expect(getProvider()).toBe("claude");
    });

    it("returns openai when openai radio is checked", () => {
      setProvider("openai");
      expect(getProvider()).toBe("openai");
    });
  });

  describe("renderServers / readServers roundtrip", () => {
    it("renders servers and reads them back correctly", () => {
      const servers: Server[] = [
        { name: "test-srv", command: "node", args: "index.js --flag", env: { KEY: "val" } },
      ];
      renderServers(servers);
      const result = readServers();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("test-srv");
      expect(result[0].command).toBe("node");
      expect(result[0].args).toBe("index.js --flag");
      expect(result[0].env).toEqual({ KEY: "val" });
    });

    it("roundtrips multiple servers with multiple env vars", () => {
      const servers: Server[] = [
        { name: "a", command: "npx", args: "-y pkg-a", env: { X: "1" } },
        { name: "b", command: "npx", args: "-y pkg-b", env: { Y: "2", Z: "3" } },
      ];
      renderServers(servers);
      const result = readServers();
      expect(result).toHaveLength(2);
      expect(result[0].env).toEqual({ X: "1" });
      expect(result[1].env).toEqual({ Y: "2", Z: "3" });
    });

    it("roundtrips defaultServers", () => {
      const servers = cloneServers(defaultServers);
      renderServers(servers);
      const result = readServers();
      expect(result).toHaveLength(defaultServers.length);
      expect(result[0].name).toBe("cron");
      expect(result[1].name).toBe("memory");
      expect(result[2].name).toBe("filesystem");
    });
  });

  // -- Provider switching (Bug 2a) --

  describe("handleProviderSwitch", () => {
    it("populates baseUrl and model when switching to openai", () => {
      setProvider("openai");
      const savedConfig = {
        openai: { baseUrl: "https://proxy.example.com", model: "gpt-4o" },
        claude: { baseUrl: "", model: "claude-sonnet-4-5-20250929" },
      };
      handleProviderSwitch(true, savedConfig);

      expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe(
        "https://proxy.example.com"
      );
      const select = document.getElementById("model") as HTMLSelectElement;
      expect(select.value).toBe("gpt-4o");
    });

    it("populates baseUrl and model when switching to claude", () => {
      setProvider("claude");
      const savedConfig = {
        claude: { baseUrl: "https://claude-proxy.example.com", model: "claude-sonnet-4-5-20250929" },
        openai: { baseUrl: "", model: "gpt-4o" },
      };
      handleProviderSwitch(true, savedConfig);

      expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe(
        "https://claude-proxy.example.com"
      );
      expect((document.getElementById("model") as HTMLSelectElement).value).toBe(
        "claude-sonnet-4-5-20250929"
      );
    });

    it("clears baseUrl when target provider has no baseUrl", () => {
      setField("baseUrl", "https://old-proxy.example.com");
      setProvider("openai");
      const savedConfig = {
        openai: { model: "gpt-4o" },
        claude: { baseUrl: "https://proxy.example.com", model: "claude-sonnet-4-5-20250929" },
      };
      handleProviderSwitch(true, savedConfig);

      expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe("");
    });

    it("shows Load models placeholder when target provider has no model", () => {
      setProvider("openai");
      const savedConfig = {
        openai: {},
        claude: { model: "claude-sonnet-4-5-20250929" },
      };
      handleProviderSwitch(true, savedConfig);

      const select = document.getElementById("model") as HTMLSelectElement;
      expect(select.value).toBe("");
      expect(select.innerHTML).toContain("Load models");
    });

    it("does nothing when not in edit mode", () => {
      setProvider("openai");
      setField("baseUrl", "original");
      const savedConfig = {
        openai: { baseUrl: "https://proxy.example.com", model: "gpt-4o" },
      };
      handleProviderSwitch(false, savedConfig);

      expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe("original");
    });

    it("does nothing when savedConfig is null", () => {
      setProvider("openai");
      setField("baseUrl", "original");
      handleProviderSwitch(true, null);

      expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe("original");
    });

    it("pre-fills baseUrl from savedConfig when target provider has baseUrl set", () => {
      setProvider("openai");
      const savedConfig = {
        openai: { baseUrl: "https://litellm.example.com/v1", model: "gpt-4o" },
        claude: { baseUrl: "", model: "claude-sonnet-4-5-20250929" },
      };
      handleProviderSwitch(true, savedConfig);

      expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe(
        "https://litellm.example.com/v1"
      );
    });

    it("preserves baseUrl from savedConfig when switching from claude+baseUrl to openai", () => {
      // Start with claude selected and a baseUrl
      setProvider("claude");
      setField("baseUrl", "https://litellm.example.com/v1");

      // Switch to openai
      setProvider("openai");
      const savedConfig = {
        openai: { baseUrl: "https://litellm.example.com/v1", model: "gpt-4o" },
        claude: { baseUrl: "https://litellm.example.com/v1", model: "claude-sonnet-4-5-20250929" },
      };
      handleProviderSwitch(true, savedConfig);

      expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe(
        "https://litellm.example.com/v1"
      );
    });
  });

  // -- syncCronConfig (Bug 2c) --

  describe("syncCronConfig", () => {
    it("preserves existing cron API_KEY env when apiKey field empty in edit mode", () => {
      setProvider("claude");
      setField("apiKey", "");
      setModel("claude-sonnet-4-5-20250929");

      const servers: Server[] = [
        {
          name: "cron",
          command: "npx",
          args: "-y mcp-cron --transport stdio --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929",
          env: { ANTHROPIC_API_KEY: "sk-existing-key" },
        },
      ];

      const result = syncCronConfig(servers, true, buildCronConfig);
      const cron = result.find((s: Server) => s.name === "cron");
      expect(cron.env.ANTHROPIC_API_KEY).toBe("sk-existing-key");
    });

    it("overwrites cron API_KEY when apiKey field has a value in edit mode", () => {
      setProvider("claude");
      setField("apiKey", "sk-new-key");
      setModel("claude-sonnet-4-5-20250929");

      const servers: Server[] = [
        {
          name: "cron",
          command: "npx",
          args: "-y mcp-cron --transport stdio --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929",
          env: { ANTHROPIC_API_KEY: "sk-old-key" },
        },
      ];

      const result = syncCronConfig(servers, true, buildCronConfig);
      const cron = result.find((s: Server) => s.name === "cron");
      expect(cron.env.ANTHROPIC_API_KEY).toBe("sk-new-key");
      expect(cron.env).not.toHaveProperty("OPENAI_API_KEY");
    });

    it("always sets API_KEY in non-edit mode (fresh setup)", () => {
      setProvider("claude");
      setField("apiKey", "");
      setModel("claude-sonnet-4-5-20250929");

      const servers: Server[] = [
        {
          name: "cron",
          command: "npx",
          args: "-y mcp-cron --transport stdio --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929",
          env: {},
        },
      ];

      const result = syncCronConfig(servers, false, buildCronConfig);
      const cron = result.find((s: Server) => s.name === "cron");
      // Even with empty apiKey, envKey is set in non-edit mode
      expect(cron.env).toHaveProperty("ANTHROPIC_API_KEY");
    });

    it("switches env key from ANTHROPIC to OPENAI when provider changes", () => {
      setProvider("openai");
      setField("apiKey", "sk-openai-key");
      setModel("gpt-4o");

      const servers: Server[] = [
        {
          name: "cron",
          command: "npx",
          args: "-y mcp-cron --transport stdio --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929",
          env: { ANTHROPIC_API_KEY: "sk-old-claude-key" },
        },
      ];

      const result = syncCronConfig(servers, false, buildCronConfig);
      const cron = result.find((s: Server) => s.name === "cron");
      expect(cron.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(cron.env.OPENAI_API_KEY).toBe("sk-openai-key");
      expect(cron.args).toContain("--ai-provider openai");
    });

    it("renames env key and shows target provider masked key from savedConfig", () => {
      setProvider("openai");
      setField("apiKey", "");
      setModel("gpt-4o");

      const servers: Server[] = [
        {
          name: "cron",
          command: "npx",
          args: "-y mcp-cron --transport stdio --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929",
          env: { ANTHROPIC_API_KEY: "sk-a****3456" },
        },
      ];
      const savedConfig = {
        claude: { apiKey: "sk-a****3456", model: "claude-sonnet-4-5-20250929" },
        openai: { apiKey: "sk-o****7890", model: "gpt-4o" },
      };

      const result = syncCronConfig(servers, true, buildCronConfig, savedConfig);
      const cron = result.find((s: Server) => s.name === "cron");
      expect(cron.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(cron.env.OPENAI_API_KEY).toBe("sk-o****7890");
      expect(cron.args).toContain("--ai-provider openai");
    });

    it("falls back to existing env value when savedConfig has no target key", () => {
      setProvider("openai");
      setField("apiKey", "");
      setModel("gpt-4o");

      const servers: Server[] = [
        {
          name: "cron",
          command: "npx",
          args: "-y mcp-cron --transport stdio --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929",
          env: { ANTHROPIC_API_KEY: "sk-a****3456" },
        },
      ];
      const savedConfig = {
        claude: { apiKey: "sk-a****3456", model: "claude-sonnet-4-5-20250929" },
        openai: {},
      };

      const result = syncCronConfig(servers, true, buildCronConfig, savedConfig);
      const cron = result.find((s: Server) => s.name === "cron");
      expect(cron.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(cron.env.OPENAI_API_KEY).toBe("sk-a****3456");
    });

    it("returns servers unchanged when no cron server exists", () => {
      setProvider("claude");
      setField("apiKey", "sk-test");
      setModel("claude-sonnet-4-5-20250929");

      const servers: Server[] = [
        { name: "memory", command: "npx", args: "-y @mcp/server-memory", env: {} },
      ];

      const result = syncCronConfig(servers, false, buildCronConfig);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("memory");
    });

    it("updates cron args with new model", () => {
      setProvider("claude");
      setField("apiKey", "sk-test");
      setModel("claude-opus-4-6");

      const servers: Server[] = [
        {
          name: "cron",
          command: "npx",
          args: "-y mcp-cron --transport stdio --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929",
          env: {},
        },
      ];

      const result = syncCronConfig(servers, false, buildCronConfig);
      const cron = result.find((s: Server) => s.name === "cron");
      expect(cron.args).toContain("--ai-model claude-opus-4-6");
      expect(cron.args).not.toContain("claude-sonnet-4-5-20250929");
    });
  });

  // -- LiteLLM proxy (baseUrl set) --

  describe("syncCronConfig with LiteLLM proxy", () => {
    it("with claude + baseUrl uses --ai-provider openai and MCP_CRON_AI_API_KEY", () => {
      setProvider("claude");
      setField("apiKey", "sk-litellm-key");
      setField("baseUrl", "https://litellm.example.com/v1");
      setModel("claude-sonnet-4-5-20250929");

      const servers: Server[] = [
        {
          name: "cron",
          command: "npx",
          args: "-y mcp-cron --transport stdio --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929",
          env: {},
        },
      ];

      const result = syncCronConfig(servers, false, buildCronConfig);
      const cron = result.find((s: Server) => s.name === "cron");
      expect(cron.args).toContain("--ai-provider openai");
      expect(cron.args).toContain("--ai-base-url https://litellm.example.com/v1");
      expect(cron.env).toHaveProperty("MCP_CRON_AI_API_KEY");
      expect(cron.env.MCP_CRON_AI_API_KEY).toBe("sk-litellm-key");
      expect(cron.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    });

    it("with openai + baseUrl uses --ai-provider openai and MCP_CRON_AI_API_KEY", () => {
      setProvider("openai");
      setField("apiKey", "sk-litellm-key");
      setField("baseUrl", "https://litellm.example.com/v1");
      setModel("gpt-4o");

      const servers: Server[] = [
        {
          name: "cron",
          command: "npx",
          args: "-y mcp-cron --transport stdio --ai-provider openai --ai-model gpt-4o",
          env: {},
        },
      ];

      const result = syncCronConfig(servers, false, buildCronConfig);
      const cron = result.find((s: Server) => s.name === "cron");
      expect(cron.args).toContain("--ai-provider openai");
      expect(cron.args).toContain("--ai-base-url https://litellm.example.com/v1");
      expect(cron.env).toHaveProperty("MCP_CRON_AI_API_KEY");
      expect(cron.env).not.toHaveProperty("OPENAI_API_KEY");
    });
  });
});
