# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

goto-assistant is a self-hosted personal AI assistant with a web-based chat interface. It supports both Claude (Anthropic) and OpenAI as providers, with MCP (Model Context Protocol) server integration for extended capabilities like memory, filesystem access, and scheduled tasks.

## Commands

```bash
# Quick start (end users)
npx goto-assistant

# Development (runs TypeScript directly via tsx)
pnpm dev

# Build (TypeScript compilation to dist/)
pnpm build

# Production
pnpm start

# Lint
pnpm lint              # run ESLint

# Tests
pnpm test              # run all tests once
pnpm test:watch        # run tests in watch mode
npx vitest run tests/config.test.ts   # run a single test file

# Packaging
npm pack --dry-run     # verify tarball contents
npm publish            # publish to npm

# Release — just push a tag; CI does the rest
git tag v<version> && git push origin v<version>
# Release workflow: sets version from tag, builds, tests, publishes to npm, creates GitHub release
# Do NOT manually edit version in package.json — it stays at 0.0.0 and is set dynamically by CI
```

## Architecture

**Backend** (`src/`): Express 5 server with WebSocket streaming. No bundler — TypeScript compiles via `tsc`, frontend is vanilla HTML/CSS/JS served statically from `public/`.

**Entry point**: `src/index.ts` — starts Express app, redirects to setup page on first run. `bin/goto-assistant.js` is the npx entry point — sets `GOTO_DATA_DIR` to `~/.goto-assistant` before importing `dist/index.js`.

**Provider abstraction**:
- `src/agents/router.ts` — dispatches to Claude or OpenAI based on config
- `src/agents/claude.ts` — uses `@anthropic-ai/claude-agent-sdk`, supports session resumption
- `src/agents/openai.ts` — uses `@openai/agents`, manages MCP server lifecycle

**Built-in tools** (critical provider difference):
- **Claude**: The Agent SDK provides built-in tools (Bash, Read, Write, Edit, Glob, Grep, etc.) automatically. With `permissionMode: "bypassPermissions"`, the agent can execute shell commands and file operations out of the box. `allowedTools` is set to MCP tool patterns only, but built-in tools remain available.
- **OpenAI**: The Agents SDK has equivalent local built-in tools — `shellTool()` (Bash equivalent), `applyPatchTool()` (Edit/Write equivalent), `computerTool()` (screen automation) — but they require explicit setup. `shellTool()` in local mode needs a custom `Shell` implementation that handles `child_process.exec()`. There are also hosted tools (`webSearchTool()`, `fileSearchTool()`, `codeInterpreterTool()`, `imageGenerationTool()`) that run on OpenAI's servers. Currently configured: `shellTool()` with a `LocalShell` class that executes commands via `child_process.exec()` (30s timeout, 1MB buffer). Not yet configured: `applyPatchTool()`, `computerTool()`.

**Conversation history** (critical provider difference):
- **Claude**: Uses SDK session resumption (`options.resume = sessionId`). The SDK maintains history server-side — we only pass the new message each turn.
- **OpenAI**: Stateless — has no session resumption. We must load the full message history from SQLite and pass it as the input array on every turn. See `runOpenAI()` which builds `inputMessages` from `history` parameter. Assistant messages must use `content: [{ type: "output_text", text }]` format (not plain strings) or the SDK throws `item.content.map is not a function`.
- When adding new per-message features (attachments, metadata, etc.), ensure both history paths are updated.

**Agent turn limits**: Both providers use `MAX_AGENT_TURNS` (defined in `src/config.ts`, currently 30) to cap tool-use loop iterations. When the limit is hit, a user-friendly message is sent via `onChunk` and the conversation ends gracefully. Claude returns an `error_max_turns` result event; OpenAI throws `MaxTurnsExceededError` (caught in `runOpenAI`).

**Image attachments** (critical provider difference):
- **OpenAI**: Images are passed inline as base64 `input_image` content blocks in the message array. History messages with attachments get their image data re-read from `data/uploads/` via `getUpload()`.
- **Claude**: The Agent SDK's `query()` only accepts a plain string prompt — passing structured content (e.g. AsyncIterable) crashes the subprocess. Instead, image file paths are appended to the prompt text, and Claude reads them via the filesystem MCP server's `read_media_file` tool. This means the filesystem MCP server must be configured for image upload to work with Claude.

**Data flow**: Browser → WebSocket → `server.ts` → `router.ts` → provider agent → streamed response chunks back via WebSocket. The setup chat sends `setupMode: true` which injects `SETUP_SYSTEM_PROMPT` (defined in `src/prompts.ts`) as a `systemPromptOverride`, threaded through `routeMessage` → `runClaude`/`runOpenAI`. This prompt instructs the AI about config file structure and cron sync rules.

**Persistence**: `src/sessions.ts` — SQLite (better-sqlite3, WAL mode) stores conversation metadata and messages in `data/sessions.db`. Claude uses `sdk_session_id` for resumption; OpenAI replays history from the messages table. Setup chat conversations are stored with `setup = 1` and filtered from `listConversations()` so they don't appear in the sidebar.

**Uploads**: `src/uploads.ts` — images stored in `data/uploads/{uuid}/{filename}`. Message content with attachments is stored as JSON in the messages table (`parseMessageContent()` handles both plain text and JSON formats).

**Configuration**: `src/config.ts` — app config stored in `data/config.json`, MCP server config stored separately in `data/mcp.json`. `mcp.json` is the single source of truth for MCP servers — edited directly by users, read by mcp-cron and the app. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) override file config. API keys are masked in API responses. `PORT` env var overrides configured port. `GOTO_DATA_DIR` env var overrides the data directory (default `./data` for dev, `~/.goto-assistant` via npx).

**Frontend** (`public/`): Vanilla JS, no framework. Uses [Pico CSS v2](https://picocss.com/) via CDN for classless styling, automatic dark/light mode (via `prefers-color-scheme`), and responsive design. `style.css` overrides Pico where needed (chat layout resets Pico's form element margins/widths, utility buttons reset Pico's button styling). Custom CSS variables `--chat-user-bg` and `--chat-active-bg` handle tinted blue backgrounds. `index.html` is the chat UI, `setup.html` is the config wizard with a side-by-side chat panel (form on the left, setup assistant chat on the right; on mobile the chat is a full-screen overlay toggled via an inline button). `setup.js` contains extracted setup page functions (provider switching, server rendering, cron config sync). `chat-core.js` provides shared chat DOM primitives (message rendering, typing indicators) and `chatCreateWs()` — the shared WebSocket factory with auto-reconnect and stale-WS guards, used by all three chat surfaces. New chat surfaces must use `chatCreateWs()` for WebSocket management. `setup-chat.js` implements the chat panel: a Q&A state machine for initial setup (provider → api_key → base_url → model → whatsapp → save) and an AI chat mode for modifying MCP servers or changing providers. The WhatsApp step offers to enable the integration and, if accepted, triggers the Baileys connection and displays the QR code inline in the chat for scanning. `cron-sync.js` derives mcp-cron args/env from provider settings. All four JS files use CJS `module.exports` guards for test imports while remaining plain `<script>` tags in the browser.

**Task dashboard** (`public/task-chat.js`, task sections in `index.html`): Sidebar "Tasks" tab lists mcp-cron tasks; clicking one opens a detail view with metadata, prompt/command, results, and an inline AI chat panel. Tasks can be run, enabled/disabled, and deleted via action buttons. `runTask()` uses fire-and-forget polling with a pending result queue: when a run completes while the user is viewing a different task, the result is queued in `taskRunState[taskId].pendingResult` and delivered when the user navigates back. There is only one shared `runBtn` DOM element — `renderTaskDetail()` always resets it to the correct state (idle/spinning) for the currently viewed task, so the pending path intentionally does not touch the button. Task API endpoints in `server.ts` proxy to mcp-cron via `callCronTool()` (defined in `src/cron.ts`); `GET /api/tasks` returns `[]` when cron is not running. When the user saves setup config (`POST /api/setup`) or the AI chat modifies MCP config (`POST /api/reload`), `reloadServices()` calls `restartCronServer()` which fingerprints the cron config and skips restart if unchanged, otherwise stops the old mcp-cron instance and starts a fresh one with updated args (e.g. new provider/model). `killProc()` sends SIGTERM to the npx process; the broken stdin pipe causes mcp-cron to exit on EOF.

**WhatsApp integration** (`src/whatsapp.ts`): Optional WhatsApp client using [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web multi-device protocol). Runs in-process — no Docker or external services needed. Auth state persisted in `data/whatsapp-auth/` via Baileys' `useMultiFileAuthState`, so QR scan is only needed once. Off by default (`whatsapp.enabled = false` in config); enabled via setup page toggle or Q&A wizard. **Self-chat only** — the agent only responds to messages in the user's own self-chat (WhatsApp's "Message yourself"), never to other people messaging the user's number. This prevents unintended AI replies to contacts. Loop prevention uses a `sentMessageIds` set to skip agent-sent messages. Messages are processed through the same `routeMessage()` pipeline as web chat. Key design: per-chatId queue (`Map<string, Promise>` chain) serializes message processing to avoid Claude session resumption conflicts; responses are buffered (not streamed) and split at ~65K chars for WhatsApp's message limit. Conversations are mapped via `channel_id` column on the conversations table (NULL for web, WhatsApp remoteJid for WA). API endpoints: `GET /api/whatsapp/status`, `GET /api/whatsapp/qr`, `POST /api/whatsapp/connect`, `POST /api/whatsapp/disconnect`.

## Key Patterns

- ES modules throughout (`"type": "module"`, `NodeNext` module resolution)
- Strict TypeScript enabled
- Tests use Vitest with `vi.mock()` to avoid real API calls; frontend tests use `// @vitest-environment jsdom` per-file directive
- `data/` directory is gitignored — holds runtime state (config, SQLite DB)
- MCP servers live in `data/mcp.json` (not `config.json`) and are passed as a separate parameter to agent functions
