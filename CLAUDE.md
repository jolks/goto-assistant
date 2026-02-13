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

# Tests
pnpm test              # run all tests once
pnpm test:watch        # run tests in watch mode
npx vitest run tests/config.test.ts   # run a single test file

# Packaging
npm pack --dry-run     # verify tarball contents
npm publish            # publish to npm
```

## Architecture

**Backend** (`src/`): Express 5 server with WebSocket streaming. No bundler — TypeScript compiles via `tsc`, frontend is vanilla HTML/CSS/JS served statically from `public/`.

**Entry point**: `src/index.ts` — starts Express app, redirects to setup page on first run. `bin/goto-assistant.js` is the npx entry point — sets `GOTO_DATA_DIR` to `~/.goto-assistant` before importing `dist/index.js`.

**Provider abstraction**:
- `src/agents/router.ts` — dispatches to Claude or OpenAI based on config
- `src/agents/claude.ts` — uses `@anthropic-ai/claude-agent-sdk`, supports session resumption
- `src/agents/openai.ts` — uses `@openai/agents`, manages MCP server lifecycle

**Conversation history** (critical provider difference):
- **Claude**: Uses SDK session resumption (`options.resume = sessionId`). The SDK maintains history server-side — we only pass the new message each turn.
- **OpenAI**: Stateless — has no session resumption. We must load the full message history from SQLite and pass it as the input array on every turn. See `runOpenAI()` which builds `inputMessages` from `history` parameter. Assistant messages must use `content: [{ type: "output_text", text }]` format (not plain strings) or the SDK throws `item.content.map is not a function`.
- When adding new per-message features (attachments, metadata, etc.), ensure both history paths are updated.

**Image attachments** (critical provider difference):
- **OpenAI**: Images are passed inline as base64 `input_image` content blocks in the message array. History messages with attachments get their image data re-read from `data/uploads/` via `getUpload()`.
- **Claude**: The Agent SDK's `query()` only accepts a plain string prompt — passing structured content (e.g. AsyncIterable) crashes the subprocess. Instead, image file paths are appended to the prompt text, and Claude reads them via the filesystem MCP server's `read_media_file` tool. This means the filesystem MCP server must be configured for image upload to work with Claude.

**Data flow**: Browser → WebSocket → `server.ts` → `router.ts` → provider agent → streamed response chunks back via WebSocket.

**Persistence**: `src/sessions.ts` — SQLite (better-sqlite3, WAL mode) stores conversation metadata and messages in `data/sessions.db`. Claude uses `sdk_session_id` for resumption; OpenAI replays history from the messages table.

**Uploads**: `src/uploads.ts` — images stored in `data/uploads/{uuid}/{filename}`. Message content with attachments is stored as JSON in the messages table (`parseMessageContent()` handles both plain text and JSON formats).

**Configuration**: `src/config.ts` — app config stored in `data/config.json`, MCP server config stored separately in `data/mcp.json`. `mcp.json` is the single source of truth for MCP servers — edited directly by users, read by mcp-cron and the app. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) override file config. API keys are masked in API responses. `PORT` env var overrides configured port. `GOTO_DATA_DIR` env var overrides the data directory (default `./data` for dev, `~/.goto-assistant` via npx).

**Frontend** (`public/`): Vanilla JS, no framework. `index.html` is the chat UI, `setup.html` is the first-run config wizard. `cron-sync.js` syncs MCP cron server config with provider settings.

## Key Patterns

- ES modules throughout (`"type": "module"`, `NodeNext` module resolution)
- Strict TypeScript enabled
- Tests use Vitest with `vi.mock()` to avoid real API calls
- `data/` directory is gitignored — holds runtime state (config, SQLite DB)
- MCP servers live in `data/mcp.json` (not `config.json`) and are passed as a separate parameter to agent functions
