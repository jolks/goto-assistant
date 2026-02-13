import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config, McpServerConfig } from "../config.js";
import { MEMORY_FILE_PATH, MEMORY_SERVER_NAME } from "../config.js";
import type { Attachment } from "./router.js";

export interface AgentResponse {
  sessionId: string | null;
  conversationId: string;
}

export async function runClaude(
  prompt: string,
  config: Config,
  mcpServersConfig: Record<string, McpServerConfig>,
  onChunk: (text: string) => void,
  resumeSessionId?: string,
  attachments?: Attachment[]
): Promise<AgentResponse> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ANTHROPIC_API_KEY: config.claude.apiKey,
  };
  if (config.claude.baseUrl) {
    env.ANTHROPIC_BASE_URL = config.claude.baseUrl;
  }

  // Build MCP servers config with their env vars
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(mcpServersConfig)) {
    const serverEnv: Record<string, string> = { ...env, ...server.env };
    if (name === MEMORY_SERVER_NAME) {
      serverEnv.MEMORY_FILE_PATH = MEMORY_FILE_PATH;
    }
    mcpServers[name] = {
      command: server.command,
      args: server.args,
      env: serverEnv,
    };
  }

  const options: Record<string, unknown> = {
    model: config.claude.model,
    mcpServers,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: Object.keys(mcpServersConfig).map((name) => `mcp__${name}__*`),
    systemPrompt: "You are a helpful personal AI assistant. You have access to MCP tools for memory, filesystem, browser automation, and scheduled tasks. Use them when appropriate. IMPORTANT: At the start of each conversation, you MUST call the memory read_graph tool to retrieve all known context about the user before responding to their first message.",
    env,
    maxTurns: 30,
  };

  if (resumeSessionId) {
    options.resume = resumeSessionId;
  }

  // When attachments are present, reference file paths in the prompt so Claude
  // can read them via the filesystem MCP server's read_media_file tool.
  // The query() function only accepts a plain string prompt.
  let queryPrompt = prompt;
  if (attachments && attachments.length > 0) {
    const paths = attachments
      .filter((att) => att.filePath)
      .map((att) => att.filePath);
    if (paths.length > 0) {
      queryPrompt = `${prompt}\n\n[The user attached ${paths.length} image(s). Read them using the filesystem read_media_file tool to see the content:\n${paths.join("\n")}]`;
    }
  }

  let sessionId: string | null = null;

  const result = query({ prompt: queryPrompt, options });

  for await (const message of result) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = (message as { session_id?: string }).session_id ?? null;
    }

    if (message.type === "assistant") {
      const content = (message as { content?: Array<{ type: string; text?: string }> }).content;
      if (content) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            onChunk(block.text);
          }
        }
      }
    }

    if (message.type === "result" && message.subtype === "success") {
      const resultMsg = message as { session_id?: string; result?: string };
      sessionId = resultMsg.session_id ?? sessionId;
      if (resultMsg.result) {
        onChunk(resultMsg.result);
      }
    }
  }

  return { sessionId, conversationId: "" };
}
