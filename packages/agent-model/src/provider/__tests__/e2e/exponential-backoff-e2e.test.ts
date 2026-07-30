/**
 * @alpha Round 4 共存阶段 — 此 e2e 测试依赖 agent-core 模块（recovery-pipeline / provider-call-gateway / AgentRuntime / types），
        将在 Round 5（agent-core 创建）后重新启用。依据 ROUND-04-split-phase-B.md §8.3。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LlmApiMockServer, Scenarios } from './mock-server';
import {
  ProviderCallGateway,
  type ProviderCallResult,
} from '@crish/agent-core';
import type { ProviderStreamEvent } from '@crish/shared-types';
import type { AgentProvider, AgentProviderRequest } from '../../types';

/**
 * A live provider that calls the mock server over real HTTP, bypassing
 * the SSRF guard in ProviderFactory so we can use localhost in tests.
 */
function createLiveProvider(
  id: string,
  baseUrl: string,
  apiKey: string
): AgentProvider {
  return {
    id,
    async *stream(
      request: AgentProviderRequest
    ): AsyncIterable<ProviderStreamEvent> {
      if (request.signal.aborted) return;

      const url = `${baseUrl}/v1/chat/completions`;
      const body = JSON.stringify({
        model: 'gpt-4o',
        messages: request.messages,
        stream: true,
      });
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      };

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: request.signal,
        });
      } catch (err) {
        yield {
          type: 'stop',
          reason: 'error',
          error: String(err),
        } as ProviderStreamEvent;
        return;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        yield {
          type: 'stop',
          reason: 'error',
          error: `[${id}] ${response.status}: ${text.slice(0, 200)}`,
        } as ProviderStreamEvent;
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        yield {
          type: 'stop',
          reason: 'error',
          error: 'No response body',
        } as ProviderStreamEvent;
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              yield {
                type: 'text-delta',
                text: delta.content,
              } as ProviderStreamEvent;
            }
            if (parsed.choices?.[0]?.finish_reason) {
              // Will yield stop below
            }
          }
        }
      } catch (err) {
        yield {
          type: 'stop',
          reason: 'error',
          error: String(err),
        } as ProviderStreamEvent;
        return;
      }

      yield { type: 'stop', reason: 'stop' } as ProviderStreamEvent;
    },
  };
}

describe.skip('E2E: Exponential backoff on transient errors (R13.3)', () => {
  const server = new LlmApiMockServer();
  let gateway: ProviderCallGateway;
  let baseUrl: string;

  beforeAll(async () => {
    await server.start(0);
    baseUrl = server.getBaseUrl();
    server.on('/chat/completions', Scenarios.repeated401(5));
    gateway = new ProviderCallGateway();
  });

  afterAll(async () => {
    await server.stop();
  });

  function makeRequest(signal?: AbortSignal): AgentProviderRequest {
    return {
      sessionId: 'test-session',
      cwd: '/test',
      messages: [
        {
          id: 'm1',
          role: 'user',
          createdAt: new Date().toISOString(),
          blocks: [{ type: 'text', text: 'Hello' }],
        },
      ],
      tools: [],
      signal: signal ?? new AbortController().signal,
    };
  }

  async function collectCall(
    gateway: ProviderCallGateway,
    provider: AgentProvider,
    request: AgentProviderRequest
  ) {
    const events: ProviderStreamEvent[] = [];
    const iterator = gateway.call(provider, request);
    let result: ProviderCallResult;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        result = next.value;
        break;
      }
      events.push(next.value as unknown as ProviderStreamEvent);
    }
    return { events, response: result.response };
  }

  it('retries on transient errors and eventually succeeds after restoring correct API key', async () => {
    // First 5 calls with invalid key should all fail with 401 (non-retryable auth errors)
    const invalidProvider = createLiveProvider(
      'mock-auth-test',
      baseUrl,
      'invalid-key'
    );

    for (let i = 0; i < 5; i++) {
      const { response } = await collectCall(
        gateway,
        invalidProvider,
        makeRequest()
      );
      expect(response.finishReason).toBe('error');
      expect(response.error).toMatch(/401/);
    }

    // 6th call with valid key should succeed
    const validProvider = createLiveProvider(
      'mock-auth-test',
      baseUrl,
      'valid-key'
    );
    const { response } = await collectCall(
      gateway,
      validProvider,
      makeRequest()
    );

    expect(response.finishReason).toBe('stop');
    expect(response.text).toContain('Success');
  });
});
