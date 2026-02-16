// Default cron args shared between setup.js and setup-chat.js.
var DEFAULT_CRON_ARGS = '-y mcp-cron --transport stdio --prevent-sleep --mcp-config-path ./data/mcp.json --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929';

// Escape HTML special characters for safe insertion into HTML templates.
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// buildCronConfig — derive mcp-cron args and env from the user's AI settings.
//
// Core rule: if baseUrl is set (LiteLLM proxy), cron always uses
// --ai-provider openai + MCP_CRON_AI_API_KEY, because mcp-cron's Anthropic
// provider does not support --ai-base-url.

function buildCronConfig({ provider, apiKey, model, baseUrl, currentArgs }) {
  const useProxy = Boolean(baseUrl);
  const aiProvider = useProxy ? 'openai' : (provider === 'claude' ? 'anthropic' : 'openai');

  // Update --ai-provider
  let args = currentArgs.replace(/--ai-provider \S+/, `--ai-provider ${aiProvider}`);

  // Update --ai-model
  if (model) {
    if (/--ai-model \S+/.test(args)) {
      args = args.replace(/--ai-model \S+/, `--ai-model ${model}`);
    } else {
      args += ` --ai-model ${model}`;
    }
  }

  // Update --ai-base-url
  if (baseUrl) {
    if (/--ai-base-url \S+/.test(args)) {
      args = args.replace(/--ai-base-url \S+/, `--ai-base-url ${baseUrl}`);
    } else {
      args += ` --ai-base-url ${baseUrl}`;
    }
  } else {
    args = args.replace(/\s*--ai-base-url \S+/, '');
  }

  // Determine env key
  let envKey;
  if (useProxy) {
    envKey = 'MCP_CRON_AI_API_KEY';
  } else if (provider === 'claude') {
    envKey = 'ANTHROPIC_API_KEY';
  } else {
    envKey = 'OPENAI_API_KEY';
  }

  return { args, envKey, envValue: apiKey };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildCronConfig, escapeHtml, DEFAULT_CRON_ARGS };
}
