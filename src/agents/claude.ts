import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config, McpServerConfig } from "../config.js";
import { MAX_AGENT_TURNS, MEMORY_FILE_PATH, MEMORY_SERVER_NAME } from "../config.js";
import type { Attachment } from "./router.js";
import { extractFileId, formatUploadRef } from "../uploads.js";

export interface ClaudeOptions {
  resumeSessionId?: string;
  attachments?: Attachment[];
  systemPromptOverride?: string;
}

export interface AgentResponse {
  sessionId: string | null;
  conversationId: string;
}

export async function runClaude(
  prompt: string,
  config: Config,
  mcpServersConfig: Record<string, McpServerConfig>,
  onChunk: (text: string) => void,
  options?: ClaudeOptions
): Promise<AgentResponse> {
  const { resumeSessionId, attachments, systemPromptOverride } = options ?? {};
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

  const queryOptions: Record<string, unknown> = {
    model: config.claude.model,
    mcpServers,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: Object.keys(mcpServersConfig).map((name) => `mcp__${name}__*`),
    systemPrompt: systemPromptOverride || "You are a helpful personal AI assistant. You have access to MCP tools for memory, filesystem, browser automation, and scheduled tasks. Use them when appropriate. You can also send messages to the user via connected messaging channels (e.g. WhatsApp) using the messaging tools — send to self or to any phone number. IMPORTANT: At the start of each conversation, you MUST call the memory read_graph tool to retrieve all known context about the user before responding to their first message.",
    env,
    maxTurns: MAX_AGENT_TURNS,
  };

  if (resumeSessionId) {
    queryOptions.resume = resumeSessionId;
  }

  // Pass image file paths in the prompt so Claude reads them with its built-in
  // Read tool (which returns proper ImageFileOutput for image files).
  // Note: the Agent SDK's query() AsyncIterable<SDKUserMessage> path does NOT
  // support image content blocks — it serializes them as text over IPC.
  let queryPrompt = prompt;
  if (attachments && attachments.length > 0) {
    const withPaths = attachments.filter((att) => att.filePath);
    if (withPaths.length > 0) {
      const paths = withPaths.map((att) => att.filePath);
      const refs = withPaths.map(a => formatUploadRef(extractFileId(a.filePath!), a.filename, a.mimeType));
      queryPrompt = `${refs.join("\n")}\n${prompt}\n\n[The user attached ${paths.length} image(s). You MUST use the Read tool to view each image before responding. Do NOT describe images without reading them first. Image paths:\n${paths.join("\n")}]`;
    }
  }

  let sessionId: string | null = null;

  const result = query({ prompt: queryPrompt, options: queryOptions });

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

    if (message.type === "result" && message.subtype === "error_max_turns") {
      const resultMsg = message as { session_id?: string };
      sessionId = resultMsg.session_id ?? sessionId;
      onChunk(`\n\n[Stopped: reached the maximum number of tool-use turns (${MAX_AGENT_TURNS}). You can continue the conversation to pick up where I left off.]`);
    }
  }

  return { sessionId, conversationId: "" };
}
