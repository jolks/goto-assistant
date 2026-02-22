import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR } from "../src/config.js";
import {
  getDb,
  createConversation,
  getConversation,
  findConversationByChannelId,
  updateSessionId,
  updateTitle,
  listConversations,
  saveMessage,
  getMessages,
  deleteConversation,
  closeDb,
} from "../src/sessions.js";
import { cleanupDbFiles } from "./helpers.js";

describe("sessions", () => {
  beforeEach(() => {
    closeDb();
    cleanupDbFiles();
  });

  afterEach(() => {
    closeDb();
    cleanupDbFiles();
  });

  it("creates a conversation and retrieves it", () => {
    const conv = createConversation("claude");
    expect(conv.id).toBeTruthy();
    expect(conv.provider).toBe("claude");
    expect(conv.sdk_session_id).toBeNull();

    const retrieved = getConversation(conv.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(conv.id);
    expect(retrieved!.provider).toBe("claude");
  });

  it("returns undefined for missing conversation", () => {
    getDb(); // ensure DB is initialized
    const result = getConversation("nonexistent-id");
    expect(result).toBeUndefined();
  });

  it("updates SDK session ID", () => {
    const conv = createConversation("claude");
    updateSessionId(conv.id, "sdk-session-123");

    const updated = getConversation(conv.id);
    expect(updated!.sdk_session_id).toBe("sdk-session-123");
  });

  it("updates conversation title", () => {
    const conv = createConversation("claude");
    expect(conv.title).toBeNull();

    updateTitle(conv.id, "Hello, how are you?");

    const updated = getConversation(conv.id);
    expect(updated!.title).toBe("Hello, how are you?");
  });

  it("lists conversations", () => {
    createConversation("claude");
    createConversation("openai");

    const list = listConversations();
    expect(list.length).toBe(2);
    const providers = list.map((c) => c.provider);
    expect(providers).toContain("claude");
    expect(providers).toContain("openai");
  });

  it("saves and retrieves messages", () => {
    const conv = createConversation("claude");
    saveMessage(conv.id, "user", "Hello");
    saveMessage(conv.id, "assistant", "Hi there!");

    const messages = getMessages(conv.id);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Hi there!");
  });

  it("returns messages in insertion order", () => {
    const conv = createConversation("claude");
    saveMessage(conv.id, "user", "first");
    saveMessage(conv.id, "assistant", "second");
    saveMessage(conv.id, "user", "third");

    const messages = getMessages(conv.id);
    expect(messages.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });

  it("returns empty array for conversation with no messages", () => {
    const conv = createConversation("claude");
    const messages = getMessages(conv.id);
    expect(messages).toEqual([]);
  });

  it("hides setup and task conversations from listConversations", () => {
    createConversation("claude", 1); // setup
    createConversation("claude", 2); // task
    createConversation("claude");    // regular (mode 0)

    const list = listConversations();
    expect(list).toHaveLength(1);
    // Only the regular conversation should be returned
    expect(list[0].provider).toBe("claude");
  });

  it("createConversation defaults mode to 0", () => {
    const conv = createConversation("claude");
    const row = getDb().prepare("SELECT mode FROM conversations WHERE id = ?").get(conv.id) as { mode: number };
    expect(row.mode).toBe(0);
  });

  it("createConversation stores mode=2 for task conversations", () => {
    const conv = createConversation("claude", 2);
    const row = getDb().prepare("SELECT mode FROM conversations WHERE id = ?").get(conv.id) as { mode: number };
    expect(row.mode).toBe(2);
  });

  it("migrates setup column to mode", () => {
    // Manually create a DB with old 'setup' column schema
    const dbPath = path.join(DATA_DIR, "sessions.db");
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        sdk_session_id TEXT,
        title TEXT,
        setup INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    rawDb.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    rawDb.prepare("INSERT INTO conversations (id, provider, setup, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))").run("old-conv", "claude", 1);
    rawDb.close();

    // Now let getDb() re-open and migrate
    const db = getDb();
    const cols = db.pragma("table_info(conversations)") as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("mode");
    expect(colNames).not.toContain("setup");

    // Verify data was preserved
    const row = db.prepare("SELECT mode FROM conversations WHERE id = ?").get("old-conv") as { mode: number };
    expect(row.mode).toBe(1);
  });

  it("creates a conversation with channel_id", () => {
    const conv = createConversation("claude", 0, "whatsapp:123456");
    expect(conv.channel_id).toBe("whatsapp:123456");

    const retrieved = getConversation(conv.id);
    expect(retrieved!.channel_id).toBe("whatsapp:123456");
  });

  it("creates a conversation with null channel_id by default", () => {
    const conv = createConversation("claude");
    expect(conv.channel_id).toBeNull();
  });

  it("findConversationByChannelId returns matching conversation", () => {
    createConversation("claude", 0, "whatsapp:123");
    createConversation("claude", 0, "whatsapp:456");

    const found = findConversationByChannelId("whatsapp:123");
    expect(found).toBeDefined();
    expect(found!.channel_id).toBe("whatsapp:123");
  });

  it("findConversationByChannelId returns undefined for unknown channelId", () => {
    getDb(); // ensure DB is initialized
    const found = findConversationByChannelId("nonexistent");
    expect(found).toBeUndefined();
  });

  it("adds channel_id column via migration", () => {
    const db = getDb();
    const cols = db.pragma("table_info(conversations)") as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain("channel_id");
  });

  it("deletes a conversation and its messages", () => {
    const conv = createConversation("claude");
    saveMessage(conv.id, "user", "Hello");
    saveMessage(conv.id, "assistant", "Hi!");

    deleteConversation(conv.id);

    expect(getConversation(conv.id)).toBeUndefined();
    expect(getMessages(conv.id)).toEqual([]);
    expect(listConversations()).toEqual([]);
  });
});
