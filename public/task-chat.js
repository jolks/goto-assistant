// task-chat.js — Inline chat logic for task mode (create/modify tasks via AI).
// Loaded as a plain <script> in the browser; importable via require() in tests.

var taskChatState = {
  ws: null,
  conversationId: null,
  taskContext: null, // null = creation mode, string = existing task context
  streamingText: '',
  streamingEl: null,
};

function taskChatAddMessage(role, text) {
  return chatAddMessage('taskChatMessages', role, text);
}

function addTaskTypingIndicator() {
  chatAddTypingIndicator('taskChatMessages', 'taskTyping');
}

function removeTaskTypingIndicator() {
  chatRemoveTypingIndicator('taskTyping');
}

function connectTaskChat() {
  var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = new WebSocket(protocol + '//' + window.location.host + '/ws');
  taskChatState.ws = ws;

  ws.addEventListener('message', function (event) {
    var msg = JSON.parse(event.data);
    if (msg.type === 'chunk') {
      removeTaskTypingIndicator();
      taskChatState.streamingText += msg.text;
      if (!taskChatState.streamingEl) {
        taskChatState.streamingEl = taskChatAddMessage('assistant', '');
      }
      if (taskChatState.streamingEl) {
        if (typeof marked !== 'undefined' && marked.parse && typeof DOMPurify !== 'undefined') {
          taskChatState.streamingEl.innerHTML = DOMPurify.sanitize(marked.parse(taskChatState.streamingText));
        } else {
          taskChatState.streamingEl.textContent = taskChatState.streamingText;
        }
        var container = document.getElementById('taskChatMessages');
        if (container) container.scrollTop = container.scrollHeight;
      }
    } else if (msg.type === 'done') {
      removeTaskTypingIndicator();
      taskChatState.conversationId = msg.conversationId;
      taskChatState.streamingText = '';
      taskChatState.streamingEl = null;
      setTaskInputEnabled(true);
      if (typeof window.onTaskChatDone === 'function') {
        window.onTaskChatDone();
      }
    } else if (msg.type === 'error') {
      removeTaskTypingIndicator();
      taskChatAddMessage('assistant', 'Error: ' + msg.text);
      setTaskInputEnabled(true);
    }
  });

  ws.addEventListener('open', function () {
    setTaskInputEnabled(true);
  });

  ws.addEventListener('close', function () {
    taskChatState.ws = null;
  });

  return ws;
}

function setTaskInputEnabled(enabled) {
  var input = document.getElementById('taskChatInput');
  var btn = document.getElementById('taskChatSendBtn');
  if (input) { input.disabled = !enabled; if (enabled) input.focus(); }
  if (btn) btn.disabled = !enabled;
}

function sendTaskChatMessage(text) {
  if (!text) return;
  if (!taskChatState.ws || taskChatState.ws.readyState !== WebSocket.OPEN) {
    taskChatAddMessage('assistant', 'Connection lost. Please try again.');
    return;
  }
  taskChatAddMessage('user', text);
  setTaskInputEnabled(false);
  addTaskTypingIndicator();
  var payload = {
    type: 'message',
    text: text,
    taskMode: true,
    conversationId: taskChatState.conversationId,
  };
  if (taskChatState.taskContext) {
    payload.taskContext = taskChatState.taskContext;
  }
  taskChatState.ws.send(JSON.stringify(payload));
}

function initTaskChat(taskContext) {
  taskChatState.taskContext = taskContext || null;
  taskChatState.conversationId = null;
  taskChatState.streamingText = '';
  taskChatState.streamingEl = null;

  // Clear messages
  var container = document.getElementById('taskChatMessages');
  if (container) container.innerHTML = '';

  // Show welcome
  if (taskContext) {
    taskChatAddMessage('assistant', 'Ask me to modify this task \u2014 change its schedule, prompt, name, or anything else.');
  } else {
    taskChatAddMessage('assistant', 'I\'ll help you create a new task. What kind of task would you like to set up?');
  }

  // Close existing connection
  disconnectTaskChat();

  // Connect — input is enabled by the WS 'open' event handler
  setTaskInputEnabled(false);
  connectTaskChat();
}

function disconnectTaskChat() {
  if (taskChatState.ws) {
    taskChatState.ws.close();
    taskChatState.ws = null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    taskChatState: taskChatState,
    taskChatAddMessage: taskChatAddMessage,
    addTaskTypingIndicator: addTaskTypingIndicator,
    removeTaskTypingIndicator: removeTaskTypingIndicator,
    sendTaskChatMessage: sendTaskChatMessage,
    initTaskChat: initTaskChat,
    disconnectTaskChat: disconnectTaskChat,
  };
}
