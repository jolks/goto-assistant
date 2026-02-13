import type { Config, McpServerConfig } from "../config.js";
import { runClaude } from "./claude.js";
import { runOpenAI } from "./openai.js";

export interface Attachment {
  filename: string;
  mimeType: string;
  data: Buffer;
  filePath?: string;
}

export interface HistoryMessage {
  role: string;
  content: string;
}

export interface RouteResult {
  sessionId: string | null;
}

export async function routeMessage(
  prompt: string,
  config: Config,
  mcpServers: Record<string, McpServerConfig>,
  onChunk: (text: string) => void,
  resumeSessionId?: string,
  attachments?: Attachment[],
  history?: HistoryMessage[]
): Promise<RouteResult> {
  switch (config.provider) {
    case "claude": {
      const result = await runClaude(prompt, config, mcpServers, onChunk, resumeSessionId, attachments);
      return { sessionId: result.sessionId };
    }
    case "openai": {
      await runOpenAI(prompt, config, mcpServers, onChunk, attachments, history);
      return { sessionId: null };
    }
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
