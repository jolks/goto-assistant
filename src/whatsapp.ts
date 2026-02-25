import path from "node:path";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  type WASocket,
  type BaileysEventMap,
  type proto,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { DATA_DIR, loadConfig, loadMcpServers } from "./config.js";
import fs from "node:fs";
import { registerChannel, unregisterChannel, ChannelUnavailableError, type SendMediaOptions } from "./messaging.js";
import { routeMessage } from "./agents/router.js";
import type { Attachment } from "./agents/router.js";
import {
  createConversation,
  findConversationByChannelId,
  getConversation,
  saveMessage,
  getMessages,
  updateSessionId,
  updateTitle,
} from "./sessions.js";
import { saveUpload, ALLOWED_IMAGE_TYPES } from "./uploads.js";
import { UPLOADS_DIR } from "./uploads.js";

const AUTH_DIR = path.join(DATA_DIR, "whatsapp-auth");

type ConnectionStatus = "disconnected" | "connecting" | "qr_ready" | "connected";

let sock: WASocket | null = null;
let connectionStatus: ConnectionStatus = "disconnected";
let currentQr: string | null = null;
let shouldReconnect = true;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 3000; // 3 seconds
const MAX_RECONNECT_DELAY = 60000; // 60 seconds

// Per-chatId queue: serialize message processing so concurrent messages don't collide
const chatQueues = new Map<string, Promise<void>>();

// Track message IDs sent by the agent to avoid processing our own replies
const sentMessageIds = new Set<string>();
const MAX_SENT_IDS = 500;

/** Get the normalized own JID (e.g. "60123456789@s.whatsapp.net") from the socket. */
function getOwnJid(): string | undefined {
  return sock?.user?.id?.replace(/:.*@/, "@");
}

/** Track a sent message ID for loop prevention. Caps the set at MAX_SENT_IDS. */
function trackSentId(id: string): void {
  sentMessageIds.add(id);
  if (sentMessageIds.size > MAX_SENT_IDS) {
    const first = sentMessageIds.values().next().value!;
    sentMessageIds.delete(first);
  }
}

export function getWhatsAppStatus(): ConnectionStatus {
  return connectionStatus;
}

export function getWhatsAppQr(): string | null {
  return currentQr;
}

export async function getWhatsAppQrDataUri(): Promise<string | null> {
  if (!currentQr) return null;
  return QRCode.toDataURL(currentQr);
}

export function splitMessage(text: string, maxLen = 65000): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Find last newline within limit
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx <= 0) {
      // No good newline break — split at maxLen
      splitIdx = maxLen;
    }
    parts.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, "");
  }
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}

function enqueueChat(chatId: string, fn: () => Promise<void>): void {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn regardless of previous success/failure
  chatQueues.set(chatId, next);
  // Clean up after completion
  next.then(() => {
    if (chatQueues.get(chatId) === next) {
      chatQueues.delete(chatId);
    }
  });
}

async function handleMessage(msg: proto.IWebMessageInfo): Promise<void> {
  if (!msg.message || !msg.key?.remoteJid) return;
  if (msg.key.remoteJid === "status@broadcast") return;

  // Only respond in self-chat (user messaging themselves) — never reply to other people
  const ownJid = getOwnJid();
  const isSelfChat = ownJid && msg.key.remoteJid === ownJid;
  if (!isSelfChat) return;

  // Skip messages the agent itself sent (prevents infinite loops)
  if (msg.key.id && sentMessageIds.has(msg.key.id)) return;

  const chatId = msg.key.remoteJid;

  enqueueChat(chatId, async () => {
    try {
      const config = loadConfig();
      const mcpServers = loadMcpServers();

      // Extract text content
      const videoMessage = msg.message?.videoMessage;
      const textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        videoMessage?.caption ||
        "";

      // Handle image attachments (+ WhatsApp GIFs as static thumbnails)
      let attachments: Attachment[] | undefined;
      let attachmentFileId: string | undefined;
      const imageMessage = msg.message?.imageMessage;
      const isGif = videoMessage?.gifPlayback;
      if (imageMessage || isGif) {
        try {
          let buffer: Buffer;
          let mimeType: string;
          if (imageMessage) {
            // Real image: download full media
            buffer = await downloadMediaMessage(
              msg as Parameters<typeof downloadMediaMessage>[0],
              "buffer",
              {}
            ) as Buffer;
            mimeType = imageMessage.mimetype || "image/jpeg";
          } else {
            // WhatsApp GIF: actual data is mp4, so use the JPEG thumbnail instead
            const thumbnail = videoMessage?.jpegThumbnail;
            if (!thumbnail) throw new Error("No GIF thumbnail available");
            buffer = Buffer.from(thumbnail);
            mimeType = "image/jpeg";
          }
          if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) throw new Error("Unsupported image type");
          const ext = mimeType.split("/")[1] || "jpg";
          const filename = `whatsapp-${Date.now()}.${ext}`;
          const meta = saveUpload(buffer, filename, mimeType);
          attachmentFileId = meta.fileId;
          attachments = [{
            filename: meta.filename,
            mimeType: meta.mimeType,
            data: buffer,
            filePath: path.resolve(UPLOADS_DIR, meta.fileId, meta.filename),
          }];
        } catch (err) {
          console.error("Failed to download WhatsApp media:", err);
        }
      }

      const prompt = textContent || (attachments ? "Describe this image." : "");
      if (!prompt && !attachments) return;

      // Find or create conversation for this chatId
      let conversation = findConversationByChannelId(chatId);
      let isNewConversation = false;
      if (!conversation) {
        conversation = createConversation(config.provider, 0, chatId);
        isNewConversation = true;
      }

      // Save user message
      if (attachments && attachments.length > 0) {
        saveMessage(conversation.id, "user", JSON.stringify({
          text: prompt,
          attachments: attachments.map(a => ({
            fileId: attachmentFileId,
            filename: a.filename,
            mimeType: a.mimeType,
          })),
        }));
      } else {
        saveMessage(conversation.id, "user", prompt);
      }

      // Set title from first message on new conversations
      if (isNewConversation) {
        const title = prompt.length > 100 ? prompt.slice(0, 100) + "..." : prompt;
        updateTitle(conversation.id, title);
      }

      // Get resume session ID for Claude
      const existing = getConversation(conversation.id);
      const resumeSessionId = existing?.sdk_session_id ?? undefined;

      // Load conversation history (excluding current message) for OpenAI
      const allMessages = getMessages(conversation.id);
      const history = allMessages.slice(0, -1);

      // Call the agent — buffer full response (no streaming for WhatsApp)
      let responseText = "";
      const result = await routeMessage(
        prompt,
        config,
        mcpServers,
        (chunk) => {
          responseText += chunk;
        },
        { resumeSessionId, attachments, history }
      );

      // Save assistant message
      if (responseText) {
        saveMessage(conversation.id, "assistant", responseText);
      }

      // Save SDK session ID for Claude resume
      if (result.sessionId) {
        updateSessionId(conversation.id, result.sessionId);
      }

      // Send response back via WhatsApp
      if (responseText && sock) {
        const parts = splitMessage(responseText);
        for (const part of parts) {
          const sent = await sock.sendMessage(chatId, { text: part });
          if (sent?.key?.id) trackSentId(sent.key.id);
        }
      }
    } catch (err) {
      console.error(`WhatsApp message handling error for ${chatId}:`, err);
      // Try to send error message back
      if (sock) {
        try {
          await sock.sendMessage(chatId, { text: "Sorry, I encountered an error processing your message." });
        } catch {
          // ignore send failure
        }
      }
    }
  });
}

export async function startWhatsApp(): Promise<void> {
  if (sock) return; // already running

  shouldReconnect = true;
  connectionStatus = "connecting";
  currentQr = null;
  // Don't reset reconnectAttempts here — reset only on successful connection

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Fetch the latest WA web version to avoid 405 protocol mismatch errors
  let version: [number, number, number] | undefined;
  try {
    ({ version } = await fetchLatestWaWebVersion());
  } catch {
    console.warn("Could not fetch latest WA web version, using Baileys default");
  }

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Baileys expects a pino logger; pass undefined to suppress logs
      keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
    },
    ...(version ? { version } : {}),
    printQRInTerminal: false,
  });

  // Connection updates
  sock.ev.on("connection.update", (update: BaileysEventMap["connection.update"]) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQr = qr;
      connectionStatus = "qr_ready";
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      currentQr = null;
      sock = null;
      unregisterChannel("whatsapp");

      if (loggedOut) {
        connectionStatus = "disconnected";
        reconnectAttempts = 0;
        console.log("WhatsApp logged out. Scan QR code again to reconnect.");
      } else if (!shouldReconnect) {
        connectionStatus = "disconnected";
        reconnectAttempts = 0;
      } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        connectionStatus = "disconnected";
        console.log(`WhatsApp reconnection failed after ${MAX_RECONNECT_ATTEMPTS} attempts (last status: ${statusCode ?? "unknown"}). Giving up.`);
        reconnectAttempts = 0;
      } else {
        reconnectAttempts++;
        const delay = Math.min(BASE_RECONNECT_DELAY * 2 ** (reconnectAttempts - 1), MAX_RECONNECT_DELAY);
        connectionStatus = "connecting";
        console.log(`WhatsApp connection closed (status: ${statusCode ?? "unknown"}), reconnecting in ${(delay / 1000).toFixed(0)}s... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(() => startWhatsApp(), delay);
      }
    } else if (connection === "open") {
      connectionStatus = "connected";
      currentQr = null;
      reconnectAttempts = 0;
      registerChannel("whatsapp", sendWhatsAppMessage);
      console.log("WhatsApp connected successfully.");
    }
  });

  // Save credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Handle incoming messages
  sock.ev.on("messages.upsert", (upsert: BaileysEventMap["messages.upsert"]) => {
    if (upsert.type !== "notify") return;
    for (const msg of upsert.messages) {
      handleMessage(msg).catch((err) =>
        console.error("WhatsApp message handler error:", err)
      );
    }
  });
}

export async function stopWhatsApp(): Promise<void> {
  shouldReconnect = false;
  reconnectAttempts = 0;
  currentQr = null;
  connectionStatus = "disconnected";
  unregisterChannel("whatsapp");
  if (sock) {
    sock.end(undefined); // Baileys requires an explicit Error | undefined argument
    sock = null;
  }
}

const MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", mp4: "video/mp4", avi: "video/x-msvideo", mov: "video/quicktime",
  mkv: "video/x-matroska", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

/** Look up MIME type from file extension. Works for both local paths and URLs. */
export function lookupMimeType(source: string): string {
  // For URLs, extract the path portion before checking extension
  let pathname = source;
  if (source.startsWith("http://") || source.startsWith("https://")) {
    try { pathname = new URL(source).pathname; } catch { /* use source as-is */ }
  }
  const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}

/** Classify a MIME type into a WhatsApp media category. */
export function classifyMediaType(mimeType: string): "image" | "video" | "audio" | "document" {
  // GIFs: Baileys' image pipeline runs sharp extractImageThumb which corrupts
  // animated GIFs (multi-frame → broken upload). Send as document to preserve
  // the original file. Proper animated GIF would require ffmpeg → mp4 + gifPlayback.
  if (mimeType === "image/gif") return "document";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

const MAX_MEDIA_SIZE = 64 * 1024 * 1024; // 64MB WhatsApp limit

/**
 * Send a text message via WhatsApp.
 * Concurrent calls are safe — Baileys serializes sendMessage internally.
 * @param text - Message content to send
 * @param to - Phone number (e.g. "+60123456789") or "self"/undefined for self-chat
 * @param options - Optional media attachment
 * @returns Number of message parts sent
 */
export async function sendWhatsAppMessage(text: string, to?: string, options?: SendMediaOptions): Promise<number> {
  // Validate phone number before checking socket so it can be tested without a connection
  let jid: string | undefined;
  if (to && to !== "self") {
    const digits = to.replace(/\D/g, "");
    if (digits.length < 7) throw new Error("Invalid phone number"); // shortest international numbers are ~7 digits
    jid = `${digits}@s.whatsapp.net`;
  }

  if (!sock) throw new ChannelUnavailableError("WhatsApp is not connected");

  if (!jid) {
    const ownJid = getOwnJid();
    if (!ownJid) throw new Error("WhatsApp own JID not available");
    jid = ownJid;
  }

  const isSelf = jid === getOwnJid();

  // Media path: send a single media message
  if (options?.media) {
    const media = options.media;
    const isUrl = media.startsWith("http://") || media.startsWith("https://");

    // Validate local files
    if (!isUrl) {
      let stat: import("node:fs").Stats | undefined;
      try { stat = await fs.promises.stat(media); } catch { /* file does not exist */ }
      if (!stat || !stat.isFile()) throw new Error(`Media file not found: ${media}`);
      if (stat.size > MAX_MEDIA_SIZE) throw new Error(`Media file exceeds 64MB limit: ${media}`);
    }

    const mimeType = lookupMimeType(media);
    const mediaType = classifyMediaType(mimeType);
    const caption = text || undefined;
    const source = { url: media };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Baileys content types vary
    let content: Record<string, any>;
    let sendCaptionSeparately = false;
    switch (mediaType) {
      case "image":
        content = { image: source, caption };
        break;
      case "video":
        content = { video: source, caption };
        break;
      case "audio":
        content = { audio: source }; // WhatsApp audio has no caption support
        sendCaptionSeparately = !!caption;
        break;
      case "document":
        content = { document: source, mimetype: mimeType, fileName: path.basename(media), caption };
        break;
      default:
        throw new Error(`Unknown media type: ${mediaType}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- content is built dynamically from a known-safe switch
    const sent = await sock.sendMessage(jid, content as any);
    if (isSelf && sent?.key?.id) trackSentId(sent.key.id);

    // Audio doesn't support captions — send the text as a separate message
    if (sendCaptionSeparately && caption) {
      const capSent = await sock.sendMessage(jid, { text: caption });
      if (isSelf && capSent?.key?.id) trackSentId(capSent.key.id);
      return 2;
    }
    return 1;
  }

  // Text-only path: split long messages
  const parts = splitMessage(text);
  for (const part of parts) {
    const sent = await sock.sendMessage(jid, { text: part });
    if (isSelf && sent?.key?.id) trackSentId(sent.key.id);
  }
  return parts.length;
}

// Exported for testing
export { enqueueChat as _enqueueChat, chatQueues as _chatQueues };
