import { Agent, Runner, MCPServerStdio, shellTool, MaxTurnsExceededError, setOpenAIAPI, OpenAIProvider } from "@openai/agents";
import type { Shell, ShellAction, ShellResult, ShellOutputResult } from "@openai/agents";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Config, McpServerConfig } from "../config.js";
import { MAX_AGENT_TURNS, MAX_HISTORY_MESSAGES, RECENT_IMAGE_WINDOW, MEMORY_FILE_PATH, MEMORY_SERVER_NAME, isChatCompletionsGateway } from "../config.js";
import type { Attachment, HistoryMessage } from "./router.js";
import { parseMessageContent } from "../sessions.js";
import { getUpload, ALLOWED_IMAGE_TYPES, extractFileId, formatUploadRef } from "../uploads.js";

const execAsync = promisify(exec);

class LocalShell implements Shell {
  async run(action: ShellAction): Promise<ShellResult> {
    const output: ShellOutputResult[] = [];
    for (const command of action.commands) {
      let stdout = "";
      let stderr = "";
      let outcome: ShellOutputResult["outcome"] = { type: "exit", exitCode: 0 };
      try {
        const result = await execAsync(command, {
          timeout: action.timeoutMs ?? 30_000,
          maxBuffer: action.maxOutputLength ?? 1024 * 1024,
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error: unknown) {
        const err = error as { code?: number; killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
        stdout = err.stdout ?? "";
        stderr = err.stderr ?? err.message ?? "";
        outcome = err.killed || err.signal === "SIGTERM"
          ? { type: "timeout" }
          : { type: "exit", exitCode: typeof err.code === "number" ? err.code : 1 };
      }
      output.push({ stdout, stderr, outcome });
      if (outcome.type === "timeout") break;
    }
    return { output };
  }
}

export interface OpenAIOptions {
  attachments?: Attachment[];
  history?: HistoryMessage[];
  systemPromptOverride?: string;
}

/**
 * Trim conversation history to avoid 413 errors from size-constrained gateways.
 * 1. Cap message count to `maxMessages` (keeps most recent history + current message).
 * 2. Strip `input_image` blocks from messages outside the `recentImageWindow`,
 *    replacing them with a text placeholder.
 * Returns a new array — does not mutate the original.
 */
export function trimHistory(
  inputMessages: Array<Record<string, unknown>>,
  maxMessages: number = MAX_HISTORY_MESSAGES,
  recentImageWindow: number = RECENT_IMAGE_WINDOW
): Array<Record<string, unknown>> {
  if (inputMessages.length === 0) return [];

  // Separate current message (last) from history
  const current = inputMessages[inputMessages.length - 1];
  const history = inputMessages.slice(0, -1);

  // Cap history to maxMessages
  const trimmed = history.length > maxMessages
    ? history.slice(history.length - maxMessages)
    : history.slice();

  // Strip images from messages outside the recent window
  const imageKeepStart = trimmed.length - recentImageWindow;
  const result = trimmed.map((msg, i) => {
    if (i >= imageKeepStart) return msg;
    if (!Array.isArray(msg.content)) return msg;

    const content = msg.content as Array<Record<string, unknown>>;
    const hasImages = content.some(block => block.type === "input_image");
    if (!hasImages) return msg;

    const imageCount = content.filter(block => block.type === "input_image").length;
    const placeholder = imageCount === 1
      ? "[Image previously shared]"
      : `[${imageCount} images previously shared]`;

    const newContent = [
      { type: "input_text", text: placeholder },
      ...content.filter(block => block.type !== "input_image"),
    ];
    return { ...msg, content: newContent };
  });

  result.push(current);
  return result;
}

export async function runOpenAI(
  prompt: string,
  config: Config,
  mcpServersConfig: Record<string, McpServerConfig>,
  onChunk: (text: string) => void,
  options?: OpenAIOptions
): Promise<void> {
  const { attachments, history, systemPromptOverride } = options || {};

  // Use Chat Completions API for gateways that don't support the Responses API
  const useChatCompletions = isChatCompletionsGateway(config.openai.baseUrl);
  setOpenAIAPI(useChatCompletions ? "chat_completions" : "responses");

  // Create a fresh provider + runner each call so config changes (API key, base
  // URL) take effect immediately. Both the default OpenAIProvider and default
  // Runner are cached singletons that never refresh, so we bypass them entirely.
  const provider = new OpenAIProvider({
    apiKey: config.openai.apiKey,
    baseURL: config.openai.baseUrl || undefined,
  });
  const runner = new Runner({ modelProvider: provider });

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
        systemPromptOverride || "You are a helpful personal AI assistant. You have access to MCP tools for memory, filesystem, browser automation, and scheduled tasks. You also have a shell tool to execute commands on the host machine. You can also send messages to the user via connected messaging channels (e.g. WhatsApp) using the messaging tools — send to self or to any phone number. Use them when appropriate. IMPORTANT: At the start of each conversation, you MUST call the memory read_graph tool to retrieve all known context about the user before responding to their first message.",
      model: config.openai.model,
      mcpServers,
      // shellTool is a hosted tool — only available with the Responses API
      tools: useChatCompletions ? [] : [
        shellTool({ shell: new LocalShell() }),
      ],
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
          const refs: string[] = [];
          for (const att of parsed.attachments) {
            // Use stored mimeType (accurate at save time); skip non-image attachments
            const mimeType = att.mimeType;
            const ref = formatUploadRef(att.fileId, att.filename, mimeType);
            if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
              refs.push(ref);
              continue;
            }
            const upload = getUpload(att.fileId);
            if (upload) {
              content.push({
                type: "input_image",
                image: `data:${mimeType};base64,${upload.data.toString("base64")}`,
              });
              refs.push(ref);
            }
          }
          // Include upload references so the model can use send_message media with upload:{fileId}
          const text = refs.length > 0 ? `${refs.join("\n")}\n${parsed.text}` : parsed.text;
          content.push({ type: "input_text", text });
          inputMessages.push({ role: "user", content });
        } else {
          inputMessages.push({ role: msg.role, content: parsed.text });
        }
      }
    }

    // Add current message
    if (attachments && attachments.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      const refs: string[] = [];
      for (const att of attachments) {
        // Build upload reference for the model to use with send_message media
        if (att.filePath) {
          refs.push(formatUploadRef(extractFileId(att.filePath), att.filename, att.mimeType));
        }
        // Only include image types as input_image blocks; skip non-image attachments
        if (ALLOWED_IMAGE_TYPES.includes(att.mimeType)) {
          content.push({
            type: "input_image",
            image: `data:${att.mimeType};base64,${att.data.toString("base64")}`,
          });
        }
      }
      const text = refs.length > 0 ? `${refs.join("\n")}\n${prompt}` : prompt;
      content.push({ type: "input_text", text });
      inputMessages.push({ role: "user", content });
    } else {
      inputMessages.push({ role: "user", content: prompt });
    }

    const trimmedMessages = trimHistory(inputMessages);
    const input = trimmedMessages.length === 1 && !history?.length && !attachments?.length ? prompt : trimmedMessages;

    try {
      const result = await runner.run(agent, input as string, { stream: true, maxTurns: MAX_AGENT_TURNS });

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
    } catch (error) {
      if (error instanceof MaxTurnsExceededError) {
        onChunk(`\n\n[Stopped: reached the maximum number of tool-use turns (${MAX_AGENT_TURNS}). You can continue the conversation to pick up where I left off.]`);
        return;
      }
      throw error;
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
