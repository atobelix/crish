import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  buildAnthropicMessagesBody,
  createAnthropicProviderFromPlan,
  createTextMessage,
  defineTextTool,
  resolveAnthropicMessagesUrl,
  shouldUseAnthropicProvider,
  toAnthropicMessages,
  type ProviderStreamEvent,
} from '.';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('Anthropic request build', () => {
  it('resolves messages URL from baseUrl variants', () => {
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1/messages'
    );
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com/v1/messages'
    );
    expect(
      resolveAnthropicMessagesUrl('https://api.anthropic.com/v1/messages')
    ).toBe('https://api.anthropic.com/v1/messages');
    expect(
      resolveAnthropicMessagesUrl('https://proxy.example/anthropic/')
    ).toBe('https://proxy.example/anthropic/v1/messages');
  });

  it('maps user/assistant/tool messages and tools into Anthropic body', () => {
    const body = buildAnthropicMessagesBody({
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
      messages: [
        createTextMessage('user', 'list files'),
        {
          id: 'a1',
          role: 'assistant',
          createdAt: new Date().toISOString(),
          blocks: [
            { type: 'text', text: "I'll list." },
            {
              type: 'tool-call',
              id: 'toolu_1',
              toolName: 'shell_command',
              input: { command: 'ls' },
            },
          ],
        },
        {
          id: 't1',
          role: 'tool',
          createdAt: new Date().toISOString(),
          blocks: [
            {
              type: 'tool-result',
              toolCallId: 'toolu_1',
              toolName: 'shell_command',
              output: { text: 'a.txt' },
              isError: false,
            },
          ],
        },
      ],
      tools: [
        defineTextTool({
          name: 'shell_command',
          description: 'Run command',
          execute: () => 'ok',
        }),
      ],
      maxTokens: 1024,
    });

    expect(body.model).toBe('claude-sonnet-4-20250514');
    expect(body.max_tokens).toBe(1024);
    expect(body.stream).toBe(true);
    expect(body.system).toBe('You are helpful.');
    expect(body.messages).toEqual([
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll list." },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'shell_command',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' },
        ],
      },
    ]);
    expect(body.tools).toEqual([
      {
        name: 'shell_command',
        description: 'Run command',
        input_schema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('merges consecutive same-role messages', () => {
    const mapped = toAnthropicMessages([
      createTextMessage('user', 'a'),
      createTextMessage('user', 'b'),
      createTextMessage('assistant', 'c'),
    ]);
    expect(mapped).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'c' }] },
    ]);
  });
});

describe('shouldUseAnthropicProvider', () => {
  it('detects by providerId, family, and baseUrl', () => {
    expect(shouldUseAnthropicProvider({ providerId: 'anthropic' })).toBe(true);
    expect(shouldUseAnthropicProvider({ providerId: 'claude-proxy' })).toBe(
      true
    );
    expect(
      shouldUseAnthropicProvider({ metadata: { family: 'anthropic' } })
    ).toBe(true);
    expect(
      shouldUseAnthropicProvider({ baseUrl: 'https://api.anthropic.com/v1' })
    ).toBe(true);
    expect(
      shouldUseAnthropicProvider({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        metadata: { family: 'openai-compatible' },
      })
    ).toBe(false);
  });
});

describe('AnthropicProvider', () => {
  it('parses streaming text deltas and stop', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://api.anthropic.com/v1/messages');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('test-key');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['content-type']).toBe('application/json');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe('claude-test');
      expect(body.stream).toBe(true);
      expect(body.max_tokens).toBeGreaterThan(0);

      return sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-test","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    };

    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-test',
      fetch: fetchMock,
    });

    const events = await collect(
      provider.stream({
        sessionId: 's',
        cwd: 'C:/repo',
        messages: [createTextMessage('user', 'hi')],
        tools: [],
        signal: new AbortController().signal,
      })
    );

    expect(events).toEqual([
      { type: 'text-delta', text: 'Hello' },
      { type: 'text-delta', text: ' world' },
      {
        type: 'stop',
        reason: 'stop',
        usage: {
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
        },
      },
    ]);
  });

  it('parses streaming tool_use with fragmented input_json_delta', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponse([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"shell_command","input":{}}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"pwd\\"}"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]);

    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'k',
      model: 'claude-test',
      fetch: fetchMock,
    });

    const events = await collect(
      provider.stream({
        sessionId: 's',
        cwd: 'C:/repo',
        messages: [createTextMessage('user', 'run pwd')],
        tools: [
          defineTextTool({
            name: 'shell_command',
            description: 'Run command',
            execute: () => 'ok',
          }),
        ],
        signal: new AbortController().signal,
      })
    );

    expect(events).toEqual([
      {
        type: 'tool-call',
        id: 'toolu_1',
        toolName: 'shell_command',
        input: { command: 'pwd' },
      },
      {
        type: 'stop',
        reason: 'tool-call',
        usage: {
          promptTokens: 5,
          completionTokens: 12,
          totalTokens: 17,
        },
      },
    ]);
  });

  it('throws with status text on HTTP non-2xx (never silent empty stream)', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
        {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
        }
      );

    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'bad',
      model: 'claude-test',
      fetch: fetchMock,
    });

    await expect(
      collect(
        provider.stream({
          sessionId: 's',
          cwd: 'C:/repo',
          messages: [createTextMessage('user', 'hi')],
          tools: [],
          signal: new AbortController().signal,
        })
      )
    ).rejects.toThrow(/401.*authentication_error|invalid x-api-key/i);
  });

  it('respects AbortSignal before fetch', async () => {
    let fetchCalls = 0;
    const fetchMock: typeof fetch = async () => {
      fetchCalls += 1;
      return sseResponse(['data: {"type":"message_stop"}\n\n']);
    };
    const controller = new AbortController();
    controller.abort();

    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'k',
      model: 'claude-test',
      fetch: fetchMock,
    });

    await expect(
      collect(
        provider.stream({
          sessionId: 's',
          cwd: 'C:/repo',
          messages: [createTextMessage('user', 'hi')],
          tools: [],
          signal: controller.signal,
        })
      )
    ).rejects.toThrow(/abort/i);
    expect(fetchCalls).toBe(0);
  });

  it('parses non-streaming JSON tool_use response', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Using tool.' },
            {
              type: 'tool_use',
              id: 'toolu_9',
              name: 'shell_command',
              input: { command: 'echo hi' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 3, output_tokens: 8 },
        }),
        { headers: { 'content-type': 'application/json' } }
      );

    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'k',
      model: 'claude-test',
      stream: false,
      fetch: fetchMock,
    });

    const events = await collect(
      provider.stream({
        sessionId: 's',
        cwd: 'C:/repo',
        messages: [createTextMessage('user', 'hi')],
        tools: [],
        signal: new AbortController().signal,
      })
    );

    expect(events).toEqual([
      { type: 'text-delta', text: 'Using tool.' },
      {
        type: 'tool-call',
        id: 'toolu_9',
        toolName: 'shell_command',
        input: { command: 'echo hi' },
      },
      {
        type: 'stop',
        reason: 'tool-call',
        usage: {
          promptTokens: 3,
          completionTokens: 8,
          totalTokens: 11,
        },
      },
    ]);
  });

  it('createAnthropicProviderFromPlan wires credential and model', async () => {
    let seenUrl = '';
    const fetchMock: typeof fetch = async (input) => {
      seenUrl = String(input);
      return sseResponse([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]);
    };

    const provider = createAnthropicProviderFromPlan(
      {
        kind: 'provider-factory-plan',
        route: {
          routeId: 'anthropic-default',
          providerId: 'anthropic',
          requestedModel: 'claude-sonnet',
          model: 'claude-sonnet',
          upstreamModel: 'claude-sonnet-4-20250514',
          priority: 100,
          routingWeight: 1,
          healthScore: 1,
          fallback: false,
          credentialSourceType: 'api-key',
          credentialSource: { type: 'api-key', providerId: 'anthropic' },
        },
        credential: {
          id: 'cred',
          source: 'api-key',
          providerId: 'anthropic',
          apiKey: 'sk-ant-test',
          baseUrl: 'https://api.anthropic.com/v1',
        },
      },
      { fetch: fetchMock }
    );

    expect(provider.id).toBe('anthropic');
    const events = await collect(
      provider.stream({
        sessionId: 's',
        cwd: 'C:/repo',
        messages: [createTextMessage('user', 'hi')],
        tools: [],
        signal: new AbortController().signal,
      })
    );
    expect(seenUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(
      events.some((e: ProviderStreamEvent) => e.type === 'text-delta')
    ).toBe(true);
  });
});
