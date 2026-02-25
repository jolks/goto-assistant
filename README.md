<p align="center">
  <img src="public/logo.svg" alt="goto-assistant" width="200">
</p>

# goto-assistant

Lightweight, self-hosted AI assistant with first-class MCP support. Supports Claude and OpenAI, with web and WhatsApp interfaces.

## Quick Start

```bash
npx goto-assistant
```

Open http://localhost:3000 — first run redirects to setup page for API key config.

### Requirements
- [Node.js](https://nodejs.org/) 20.11 or later — `npx` runs the app and most MCP servers
- [uv](https://docs.astral.sh/uv/) — `uvx` runs the time MCP server (Python-based)
- Anthropic or OpenAI API key

### Data Storage
All data (config, conversations, uploads) stored in `~/.goto-assistant/`.
Custom location: `GOTO_DATA_DIR=/path/to/data npx goto-assistant`

### Custom Port
```bash
PORT=3001 npx goto-assistant
```

## Why goto-assistant?

One command, no Docker, no framework — just MCP. Chat from the web or WhatsApp.

```
        You
         │
    chat / ask
         │
         ▼
   ┌───────────┐
   │    AI     │
   │ Assistant │
   └──┬──┬──┬──┘
      │  │  │  │
      │  │  │  └── create / update / run /  ──▶ ┌───────┐
      │  │  │      schedule / get results       │ Cron  │──── ┐
      │  │  └───── read / write ────────────▶ ┌─┴───────┴┐    │
      │  │                                    │  Files    │   │ AI tasks
      │  └──────── remember / recall ───────▶ ┌┴──────────┴┐  │ w/ MCP
      │                                       │  Memory    │◀─┘ access
      │                                       ├────────────┤
      └────────── do anything ──────────────▶ │  + your    │
                                              │ MCP servers│
                                              └────────────┘
```

That one `npx` command gives you an AI assistant that can remember across conversations, manage your files, and run tasks on a schedule or on-demand — all through the standard [MCP protocol](https://modelcontextprotocol.io). Add any MCP server to extend it further.

## See it in action

### Setup

<table>
<tr>
<td width="50%">

**First run — provider, API key & WhatsApp**

<video src="https://github.com/user-attachments/assets/2e1a0e5e-bd27-4cfc-abc1-acd1d9ac91ed" width="100%"></video>

Run `npx goto-assistant`, pick your AI provider, paste your API key, and connect WhatsApp by scanning the QR code — done.

</td>
<td width="50%">

**Adding an MCP server**

<video src="https://github.com/user-attachments/assets/393ed73f-1a0c-4dfe-bac8-2570ea3ac498" width="100%"></video>

Add MCP servers through the setup wizard. The assistant verifies each server before save (trimmed for brevity — verification may take up to minutes for security purposes).

</td>
</tr>
</table>

### Tasks

<table>
<tr>
<td width="50%">

**Create a task**

<video src="https://github.com/user-attachments/assets/249eab2c-250d-4f96-98b3-2bb78640efa9" width="100%"></video>

Ask the assistant to create an on-demand task.

</td>
<td width="50%">

**Update a task**

<video src="https://github.com/user-attachments/assets/960345c7-b314-4c88-b0e6-cb68e53a1e7b" width="100%"></video>

Modify task prompts, commands, or settings through chat.

</td>
</tr>
<tr>
<td width="50%">

**Run a task & compare results**

<video src="https://github.com/user-attachments/assets/b5202cbb-3e4c-4284-9ec9-46941cbf7c19" width="100%"></video>

Run tasks on demand and compare results across runs.

</td>
<td width="50%">

**Schedule a task**

<video src="https://github.com/user-attachments/assets/de8b34d7-7141-4552-b986-565f871b9859" width="100%"></video>

Schedule tasks to run periodically using natural language.

</td>
</tr>
<tr>
<td width="50%">

**Chat & manage tasks on WhatsApp**

<video src="https://github.com/user-attachments/assets/33a6bf28-2a57-426a-8002-b022178aa0d8" width="100%"></video>

Chat with the AI assistant and manage tasks from WhatsApp — the same assistant, on the go.

</td>
<td width="50%">
</td>
</tr>
</table>

## Data Privacy

goto-assistant connects directly to AI providers using your own API keys. Both Anthropic and OpenAI have clear policies that API data is **not used for model training** by default:

**Anthropic** ([Commercial Terms](https://www.anthropic.com/legal/commercial-terms); [Privacy Center](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training)):

> "Anthropic may not train models on Customer Content from Services."

> "By default, we will not use your inputs or outputs from our commercial products to train our models."

**OpenAI** ([Platform Data Controls](https://platform.openai.com/docs/guides/your-data); [Enterprise Privacy](https://openai.com/enterprise-privacy/)):

> "Data sent to the OpenAI API is not used to train or improve OpenAI models (unless you explicitly opt in to share data with us)."

> "We do not train our models on your data by default."

Your conversations and data stay between you and the provider's API. All local data is stored on your machine:

- **goto-assistant**: conversations, config, uploads, and WhatsApp auth in `~/.goto-assistant/`
- **mcp-cron**: tasks and results in `~/.mcp-cron/`

## WhatsApp Integration

Chat with the assistant directly from WhatsApp — no extra apps, no Docker, no webhooks needed.

Uses [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web multi-device protocol) running in-process. Enable it in the setup wizard or toggle it on the setup page, scan the QR code once, and you're connected. Auth persists across restarts.

Messages go through the same AI pipeline as the web chat. The agent only responds in your self-chat ("Message yourself") — it never replies to other people messaging your number.

## Architecture

Browser and WhatsApp clients connect to `server.ts` (WebSocket + REST), which routes messages through `router.ts` to the Claude or OpenAI agent SDK. Agents access MCP servers (memory, filesystem, cron, messaging, etc.) for extended capabilities. Messaging flows through a channel registry — the `mcp-messaging` MCP server proxies tool calls to `POST /api/messaging/send`, which routes to the appropriate channel (WhatsApp, etc.).

See [docs/architecture.md](docs/architecture.md) for the full architecture diagram.

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

4. Lint and test:
   ```bash
   pnpm lint
   pnpm test
   ```

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
| **time** | [`mcp-server-time`](https://github.com/modelcontextprotocol/servers/tree/main/src/time) | Current time and timezone conversions |
| **cron** | [`mcp-cron`](https://github.com/jolks/mcp-cron) | Schedule or run on-demand shell commands and AI prompts with access to MCP servers |
| **messaging** | built-in | Send messages via connected platforms (WhatsApp, more coming) |

Add your own through the setup page — either via the form or by asking the setup wizard AI chat — or by editing `data/mcp.json` directly. Any MCP server that supports stdio transport will work — browse the [MCP server directory](https://github.com/modelcontextprotocol/servers) for more.