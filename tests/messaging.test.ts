import { describe, it, expect, beforeEach } from "vitest";
import { registerChannel, unregisterChannel, getChannel, listChannels, sendMessage, UnknownChannelError } from "../src/messaging.js";

describe("messaging", () => {
  beforeEach(() => {
    // Clean up all channels between tests
    for (const name of listChannels()) {
      unregisterChannel(name);
    }
  });

  describe("registerChannel / unregisterChannel", () => {
    it("registers and retrieves a channel", () => {
      const send = async () => 1;
      registerChannel("test", send);
      expect(getChannel("test")).toBe(send);
    });

    it("unregisters a channel", () => {
      registerChannel("test", async () => 1);
      unregisterChannel("test");
      expect(getChannel("test")).toBeUndefined();
    });

    it("unregister is a no-op for unknown channel", () => {
      unregisterChannel("nonexistent");
      expect(listChannels()).toEqual([]);
    });
  });

  describe("listChannels", () => {
    it("returns empty array when no channels registered", () => {
      expect(listChannels()).toEqual([]);
    });

    it("returns registered channel names", () => {
      registerChannel("whatsapp", async () => 1);
      registerChannel("telegram", async () => 1);
      expect(listChannels()).toEqual(["whatsapp", "telegram"]);
    });
  });

  describe("sendMessage", () => {
    it("routes to the correct channel send function", async () => {
      let capturedArgs: { message: string; to?: string } | undefined;
      registerChannel("whatsapp", async (message, to) => {
        capturedArgs = { message, to };
        return 1;
      });

      const result = await sendMessage("whatsapp", "hello", "self");
      expect(result).toBe(1);
      expect(capturedArgs).toEqual({ message: "hello", to: "self" });
    });

    it("passes through the part count from the send function", async () => {
      registerChannel("whatsapp", async () => 3);
      const result = await sendMessage("whatsapp", "long message");
      expect(result).toBe(3);
    });

    it("throws UnknownChannelError for unknown channel with helpful message", async () => {
      registerChannel("whatsapp", async () => 1);
      await expect(sendMessage("telegram", "hi")).rejects.toThrow(UnknownChannelError);
      await expect(sendMessage("telegram", "hi")).rejects.toThrow(
        'Unknown channel: "telegram". Available channels: whatsapp'
      );
    });

    it("throws UnknownChannelError with 'none' when no channels registered", async () => {
      await expect(sendMessage("whatsapp", "hi")).rejects.toThrow(UnknownChannelError);
      await expect(sendMessage("whatsapp", "hi")).rejects.toThrow(
        'Unknown channel: "whatsapp". Available channels: none'
      );
    });

    it("propagates errors from the send function", async () => {
      registerChannel("whatsapp", async () => {
        throw new Error("Not connected");
      });
      await expect(sendMessage("whatsapp", "hi")).rejects.toThrow("Not connected");
    });

    it("forwards options with media to the send function", async () => {
      let capturedArgs: { message: string; to?: string; options?: { media?: string } } | undefined;
      registerChannel("whatsapp", async (message, to, options) => {
        capturedArgs = { message, to, options };
        return 1;
      });

      const result = await sendMessage("whatsapp", "caption", "self", { media: "/tmp/photo.jpg" });
      expect(result).toBe(1);
      expect(capturedArgs).toEqual({ message: "caption", to: "self", options: { media: "/tmp/photo.jpg" } });
    });
  });
});
