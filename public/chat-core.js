// chat-core.js — Shared chat DOM primitives used by index.html, setup-chat.js, and task-chat.js.
// Loaded as a plain <script> in the browser; importable via require() in tests.

/**
 * Add a message to a chat container. Renders markdown via marked + DOMPurify when available.
 * @param {string} containerId - The DOM id of the messages container
 * @param {string} role - 'user' or 'assistant'
 * @param {string} text - Message text
 * @returns {HTMLElement|null} The created element, or null if container not found
 */
function chatAddMessage(containerId, role, text) {
  var container = document.getElementById(containerId);
  if (!container) return null;
  var div = document.createElement('div');
  div.className = 'message ' + role;
  if (typeof marked !== 'undefined' && marked.parse && typeof DOMPurify !== 'undefined') {
    div.innerHTML = DOMPurify.sanitize(marked.parse(text));
  } else {
    div.textContent = text;
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

/**
 * Add a typing indicator (3 bouncing dots) to a chat container.
 * @param {string} containerId - The DOM id of the messages container
 * @param {string} indicatorId - The DOM id for the typing indicator element
 */
function chatAddTypingIndicator(containerId, indicatorId) {
  var container = document.getElementById(containerId);
  if (!container) return;
  var el = document.createElement('div');
  el.className = 'typing-indicator';
  el.id = indicatorId;
  el.innerHTML = '<span></span><span></span><span></span>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

/**
 * Remove a typing indicator by its DOM id.
 * @param {string} indicatorId - The DOM id of the typing indicator to remove
 */
function chatRemoveTypingIndicator(indicatorId) {
  var el = document.getElementById(indicatorId);
  if (el) el.remove();
}

/**
 * Create a WebSocket connection with auto-reconnect support.
 * All chat surfaces should use this instead of creating WebSockets directly.
 * @param {Object} callbacks
 * @param {function} callbacks.onMessage - Called with each MessageEvent
 * @param {function} [callbacks.onOpen] - Called with the new ws when connection opens
 * @param {function} [callbacks.onError] - Called with the ws when a connection error occurs
 * @param {function} [callbacks.onClose] - Called with the specific ws that closed (stale-WS guard)
 * @param {function} [callbacks.shouldReconnect] - Return true to auto-reconnect after 2s
 * @returns {WebSocket}
 */
function chatCreateWs(callbacks) {
  var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = new WebSocket(protocol + '//' + window.location.host + '/ws');
  ws.addEventListener('message', callbacks.onMessage);
  ws.addEventListener('open', function () {
    if (callbacks.onOpen) callbacks.onOpen(ws);
  });
  ws.addEventListener('error', function () {
    if (callbacks.onError) callbacks.onError(ws);
  });
  ws.addEventListener('close', function () {
    if (callbacks.onClose) callbacks.onClose(ws);
    if (callbacks.shouldReconnect && callbacks.shouldReconnect()) {
      setTimeout(function () { chatCreateWs(callbacks); }, 2000);
    }
  });
  return ws;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { chatAddMessage, chatAddTypingIndicator, chatRemoveTypingIndicator, chatCreateWs };
}
