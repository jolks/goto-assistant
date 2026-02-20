// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Provide marked + DOMPurify + chat-core globals before task-chat.js is imported
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).marked = {
    parse: (text: string) => `<p>${text}</p>`,
  };
  (globalThis as Record<string, unknown>).DOMPurify = {
    sanitize: (html: string) => html,
  };
});

import { chatAddMessage, chatAddTypingIndicator, chatRemoveTypingIndicator, chatCreateWs } from "../public/chat-core.js";
(globalThis as Record<string, unknown>).chatAddMessage = chatAddMessage;
(globalThis as Record<string, unknown>).chatAddTypingIndicator = chatAddTypingIndicator;
(globalThis as Record<string, unknown>).chatRemoveTypingIndicator = chatRemoveTypingIndicator;
(globalThis as Record<string, unknown>).chatCreateWs = chatCreateWs;

import {
  taskChatState,
  taskRunState,
  cancelTaskRun,
  isTaskRunning,
  consumePendingResult,
  taskChatAddMessage,
  addTaskTypingIndicator,
  removeTaskTypingIndicator,
  sendTaskChatMessage,
  runTask,
  initTaskChat,
  disconnectTaskChat,
} from "../public/task-chat.js";

function setupDOM() {
  document.body.innerHTML = `
    <div id="taskChatMessages"></div>
    <input id="taskChatInput" />
    <button id="taskChatSendBtn">Send</button>
  `;
}

function resetState() {
  taskChatState.ws = null;
  taskChatState.conversationId = null;
  taskChatState.taskContext = null;
  taskChatState.streamingText = "";
  taskChatState.streamingEl = null;
  taskChatState.active = false;
  // Clear all run state entries
  for (const key of Object.keys(taskRunState)) {
    cancelTaskRun(key);
  }
}

describe("task-chat", () => {
  beforeEach(() => {
    setupDOM();
    resetState();
  });

  describe("taskChatAddMessage", () => {
    it("delegates to chatAddMessage with correct container", () => {
      const el = taskChatAddMessage("user", "Hello");
      expect(el).toBeInstanceOf(HTMLElement);
      expect(document.querySelectorAll("#taskChatMessages .message")).toHaveLength(1);
    });
  });

  describe("typing indicator", () => {
    it("delegates to chatAddTypingIndicator/chatRemoveTypingIndicator", () => {
      addTaskTypingIndicator();
      expect(document.getElementById("taskTyping")).not.toBeNull();
      removeTaskTypingIndicator();
      expect(document.getElementById("taskTyping")).toBeNull();
    });
  });

  describe("sendTaskChatMessage", () => {
    it("shows 'Connection lost' when ws is null", () => {
      taskChatState.ws = null;
      sendTaskChatMessage("hello");
      const msgs = document.querySelectorAll("#taskChatMessages .message");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].textContent).toContain("Connection lost");
    });

    it("does nothing for empty text", () => {
      sendTaskChatMessage("");
      const msgs = document.querySelectorAll("#taskChatMessages .message");
      expect(msgs).toHaveLength(0);
    });

    it("sends correct payload with taskMode and conversationId", () => {
      const mockSend = vi.fn();
      taskChatState.ws = { readyState: WebSocket.OPEN, send: mockSend } as unknown as WebSocket;
      taskChatState.conversationId = "conv-123";

      sendTaskChatMessage("create a backup task");

      expect(mockSend).toHaveBeenCalledOnce();
      const payload = JSON.parse(mockSend.mock.calls[0][0]);
      expect(payload.type).toBe("message");
      expect(payload.text).toBe("create a backup task");
      expect(payload.taskMode).toBe(true);
      expect(payload.conversationId).toBe("conv-123");
      expect(payload.taskContext).toBeUndefined();
    });

    it("includes taskContext when present in state", () => {
      const mockSend = vi.fn();
      taskChatState.ws = { readyState: WebSocket.OPEN, send: mockSend } as unknown as WebSocket;
      taskChatState.taskContext = '{"id":"t1","name":"backup"}';

      sendTaskChatMessage("change schedule");

      const payload = JSON.parse(mockSend.mock.calls[0][0]);
      expect(payload.taskContext).toBe('{"id":"t1","name":"backup"}');
    });

    it("adds user message and typing indicator on send", () => {
      taskChatState.ws = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket;
      sendTaskChatMessage("hello");

      const userMsgs = document.querySelectorAll("#taskChatMessages .message.user");
      expect(userMsgs).toHaveLength(1);
      expect(document.getElementById("taskTyping")).not.toBeNull();
    });

    it("disables input and button on send", () => {
      taskChatState.ws = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket;
      sendTaskChatMessage("hello");

      const input = document.getElementById("taskChatInput") as HTMLInputElement;
      const btn = document.getElementById("taskChatSendBtn") as HTMLButtonElement;
      expect(input.disabled).toBe(true);
      expect(btn.disabled).toBe(true);
    });
  });

  describe("taskRunState helpers", () => {
    it("cancelTaskRun clears specific task's timers and removes from map", () => {
      const pollTimer = setInterval(() => {}, 1000);
      const timeoutTimer = setTimeout(() => {}, 60000);
      taskRunState["t1"] = { pollTimer, timeoutTimer, runStartTime: Date.now(), pendingResult: null };
      taskRunState["t2"] = { pollTimer: null, timeoutTimer: null, runStartTime: Date.now(), pendingResult: null };

      cancelTaskRun("t1");

      expect(taskRunState["t1"]).toBeUndefined();
      expect(taskRunState["t2"]).toBeDefined();
      cancelTaskRun("t2");
    });

    it("cancelTaskRun is safe for non-existent taskId", () => {
      expect(() => cancelTaskRun("nonexistent")).not.toThrow();
    });

    it("isTaskRunning returns true when running, false when not", () => {
      expect(isTaskRunning("t1")).toBe(false);
      taskRunState["t1"] = { pollTimer: null, timeoutTimer: null, runStartTime: Date.now(), pendingResult: null };
      expect(isTaskRunning("t1")).toBe(true);
      delete taskRunState["t1"];
    });

    it("isTaskRunning returns false when pendingResult is set (run completed)", () => {
      taskRunState["t1"] = { pollTimer: null, timeoutTimer: null, runStartTime: Date.now(), pendingResult: "**Task executed**" };
      expect(isTaskRunning("t1")).toBe(false);
      delete taskRunState["t1"];
    });

    it("consumePendingResult returns pending result text and clears entry", () => {
      taskRunState["t1"] = { pollTimer: null, timeoutTimer: null, runStartTime: Date.now(), pendingResult: "**Task executed**" };
      const result = consumePendingResult("t1");
      expect(result).toBe("**Task executed**");
      expect(taskRunState["t1"]).toBeUndefined();
    });

    it("consumePendingResult returns null when no pending result", () => {
      expect(consumePendingResult("t1")).toBeNull();
      taskRunState["t1"] = { pollTimer: null, timeoutTimer: null, runStartTime: Date.now(), pendingResult: null };
      expect(consumePendingResult("t1")).toBeNull();
      delete taskRunState["t1"];
    });
  });

  describe("runTask", () => {
    let runBtn: HTMLButtonElement;
    let mockRenderTaskResult: ReturnType<typeof vi.fn>;
    let mockFormatDuration: ReturnType<typeof vi.fn>;
    let mockGetCurrentTaskId: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      runBtn = document.createElement("button");
      runBtn.innerHTML = "&#9654;";
      document.body.appendChild(runBtn);
      mockRenderTaskResult = vi.fn();
      mockFormatDuration = vi.fn().mockReturnValue("2s");
      mockGetCurrentTaskId = vi.fn().mockReturnValue("t1");
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("creates taskRunState entry on start", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));
      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);
      expect(taskRunState["t1"]).toBeDefined();
      expect(taskRunState["t1"].runStartTime).toBeGreaterThan(0);
    });

    it("disables button and adds task-running class on start", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));
      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);
      expect(runBtn.disabled).toBe(true);
      expect(runBtn.classList.contains("task-running")).toBe(true);
    });

    it("is idempotent: returns early when task already running", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
      vi.stubGlobal("fetch", fetchMock);

      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);
      const callCount = fetchMock.mock.calls.length;

      // Try to run again — should be a no-op
      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock.mock.calls.length).toBe(callCount);
    });

    it("restores button when run fetch fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);
      expect(runBtn.disabled).toBe(false);
      expect(runBtn.classList.contains("task-running")).toBe(false);
      expect(taskRunState["t1"]).toBeUndefined();
    });

    it("skips stale results where end_time is before runStartTime", async () => {
      const staleTime = new Date(Date.now() - 60000).toISOString();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) })
        .mockResolvedValue({ ok: true, json: () => Promise.resolve([{ end_time: staleTime, output: "old" }]) });
      vi.stubGlobal("fetch", fetchMock);

      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);

      expect(runBtn.disabled).toBe(true);
      expect(runBtn.classList.contains("task-running")).toBe(true);
      expect(mockRenderTaskResult).not.toHaveBeenCalled();
    });

    it("detects fresh result and restores button, renders result, adds chat message", async () => {
      const freshTime = new Date(Date.now() + 5000).toISOString();
      const freshResult = { end_time: freshTime, start_time: new Date(Date.now() + 3000).toISOString(), output: "hello world", exit_code: 0 };
      const fullResults = [freshResult, { end_time: freshTime, output: "old" }];
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([freshResult]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(fullResults) });
      vi.stubGlobal("fetch", fetchMock);

      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(0);

      expect(runBtn.disabled).toBe(false);
      expect(runBtn.classList.contains("task-running")).toBe(false);
      expect(mockRenderTaskResult).toHaveBeenCalledWith(fullResults);
      expect(taskRunState["t1"]).toBeUndefined();

      const msgs = document.querySelectorAll("#taskChatMessages .message.assistant");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].textContent).toContain("Task executed");
      expect(msgs[0].textContent).toContain("OK");
      expect(msgs[0].textContent).toContain("hello world");
    });

    it("stores pendingResult when getCurrentTaskId !== taskId and does NOT reset button", async () => {
      mockGetCurrentTaskId.mockReturnValue("other-task");
      const freshTime = new Date(Date.now() + 5000).toISOString();
      const freshResult = { end_time: freshTime, start_time: freshTime, output: "bg result", exit_code: 0 };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([freshResult]) });
      vi.stubGlobal("fetch", fetchMock);

      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(0);

      // Chat should NOT have a message — user is viewing a different task
      const msgs = document.querySelectorAll("#taskChatMessages .message.assistant");
      expect(msgs).toHaveLength(0);

      // Button stays spinning — runTask does NOT reset it in the pending path;
      // the caller (renderTaskDetail) is responsible for button state on task switch
      expect(runBtn.disabled).toBe(true);
      expect(runBtn.classList.contains("task-running")).toBe(true);

      // Pending result should be stored
      expect(taskRunState["t1"]).toBeDefined();
      expect(taskRunState["t1"].pendingResult).toContain("bg result");

      // consumePendingResult retrieves it
      const pending = consumePendingResult("t1");
      expect(pending).toContain("bg result");
      expect(taskRunState["t1"]).toBeUndefined();
    });

    it("shared button resets to idle when switching to a non-running task (renderTaskDetail pattern)", async () => {
      // Simulate: run t1 → result goes to pending → user switches to t2
      mockGetCurrentTaskId.mockReturnValue("other-task");
      const freshTime = new Date(Date.now() + 5000).toISOString();
      const freshResult = { end_time: freshTime, start_time: freshTime, output: "done", exit_code: 0 };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([freshResult]) });
      vi.stubGlobal("fetch", fetchMock);

      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(0);

      // Button is still spinning from t1's run
      expect(runBtn.disabled).toBe(true);
      expect(runBtn.classList.contains("task-running")).toBe(true);

      // Simulate renderTaskDetail for t2 — same pattern used in index.html
      // This is the check that would have caught the missing else-branch bug
      if (isTaskRunning("t2")) {
        runBtn.disabled = true;
        runBtn.innerHTML = "&#9696;";
        runBtn.classList.add("task-running");
      } else {
        runBtn.disabled = false;
        runBtn.innerHTML = "&#9654;";
        runBtn.classList.remove("task-running");
      }

      // Button must be idle — t2 is not running
      expect(runBtn.disabled).toBe(false);
      expect(runBtn.classList.contains("task-running")).toBe(false);

      // And t1's pending result is still available
      const pending = consumePendingResult("t1");
      expect(pending).toContain("done");
    });

    it("shared button shows spinning when switching to a task that IS running", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
      vi.stubGlobal("fetch", fetchMock);

      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);

      // Simulate renderTaskDetail for t1 — task is actively running
      if (isTaskRunning("t1")) {
        runBtn.disabled = true;
        runBtn.innerHTML = "&#9696;";
        runBtn.classList.add("task-running");
      } else {
        runBtn.disabled = false;
        runBtn.innerHTML = "&#9654;";
        runBtn.classList.remove("task-running");
      }

      expect(runBtn.disabled).toBe(true);
      expect(runBtn.classList.contains("task-running")).toBe(true);
    });

    it("shows Failed status for non-zero exit code", async () => {
      const freshTime = new Date(Date.now() + 5000).toISOString();
      const errResult = { end_time: freshTime, start_time: freshTime, output: "error msg", exit_code: 1 };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([errResult]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([errResult]) });
      vi.stubGlobal("fetch", fetchMock);

      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(0);

      const msgs = document.querySelectorAll("#taskChatMessages .message.assistant");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].textContent).toContain("Failed");
    });

    it("compares timestamps numerically, not as strings (timezone-safe)", async () => {
      const now = Date.now();
      const pastDate = new Date(now - 300000);
      const offset = "+09:00";
      const pad = (n: number) => String(n).padStart(2, "0");
      const fakeLocal = new Date(pastDate.getTime() + 9 * 3600000);
      const staleOffsetTime = `${fakeLocal.getUTCFullYear()}-${pad(fakeLocal.getUTCMonth() + 1)}-${pad(fakeLocal.getUTCDate())}T${pad(fakeLocal.getUTCHours())}:${pad(fakeLocal.getUTCMinutes())}:${pad(fakeLocal.getUTCSeconds())}${offset}`;

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) })
        .mockResolvedValue({ ok: true, json: () => Promise.resolve([{ end_time: staleOffsetTime, output: "stale" }]) });
      vi.stubGlobal("fetch", fetchMock);

      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);

      expect(runBtn.disabled).toBe(true);
      expect(mockRenderTaskResult).not.toHaveBeenCalled();
    });

    it("supports multiple concurrent runs for different tasks", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
      vi.stubGlobal("fetch", fetchMock);

      const runBtn2 = document.createElement("button");
      document.body.appendChild(runBtn2);

      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      runTask("t2", runBtn2, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);

      expect(taskRunState["t1"]).toBeDefined();
      expect(taskRunState["t2"]).toBeDefined();
    });

    it("60s timeout removes entry and restores button state", async () => {
      const staleTime = new Date(Date.now() - 60000).toISOString();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) })
        .mockResolvedValue({ ok: true, json: () => Promise.resolve([{ end_time: staleTime, output: "old" }]) });
      vi.stubGlobal("fetch", fetchMock);

      runTask("t1", runBtn, mockRenderTaskResult, mockFormatDuration, mockGetCurrentTaskId);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60000);

      expect(runBtn.disabled).toBe(false);
      expect(runBtn.classList.contains("task-running")).toBe(false);
      expect(taskRunState["t1"]).toBeUndefined();
    });
  });

  describe("initTaskChat", () => {
    beforeEach(() => {
      // Mock chatCreateWs so it returns a fake ws and captures callbacks
      const mockWs = {
        close: vi.fn(),
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      };
      vi.stubGlobal("chatCreateWs", vi.fn(() => mockWs));
    });

    it("shows creation welcome when context is null", () => {
      initTaskChat(null);
      const msgs = document.querySelectorAll("#taskChatMessages .message.assistant");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].textContent).toContain("create a new task");
    });

    it("shows edit welcome when context provided", () => {
      initTaskChat('{"id":"t1"}');
      const msgs = document.querySelectorAll("#taskChatMessages .message.assistant");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].textContent).toContain("modify this task");
    });

    it("clears previous messages on re-init", () => {
      taskChatAddMessage("user", "old message");
      expect(document.querySelectorAll("#taskChatMessages .message")).toHaveLength(1);

      initTaskChat(null);
      // Should only have the new welcome message
      const msgs = document.querySelectorAll("#taskChatMessages .message");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].classList.contains("assistant")).toBe(true);
    });

    it("sets active flag to true", () => {
      initTaskChat(null);
      expect(taskChatState.active).toBe(true);
    });
  });

  describe("disconnectTaskChat", () => {
    it("closes WS, sets to null, and clears active flag", () => {
      const mockClose = vi.fn();
      taskChatState.ws = { close: mockClose } as unknown as WebSocket;
      taskChatState.active = true;

      disconnectTaskChat();

      expect(mockClose).toHaveBeenCalledOnce();
      expect(taskChatState.ws).toBeNull();
      expect(taskChatState.active).toBe(false);
    });

    it("is safe when ws is already null", () => {
      taskChatState.ws = null;
      expect(() => disconnectTaskChat()).not.toThrow();
      expect(taskChatState.active).toBe(false);
    });
  });
});
