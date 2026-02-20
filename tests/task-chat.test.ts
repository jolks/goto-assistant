// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";

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
  taskChatAddMessage,
  addTaskTypingIndicator,
  removeTaskTypingIndicator,
  sendTaskChatMessage,
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
