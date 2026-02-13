import type { Config } from "../config.js";
import { runClaude } from "./claude.js";
import { runOpenAI } from "./openai.js";

export interface RouteResult {
  sessionId: string | null;
}

export async function routeMessage(
  prompt: string,
  config: Config,
  onChunk: (text: string) => void,
  resumeSessionId?: string
): Promise<RouteResult> {
  switch (config.provider) {
    case "claude": {
      const result = await runClaude(prompt, config, onChunk, resumeSessionId);
      return { sessionId: result.sessionId };
    }
    case "openai": {
      await runOpenAI(prompt, config, onChunk);
      return { sessionId: null };
    }
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
