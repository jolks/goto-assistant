import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { DATA_DIR } from "./config.js";

export interface Conversation {
  id: string;
  provider: string;
  sdk_session_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
}

const DB_PATH = path.join(DATA_DIR, "sessions.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      sdk_session_id TEXT,
      title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    )
  `);
  return db;
}

export function createConversation(provider: string): Conversation {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT INTO conversations (id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
    .run(id, provider, now, now);
  return { id, provider, sdk_session_id: null, title: null, created_at: now, updated_at: now };
}

export function getConversation(id: string): Conversation | undefined {
  return getDb()
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .get(id) as Conversation | undefined;
}

export function updateSessionId(conversationId: string, sdkSessionId: string): void {
  getDb()
    .prepare(
      "UPDATE conversations SET sdk_session_id = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(sdkSessionId, conversationId);
}

export function updateTitle(conversationId: string, title: string): void {
  getDb()
    .prepare(
      "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(title, conversationId);
}

export function listConversations(): Conversation[] {
  return getDb()
    .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
    .all() as Conversation[];
}

export function saveMessage(conversationId: string, role: string, content: string): void {
  getDb()
    .prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)")
    .run(conversationId, role, content);
}

export function getMessages(conversationId: string): Message[] {
  return getDb()
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC")
    .all(conversationId) as Message[];
}

export function deleteConversation(id: string): void {
  getDb().prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
  getDb().prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

export interface ParsedContent {
  text: string;
  attachments?: Array<{ fileId: string; filename: string; mimeType: string }>;
}

export function parseMessageContent(content: string): ParsedContent {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.text === "string") {
      return { text: parsed.text, attachments: parsed.attachments };
    }
  } catch {
    // Not JSON — treat as plain text
  }
  return { text: content };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
