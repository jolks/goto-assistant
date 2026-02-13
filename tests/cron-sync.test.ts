import { describe, it, expect } from 'vitest';
import { buildCronConfig } from '../public/cron-sync.js';

const DEFAULT_ARGS =
  '-y mcp-cron --transport stdio --prevent-sleep --ai-provider anthropic --ai-model claude-sonnet-4-5-20250929';

describe('buildCronConfig', () => {
  describe('provider + baseUrl combinations', () => {
    it('claude + no baseUrl → anthropic provider + ANTHROPIC_API_KEY', () => {
      const result = buildCronConfig({
        provider: 'claude',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5-20250929',
        baseUrl: '',
        currentArgs: DEFAULT_ARGS,
      });
      expect(result.args).toContain('--ai-provider anthropic');
      expect(result.envKey).toBe('ANTHROPIC_API_KEY');
      expect(result.envValue).toBe('sk-ant-test');
    });

    it('claude + baseUrl → openai provider + MCP_CRON_AI_API_KEY', () => {
      const result = buildCronConfig({
        provider: 'claude',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5-20250929',
        baseUrl: 'http://localhost:4000',
        currentArgs: DEFAULT_ARGS,
      });
      expect(result.args).toContain('--ai-provider openai');
      expect(result.args).not.toContain('--ai-provider anthropic');
      expect(result.envKey).toBe('MCP_CRON_AI_API_KEY');
      expect(result.envValue).toBe('sk-ant-test');
    });

    it('openai + no baseUrl → openai provider + OPENAI_API_KEY', () => {
      const result = buildCronConfig({
        provider: 'openai',
        apiKey: 'sk-openai-test',
        model: 'gpt-4o',
        baseUrl: '',
        currentArgs: DEFAULT_ARGS,
      });
      expect(result.args).toContain('--ai-provider openai');
      expect(result.envKey).toBe('OPENAI_API_KEY');
      expect(result.envValue).toBe('sk-openai-test');
    });

    it('openai + baseUrl → openai provider + MCP_CRON_AI_API_KEY', () => {
      const result = buildCronConfig({
        provider: 'openai',
        apiKey: 'sk-openai-test',
        model: 'gpt-4o',
        baseUrl: 'http://localhost:4000',
        currentArgs: DEFAULT_ARGS,
      });
      expect(result.args).toContain('--ai-provider openai');
      expect(result.envKey).toBe('MCP_CRON_AI_API_KEY');
      expect(result.envValue).toBe('sk-openai-test');
    });
  });

  describe('--ai-model handling', () => {
    it('updates existing --ai-model', () => {
      const result = buildCronConfig({
        provider: 'claude',
        apiKey: 'key',
        model: 'claude-opus-4-6',
        baseUrl: '',
        currentArgs: DEFAULT_ARGS,
      });
      expect(result.args).toContain('--ai-model claude-opus-4-6');
      expect(result.args).not.toContain('claude-sonnet-4-5-20250929');
    });

    it('appends --ai-model when not present', () => {
      const argsWithoutModel = '-y mcp-cron --transport stdio --prevent-sleep --ai-provider anthropic';
      const result = buildCronConfig({
        provider: 'claude',
        apiKey: 'key',
        model: 'claude-opus-4-6',
        baseUrl: '',
        currentArgs: argsWithoutModel,
      });
      expect(result.args).toContain('--ai-model claude-opus-4-6');
    });
  });

  describe('--ai-base-url handling', () => {
    it('adds --ai-base-url when baseUrl is set', () => {
      const result = buildCronConfig({
        provider: 'claude',
        apiKey: 'key',
        model: 'model',
        baseUrl: 'http://localhost:4000',
        currentArgs: DEFAULT_ARGS,
      });
      expect(result.args).toContain('--ai-base-url http://localhost:4000');
    });

    it('updates existing --ai-base-url', () => {
      const argsWithBaseUrl = DEFAULT_ARGS + ' --ai-base-url http://old:3000';
      const result = buildCronConfig({
        provider: 'claude',
        apiKey: 'key',
        model: 'model',
        baseUrl: 'http://new:4000',
        currentArgs: argsWithBaseUrl,
      });
      expect(result.args).toContain('--ai-base-url http://new:4000');
      expect(result.args).not.toContain('http://old:3000');
    });

    it('removes --ai-base-url when baseUrl is cleared', () => {
      const argsWithBaseUrl = DEFAULT_ARGS + ' --ai-base-url http://localhost:4000';
      const result = buildCronConfig({
        provider: 'claude',
        apiKey: 'key',
        model: 'model',
        baseUrl: '',
        currentArgs: argsWithBaseUrl,
      });
      expect(result.args).not.toContain('--ai-base-url');
    });
  });
});
