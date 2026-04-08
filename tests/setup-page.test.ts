// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// setup.js references DEFAULT_CRON_ARGS and escapeHtml as globals (set by cron-sync.js <script> in the browser).
// vi.hoisted runs before imports are evaluated, so setup.js can find them during module init.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).DEFAULT_CRON_ARGS = '-y mcp-cron --transport stdio --prevent-sleep --mcp-config-path ./data/mcp.json --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929';
  (globalThis as Record<string, unknown>).escapeHtml = function (str: string) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
});

import { buildCronConfig } from "../public/cron-sync.js";
import {
  defaultServers,
  getProvider,
  renderServers,
  readServers,
  syncCronConfig,
  handleProviderSwitch,
  toggleBaseUrl,
  showApiKeyStatus,
  autoLoadModels,
} from "../public/setup.js";

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
    <small id="apiKeyStatus" class="api-key-status"></small>
    <div id="baseUrlRow">
      <input type="text" id="baseUrl" value="">
    </div>
    <div class="model-select-row">
      <select id="model"><option value="">— Select provider first —</option></select>
      <span id="modelSpinner" class="model-spinner" style="display:none"></span>
    </div>
    <details id="mcpDetails">
      <summary>MCP Servers <small id="mcpCount"></small></summary>
      <div id="mcpServers" class="mcp-servers"></div>
    </details>
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

    it("escapes HTML special characters in server fields (XSS prevention)", () => {
      const servers: Server[] = [
        { name: '<img onerror="alert(1)">', command: 'node">', args: '--flag <script>', env: { '<key>': '<val>' } },
      ];
      renderServers(servers);
      const container = document.getElementById("mcpServers")!;
      // No injected elements — escapeHtml prevents XSS
      expect(container.querySelectorAll("script")).toHaveLength(0);
      expect(container.querySelectorAll("img")).toHaveLength(0);
      // DOM .value auto-unescapes, so readServers should return the original values
      const result = readServers();
      expect(result[0].name).toBe('<img onerror="alert(1)">');
      expect(result[0].command).toBe('node">');
      expect(result[0].args).toBe('--flag <script>');
      expect(result[0].env['<key>']).toBe('<val>');
    });

    it("roundtrips defaultServers", () => {
      const servers = cloneServers(defaultServers);
      renderServers(servers);
      const result = readServers();
      expect(result).toHaveLength(defaultServers.length);
      expect(result[0].name).toBe("cron");
      expect(result[1].name).toBe("memory");
      expect(result[2].name).toBe("time");
    });
  });

  // -- Base URL visibility --

  describe("toggleBaseUrl", () => {
    it("hides baseUrlRow and clears value for claude", () => {
      setField("baseUrl", "https://proxy.example.com");
      toggleBaseUrl("claude");
      const row = document.getElementById("baseUrlRow") as HTMLElement;
      expect(row.style.display).toBe("none");
      expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe("");
    });

    it("shows baseUrlRow for openai", () => {
      const row = document.getElementById("baseUrlRow") as HTMLElement;
      row.style.display = "none";
      toggleBaseUrl("openai");
      expect(row.style.display).toBe("");
    });

    it("does not throw when baseUrlRow is missing", () => {
      document.getElementById("baseUrlRow")!.remove();
      expect(() => toggleBaseUrl("claude")).not.toThrow();
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

    // Note: in production, toggleBaseUrl("claude") is called first, which clears
    // the value and hides the row. This tests handleProviderSwitch in isolation.
    it("does not restore baseUrl when switching to claude", () => {
      setProvider("claude");
      setField("baseUrl", "https://old-proxy.example.com");
      const savedConfig = {
        claude: { baseUrl: "https://claude-proxy.example.com", model: "claude-sonnet-4-5-20250929" },
        openai: { baseUrl: "", model: "gpt-4o" },
      };
      handleProviderSwitch(true, savedConfig);

      // baseUrl should NOT be restored for Claude (SDK doesn't support proxies)
      expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe(
        "https://old-proxy.example.com"
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

    it("combined toggleBaseUrl + handleProviderSwitch hides and clears for claude", () => {
      setField("baseUrl", "https://proxy.example.com");
      setProvider("claude");
      const savedConfig = {
        claude: { baseUrl: "https://claude-proxy.example.com", model: "claude-sonnet-4-5-20250929" },
        openai: { baseUrl: "https://openai-proxy.example.com", model: "gpt-4o" },
      };
      toggleBaseUrl("claude");
      handleProviderSwitch(true, savedConfig);

      const row = document.getElementById("baseUrlRow") as HTMLElement;
      expect(row.style.display).toBe("none");
      expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe("");
    });

    it("combined toggleBaseUrl + handleProviderSwitch shows and restores for openai", () => {
      // Start hidden (as if coming from Claude)
      const row = document.getElementById("baseUrlRow") as HTMLElement;
      row.style.display = "none";
      setProvider("openai");
      const savedConfig = {
        claude: { baseUrl: "", model: "claude-sonnet-4-5-20250929" },
        openai: { baseUrl: "https://litellm.example.com/v1", model: "gpt-4o" },
      };
      toggleBaseUrl("openai");
      handleProviderSwitch(true, savedConfig);

      expect(row.style.display).toBe("");
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

  // -- API key status indicator --

  describe("showApiKeyStatus", () => {
    it("shows 'Key saved' text and saved class when true", () => {
      showApiKeyStatus(true);
      const el = document.getElementById("apiKeyStatus")!;
      expect(el.textContent).toBe("Key saved");
      expect(el.className).toBe("api-key-status saved");
    });

    it("clears text and resets class when false", () => {
      showApiKeyStatus(true);
      showApiKeyStatus(false);
      const el = document.getElementById("apiKeyStatus")!;
      expect(el.textContent).toBe("");
      expect(el.className).toBe("api-key-status");
    });

    it("does not throw when element is missing", () => {
      document.getElementById("apiKeyStatus")!.remove();
      expect(() => showApiKeyStatus(true)).not.toThrow();
    });
  });

  // -- Auto-load models --

  describe("autoLoadModels", () => {
    let originalFetch: typeof globalThis.fetch;
    let fetchBody: Record<string, unknown> | null;

    function mockFetch(response: { ok: boolean; models?: Array<{ id: string; name: string }> }) {
      fetchBody = null;
      globalThis.fetch = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
        if (opts?.body) fetchBody = JSON.parse(opts.body as string);
        if (!response.ok) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ error: "No API key configured" }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: response.models }),
        });
      }) as unknown as typeof fetch;
    }

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("shows loading state and spinner while fetching", async () => {
      let resolveResponse!: (v: unknown) => void;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        return new Promise((r) => { resolveResponse = r; });
      }) as unknown as typeof fetch;

      const promise = autoLoadModels("claude", "sk-test", undefined, undefined);
      const select = document.getElementById("model") as HTMLSelectElement;
      const spinner = document.getElementById("modelSpinner") as HTMLElement;
      expect(select.innerHTML).toContain("Loading...");
      expect(spinner.style.display).toBe("");

      resolveResponse({
        ok: true,
        json: () => Promise.resolve({ models: [{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" }] }),
      });
      await promise;
      expect(spinner.style.display).toBe("none");
    });

    it("populates select with returned models", async () => {
      mockFetch({ ok: true, models: [
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
      ]});
      await autoLoadModels("openai", "sk-test", undefined, undefined);
      const select = document.getElementById("model") as HTMLSelectElement;
      expect(select.options).toHaveLength(2);
      expect(select.options[0].value).toBe("gpt-4o");
      expect(select.options[0].text).toBe("GPT-4o");
      expect(select.options[1].value).toBe("gpt-3.5-turbo");
    });

    it("pre-selects savedModel when it exists in the list", async () => {
      mockFetch({ ok: true, models: [
        { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      ]});
      await autoLoadModels("openai", "sk-test", undefined, "gpt-4o");
      const select = document.getElementById("model") as HTMLSelectElement;
      expect(select.value).toBe("gpt-4o");
    });

    it("omits apiKey from request body when not provided", async () => {
      mockFetch({ ok: true, models: [{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" }] });
      await autoLoadModels("claude", undefined, undefined, undefined);
      expect(fetchBody).toEqual({ provider: "claude" });
      expect(fetchBody).not.toHaveProperty("apiKey");
    });

    it("includes apiKey in request body when provided", async () => {
      mockFetch({ ok: true, models: [{ id: "gpt-4o", name: "GPT-4o" }] });
      await autoLoadModels("openai", "sk-test-key", undefined, undefined);
      expect(fetchBody).toHaveProperty("apiKey", "sk-test-key");
    });

    it("includes baseUrl when provided", async () => {
      mockFetch({ ok: true, models: [{ id: "gpt-4o", name: "GPT-4o" }] });
      await autoLoadModels("openai", "sk-test", "https://proxy.example.com/v1", undefined);
      expect(fetchBody).toHaveProperty("baseUrl", "https://proxy.example.com/v1");
    });

    it("sends baseUrl as empty string when explicitly cleared", async () => {
      mockFetch({ ok: true, models: [{ id: "gpt-4o", name: "GPT-4o" }] });
      await autoLoadModels("openai", "sk-test", "", undefined);
      expect(fetchBody).toHaveProperty("baseUrl", "");
    });

    it("omits baseUrl when undefined (backend uses saved config)", async () => {
      mockFetch({ ok: true, models: [{ id: "gpt-4o", name: "GPT-4o" }] });
      await autoLoadModels("openai", undefined, undefined, undefined);
      expect(fetchBody).not.toHaveProperty("baseUrl");
    });

    it("shows error option on fetch failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error")) as unknown as typeof fetch;
      await autoLoadModels("openai", "sk-test", undefined, undefined);
      const select = document.getElementById("model") as HTMLSelectElement;
      expect(select.innerHTML).toContain("Failed to load models");
      expect((document.getElementById("modelSpinner") as HTMLElement).style.display).toBe("none");
    });

    it("shows 'Enter API key' option when backend returns error", async () => {
      mockFetch({ ok: false });
      await autoLoadModels("openai", undefined, undefined, undefined);
      const select = document.getElementById("model") as HTMLSelectElement;
      expect(select.innerHTML).toContain("Enter API key to load models");
    });

    it("dispatches change event on model select after populating", async () => {
      mockFetch({ ok: true, models: [{ id: "gpt-4o", name: "GPT-4o" }] });
      const select = document.getElementById("model") as HTMLSelectElement;
      const changeSpy = vi.fn();
      select.addEventListener("change", changeSpy);
      await autoLoadModels("openai", "sk-test", undefined, undefined);
      expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    it("ignores stale response when a newer request is made", async () => {
      let resolveFirst!: (v: unknown) => void;
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise((r) => { resolveFirst = r; });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: [{ id: "gpt-4o", name: "GPT-4o" }] }),
        });
      }) as unknown as typeof fetch;

      // Fire first request (will be stale)
      const first = autoLoadModels("claude", "sk-test", undefined, undefined);
      // Fire second request immediately (supersedes first)
      const second = autoLoadModels("openai", "sk-test", undefined, undefined);
      await second;

      // Now resolve the stale first response — it should be ignored
      resolveFirst({
        ok: true,
        json: () => Promise.resolve({ models: [{ id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" }] }),
      });
      await first;

      // Select should show the second (newer) result, not the stale first
      const select = document.getElementById("model") as HTMLSelectElement;
      expect(select.options[0].value).toBe("gpt-4o");
    });
  });

  // -- MCP Servers details/summary --

  describe("MCP Servers details", () => {
    it("details element is collapsed by default", () => {
      const details = document.getElementById("mcpDetails") as HTMLDetailsElement;
      expect(details.open).toBe(false);
    });

    it("count badge updates correctly", () => {
      const countEl = document.getElementById("mcpCount")!;
      countEl.textContent = "(7)";
      expect(countEl.textContent).toBe("(7)");
    });

    it("servers render inside details when expanded", () => {
      const details = document.getElementById("mcpDetails") as HTMLDetailsElement;
      details.open = true;
      renderServers([
        { name: "memory", command: "npx", args: "-y server-memory", env: {} },
        { name: "cron", command: "npx", args: "-y mcp-cron", env: {} },
      ]);
      const serverEls = document.querySelectorAll(".mcp-server");
      expect(serverEls).toHaveLength(2);
    });
  });
});
