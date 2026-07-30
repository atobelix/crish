import { describe, it, expect } from 'vitest';
import { AnthropicMessagesEngine } from './anthropic-messages-engine';
import { createSecret } from '../auth/types';
import type { ProviderStreamEvent } from '@crish/shared-types';
import type { AgentProviderRequest, EngineOptions } from '../types';

describe('AnthropicMessagesEngine', () => {
  const engine = new AnthropicMessagesEngine();

  const defaultRequest: AgentProviderRequest = {
    sessionId: 's_test',
    cwd: '/test',
    messages: [
      {
        id: 'm1',
        role: 'user',
        createdAt: new Date().toISOString(),
        blocks: [{ type: 'text', text: 'Hi' }],
      },
    ],
    tools: [],
    signal: new AbortController().signal,
  };

  const defaultOptions: EngineOptions = {
    model: 'claude-3-5-sonnet-20241022',
    apiKey: createSecret('sk-ant-test'),
    baseUrl: 'https://api.anthropic.com/v1',
    stream: true,
    extra: { model: 'claude-3-5-sonnet-20241022' },
  };

  describe('buildRequest', () => {
    it('builds a basic messages request', () => {
      const result = engine.buildRequest(defaultRequest, defaultOptions);
      expect(result.url).toBe('https://api.anthropic.com/v1/messages');
      expect(result.init.method).toBe('POST');
      expect(result.init.headers).toMatchObject({
        'content-type': 'application/json',
        'x-api-key': 'sk-ant-test',
      });
      const body = JSON.parse(result.init.body as string);
      expect(body.model).toBe('claude-3-5-sonnet-20241022');
      expect(body.max_tokens).toBeGreaterThan(0);
      expect(body.stream).toBe(true);
    });

    it('includes system prompt in body.system', () => {
      const request = { ...defaultRequest, systemPrompt: 'You are Claude.' };
      const result = engine.buildRequest(request, defaultOptions);
      const body = JSON.parse(result.init.body as string);
      expect(body.system).toContain('You are Claude.');
    });

    it('uses non-streaming when stream is false', () => {
      const options = { ...defaultOptions, stream: false };
      const result = engine.buildRequest(defaultRequest, options);
      const body = JSON.parse(result.init.body as string);
      expect(body.stream).toBe(false);
    });

    it('includes tools when provided', () => {
      const request = {
        ...defaultRequest,
        tools: [
          {
            name: 'search',
            description: 'Search tool',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      } as unknown as AgentProviderRequest;
      const result = engine.buildRequest(request, defaultOptions);
      const body = JSON.parse(result.init.body as string);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].name).toBe('search');
    });

    it('includes thinking config when provided in extra', () => {
      const options = {
        ...defaultOptions,
        extra: { ...defaultOptions.extra, thinking: { budget_tokens: 2000 } },
      };
      const result = engine.buildRequest(defaultRequest, options);
      const body = JSON.parse(result.init.body as string);
      expect(body.thinking).toMatchObject({
        type: 'enabled',
        budget_tokens: 2000,
      });
    });

    it('sets anthropic-beta header when thinking is enabled', () => {
      const options = {
        ...defaultOptions,
        extra: { ...defaultOptions.extra, thinking: { budget_tokens: 2000 } },
      };
      const result = engine.buildRequest(defaultRequest, options);
      expect(
        (result.init.headers as Record<string, string>)['anthropic-beta']
      ).toBe('interleaved-thinking-2025-05-14');
    });

    it('allows custom anthropic version', () => {
      const options = { ...defaultOptions, anthropicVersion: '2023-01-01' };
      const result = engine.buildRequest(defaultRequest, options);
      expect(
        (result.init.headers as Record<string, string>)['anthropic-version']
      ).toBe('2023-01-01');
    });
  });

  describe('parseResponse', () => {
    it('parses a valid JSON response', async () => {
      const body = {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from Claude' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      const events: ProviderStreamEvent[] = [];
      for await (const event of engine.parseResponse(body)) {
        events.push(event as ProviderStreamEvent);
      }
      expect(events.some((e) => e.type === 'text-delta')).toBe(true);
    });

    it('returns error for non-object response', async () => {
      const events: ProviderStreamEvent[] = [];
      for await (const event of engine.parseResponse('invalid')) {
        events.push(event as ProviderStreamEvent);
      }
      expect(events[0]!.type).toBe('stop');
      if (events[0]!.type === 'stop') {
        expect((events[0] as { reason?: string }).reason).toBe('error');
      }
    });
  });

  describe('classifyError', () => {
    it('classifies 401 as auth error', () => {
      const result = engine.classifyError(new Error('Unauthorized'), 401);
      expect(result.kind).toBe('auth');
    });

    it('classifies 429 as rate-limit', () => {
      const result = engine.classifyError(new Error('rate limit'), 429);
      expect(result.kind).toBe('rate-limit');
    });
  });
});
