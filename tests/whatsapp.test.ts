import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { splitMessage, _enqueueChat, _chatQueues } from "../src/whatsapp.js";

describe("whatsapp", () => {
  describe("splitMessage", () => {
    it("returns single-element array for short messages", () => {
      const result = splitMessage("Hello world");
      expect(result).toEqual(["Hello world"]);
    });

    it("returns single-element array for messages at exactly maxLen", () => {
      const msg = "a".repeat(100);
      const result = splitMessage(msg, 100);
      expect(result).toEqual([msg]);
    });

    it("splits long messages at newline boundaries", () => {
      const line1 = "a".repeat(60);
      const line2 = "b".repeat(60);
      const msg = line1 + "\n" + line2;
      const result = splitMessage(msg, 80);
      expect(result).toEqual([line1, line2]);
    });

    it("splits at maxLen when no newlines exist", () => {
      const msg = "a".repeat(200);
      const result = splitMessage(msg, 80);
      expect(result).toHaveLength(3);
      expect(result[0]).toBe("a".repeat(80));
      expect(result[1]).toBe("a".repeat(80));
      expect(result[2]).toBe("a".repeat(40));
    });

    it("handles multiple splits with newlines", () => {
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}: ${"x".repeat(20)}`);
      const msg = lines.join("\n");
      const result = splitMessage(msg, 60);
      // Should split into multiple parts, each <=60 chars
      for (const part of result) {
        expect(part.length).toBeLessThanOrEqual(60);
      }
      // Rejoining should reconstruct the original (minus inter-part newlines)
      expect(result.join("\n")).toBe(msg);
    });

    it("returns empty array content for empty string", () => {
      const result = splitMessage("");
      expect(result).toEqual([""]);
    });

    it("uses default maxLen of 65000", () => {
      const msg = "a".repeat(65000);
      const result = splitMessage(msg);
      expect(result).toEqual([msg]);

      const longMsg = "a".repeat(65001);
      const result2 = splitMessage(longMsg);
      expect(result2.length).toBeGreaterThan(1);
    });
  });

  describe("per-chat queuing", () => {
    beforeEach(() => {
      _chatQueues.clear();
    });

    afterEach(() => {
      _chatQueues.clear();
    });

    it("serializes tasks for the same chatId", async () => {
      const order: number[] = [];

      const task1 = () => new Promise<void>((resolve) => {
        setTimeout(() => { order.push(1); resolve(); }, 50);
      });
      const task2 = () => new Promise<void>((resolve) => {
        setTimeout(() => { order.push(2); resolve(); }, 10);
      });

      _enqueueChat("chat1", task1);
      _enqueueChat("chat1", task2);

      // Wait for both to complete
      await _chatQueues.get("chat1");
      // Small extra wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(order).toEqual([1, 2]);
    });

    it("allows parallel execution for different chatIds", async () => {
      const order: string[] = [];

      const task1 = () => new Promise<void>((resolve) => {
        setTimeout(() => { order.push("chat1"); resolve(); }, 50);
      });
      const task2 = () => new Promise<void>((resolve) => {
        setTimeout(() => { order.push("chat2"); resolve(); }, 10);
      });

      _enqueueChat("chat1", task1);
      _enqueueChat("chat2", task2);

      await Promise.all([
        _chatQueues.get("chat1"),
        _chatQueues.get("chat2"),
      ]);

      // chat2 should finish first since it has shorter timeout
      expect(order).toEqual(["chat2", "chat1"]);
    });

    it("continues processing after a task failure", async () => {
      const order: number[] = [];

      const failingTask = () => {
        return new Promise<void>((_, reject) => {
          setTimeout(() => { order.push(1); reject(new Error("fail")); }, 10);
        }).catch(() => { /* expected failure */ });
      };
      const successTask = () => new Promise<void>((resolve) => {
        setTimeout(() => { order.push(2); resolve(); }, 10);
      });

      _enqueueChat("chat1", failingTask);
      _enqueueChat("chat1", successTask);

      await _chatQueues.get("chat1");
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(order).toEqual([1, 2]);
    });

    it("cleans up queue after all tasks complete", async () => {
      const task = () => Promise.resolve();

      _enqueueChat("chat1", task);
      await _chatQueues.get("chat1");
      // Allow microtask for cleanup
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(_chatQueues.has("chat1")).toBe(false);
    });
  });
});
