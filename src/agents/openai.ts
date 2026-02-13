import { Agent, run, MCPServerStdio } from "@openai/agents";
import type { Config } from "../config.js";
import { MEMORY_FILE_PATH, MEMORY_SERVER_NAME } from "../config.js";

export async function runOpenAI(
  prompt: string,
  config: Config,
  onChunk: (text: string) => void
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
  for (const [name, server] of Object.entries(config.mcpServers)) {
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

    const result = await run(agent, prompt, { stream: true });

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
