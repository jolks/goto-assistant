// setup.js — extracted functions from setup.html for testability.
// Loaded as a plain <script> in the browser; importable via require() in tests.

var defaultServers = [
  { name: 'cron', command: 'npx', args: '-y mcp-cron --transport stdio --prevent-sleep --mcp-config-path ./data/mcp.json --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929', env: {} },
  { name: 'memory', command: 'npx', args: '-y @modelcontextprotocol/server-memory', env: {} },
  { name: 'filesystem', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem .', env: {} },
  { name: 'time', command: 'uvx', args: 'mcp-server-time', env: {} },
];

function getProvider() {
  return document.querySelector('input[name="provider"]:checked').value;
}

function renderServers(servers) {
  var container = document.getElementById('mcpServers');
  container.innerHTML = '';
  servers.forEach(function (s, i) {
    var div = document.createElement('article');
    div.className = 'mcp-server';
    var envRows = Object.entries(s.env || {}).map(function (_ref, ei) {
      var k = _ref[0], v = _ref[1];
      return '<div class="env-row">' +
        '<input type="text" placeholder="Key" value="' + k + '" data-server="' + i + '" data-env-key="' + ei + '">' +
        '<input type="text" placeholder="Value" value="' + v + '" data-server="' + i + '" data-env-val="' + ei + '">' +
        '<button class="btn-icon" onclick="removeEnv(' + i + ',' + ei + ')">×</button>' +
        '</div>';
    }).join('');
    div.innerHTML =
      '<header class="mcp-server-header">' +
        '<input type="text" value="' + s.name + '" data-server="' + i + '" data-field="name" placeholder="Server name">' +
        '<button class="btn-icon" onclick="removeServer(' + i + ')">×</button>' +
      '</header>' +
      '<label>Command</label>' +
      '<input type="text" value="' + s.command + '" data-server="' + i + '" data-field="command">' +
      '<label>Args</label>' +
      '<input type="text" value="' + s.args + '" data-server="' + i + '" data-field="args">' +
      '<label>Environment Variables</label>' +
      envRows +
      '<button class="secondary outline" style="margin-top:4px;font-size:12px;padding:4px 10px" onclick="addEnv(' + i + ')">+ Add Env</button>';
    container.appendChild(div);
  });
}

function readServers() {
  var container = document.getElementById('mcpServers');
  var items = container.querySelectorAll('.mcp-server');
  return Array.from(items).map(function (item) {
    var name = item.querySelector('[data-field="name"]').value;
    var command = item.querySelector('[data-field="command"]').value;
    var args = item.querySelector('[data-field="args"]').value;
    var envRows = item.querySelectorAll('.env-row');
    var env = {};
    envRows.forEach(function (row) {
      var k = row.querySelector('[placeholder="Key"]').value.trim();
      var v = row.querySelector('[placeholder="Value"]').value.trim();
      if (k) env[k] = v;
    });
    return { name: name, command: command, args: args, env: env };
  });
}

// Sync cron server config. Takes servers array, isEditing flag, and buildCronConfigFn.
// Returns updated servers array (mutates in place for convenience, also returns).
function syncCronConfig(servers, isEditing, buildCronConfigFn, savedConfig) {
  var cron = servers.find(function (s) { return s.name === 'cron'; });
  if (!cron) return servers;

  var provider = getProvider();
  var apiKey = document.getElementById('apiKey').value.trim();
  var model = document.getElementById('model').value;
  var baseUrl = document.getElementById('baseUrl').value.trim();

  var result = buildCronConfigFn({
    provider: provider,
    apiKey: apiKey,
    model: model,
    baseUrl: baseUrl,
    currentArgs: cron.args,
  });

  cron.args = result.args;

  // Always rename the env key to match the provider.
  // In edit mode with no new key entered, preserve the existing value.
  var oldKeys = Object.keys(cron.env).filter(function (k) { return k.includes('API_KEY'); });
  if (apiKey || !isEditing) {
    oldKeys.forEach(function (k) { delete cron.env[k]; });
    cron.env[result.envKey] = result.envValue;
  } else if (oldKeys.length > 0 && oldKeys[0] !== result.envKey) {
    // Use the target provider's masked key from savedConfig when available
    var targetValue = cron.env[oldKeys[0]];
    if (savedConfig) {
      var pc = savedConfig[provider] || {};
      if (pc.apiKey) targetValue = pc.apiKey;
    }
    oldKeys.forEach(function (k) { delete cron.env[k]; });
    cron.env[result.envKey] = targetValue;
  }

  return servers;
}

// Handle provider switch: pre-fill baseUrl and model from saved config.
function handleProviderSwitch(isEditing, savedConfig) {
  if (!isEditing || !savedConfig) return;

  var p = getProvider();
  var pc = savedConfig[p] || {};
  document.getElementById('baseUrl').value = pc.baseUrl || '';
  var select = document.getElementById('model');
  if (pc.model) {
    select.innerHTML = '<option value="' + escapeHtml(pc.model) + '">' + escapeHtml(pc.model) + '</option>';
  } else {
    select.innerHTML = '<option value="">\u2014 Load models \u2014</option>';
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { defaultServers: defaultServers, getProvider: getProvider, renderServers: renderServers, readServers: readServers, syncCronConfig: syncCronConfig, handleProviderSwitch: handleProviderSwitch };
}
