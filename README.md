# goto-assistant

Lightweight, self-hosted AI assistant with first-class MCP support. Supports both Claude (Anthropic) and OpenAI as providers, with a web-based chat interface.

## Quick Start

```bash
npx goto-assistant
```

Open http://localhost:3000 — first run redirects to setup page for API key config.

### Requirements
- Node.js 20.11 or later
- Anthropic or OpenAI API key

### Data Storage
All data (config, conversations, uploads) stored in `~/.goto-assistant/`.
Custom location: `GOTO_DATA_DIR=/path/to/data npx goto-assistant`

### Custom Port
```bash
PORT=3001 npx goto-assistant
```

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

## Development Setup

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

App configuration is stored in `data/config.json` (created on first setup). MCP server configuration is stored separately in `data/mcp.json`. Environment variables override file config:

- `ANTHROPIC_API_KEY` — API key for Claude
- `OPENAI_API_KEY` — API key for OpenAI

## MCP Servers

The assistant comes pre-configured with these MCP servers:

| Server | Package | Capabilities |
|--------|---------|-------------|
| **memory** | [`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | Persistent knowledge graph across conversations |
| **filesystem** | [`@modelcontextprotocol/server-filesystem`](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) | Read, write, and manage local files |
| **cron** | [`mcp-cron`](https://github.com/jolks/mcp-cron) | Schedule shell commands and AI prompts with access to MCP servers |

Add your own through the setup page or by editing `data/mcp.json` directly. Any MCP server that supports stdio transport will work — browse the [MCP server directory](https://github.com/modelcontextprotocol/servers) for more.

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
