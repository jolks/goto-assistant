// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).marked = {
    parse: (text: string) => `<p>${text}</p>`,
  };
  (globalThis as Record<string, unknown>).DOMPurify = {
    sanitize: (html: string) => html,
  };
});

import { chatAddMessage, chatAddTypingIndicator, chatRemoveTypingIndicator, chatCreateWs } from "../public/chat-core.js";

describe("chat-core", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="messages"></div>';
  });

  describe("chatAddMessage", () => {
    it("adds a message with role class", () => {
      chatAddMessage("messages", "user", "Hello");
      const msg = document.querySelector("#messages .message.user");
      expect(msg).not.toBeNull();
      expect(msg!.innerHTML).toContain("Hello");
    });

    it("renders markdown via marked + DOMPurify", () => {
      chatAddMessage("messages", "assistant", "**bold**");
      const msg = document.querySelector("#messages .message.assistant");
      expect(msg!.innerHTML).toContain("<p>");
    });

    it("returns the created element", () => {
      const el = chatAddMessage("messages", "user", "test");
      expect(el).toBeInstanceOf(HTMLElement);
      expect(el!.className).toBe("message user");
    });

    it("returns null when container is missing", () => {
      const result = chatAddMessage("nonexistent", "user", "test");
      expect(result).toBeNull();
    });

    it("scrolls container to bottom", () => {
      const container = document.getElementById("messages")!;
      Object.defineProperty(container, "scrollHeight", { value: 500, configurable: true });
      chatAddMessage("messages", "user", "test");
      expect(container.scrollTop).toBe(500);
    });
  });

  describe("chatAddTypingIndicator", () => {
    it("adds indicator with 3 spans", () => {
      chatAddTypingIndicator("messages", "typing");
      const indicator = document.getElementById("typing");
      expect(indicator).not.toBeNull();
      expect(indicator!.querySelectorAll("span")).toHaveLength(3);
      expect(indicator!.className).toBe("typing-indicator");
    });

    it("does nothing when container is missing", () => {
      chatAddTypingIndicator("nonexistent", "typing");
      expect(document.getElementById("typing")).toBeNull();
    });
  });

  describe("chatCreateWs", () => {
    let listeners: Record<string, Array<() => void>>;
    let mockWs: Record<string, unknown>;

    beforeEach(() => {
      listeners = {};
      mockWs = {
        addEventListener: (event: string, fn: () => void) => {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(fn);
        },
      };
      vi.stubGlobal("WebSocket", vi.fn(() => mockWs));
      vi.stubGlobal("window", { location: { protocol: "http:", host: "localhost:3000" } });
    });

    it("calls onError callback on error event", () => {
      const onError = vi.fn();
      chatCreateWs({ onMessage: vi.fn(), onError });
      // Simulate error event
      listeners["error"].forEach(fn => fn());
      expect(onError).toHaveBeenCalledWith(mockWs);
    });

    it("does not throw when onError is not provided", () => {
      chatCreateWs({ onMessage: vi.fn() });
      expect(() => listeners["error"].forEach(fn => fn())).not.toThrow();
    });
  });

  describe("chatRemoveTypingIndicator", () => {
    it("removes indicator by id", () => {
      chatAddTypingIndicator("messages", "typing");
      expect(document.getElementById("typing")).not.toBeNull();
      chatRemoveTypingIndicator("typing");
      expect(document.getElementById("typing")).toBeNull();
    });

    it("is safe when no indicator exists", () => {
      expect(() => chatRemoveTypingIndicator("typing")).not.toThrow();
    });
  });
});
