// setup-chat.js — Chat panel logic for the setup page.
// Provides a Q&A state machine for initial setup and AI chat for MCP server configuration.
// Loaded as a plain <script> in the browser; importable via require() in tests.

// States: provider → api_key → base_url → loading_models → model → saving → ai_chat
var setupChatState = {
  current: 'provider',
  provider: null,
  apiKey: null,
  baseUrl: null,
  model: null,
  conversationId: null,
  ws: null,
  streamingText: '',
  streamingEl: null,
};

function addMessage(role, text) {
  return chatAddMessage('chatMessages', role, text);
}

function showChoices(options, onSelect) {
  var container = document.getElementById('chatChoices');
  container.innerHTML = '';
  var choicesDiv = document.createElement('div');
  choicesDiv.className = 'chat-choices';
  options.forEach(function (opt) {
    var btn = document.createElement('button');
    btn.className = 'chat-choice-btn';
    btn.textContent = opt.label || opt;
    btn.addEventListener('click', function () {
      container.innerHTML = '';
      onSelect(opt.value !== undefined ? opt.value : opt);
    });
    choicesDiv.appendChild(btn);
  });
  container.appendChild(choicesDiv);
}

function setInputMode(mode) {
  var textarea = document.getElementById('chatInput');
  var sendBtn = document.getElementById('chatSendBtn');
  var placeholders = {
    disabled: '', password: 'Enter your API key...',
    text: 'Send a message...', optional: 'Press Enter to skip, or enter a URL...',
  };
  textarea.disabled = mode === 'disabled';
  sendBtn.disabled = mode === 'disabled';
  textarea.placeholder = placeholders[mode] || '';
  if (mode !== 'disabled') textarea.focus();
}

// Build default MCP servers object using defaultServers from setup.js and buildCronConfig from cron-sync.js
function buildDefaultMcpServers(provider, apiKey, model, baseUrl) {
  var servers = {};
  defaultServers.forEach(function (s) {
    if (s.name === 'cron') {
      var cronResult = buildCronConfig({
        provider: provider,
        apiKey: apiKey,
        model: model,
        baseUrl: baseUrl,
        currentArgs: s.args,
      });
      servers[s.name] = {
        command: s.command,
        args: cronResult.args.split(/\s+/).filter(Boolean),
        env: {},
      };
      servers[s.name].env[cronResult.envKey] = cronResult.envValue;
    } else {
      servers[s.name] = {
        command: s.command,
        args: s.args.split(/\s+/).filter(Boolean),
      };
    }
  });
  return servers;
}

async function loadModelsForChat(provider, apiKey, baseUrl) {
  var res = await fetch('/api/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: provider, apiKey: apiKey, baseUrl: baseUrl || undefined }),
  });
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load models');
  return data.models;
}

async function saveSetupConfig(provider, apiKey, model, baseUrl, mcpServers) {
  var providerConfig = {};
  if (apiKey) providerConfig.apiKey = apiKey;
  if (model) providerConfig.model = model;
  providerConfig.baseUrl = baseUrl || '';

  var config = {
    provider: provider,
    claude: provider === 'claude' ? providerConfig : {},
    openai: provider === 'openai' ? providerConfig : {},
    server: { port: parseInt(document.getElementById('port').value) || 3000 },
    mcpServers: mcpServers,
  };

  var res = await fetch('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error('Failed to save config');
}

function addSetupTypingIndicator() {
  chatAddTypingIndicator('chatMessages', 'setupTyping');
}

function removeSetupTypingIndicator() {
  chatRemoveTypingIndicator('setupTyping');
}

function connectAiChat() {
  return chatCreateWs({
    onMessage: function (event) {
      var msg = JSON.parse(event.data);
      if (msg.type === 'chunk') {
        removeSetupTypingIndicator();
        setupChatState.streamingText += msg.text;
        if (!setupChatState.streamingEl) {
          setupChatState.streamingEl = addMessage('assistant', '');
        }
        if (typeof marked !== 'undefined' && marked.parse && typeof DOMPurify !== 'undefined') {
          setupChatState.streamingEl.innerHTML = DOMPurify.sanitize(marked.parse(setupChatState.streamingText));
        } else {
          setupChatState.streamingEl.textContent = setupChatState.streamingText;
        }
        var container = document.getElementById('chatMessages');
        container.scrollTop = container.scrollHeight;
      } else if (msg.type === 'done') {
        removeSetupTypingIndicator();
        setupChatState.conversationId = msg.conversationId;
        setupChatState.streamingText = '';
        setupChatState.streamingEl = null;
        setInputMode('text');
        // Refresh form after AI response to pick up any config changes
        if (typeof window.refreshForm === 'function') {
          window.refreshForm();
        }
      } else if (msg.type === 'error') {
        removeSetupTypingIndicator();
        addMessage('assistant', 'Error: ' + msg.text);
        setInputMode('text');
      }
    },
    onOpen: function (ws) {
      setupChatState.ws = ws;
    },
    onError: function () {
      addMessage('assistant', 'Connection error. Please check your network and refresh the page.');
    },
    onClose: function (closedWs) {
      if (setupChatState.ws === closedWs) {
        setupChatState.ws = null;
      }
    },
    shouldReconnect: function () {
      return setupChatState.current === 'ai_chat';
    },
  });
}

function sendAiMessage(text) {
  if (!setupChatState.ws || setupChatState.ws.readyState !== WebSocket.OPEN) {
    addMessage('assistant', 'Connection lost. Please refresh the page.');
    return;
  }
  addMessage('user', text);
  setInputMode('disabled');
  addSetupTypingIndicator();
  setupChatState.ws.send(JSON.stringify({
    type: 'message',
    text: text,
    conversationId: setupChatState.conversationId,
    setupMode: true,
  }));
}

// Handle input from chat textarea
function handleInput(text) {
  var state = setupChatState.current;

  if (state === 'ai_chat') {
    sendAiMessage(text);
    return;
  }

  if (state === 'api_key') {
    setupChatState.apiKey = text;
    // Show masked key in chat
    addMessage('user', '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022');
    // Update form and sync cron config
    document.getElementById('apiKey').value = text;
    syncCronFromChat();
    // Advance to base URL
    setupChatState.current = 'base_url';
    addMessage('assistant', 'Do you need a custom base URL? (For LiteLLM proxy)\n\nPress Enter to skip for direct API access.');
    setInputMode('optional');
    return;
  }

  if (state === 'base_url') {
    setupChatState.baseUrl = text || '';
    if (text) {
      addMessage('user', text);
    } else {
      addMessage('user', '(skipped)');
    }
    // Update form and sync cron config
    document.getElementById('baseUrl').value = text || '';
    syncCronFromChat();
    // Load models
    setupChatState.current = 'loading_models';
    addMessage('assistant', 'Loading available models...');
    setInputMode('disabled');
    loadModelsForChat(setupChatState.provider, setupChatState.apiKey, setupChatState.baseUrl)
      .then(function (models) {
        // Update the form model dropdown
        var select = document.getElementById('model');
        select.innerHTML = models.map(function (m) {
          return '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name) + '</option>';
        }).join('');
        // Show model choices in chat
        setupChatState.current = 'model';
        addMessage('assistant', 'Select a model:');
        showChoices(models.map(function (m) {
          return { label: m.name, value: m.id };
        }), function (modelId) {
          handleModelSelect(modelId);
        });
      })
      .catch(function (err) {
        addMessage('assistant', 'Failed to load models: ' + err.message + '\n\nPlease check your API key and try again.');
        setupChatState.current = 'api_key';
        addMessage('assistant', 'Please enter your API key:');
        setInputMode('password');
      });
    return;
  }
}

function handleModelSelect(modelId) {
  setupChatState.model = modelId;
  addMessage('user', modelId);
  // Update form and sync cron config
  var select = document.getElementById('model');
  select.value = modelId;
  syncCronFromChat();

  // Save config
  setupChatState.current = 'saving';
  addMessage('assistant', 'Saving configuration...');
  setInputMode('disabled');

  var mcpServers = buildDefaultMcpServers(
    setupChatState.provider,
    setupChatState.apiKey,
    setupChatState.model,
    setupChatState.baseUrl
  );

  saveSetupConfig(
    setupChatState.provider,
    setupChatState.apiKey,
    setupChatState.model,
    setupChatState.baseUrl,
    mcpServers
  ).then(function () {
    // Refresh the form from backend
    if (typeof window.refreshForm === 'function') {
      return window.refreshForm();
    }
  }).then(function () {
    setupChatState.current = 'ai_chat';
    addMessage('assistant', 'Configuration saved! Default MCP servers configured.\n\nYou can now ask me to help customize your MCP servers, or close this panel and edit the form directly.');
    setInputMode('text');
    connectAiChat();
  }).catch(function (err) {
    addMessage('assistant', 'Failed to save: ' + err.message + '\n\nPlease select a model to try again:');
    setupChatState.current = 'model';
    // Re-show model choices from the existing <select> options
    var select = document.getElementById('model');
    var options = Array.from(select.options).filter(function (o) { return o.value; });
    showChoices(options.map(function (o) {
      return { label: o.textContent, value: o.value };
    }), function (modelId) {
      handleModelSelect(modelId);
    });
  });
}

// Initialize the setup chat panel
function initSetupChat(options) {
  var isEditing = options && options.isEditing;
  var config = options && options.config;

  // Wire up send button and Enter key
  var sendBtn = document.getElementById('chatSendBtn');
  var input = document.getElementById('chatInput');

  function doSend() {
    var text = input.value.trim();
    // Allow empty text for base_url state (skip behavior)
    if (setupChatState.current !== 'base_url' && !text) return;
    input.value = '';
    handleInput(text);
  }

  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  if (isEditing && config) {
    // Edit mode: show summary and offer choices
    var provider = config.provider || 'unknown';
    var model = config[provider] && config[provider].model ? config[provider].model : 'unknown';
    addMessage('assistant', 'Current configuration:\n- **Provider:** ' + provider + '\n- **Model:** ' + model + '\n\nWhat would you like to do?');
    setupChatState.current = 'edit_choice';
    showChoices([
      { label: 'Reconfigure Basics', value: 'reconfigure' },
      { label: 'Customize MCP Servers', value: 'customize' },
    ], function (choice) {
      if (choice === 'reconfigure') {
        startQA();
      } else {
        setupChatState.current = 'ai_chat';
        addMessage('assistant', 'You can ask me to add, remove, or modify MCP servers, or change provider. For example:\n- "Add a web search MCP server"\n- "Remove the time server"\n- "Show me my current MCP config"\n- "Change provider"');
        setInputMode('text');
        connectAiChat();
      }
    });
  } else {
    // Fresh setup: start Q&A
    startQA();
  }
}

// Sync the form's MCP cron server config to match current form field values.
// Directly calls the global functions from setup.js / cron-sync.js.
// In the browser, var-declared functions in <script> tags are on window.
function syncCronFromChat() {
  if (typeof readServers !== 'function' || typeof syncCronConfig !== 'function' ||
      typeof renderServers !== 'function' || typeof buildCronConfig !== 'function') {
    return;
  }
  var srvs = readServers();
  var editing = !!(typeof window !== 'undefined' && window._savedConfig);
  var savedCfg = (typeof window !== 'undefined' && window._savedConfig) || undefined;
  srvs = syncCronConfig(srvs, editing, buildCronConfig, savedCfg);
  renderServers(srvs);
}

function startQA() {
  setupChatState.current = 'provider';
  addMessage('assistant', 'Welcome to goto-assistant! I\'ll help you get set up.\n\nWhich AI provider would you like to use?');
  showChoices([
    { label: 'Claude', value: 'claude' },
    { label: 'OpenAI', value: 'openai' },
  ], function (provider) {
    setupChatState.provider = provider;
    addMessage('user', provider === 'claude' ? 'Claude' : 'OpenAI');
    // Update form radio, pre-fill fields from savedConfig, and sync cron config
    var radio = document.querySelector('input[name="provider"][value="' + provider + '"]');
    if (radio) {
      radio.checked = true;
    }
    if (typeof handleProviderSwitch === 'function') {
      handleProviderSwitch(!!window._savedConfig, window._savedConfig);
    }
    syncCronFromChat();
    // Advance to API key
    setupChatState.current = 'api_key';
    addMessage('assistant', 'Please enter your API key:');
    setInputMode('password');
  });
  setInputMode('disabled');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    setupChatState: setupChatState,
    addMessage: addMessage,
    showChoices: showChoices,
    setInputMode: setInputMode,
    addSetupTypingIndicator: addSetupTypingIndicator,
    removeSetupTypingIndicator: removeSetupTypingIndicator,
    buildDefaultMcpServers: buildDefaultMcpServers,
    handleInput: handleInput,
    handleModelSelect: handleModelSelect,
    initSetupChat: initSetupChat,
    syncCronFromChat: syncCronFromChat,
  };
}
