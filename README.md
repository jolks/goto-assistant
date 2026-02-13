# goto-assistant

A self-hosted personal AI assistant with a web-based chat interface. Supports both Claude (Anthropic) and OpenAI as providers, with MCP server integration for extended capabilities.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│  ┌──────────────┐  ┌──────────────┐                     │
│  │  index.html   │  │  setup.html  │                     │
│  │  (Chat UI)    │  │  (Config)    │                     │
│  └──────┬───────┘  └──────┬───────┘                     │
│         │ WebSocket        │ HTTP POST                   │
└─────────┼──────────────────┼────────────────────────────┘
          │                  │
┌─────────┼──────────────────┼────────────────────────────┐
│  server.ts                 │                             │
│  ┌──────┴───────┐  ┌──────┴───────┐                     │
│  │  WebSocket    │  │  REST API    │                     │
│  │  Handler      │  │  /api/*      │                     │
│  └──────┬───────┘  └──────────────┘                     │
│         │                                                │
│  ┌──────┴───────┐                                        │
│  │  router.ts    │──── routes by provider                │
│  └──┬────────┬──┘                                        │
│     │        │                                           │
│  ┌──┴──┐  ┌──┴───┐     ┌────────────┐                   │
│  │Claude│  │OpenAI│────▶│ MCP Servers │                   │
│  │Agent │  │Agent │     │ (memory,    │                   │
│  │ SDK  │  │ SDK  │     │  fs, cron)  │                   │
│  └──┬──┘  └──┬───┘     └────────────┘                   │
│     │        │                                           │
│  ┌──┴────────┴──┐     ┌────────────┐                     │
│  │  sessions.ts  │────▶│  SQLite DB  │                    │
│  │  (persistence)│     │  data/      │                    │
│  └──────────────┘     └────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

## Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Start the development server:
   ```bash
   pnpm dev
   ```

3. Open `http://localhost:3000` — you'll be redirected to the setup page on first run to configure your AI provider and API key.

## Configuration

Configuration is stored in `data/config.json` (created on first setup). Environment variables override file config:

- `ANTHROPIC_API_KEY` — API key for Claude
- `OPENAI_API_KEY` — API key for OpenAI

## MCP Servers

The assistant supports MCP servers for extended capabilities. Configure them through the setup page or by editing the `mcpServers` section in `data/config.json`.

### Claude Code MCP servers

If you use [Claude Code](https://claude.ai/code), copy the example config to get MCP servers for development:

```bash
cp .mcp.json.example .mcp.json
```

Edit `.mcp.json` to set your preferred AI provider/model for the cron server. This file is gitignored since it contains personal preferences.

## Development

```bash
pnpm dev          # run with tsx (hot TypeScript execution)
pnpm build        # compile TypeScript to dist/
pnpm start        # run compiled build
pnpm test         # run tests
pnpm test:watch   # run tests in watch mode
```
