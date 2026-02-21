// task-chat.js — Inline chat logic for task mode (create/modify tasks via AI).
// Loaded as a plain <script> in the browser; importable via require() in tests.

function cronToHuman(expr) {
  if (typeof cronstrue === 'undefined' || !expr) return null;
  try {
    return cronstrue.toString(expr);
  } catch (e) {
    return null;
  }
}

var taskRunState = {};
// Shape: { [taskId]: { pollTimer, timeoutTimer, runStartTime, pendingResult } }
// pendingResult: null while running, string (chat text) when result arrived but user wasn't viewing this task

function cancelTaskRun(taskId) {
  var state = taskRunState[taskId];
  if (!state) return;
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
  delete taskRunState[taskId];
}

function isTaskRunning(taskId) {
  var state = taskRunState[taskId];
  return !!state && !state.pendingResult;
}

function consumePendingResult(taskId) {
  var state = taskRunState[taskId];
  if (!state || !state.pendingResult) return null;
  var result = state.pendingResult;
  delete taskRunState[taskId]; // clean up fully — run is done
  return result;
}

var taskChatState = {
  ws: null,
  conversationId: null,
  taskContext: null, // null = creation mode, string = existing task context
  streamingText: '',
  streamingEl: null,
  active: false, // true while a task chat panel is open; drives reconnect
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
  return chatCreateWs({
    onMessage: function (event) {
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
    },
    onOpen: function (ws) {
      taskChatState.ws = ws;
      setTaskInputEnabled(true);
    },
    onError: function () {
      taskChatAddMessage('assistant', 'Connection error. Please try again.');
    },
    onClose: function (closedWs) {
      if (taskChatState.ws === closedWs) {
        taskChatState.ws = null;
      }
    },
    shouldReconnect: function () {
      return taskChatState.active;
    },
  });
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

  // Mark active so reconnect logic kicks in
  taskChatState.active = true;

  // Connect — input is enabled by the WS 'open' event handler
  setTaskInputEnabled(false);
  connectTaskChat();
}

/**
 * Run a task directly via API and poll for the result.
 * @param {string} taskId - Task ID to run
 * @param {HTMLButtonElement} runBtn - The run button element
 * @param {function} renderTaskResult - Callback to refresh the results panel
 * @param {function} formatDuration - Formats start/end into a human-readable duration
 * @param {function} getCurrentTaskId - Returns the currently viewed task ID
 */
function runTask(taskId, runBtn, renderTaskResult, formatDuration, getCurrentTaskId) {
  if (isTaskRunning(taskId)) return;

  runBtn.disabled = true;
  runBtn.innerHTML = '&#9696;';
  runBtn.classList.add('task-running');
  var runStartTime = Date.now();

  var entry = { pollTimer: null, timeoutTimer: null, runStartTime: runStartTime, pendingResult: null };
  taskRunState[taskId] = entry;

  function resetButton() {
    runBtn.disabled = false;
    runBtn.innerHTML = '&#9654;';
    runBtn.classList.remove('task-running');
  }

  fetch('/api/tasks/' + taskId + '/run', { method: 'POST' })
    .then(function () {
      entry.pollTimer = setInterval(function () {
        fetch('/api/tasks/' + taskId + '/results?limit=1')
          .then(function (res) { return res.json(); })
          .then(function (data) {
            var result = Array.isArray(data) ? data[0] : data;
            if (result && result.end_time && new Date(result.end_time).getTime() >= runStartTime) {
              clearInterval(entry.pollTimer);
              clearTimeout(entry.timeoutTimer);

              var isError = (result.exit_code !== 0 && result.exit_code !== undefined) || result.error != null;
              var output = result.output || result.error || result.result || '(no output)';
              var duration = formatDuration(result.start_time, result.end_time);
              var status = isError ? 'Failed' : 'OK';
              var chatText = '**Task executed \u2014 ' + status + '**' + (duration ? ' (' + duration + ')' : '') + '\n\n' + (typeof output === 'string' ? output : JSON.stringify(output, null, 2));

              if (getCurrentTaskId && getCurrentTaskId() === taskId) {
                taskChatAddMessage('assistant', chatText);
                fetch('/api/tasks/' + taskId + '/results?limit=5')
                  .then(function (res) { return res.json(); })
                  .then(function (fullData) { renderTaskResult(fullData); })
                  .catch(function () {});
                resetButton();
                cancelTaskRun(taskId);
              } else {
                // User is viewing a different task or conversations — queue result
                entry.pendingResult = chatText;
                // Clean up timers but keep entry for consumePendingResult
                entry.pollTimer = null;
                entry.timeoutTimer = null;
              }
            }
          })
          .catch(function () {});
      }, 3000);
      entry.timeoutTimer = setTimeout(function () {
        clearInterval(entry.pollTimer);
        if (getCurrentTaskId && getCurrentTaskId() === taskId) {
          taskChatAddMessage('assistant', 'Task is taking longer than expected. Check results later.');
        }
        resetButton();
        delete taskRunState[taskId];
      }, 60000);
    })
    .catch(function () {
      resetButton();
      delete taskRunState[taskId];
    });
}

function disconnectTaskChat() {
  taskChatState.active = false;
  if (taskChatState.ws) {
    taskChatState.ws.close();
    taskChatState.ws = null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cronToHuman: cronToHuman,
    taskChatState: taskChatState,
    taskRunState: taskRunState,
    cancelTaskRun: cancelTaskRun,
    isTaskRunning: isTaskRunning,
    consumePendingResult: consumePendingResult,
    taskChatAddMessage: taskChatAddMessage,
    addTaskTypingIndicator: addTaskTypingIndicator,
    removeTaskTypingIndicator: removeTaskTypingIndicator,
    sendTaskChatMessage: sendTaskChatMessage,
    runTask: runTask,
    initTaskChat: initTaskChat,
    disconnectTaskChat: disconnectTaskChat,
  };
}
