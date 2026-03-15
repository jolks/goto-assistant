import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture event handlers registered by each startWhatsApp() call
type EvHandler = (...args: unknown[]) => void;
let evHandlers: Record<string, EvHandler> = {};

vi.mock("@whiskeysockets/baileys", () => ({
  default: vi.fn(() => {
    evHandlers = {};
    return {
      ev: {
        on: vi.fn((event: string, handler: EvHandler) => {
          evHandlers[event] = handler;
        }),
      },
      end: vi.fn(),
      user: { id: "60123456789:1@s.whatsapp.net" },
      sendMessage: vi.fn(),
    };
  }),
  useMultiFileAuthState: vi.fn(async () => ({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn(),
  })),
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  fetchLatestWaWebVersion: vi.fn(async () => ({ version: [2, 2400, 0] })),
  DisconnectReason: { loggedOut: 401, connectionClosed: 428, connectionLost: 408, timedOut: 515 },
  downloadMediaMessage: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  DATA_DIR: "/tmp/test-wa-data",
  loadConfig: vi.fn(),
  loadMcpServers: vi.fn(),
}));

vi.mock("../src/messaging.js", () => ({
  registerChannel: vi.fn(),
  unregisterChannel: vi.fn(),
  ChannelUnavailableError: class extends Error {},
}));

vi.mock("../src/agents/router.js", () => ({
  routeMessage: vi.fn(),
}));

vi.mock("../src/sessions.js", () => ({
  createConversation: vi.fn(),
  findConversationByChannelId: vi.fn(),
  getConversation: vi.fn(),
  saveMessage: vi.fn(),
  getMessages: vi.fn(),
  updateSessionId: vi.fn(),
  updateTitle: vi.fn(),
}));

vi.mock("../src/uploads.js", () => ({
  saveUpload: vi.fn(),
  ALLOWED_IMAGE_TYPES: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  UPLOADS_DIR: "/tmp/test-uploads",
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async (qr: string) => `data:image/png;base64,${qr}`) },
}));

// Spy on fs.rmSync — mock it to a no-op so it doesn't actually delete anything
import fs from "node:fs";
const rmSyncSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => {});

const { registerChannel, unregisterChannel } = await import("../src/messaging.js");
const { startWhatsApp, stopWhatsApp, getWhatsAppStatus, getWhatsAppQr } = await import("../src/whatsapp.js");
const makeWASocket = (await import("@whiskeysockets/baileys")).default;

/** Simulate a connection.update event from Baileys */
function emitConnectionUpdate(update: Record<string, unknown>) {
  evHandlers["connection.update"]?.(update);
}

describe("whatsapp connection lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    rmSyncSpy.mockClear();
  });

  afterEach(async () => {
    await stopWhatsApp();
    vi.useRealTimers();
  });

  it("sets status to qr_ready when QR code is received", async () => {
    await startWhatsApp();
    emitConnectionUpdate({ qr: "qr-string-123" });

    expect(getWhatsAppStatus()).toBe("qr_ready");
    expect(getWhatsAppQr()).toBe("qr-string-123");
  });

  it("sets status to connected on successful open", async () => {
    await startWhatsApp();
    emitConnectionUpdate({ connection: "open" });

    expect(getWhatsAppStatus()).toBe("connected");
    expect(getWhatsAppQr()).toBeNull();
    expect(registerChannel).toHaveBeenCalledWith("whatsapp", expect.any(Function));
  });

  it("clears auth state on logout", async () => {
    await startWhatsApp();
    emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });

    expect(rmSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining("whatsapp-auth"),
      { recursive: true, force: true },
    );
    expect(getWhatsAppStatus()).toBe("disconnected");
    expect(unregisterChannel).toHaveBeenCalledWith("whatsapp");
  });

  it("generates fresh QR after logout and reconnect", async () => {
    await startWhatsApp();

    // Simulate logout — clears auth + sets sock = null
    emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    expect(getWhatsAppStatus()).toBe("disconnected");

    // User clicks "Connect" again — should create a new socket
    await startWhatsApp();
    expect(makeWASocket).toHaveBeenCalledTimes(2);

    // Baileys generates a fresh QR for the clean auth state
    emitConnectionUpdate({ qr: "fresh-qr-after-logout" });

    expect(getWhatsAppStatus()).toBe("qr_ready");
    expect(getWhatsAppQr()).toBe("fresh-qr-after-logout");
  });

  it("does NOT clear auth on non-logout disconnect", async () => {
    await startWhatsApp();
    emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });

    expect(rmSyncSpy).not.toHaveBeenCalled();
  });

  it("schedules reconnect with exponential backoff on non-logout disconnect", async () => {
    await startWhatsApp();

    // First disconnect — should schedule reconnect at 3s
    emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    expect(getWhatsAppStatus()).toBe("connecting");

    // Advance timer to trigger the reconnect
    await vi.advanceTimersByTimeAsync(3000);
    expect(makeWASocket).toHaveBeenCalledTimes(2);

    // Second disconnect — should schedule reconnect at 6s
    emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    expect(getWhatsAppStatus()).toBe("connecting");

    await vi.advanceTimersByTimeAsync(6000);
    expect(makeWASocket).toHaveBeenCalledTimes(3);
  });

  it("gives up after max reconnect attempts", async () => {
    await startWhatsApp();

    // Exhaust all 10 reconnect attempts
    for (let i = 0; i < 10; i++) {
      emitConnectionUpdate({
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 408 } } },
      });
      const delay = Math.min(3000 * 2 ** i, 60000);
      await vi.advanceTimersByTimeAsync(delay);
    }

    // 11th disconnect — should give up
    emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });

    expect(getWhatsAppStatus()).toBe("disconnected");
    // No more reconnect scheduled — makeWASocket call count should not increase
    const callCount = vi.mocked(makeWASocket).mock.calls.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(makeWASocket).toHaveBeenCalledTimes(callCount);
  });
});
