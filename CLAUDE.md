# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

goto-assistant is a self-hosted personal AI assistant with a web-based chat interface. It supports both Claude (Anthropic) and OpenAI as providers, with MCP (Model Context Protocol) server integration for extended capabilities like memory, filesystem access, and scheduled tasks.

## Commands

```bash
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
```

## Architecture

**Backend** (`src/`): Express 5 server with WebSocket streaming. No bundler — TypeScript compiles via `tsc`, frontend is vanilla HTML/CSS/JS served statically from `public/`.

**Entry point**: `src/index.ts` — starts Express app, redirects to setup page on first run.

**Provider abstraction**:
- `src/agents/router.ts` — dispatches to Claude or OpenAI based on config
- `src/agents/claude.ts` — uses `@anthropic-ai/claude-agent-sdk`, supports session resumption
- `src/agents/openai.ts` — uses `@openai/agents`, manages MCP server lifecycle

**Data flow**: Browser → WebSocket → `server.ts` → `router.ts` → provider agent → streamed response chunks back via WebSocket.

**Persistence**: `src/sessions.ts` — SQLite (better-sqlite3, WAL mode) stores conversation metadata in `data/sessions.db`. The AI SDKs handle actual conversation history; the database tracks session IDs for resumption.

**Configuration**: `src/config.ts` — stored in `data/config.json`. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) override file config. API keys are masked in API responses.

**Frontend** (`public/`): Vanilla JS, no framework. `index.html` is the chat UI, `setup.html` is the first-run config wizard. `cron-sync.js` syncs MCP cron server config with provider settings.

## Key Patterns

- ES modules throughout (`"type": "module"`, `NodeNext` module resolution)
- Strict TypeScript enabled
- Tests use Vitest with `vi.mock()` to avoid real API calls
- `data/` directory is gitignored — holds runtime state (config, SQLite DB)
- MCP servers are configured per-provider and passed environment variables for API keys
