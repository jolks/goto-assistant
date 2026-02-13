import { Agent, run, MCPServerStdio } from "@openai/agents";
import type { Config, McpServerConfig } from "../config.js";
import { MEMORY_FILE_PATH, MEMORY_SERVER_NAME } from "../config.js";
import type { Attachment, HistoryMessage } from "./router.js";
import { parseMessageContent } from "../sessions.js";
import { getUpload } from "../uploads.js";

export async function runOpenAI(
  prompt: string,
  config: Config,
  mcpServersConfig: Record<string, McpServerConfig>,
  onChunk: (text: string) => void,
  attachments?: Attachment[],
  history?: HistoryMessage[]
): Promise<void> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    OPENAI_API_KEY: config.openai.apiKey,
  };
  if (config.openai.baseUrl) {
    env.OPENAI_BASE_URL = config.openai.baseUrl;
  }

  // Set up MCP stdio servers
  const mcpServers: MCPServerStdio[] = [];
  for (const [name, server] of Object.entries(mcpServersConfig)) {
    const serverEnv: Record<string, string> = { ...env, ...server.env };
    if (name === MEMORY_SERVER_NAME) {
      serverEnv.MEMORY_FILE_PATH = MEMORY_FILE_PATH;
    }
    mcpServers.push(
      new MCPServerStdio({
        name,
        fullCommand: `${server.command} ${server.args.join(" ")}`,
        env: serverEnv,
      })
    );
  }

  try {
    // Connect all MCP servers
    for (const server of mcpServers) {
      await server.connect();
    }

    const agent = new Agent({
      name: "goto-assistant",
      instructions:
        "You are a helpful personal AI assistant. You have access to MCP tools for memory, filesystem, browser automation, and scheduled tasks. Use them when appropriate. IMPORTANT: At the start of each conversation, you MUST call the memory read_graph tool to retrieve all known context about the user before responding to their first message.",
      model: config.openai.model,
      mcpServers,
    });

    // Build conversation input with history
    const inputMessages: Array<Record<string, unknown>> = [];

    // Add previous messages (re-include images from uploads)
    if (history && history.length > 0) {
      for (const msg of history) {
        const parsed = parseMessageContent(msg.content);
        if (msg.role === "assistant") {
          // OpenAI Responses API requires assistant content as an array of output blocks
          inputMessages.push({
            role: "assistant",
            content: [{ type: "output_text", text: parsed.text }],
          });
        } else if (parsed.attachments && parsed.attachments.length > 0) {
          // Re-read image data for user messages that had attachments
          const content: Array<Record<string, unknown>> = [];
          for (const att of parsed.attachments) {
            const upload = getUpload(att.fileId);
            if (upload) {
              content.push({
                type: "input_image",
                image: `data:${upload.mimeType};base64,${upload.data.toString("base64")}`,
              });
            }
          }
          content.push({ type: "input_text", text: parsed.text });
          inputMessages.push({ role: "user", content });
        } else {
          inputMessages.push({ role: msg.role, content: parsed.text });
        }
      }
    }

    // Add current message
    if (attachments && attachments.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      for (const att of attachments) {
        content.push({
          type: "input_image",
          image: `data:${att.mimeType};base64,${att.data.toString("base64")}`,
        });
      }
      content.push({ type: "input_text", text: prompt });
      inputMessages.push({ role: "user", content });
    } else {
      inputMessages.push({ role: "user", content: prompt });
    }

    const input = inputMessages.length === 1 && !history?.length && !attachments?.length ? prompt : inputMessages;
    const result = await run(agent, input as string, { stream: true });

    for await (const event of result) {
      if (
        event.type === "raw_model_stream_event" &&
        event.data?.type === "output_text_delta"
      ) {
        const delta = (event.data as { delta?: string }).delta;
        if (delta) {
          onChunk(delta);
        }
      }
    }
  } finally {
    // Disconnect all MCP servers
    for (const server of mcpServers) {
      try {
        await server.close();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
