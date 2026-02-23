import path from "node:path";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  type WASocket,
  type BaileysEventMap,
  type proto,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { DATA_DIR, loadConfig, loadMcpServers } from "./config.js";
import { registerChannel, unregisterChannel } from "./messaging.js";
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
      const textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "";

      // Handle image attachments
      let attachments: Attachment[] | undefined;
      let attachmentFileId: string | undefined;
      const imageMessage = msg.message?.imageMessage;
      if (imageMessage) {
        try {
          const buffer = await downloadMediaMessage(
            msg as Parameters<typeof downloadMediaMessage>[0],
            "buffer",
            {}
          ) as Buffer;
          const mimeType = imageMessage.mimetype || "image/jpeg";
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

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Baileys expects a pino logger; pass undefined to suppress logs
      keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
    },
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

      if (!loggedOut && shouldReconnect) {
        connectionStatus = "connecting";
        console.log("WhatsApp connection closed, reconnecting...");
        setTimeout(() => startWhatsApp(), 3000);
      } else {
        connectionStatus = "disconnected";
        if (loggedOut) {
          console.log("WhatsApp logged out. Scan QR code again to reconnect.");
        }
      }
    } else if (connection === "open") {
      connectionStatus = "connected";
      currentQr = null;
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
  currentQr = null;
  connectionStatus = "disconnected";
  unregisterChannel("whatsapp");
  if (sock) {
    sock.end(undefined); // Baileys requires an explicit Error | undefined argument
    sock = null;
  }
}

/**
 * Send a text message via WhatsApp.
 * Concurrent calls are safe — Baileys serializes sendMessage internally.
 * @param text - Message content to send
 * @param to - Phone number (e.g. "+60123456789") or "self"/undefined for self-chat
 * @returns Number of message parts sent
 */
export async function sendWhatsAppMessage(text: string, to?: string): Promise<number> {
  // Validate phone number before checking socket so it can be tested without a connection
  let jid: string | undefined;
  if (to && to !== "self") {
    const digits = to.replace(/\D/g, "");
    if (digits.length < 7) throw new Error("Invalid phone number"); // shortest international numbers are ~7 digits
    jid = `${digits}@s.whatsapp.net`;
  }

  if (!sock) throw new Error("WhatsApp is not connected");

  if (!jid) {
    const ownJid = getOwnJid();
    if (!ownJid) throw new Error("WhatsApp own JID not available");
    jid = ownJid;
  }

  const isSelf = jid === getOwnJid();

  const parts = splitMessage(text);
  for (const part of parts) {
    const sent = await sock.sendMessage(jid, { text: part });
    if (isSelf && sent?.key?.id) trackSentId(sent.key.id);
  }
  return parts.length;
}

// Exported for testing
export { enqueueChat as _enqueueChat, chatQueues as _chatQueues };
