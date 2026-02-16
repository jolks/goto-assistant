import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.GOTO_DATA_DIR = "tests/data";
});

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../src/config.js";
import {
  getDb,
  createConversation,
  getConversation,
  updateSessionId,
  updateTitle,
  listConversations,
  saveMessage,
  getMessages,
  deleteConversation,
  closeDb,
} from "../src/sessions.js";

const DB_PATH = path.join(DATA_DIR, "sessions.db");

describe("sessions", () => {
  beforeEach(() => {
    closeDb();
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    if (fs.existsSync(DB_PATH + "-wal")) fs.unlinkSync(DB_PATH + "-wal");
    if (fs.existsSync(DB_PATH + "-shm")) fs.unlinkSync(DB_PATH + "-shm");
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    if (fs.existsSync(DB_PATH + "-wal")) fs.unlinkSync(DB_PATH + "-wal");
    if (fs.existsSync(DB_PATH + "-shm")) fs.unlinkSync(DB_PATH + "-shm");
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

  it("hides setup conversations from listConversations", () => {
    createConversation("claude", true);
    createConversation("claude");

    const list = listConversations();
    expect(list).toHaveLength(1);
    // The non-setup conversation should be returned
    expect(list[0].provider).toBe("claude");
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
