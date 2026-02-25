# Architecture

```mermaid
flowchart TD
    subgraph Clients
        subgraph Browser
            index["index.html<br/>(Chat + Tasks Dashboard)"]
            setup["setup.html<br/>(Config Wizard)"]
        end
        whatsapp_client["WhatsApp<br/>(self-chat)"]
    end

    subgraph "server.ts"
        ws["WebSocket Handler"]
        rest["REST API /api/*"]
        wa["whatsapp.ts (Baileys)"]

        subgraph "messaging.ts — Channel Registry"
            ch_wa["whatsapp"]
            ch_future["future: telegram, signal, ..."]
        end

        messaging_api["/api/messaging/*"]

        router["router.ts"]

        subgraph providers ["routes by provider"]
            claude["Claude Agent SDK"]
            openai["OpenAI Agent SDK"]
        end

        sessions["sessions.ts"]
    end

    subgraph "MCP Servers"
        memory["memory"]
        filesystem["filesystem"]
        other_mcp["..."]
        cron["mcp-cron<br/>(AI tasks + shell commands)"]
        mcp_msg["mcp-messaging<br/>→ POST /api/messaging/*"]
    end

    db[("SQLite DB<br/>data/sessions.db")]

    index -- "WebSocket" --> ws
    setup -- "HTTP" --> rest
    whatsapp_client -- "WhatsApp servers<br/>(WebSocket)" --> wa

    ws --> router
    rest --> router
    wa --> router
    router --> claude & openai

    rest --> messaging_api
    messaging_api --> ch_wa
    ch_wa -- "sendWhatsAppMessage" --> wa

    claude --> memory & filesystem & other_mcp & cron & mcp_msg
    openai --> memory & filesystem & other_mcp & cron & mcp_msg
    cron --> memory & filesystem & other_mcp

    mcp_msg -- "proxies to" --> messaging_api

    sessions --> db
```

## Messaging Flow

When an AI agent (main chat or mcp-cron task) wants to send a message:

1. **Agent** calls `send_message` tool via the `mcp-messaging` MCP server (stdio)
2. **mcp-messaging** proxies the call to `POST /api/messaging/send` on localhost
3. **server.ts** validates the request and calls `sendMessage()` from the channel registry
4. **messaging.ts** looks up the channel (e.g. "whatsapp") and delegates to its `SendFn`
5. **whatsapp.ts** `sendWhatsAppMessage()` sends via the Baileys socket, splitting long messages

The channel registry (`src/messaging.ts`) is a simple `Map<string, SendFn>`. Adding a new channel (Telegram, Signal, etc.) requires:
1. A connection module with a send function matching `(message: string, to?: string) => Promise<number>`
2. A `registerChannel()` call at startup and in `reloadServices()`

No changes to the MCP server, HTTP endpoints, or agent prompts are needed.
