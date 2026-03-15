import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "../src/config.js";

// We need to set env vars before importing episodic.ts since it reads them at module load
const SESSIONS_DB_PATH = path.join(DATA_DIR, "sessions.db");
const CRON_DB_PATH = path.join(DATA_DIR, "cron-results.db");
const INDEX_DB_PATH = path.join(DATA_DIR, "episodic-index.db");

// Set env vars before importing
process.env.GOTO_DATA_DIR = DATA_DIR;
process.env.MCP_CRON_DB_PATH = CRON_DB_PATH;

// Dynamic import to pick up env vars — top-level await in ESM
const episodic = await import("../src/episodic.js");
const { ensureIndex, searchEpisodes, getConversationContext, getTaskHistory, listRecentEpisodes, closeIndexDb } = episodic;

function createSessionsDb(): Database.Database {
  const db = new Database(SESSIONS_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      sdk_session_id TEXT,
      title TEXT,
      mode INTEGER NOT NULL DEFAULT 0,
      channel_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
  `);
  return db;
}

function createCronDb(): Database.Database {
  const db = new Database(CRON_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      type TEXT NOT NULL,
      command TEXT DEFAULT '',
      prompt TEXT DEFAULT '',
      schedule TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      command TEXT DEFAULT '',
      prompt TEXT DEFAULT '',
      output TEXT DEFAULT '',
      error TEXT DEFAULT '',
      exit_code INTEGER DEFAULT 0,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration TEXT DEFAULT ''
    );
    CREATE INDEX idx_results_task_start ON results (task_id, start_time DESC);
  `);
  return db;
}

function cleanupAll() {
  closeIndexDb();
  for (const f of [
    SESSIONS_DB_PATH, SESSIONS_DB_PATH + "-wal", SESSIONS_DB_PATH + "-shm",
    CRON_DB_PATH, CRON_DB_PATH + "-wal", CRON_DB_PATH + "-shm",
    INDEX_DB_PATH, INDEX_DB_PATH + "-wal", INDEX_DB_PATH + "-shm",
  ]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe("episodic", () => {
  beforeEach(() => {
    cleanupAll();
  });

  afterEach(() => {
    cleanupAll();
  });

  describe("ensureIndex", () => {
    it("creates FTS5 tables in index DB from empty sessions.db + cron DB", () => {
      createSessionsDb().close();
      createCronDb().close();
      ensureIndex();

      const idx = new Database(INDEX_DB_PATH, { readonly: true });
      const tables = idx
        .prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='virtual table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("messages_fts");
      expect(names).toContain("results_fts");
      expect(names).toContain("index_state");
      idx.close();
    });

    it("indexes existing conversation messages into messages_fts", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider, title) VALUES (?, ?, ?)").run("conv1", "claude", "Test conversation");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", "Hello world");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "assistant", "Hi there!");
      sdb.close();

      ensureIndex();

      const idx = new Database(INDEX_DB_PATH, { readonly: true });
      const count = idx.prepare("SELECT count(*) AS c FROM messages_fts").get() as { c: number };
      expect(count.c).toBe(2);
      idx.close();
    });

    it("indexes existing task results into results_fts", () => {
      const cdb = createCronDb();
      cdb.prepare("INSERT INTO tasks (id, name, type, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("task1", "Daily backup", "shell_command", "0 0 * * *", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      cdb.prepare("INSERT INTO results (task_id, output, start_time, end_time) VALUES (?, ?, ?, ?)").run("task1", "Backup completed successfully", "2026-03-14T00:00:00Z", "2026-03-14T00:01:00Z");
      cdb.close();

      ensureIndex();

      const idx = new Database(INDEX_DB_PATH, { readonly: true });
      const count = idx.prepare("SELECT count(*) AS c FROM results_fts").get() as { c: number };
      expect(count.c).toBe(1);
      idx.close();
    });

    it("incremental: only indexes new messages/results since last watermark", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", "First message");
      sdb.close();

      ensureIndex();

      // Add more messages
      const sdb2 = new Database(SESSIONS_DB_PATH);
      sdb2.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "assistant", "Second message");
      sdb2.close();

      // Close and re-open index to force re-initialization
      closeIndexDb();
      ensureIndex();

      const idx = new Database(INDEX_DB_PATH, { readonly: true });
      const count = idx.prepare("SELECT count(*) AS c FROM messages_fts").get() as { c: number };
      expect(count.c).toBe(2);
      idx.close();
    });

    it("handles missing sessions.db gracefully (empty results, no crash)", () => {
      createCronDb().close();
      // sessions.db does not exist
      expect(() => ensureIndex()).not.toThrow();
    });

    it("handles missing cron DB gracefully (empty results, no crash)", () => {
      createSessionsDb().close();
      // cron DB does not exist
      expect(() => ensureIndex()).not.toThrow();
    });

    it("parses JSON message content (extracts text, ignores attachment metadata)", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      const jsonContent = JSON.stringify({ text: "Check this image", attachments: [{ fileId: "abc", filename: "photo.jpg", mimeType: "image/jpeg" }] });
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", jsonContent);
      sdb.close();

      ensureIndex();

      // Search should find "image" from the text, not attachment metadata
      const results = searchEpisodes("image");
      expect(results.length).toBe(1);
      expect(results[0].snippet).toContain("image");
    });
  });

  describe("searchEpisodes", () => {
    it("finds conversation messages matching query", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider, title) VALUES (?, ?, ?)").run("conv1", "claude", "Deploy chat");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", "How do I deploy to production?");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "assistant", "Run the deployment script");
      sdb.close();

      const results = searchEpisodes("deploy production");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe("conversation_message");
      expect((results[0] as { conversation_id: string }).conversation_id).toBe("conv1");
    });

    it("finds task results matching query", () => {
      const cdb = createCronDb();
      cdb.prepare("INSERT INTO tasks (id, name, type, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("task1", "Database backup", "shell_command", "0 0 * * *", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      cdb.prepare("INSERT INTO results (task_id, output, start_time, end_time) VALUES (?, ?, ?, ?)").run("task1", "Backup completed at /var/backups/db.sql", "2026-03-14T00:00:00Z", "2026-03-14T00:01:00Z");
      cdb.close();

      const results = searchEpisodes("backup");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.type === "task_result")).toBe(true);
    });

    it("source=conversations filters out task results", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", "backup discussion");
      sdb.close();

      const cdb = createCronDb();
      cdb.prepare("INSERT INTO tasks (id, name, type, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("task1", "backup", "shell_command", "0 0 * * *", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      cdb.prepare("INSERT INTO results (task_id, output, start_time, end_time) VALUES (?, ?, ?, ?)").run("task1", "backup done", "2026-03-14T00:00:00Z", "2026-03-14T00:01:00Z");
      cdb.close();

      const results = searchEpisodes("backup", { source: "conversations" });
      expect(results.every((r) => r.type === "conversation_message")).toBe(true);
    });

    it("source=tasks filters out conversation messages", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", "backup discussion");
      sdb.close();

      const cdb = createCronDb();
      cdb.prepare("INSERT INTO tasks (id, name, type, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("task1", "backup", "shell_command", "0 0 * * *", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      cdb.prepare("INSERT INTO results (task_id, output, start_time, end_time) VALUES (?, ?, ?, ?)").run("task1", "backup done", "2026-03-14T00:00:00Z", "2026-03-14T00:01:00Z");
      cdb.close();

      const results = searchEpisodes("backup", { source: "tasks" });
      expect(results.every((r) => r.type === "task_result")).toBe(true);
    });

    it("time_range.after filters old results", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run("conv1", "user", "old deployment message", "2025-01-01T00:00:00Z");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run("conv1", "user", "new deployment message", "2026-03-14T00:00:00Z");
      sdb.close();

      const results = searchEpisodes("deployment", {
        time_range: { after: "2026-01-01T00:00:00Z" },
      });
      expect(results.length).toBe(1);
      expect((results[0] as { created_at: string }).created_at).toBe("2026-03-14T00:00:00Z");
    });

    it("time_range.before filters future results", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run("conv1", "user", "early deployment", "2026-01-01T00:00:00Z");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run("conv1", "user", "later deployment", "2026-06-01T00:00:00Z");
      sdb.close();

      const results = searchEpisodes("deployment", {
        time_range: { before: "2026-03-01T00:00:00Z" },
      });
      expect(results.length).toBe(1);
      expect((results[0] as { created_at: string }).created_at).toBe("2026-01-01T00:00:00Z");
    });

    it("respects limit parameter", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      for (let i = 0; i < 10; i++) {
        sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", `testing message number ${i}`);
      }
      sdb.close();

      const results = searchEpisodes("testing", { limit: 3 });
      expect(results.length).toBe(3);
    });

    it("returns snippets with matched terms highlighted", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", "The kubernetes cluster is running smoothly");
      sdb.close();

      const results = searchEpisodes("kubernetes");
      expect(results.length).toBe(1);
      // FTS5 snippet uses >>> <<< markers
      expect(results[0].snippet).toContain(">>>");
      expect(results[0].snippet).toContain("<<<");
    });

    it("sanitizes FTS5 special characters in query", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", "Hello world");
      sdb.close();

      // These should not crash the FTS5 engine
      expect(() => searchEpisodes("hello*")).not.toThrow();
      expect(() => searchEpisodes("hello AND world")).not.toThrow();
      expect(() => searchEpisodes('"exact phrase"')).not.toThrow();
      expect(() => searchEpisodes("hello OR world NOT bad")).not.toThrow();
    });

    it("handles Unicode/accented characters in queries without stripping them", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", "Déploiement réussi café");
      sdb.close();

      // Should not crash and should find the accented term
      expect(() => searchEpisodes("réussi")).not.toThrow();
      const results = searchEpisodes("réussi");
      expect(results.length).toBe(1);
      expect(results[0].snippet).toContain("réussi");
    });

    it("handles CJK (kanji) characters in queries without stripping them", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      // Space-separated so FTS5 unicode61 tokenizer creates individual tokens
      // (unsegmented Japanese text becomes one giant token, a known FTS5 limitation)
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", "データベース バックアップ 完了");
      sdb.close();

      expect(() => searchEpisodes("バックアップ")).not.toThrow();
      const results = searchEpisodes("バックアップ");
      expect(results.length).toBe(1);
      expect(results[0].snippet).toContain("バックアップ");
    });

    it("returns empty array when no matches", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", "Hello world");
      sdb.close();

      const results = searchEpisodes("zzzznonexistent");
      expect(results).toEqual([]);
    });
  });

  describe("getConversationContext", () => {
    it("returns messages in chronological order for a conversation", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider, title) VALUES (?, ?, ?)").run("conv1", "claude", "Test chat");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", "First");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "assistant", "Second");
      sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", "Third");
      sdb.close();

      const ctx = getConversationContext("conv1");
      expect(ctx.conversation_id).toBe("conv1");
      expect(ctx.title).toBe("Test chat");
      expect(ctx.provider).toBe("claude");
      expect(ctx.messages).toHaveLength(3);
      expect(ctx.messages.map((m) => m.content)).toEqual(["First", "Second", "Third"]);
    });

    it("includes conversation metadata (title, provider, timestamps)", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider, title, created_at) VALUES (?, ?, ?, ?)").run("conv1", "openai", "My chat", "2026-03-14T10:00:00Z");
      sdb.close();

      const ctx = getConversationContext("conv1");
      expect(ctx.title).toBe("My chat");
      expect(ctx.provider).toBe("openai");
      expect(ctx.created_at).toBe("2026-03-14T10:00:00Z");
    });

    it("respects limit (returns most recent N messages)", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      for (let i = 1; i <= 10; i++) {
        sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", `Message ${i}`);
      }
      sdb.close();

      const ctx = getConversationContext("conv1", { limit: 3 });
      expect(ctx.messages).toHaveLength(3);
      // Should be the last 3 messages
      expect(ctx.messages[0].content).toBe("Message 8");
      expect(ctx.messages[2].content).toBe("Message 10");
    });

    it("around_message_id centers the window around a specific message", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      for (let i = 1; i <= 20; i++) {
        sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run("conv1", "user", `Message ${i}`);
      }
      sdb.close();

      // Get messages around message id 10 (which has content "Message 10")
      const ctx = getConversationContext("conv1", { limit: 5, around_message_id: 10 });
      expect(ctx.messages.length).toBeGreaterThan(0);
      expect(ctx.messages.length).toBeLessThanOrEqual(5);
      // Should include the target message
      expect(ctx.messages.some((m) => m.id === 10)).toBe(true);
    });

    it("around_message_id works correctly with ID gaps from interleaved conversations", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv1", "claude");
      sdb.prepare("INSERT INTO conversations (id, provider) VALUES (?, ?)").run("conv2", "claude");
      // Interleave messages: conv1 gets odd IDs (1,3,5,7,9), conv2 gets even IDs (2,4,6,8,10)
      for (let i = 1; i <= 10; i++) {
        const convId = i % 2 === 1 ? "conv1" : "conv2";
        sdb.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)").run(convId, "user", `Msg ${i} in ${convId}`);
      }
      sdb.close();

      // conv1 has messages with IDs 1,3,5,7,9. Ask for window around ID 5 (3rd message in conv1).
      const ctx = getConversationContext("conv1", { limit: 3, around_message_id: 5 });
      expect(ctx.messages).toHaveLength(3);
      // Should center around the 3rd message (ID 5), so IDs 3,5,7
      const ids = ctx.messages.map((m) => m.id);
      expect(ids).toEqual([3, 5, 7]);
    });

    it("returns empty messages array for unknown conversation_id", () => {
      createSessionsDb().close();
      const ctx = getConversationContext("nonexistent");
      expect(ctx.conversation_id).toBe("nonexistent");
      expect(ctx.messages).toEqual([]);
      expect(ctx.title).toBeNull();
    });
  });

  describe("getTaskHistory", () => {
    it("returns task metadata + execution results", () => {
      const cdb = createCronDb();
      cdb.prepare("INSERT INTO tasks (id, name, description, type, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("task1", "Daily backup", "Backs up the database", "shell_command", "0 0 * * *", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      cdb.prepare("INSERT INTO results (task_id, output, exit_code, start_time, end_time, duration) VALUES (?, ?, ?, ?, ?, ?)").run("task1", "OK", 0, "2026-03-14T00:00:00Z", "2026-03-14T00:01:00Z", "1m0s");
      cdb.close();

      const history = getTaskHistory("task1");
      expect(history.task_id).toBe("task1");
      expect(history.task_name).toBe("Daily backup");
      expect(history.description).toBe("Backs up the database");
      expect(history.schedule).toBe("0 0 * * *");
      expect(history.results).toHaveLength(1);
      expect(history.results[0].exit_code).toBe(0);
      expect(history.results[0].output).toBe("OK");
    });

    it("results ordered by start_time DESC (most recent first)", () => {
      const cdb = createCronDb();
      cdb.prepare("INSERT INTO tasks (id, name, type, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("task1", "Backup", "shell_command", "0 0 * * *", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      cdb.prepare("INSERT INTO results (task_id, output, start_time, end_time) VALUES (?, ?, ?, ?)").run("task1", "First run", "2026-03-01T00:00:00Z", "2026-03-01T00:01:00Z");
      cdb.prepare("INSERT INTO results (task_id, output, start_time, end_time) VALUES (?, ?, ?, ?)").run("task1", "Second run", "2026-03-14T00:00:00Z", "2026-03-14T00:01:00Z");
      cdb.close();

      const history = getTaskHistory("task1");
      expect(history.results[0].output).toBe("Second run");
      expect(history.results[1].output).toBe("First run");
    });

    it("respects limit parameter", () => {
      const cdb = createCronDb();
      cdb.prepare("INSERT INTO tasks (id, name, type, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("task1", "Backup", "shell_command", "0 0 * * *", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      for (let i = 0; i < 10; i++) {
        cdb.prepare("INSERT INTO results (task_id, output, start_time, end_time) VALUES (?, ?, ?, ?)").run("task1", `Run ${i}`, `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`, `2026-03-${String(i + 1).padStart(2, "0")}T00:01:00Z`);
      }
      cdb.close();

      const history = getTaskHistory("task1", { limit: 3 });
      expect(history.results).toHaveLength(3);
    });

    it("returns empty results for unknown task_id", () => {
      createCronDb().close();
      const history = getTaskHistory("nonexistent");
      expect(history.task_id).toBe("nonexistent");
      expect(history.task_name).toBeNull();
      expect(history.results).toEqual([]);
    });
  });

  describe("listRecentEpisodes", () => {
    it("returns conversations and task results in reverse chronological order", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider, title, updated_at) VALUES (?, ?, ?, ?)").run("conv1", "claude", "Old chat", "2026-03-01T00:00:00Z");
      sdb.prepare("INSERT INTO conversations (id, provider, title, updated_at) VALUES (?, ?, ?, ?)").run("conv2", "claude", "New chat", "2026-03-14T00:00:00Z");
      sdb.close();

      const cdb = createCronDb();
      cdb.prepare("INSERT INTO tasks (id, name, type, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("task1", "Backup", "shell_command", "0 0 * * *", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      cdb.prepare("INSERT INTO results (task_id, output, start_time, end_time) VALUES (?, ?, ?, ?)").run("task1", "OK", "2026-03-10T00:00:00Z", "2026-03-10T00:01:00Z");
      cdb.close();

      const episodes = listRecentEpisodes();
      expect(episodes.length).toBe(3);
      // Most recent first
      expect(episodes[0].timestamp).toBe("2026-03-14T00:00:00Z");
    });

    it("source=conversations filters to conversations only", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider, title, updated_at) VALUES (?, ?, ?, ?)").run("conv1", "claude", "Chat", "2026-03-14T00:00:00Z");
      sdb.close();

      const cdb = createCronDb();
      cdb.prepare("INSERT INTO tasks (id, name, type, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("task1", "Backup", "shell_command", "0 0 * * *", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      cdb.prepare("INSERT INTO results (task_id, output, start_time, end_time) VALUES (?, ?, ?, ?)").run("task1", "OK", "2026-03-14T00:00:00Z", "2026-03-14T00:01:00Z");
      cdb.close();

      const episodes = listRecentEpisodes({ source: "conversations" });
      expect(episodes.every((e) => e.type === "conversation")).toBe(true);
    });

    it("source=tasks filters to task results only", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider, title, updated_at) VALUES (?, ?, ?, ?)").run("conv1", "claude", "Chat", "2026-03-14T00:00:00Z");
      sdb.close();

      const cdb = createCronDb();
      cdb.prepare("INSERT INTO tasks (id, name, type, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("task1", "Backup", "shell_command", "0 0 * * *", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      cdb.prepare("INSERT INTO results (task_id, output, start_time, end_time) VALUES (?, ?, ?, ?)").run("task1", "OK", "2026-03-14T00:00:00Z", "2026-03-14T00:01:00Z");
      cdb.close();

      const episodes = listRecentEpisodes({ source: "tasks" });
      expect(episodes.every((e) => e.type === "task_result")).toBe(true);
    });

    it("before parameter filters for pagination", () => {
      const sdb = createSessionsDb();
      sdb.prepare("INSERT INTO conversations (id, provider, title, updated_at) VALUES (?, ?, ?, ?)").run("conv1", "claude", "Old", "2026-01-01T00:00:00Z");
      sdb.prepare("INSERT INTO conversations (id, provider, title, updated_at) VALUES (?, ?, ?, ?)").run("conv2", "claude", "New", "2026-03-14T00:00:00Z");
      sdb.close();

      const episodes = listRecentEpisodes({ before: "2026-02-01T00:00:00Z" });
      expect(episodes).toHaveLength(1);
      expect(episodes[0].title).toBe("Old");
    });

    it("respects limit parameter", () => {
      const sdb = createSessionsDb();
      for (let i = 0; i < 10; i++) {
        sdb.prepare("INSERT INTO conversations (id, provider, title, updated_at) VALUES (?, ?, ?, ?)").run(`conv${i}`, "claude", `Chat ${i}`, `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`);
      }
      sdb.close();

      const episodes = listRecentEpisodes({ limit: 3 });
      expect(episodes).toHaveLength(3);
    });
  });
});
