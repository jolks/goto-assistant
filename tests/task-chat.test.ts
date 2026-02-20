// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";

// Provide marked + DOMPurify globals before task-chat.js is imported
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).marked = {
    parse: (text: string) => `<p>${text}</p>`,
  };
  (globalThis as Record<string, unknown>).DOMPurify = {
    sanitize: (html: string) => html,
  };
});

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
}

describe("task-chat", () => {
  beforeEach(() => {
    setupDOM();
    resetState();
  });

  describe("taskChatAddMessage", () => {
    it("adds a user message to the container", () => {
      taskChatAddMessage("user", "Hello");
      const msgs = document.querySelectorAll("#taskChatMessages .message");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].classList.contains("user")).toBe(true);
      expect(msgs[0].innerHTML).toContain("Hello");
    });

    it("adds an assistant message with markdown rendering", () => {
      taskChatAddMessage("assistant", "**bold**");
      const msgs = document.querySelectorAll("#taskChatMessages .message");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].classList.contains("assistant")).toBe(true);
      expect(msgs[0].innerHTML).toContain("**bold**");
    });

    it("returns null when container is missing", () => {
      document.body.innerHTML = "";
      const result = taskChatAddMessage("user", "test");
      expect(result).toBeNull();
    });

    it("returns the created element", () => {
      const el = taskChatAddMessage("user", "test");
      expect(el).toBeInstanceOf(HTMLElement);
      expect(el!.className).toBe("message user");
    });
  });

  describe("typing indicator", () => {
    it("adds typing indicator with 3 spans", () => {
      addTaskTypingIndicator();
      const indicator = document.getElementById("taskTyping");
      expect(indicator).not.toBeNull();
      expect(indicator!.querySelectorAll("span")).toHaveLength(3);
    });

    it("removes typing indicator", () => {
      addTaskTypingIndicator();
      expect(document.getElementById("taskTyping")).not.toBeNull();
      removeTaskTypingIndicator();
      expect(document.getElementById("taskTyping")).toBeNull();
    });

    it("is safe when no indicator exists", () => {
      expect(() => removeTaskTypingIndicator()).not.toThrow();
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
      // Mock WebSocket constructor
      const mockWs = {
        addEventListener: vi.fn(),
        close: vi.fn(),
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      };
      vi.stubGlobal("WebSocket", vi.fn(() => mockWs));
      vi.stubGlobal("location", { protocol: "http:", host: "localhost:3000" });
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
  });

  describe("disconnectTaskChat", () => {
    it("closes WS and sets to null", () => {
      const mockClose = vi.fn();
      taskChatState.ws = { close: mockClose } as unknown as WebSocket;

      disconnectTaskChat();

      expect(mockClose).toHaveBeenCalledOnce();
      expect(taskChatState.ws).toBeNull();
    });

    it("is safe when ws is already null", () => {
      taskChatState.ws = null;
      expect(() => disconnectTaskChat()).not.toThrow();
    });
  });
});
