/**
 * Episodic memory: search and retrieve past conversations and task execution results.
 *
 * Opens sessions.db (goto-assistant) and results.db (mcp-cron) read-only.
 * Maintains a separate FTS5 index DB (episodic-index.db) that is a rebuildable index.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TimeRange {
  after?: string; // ISO 8601
  before?: string; // ISO 8601
}

export interface ConversationMessageResult {
  type: "conversation_message";
  conversation_id: string;
  conversation_title: string | null;
  message_id: number;
  role: string;
  snippet: string;
  created_at: string;
}

export interface TaskResultResult {
  type: "task_result";
  task_id: string;
  task_name: string;
  result_id: number;
  snippet: string;
  start_time: string;
  exit_code: number;
}

export type EpisodeResult = ConversationMessageResult | TaskResultResult;

export interface ConversationContext {
  conversation_id: string;
  title: string | null;
  provider: string | null;
  created_at: string | null;
  messages: Array<{
    id: number;
    role: string;
    content: string;
    created_at: string;
  }>;
}

export interface TaskHistory {
  task_id: string;
  task_name: string | null;
  description: string | null;
  schedule: string | null;
  results: Array<{
    id: number;
    output: string;
    error: string;
    exit_code: number;
    start_time: string;
    end_time: string;
    duration: string;
  }>;
}

export interface RecentEpisode {
  type: "conversation" | "task_result";
  id: string;
  title: string | null;
  timestamp: string;
  preview: string;
}

// ── Paths ──────────────────────────────────────────────────────────────────

const dataDir = process.env.GOTO_DATA_DIR || "";
const sessionsDbPath = dataDir ? path.join(dataDir, "sessions.db") : "";
const cronDbPath = process.env.MCP_CRON_DB_PATH || "";
const indexDbPath = dataDir ? path.join(dataDir, "episodic-index.db") : "";

// ── DB helpers ─────────────────────────────────────────────────────────────

function openReadOnly(dbPath: string): Database.Database | null {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

let indexDb: Database.Database | null = null;

function getIndexDb(): Database.Database {
  if (indexDb) return indexDb;
  if (!dataDir) throw new Error("GOTO_DATA_DIR is not set");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  indexDb = new Database(indexDbPath);
  indexDb.pragma("journal_mode = WAL");
  indexDb.exec(`
    CREATE TABLE IF NOT EXISTS index_state (
      source TEXT PRIMARY KEY,
      last_indexed_id INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      conversation_id UNINDEXED,
      message_id UNINDEXED,
      role UNINDEXED,
      conversation_title UNINDEXED,
      created_at UNINDEXED,
      tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS results_fts USING fts5(
      content,
      task_id UNINDEXED,
      result_id UNINDEXED,
      task_name UNINDEXED,
      start_time UNINDEXED,
      exit_code UNINDEXED,
      tokenize='porter unicode61'
    );
  `);
  return indexDb;
}

export function closeIndexDb(): void {
  if (indexDb) {
    indexDb.close();
    indexDb = null;
  }
}

// ── Content parsing (duplicated from sessions.ts to avoid import) ──────────

function parseMessageContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.text === "string") {
      return parsed.text;
    }
  } catch {
    // Not JSON — plain text
  }
  return content;
}

// ── FTS5 query sanitization (same approach as mcp-broker) ──────────────────

const FTS5_KEYWORDS = new Set(["AND", "OR", "NOT", "NEAR"]);

function sanitizeQuery(query: string): string {
  // Strip FTS5 special characters, convert words to prefix searches
  const cleaned = query.replace(/[^a-zA-Z0-9\s]/g, "").trim();
  if (!cleaned) return '""'; // empty query matches nothing
  return cleaned
    .split(/\s+/)
    .filter((w) => w && !FTS5_KEYWORDS.has(w.toUpperCase()))
    .map((w) => `"${w}"*`)
    .join(" ");
}

// ── Index management ───────────────────────────────────────────────────────

export function ensureIndex(): void {
  const idx = getIndexDb();

  // Index sessions.db messages
  const sessionsDb = openReadOnly(sessionsDbPath);
  if (sessionsDb) {
    try {
      const stateRow = idx
        .prepare("SELECT last_indexed_id FROM index_state WHERE source = 'sessions'")
        .get() as { last_indexed_id: number } | undefined;
      const lastId = stateRow?.last_indexed_id ?? 0;

      const rows = sessionsDb
        .prepare(`
          SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title
          FROM messages m
          LEFT JOIN conversations c ON m.conversation_id = c.id
          WHERE m.id > ?
          ORDER BY m.id ASC
        `)
        .all(lastId) as Array<{
        id: number;
        conversation_id: string;
        role: string;
        content: string;
        created_at: string;
        title: string | null;
      }>;

      if (rows.length > 0) {
        const insert = idx.prepare(`
          INSERT INTO messages_fts (content, conversation_id, message_id, role, conversation_title, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        const tx = idx.transaction(() => {
          for (const row of rows) {
            const text = parseMessageContent(row.content);
            insert.run(text, row.conversation_id, row.id, row.role, row.title, row.created_at);
          }
        });
        tx();

        const maxId = rows[rows.length - 1].id;
        idx
          .prepare(
            `INSERT INTO index_state (source, last_indexed_id, updated_at)
             VALUES ('sessions', ?, datetime('now'))
             ON CONFLICT(source) DO UPDATE SET last_indexed_id = ?, updated_at = datetime('now')`
          )
          .run(maxId, maxId);
      }
    } finally {
      sessionsDb.close();
    }
  }

  // Index cron results.db
  const cronDb = openReadOnly(cronDbPath);
  if (cronDb) {
    try {
      const stateRow = idx
        .prepare("SELECT last_indexed_id FROM index_state WHERE source = 'cron'")
        .get() as { last_indexed_id: number } | undefined;
      const lastId = stateRow?.last_indexed_id ?? 0;

      // Check if tasks table exists (it may not in early versions)
      const tablesExist = cronDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
        .get();

      const rows = cronDb
        .prepare(`
          SELECT r.id, r.task_id, r.output, r.error, r.start_time, r.exit_code,
                 r.prompt${tablesExist ? ", t.name AS task_name, t.description" : ""}
          FROM results r
          ${tablesExist ? "LEFT JOIN tasks t ON r.task_id = t.id" : ""}
          WHERE r.id > ?
          ORDER BY r.id ASC
        `)
        .all(lastId) as Array<{
        id: number;
        task_id: string;
        output: string;
        error: string;
        start_time: string;
        exit_code: number;
        prompt: string;
        task_name?: string;
        description?: string;
      }>;

      if (rows.length > 0) {
        const insert = idx.prepare(`
          INSERT INTO results_fts (content, task_id, result_id, task_name, start_time, exit_code)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        const tx = idx.transaction(() => {
          for (const row of rows) {
            // Combine task name, description, output, error, and prompt for searchability
            const parts = [
              row.task_name || "",
              row.description || "",
              row.output || "",
              row.error || "",
              row.prompt || "",
            ].filter(Boolean);
            const content = parts.join(" ");
            insert.run(content, row.task_id, row.id, row.task_name || "", row.start_time, row.exit_code);
          }
        });
        tx();

        const maxId = rows[rows.length - 1].id;
        idx
          .prepare(
            `INSERT INTO index_state (source, last_indexed_id, updated_at)
             VALUES ('cron', ?, datetime('now'))
             ON CONFLICT(source) DO UPDATE SET last_indexed_id = ?, updated_at = datetime('now')`
          )
          .run(maxId, maxId);
      }
    } finally {
      cronDb.close();
    }
  }
}

// ── Search ─────────────────────────────────────────────────────────────────

export function searchEpisodes(
  query: string,
  options?: {
    source?: "all" | "conversations" | "tasks";
    time_range?: TimeRange;
    limit?: number;
  }
): EpisodeResult[] {
  ensureIndex();
  const idx = getIndexDb();
  const source = options?.source ?? "all";
  const limit = options?.limit ?? 20;
  const ftsQuery = sanitizeQuery(query);
  const results: EpisodeResult[] = [];

  if (source === "all" || source === "conversations") {
    let sql = `
      SELECT snippet(messages_fts, 0, '>>>', '<<<', '...', 40) AS snippet,
             conversation_id, message_id, role, conversation_title, created_at
      FROM messages_fts
      WHERE messages_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (options?.time_range?.after) {
      sql += " AND created_at > ?";
      params.push(options.time_range.after);
    }
    if (options?.time_range?.before) {
      sql += " AND created_at < ?";
      params.push(options.time_range.before);
    }

    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    const rows = idx.prepare(sql).all(...params) as Array<{
      snippet: string;
      conversation_id: string;
      message_id: number;
      role: string;
      conversation_title: string | null;
      created_at: string;
    }>;

    for (const row of rows) {
      results.push({
        type: "conversation_message",
        conversation_id: row.conversation_id,
        conversation_title: row.conversation_title,
        message_id: row.message_id,
        role: row.role,
        snippet: row.snippet,
        created_at: row.created_at,
      });
    }
  }

  if (source === "all" || source === "tasks") {
    let sql = `
      SELECT snippet(results_fts, 0, '>>>', '<<<', '...', 40) AS snippet,
             task_id, result_id, task_name, start_time, exit_code
      FROM results_fts
      WHERE results_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (options?.time_range?.after) {
      sql += " AND start_time > ?";
      params.push(options.time_range.after);
    }
    if (options?.time_range?.before) {
      sql += " AND start_time < ?";
      params.push(options.time_range.before);
    }

    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    const rows = idx.prepare(sql).all(...params) as Array<{
      snippet: string;
      task_id: string;
      result_id: number;
      task_name: string;
      start_time: string;
      exit_code: number;
    }>;

    for (const row of rows) {
      results.push({
        type: "task_result",
        task_id: row.task_id,
        task_name: row.task_name,
        result_id: row.result_id,
        snippet: row.snippet,
        start_time: row.start_time,
        exit_code: row.exit_code,
      });
    }
  }

  return results.slice(0, limit);
}

// ── Conversation context ───────────────────────────────────────────────────

export function getConversationContext(
  conversationId: string,
  options?: { limit?: number; around_message_id?: number }
): ConversationContext {
  const limit = options?.limit ?? 50;
  const sessionsDb = openReadOnly(sessionsDbPath);
  if (!sessionsDb) {
    return { conversation_id: conversationId, title: null, provider: null, created_at: null, messages: [] };
  }

  try {
    const conv = sessionsDb
      .prepare("SELECT title, provider, created_at FROM conversations WHERE id = ?")
      .get(conversationId) as { title: string | null; provider: string; created_at: string } | undefined;

    let messages: Array<{ id: number; role: string; content: string; created_at: string }>;

    if (options?.around_message_id) {
      // Get a window around the specified message
      const half = Math.floor(limit / 2);
      messages = sessionsDb
        .prepare(
          `SELECT id, role, content, created_at FROM messages
           WHERE conversation_id = ? AND id >= (? - ?) AND id <= (? + ?)
           ORDER BY id ASC
           LIMIT ?`
        )
        .all(
          conversationId,
          options.around_message_id, half,
          options.around_message_id, half,
          limit
        ) as typeof messages;
    } else {
      // Get the most recent N messages
      messages = sessionsDb
        .prepare(
          `SELECT id, role, content, created_at FROM (
             SELECT id, role, content, created_at FROM messages
             WHERE conversation_id = ?
             ORDER BY id DESC
             LIMIT ?
           ) sub ORDER BY id ASC`
        )
        .all(conversationId, limit) as typeof messages;
    }

    // Parse JSON content to extract text
    for (const msg of messages) {
      msg.content = parseMessageContent(msg.content);
    }

    return {
      conversation_id: conversationId,
      title: conv?.title ?? null,
      provider: conv?.provider ?? null,
      created_at: conv?.created_at ?? null,
      messages,
    };
  } finally {
    sessionsDb.close();
  }
}

// ── Task history ───────────────────────────────────────────────────────────

export function getTaskHistory(
  taskId: string,
  options?: { limit?: number }
): TaskHistory {
  const limit = options?.limit ?? 10;
  const cronDb = openReadOnly(cronDbPath);
  if (!cronDb) {
    return { task_id: taskId, task_name: null, description: null, schedule: null, results: [] };
  }

  try {
    // Check if tasks table exists
    const tasksExist = cronDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
      .get();

    let taskMeta: { name: string; description: string; schedule: string } | undefined;
    if (tasksExist) {
      taskMeta = cronDb
        .prepare("SELECT name, description, schedule FROM tasks WHERE id = ?")
        .get(taskId) as typeof taskMeta;
    }

    const results = cronDb
      .prepare(
        `SELECT id, output, error, exit_code, start_time, end_time, duration
         FROM results
         WHERE task_id = ?
         ORDER BY start_time DESC
         LIMIT ?`
      )
      .all(taskId, limit) as Array<{
      id: number;
      output: string;
      error: string;
      exit_code: number;
      start_time: string;
      end_time: string;
      duration: string;
    }>;

    return {
      task_id: taskId,
      task_name: taskMeta?.name ?? null,
      description: taskMeta?.description ?? null,
      schedule: taskMeta?.schedule ?? null,
      results,
    };
  } finally {
    cronDb.close();
  }
}

// ── Recent episodes ────────────────────────────────────────────────────────

export function listRecentEpisodes(options?: {
  source?: "all" | "conversations" | "tasks";
  limit?: number;
  before?: string; // ISO 8601 for pagination
}): RecentEpisode[] {
  const source = options?.source ?? "all";
  const limit = options?.limit ?? 20;
  const episodes: RecentEpisode[] = [];

  if (source === "all" || source === "conversations") {
    const sessionsDb = openReadOnly(sessionsDbPath);
    if (sessionsDb) {
      try {
        let sql = `
          SELECT c.id, c.title, c.updated_at AS timestamp,
                 (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message
          FROM conversations c
          WHERE c.mode = 0
        `;
        const params: (string | number)[] = [];

        if (options?.before) {
          sql += " AND c.updated_at < ?";
          params.push(options.before);
        }

        sql += " ORDER BY c.updated_at DESC LIMIT ?";
        params.push(limit);

        const rows = sessionsDb.prepare(sql).all(...params) as Array<{
          id: string;
          title: string | null;
          timestamp: string;
          last_message: string | null;
        }>;

        for (const row of rows) {
          const preview = row.last_message ? parseMessageContent(row.last_message) : "";
          episodes.push({
            type: "conversation",
            id: row.id,
            title: row.title,
            timestamp: row.timestamp,
            preview: preview.length > 200 ? preview.slice(0, 200) + "..." : preview,
          });
        }
      } finally {
        sessionsDb.close();
      }
    }
  }

  if (source === "all" || source === "tasks") {
    const cronDb = openReadOnly(cronDbPath);
    if (cronDb) {
      try {
        // Check if tasks table exists
        const tasksExist = cronDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
          .get();

        let sql: string;
        if (tasksExist) {
          sql = `
            SELECT r.id, r.task_id, r.output, r.error, r.start_time, r.exit_code, t.name AS task_name
            FROM results r
            LEFT JOIN tasks t ON r.task_id = t.id
          `;
        } else {
          sql = `
            SELECT r.id, r.task_id, r.output, r.error, r.start_time, r.exit_code
            FROM results r
          `;
        }

        const params: (string | number)[] = [];

        if (options?.before) {
          sql += " WHERE r.start_time < ?";
          params.push(options.before);
        }

        sql += " ORDER BY r.start_time DESC LIMIT ?";
        params.push(limit);

        const rows = cronDb.prepare(sql).all(...params) as Array<{
          id: number;
          task_id: string;
          output: string;
          error: string;
          start_time: string;
          exit_code: number;
          task_name?: string;
        }>;

        for (const row of rows) {
          const preview = row.error || row.output || "";
          episodes.push({
            type: "task_result",
            id: row.task_id,
            title: row.task_name || null,
            timestamp: row.start_time,
            preview: preview.length > 200 ? preview.slice(0, 200) + "..." : preview,
          });
        }
      } finally {
        cronDb.close();
      }
    }
  }

  // Sort by timestamp descending and limit
  episodes.sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1));
  return episodes.slice(0, limit);
}
