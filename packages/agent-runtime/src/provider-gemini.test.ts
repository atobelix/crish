import { describe, expect, it } from 'vitest';
import {
  GeminiProvider,
  buildGeminiGenerateContentBody,
  createGeminiProviderFromPlan,
  createTextMessage,
  defineTextTool,
  resolveGeminiGenerateContentUrl,
  shouldUseGeminiProvider,
  toGeminiContents,
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

describe('Gemini request build', () => {
  it('resolves streamGenerateContent URL from baseUrl variants', () => {
    expect(
      resolveGeminiGenerateContentUrl(
        'https://generativelanguage.googleapis.com',
        'gemini-2.0-flash'
      )
    ).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse'
    );
    expect(
      resolveGeminiGenerateContentUrl(
        'https://generativelanguage.googleapis.com/v1beta',
        'gemini-2.0-flash'
      )
    ).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse'
    );
    expect(
      resolveGeminiGenerateContentUrl(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash',
        'ignored'
      )
    ).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse'
    );
    expect(
      resolveGeminiGenerateContentUrl(
        'https://generativelanguage.googleapis.com',
        'models/gemini-2.0-flash',
        {
          stream: false,
        }
      )
    ).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
    );
  });

  it('maps user/assistant/tool messages and tools into Gemini body', () => {
    const body = buildGeminiGenerateContentBody({
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
              id: 'call_1',
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
              toolCallId: 'call_1',
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
      maxOutputTokens: 1024,
    });

    expect(body.systemInstruction).toEqual({
      parts: [{ text: 'You are helpful.' }],
    });
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: 1024 });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'list files' }] },
      {
        role: 'model',
        parts: [
          { text: "I'll list." },
          {
            functionCall: {
              id: 'call_1',
              name: 'shell_command',
              args: { command: 'ls' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_1',
              name: 'shell_command',
              response: { result: 'a.txt' },
            },
          },
        ],
      },
    ]);
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'shell_command',
            description: 'Run command',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: true,
            },
          },
        ],
      },
    ]);
    expect(body.toolConfig).toEqual({
      functionCallingConfig: { mode: 'AUTO' },
    });
  });

  it('merges consecutive same-role messages', () => {
    const mapped = toGeminiContents([
      createTextMessage('user', 'a'),
      createTextMessage('user', 'b'),
      createTextMessage('assistant', 'c'),
    ]);
    expect(mapped).toEqual([
      {
        role: 'user',
        parts: [{ text: 'a' }, { text: 'b' }],
      },
      { role: 'model', parts: [{ text: 'c' }] },
    ]);
  });
});

describe('shouldUseGeminiProvider', () => {
  it('detects by providerId, family, and baseUrl', () => {
    expect(shouldUseGeminiProvider({ providerId: 'gemini' })).toBe(true);
    expect(shouldUseGeminiProvider({ providerId: 'google-ai-studio' })).toBe(
      true
    );
    expect(shouldUseGeminiProvider({ metadata: { family: 'gemini' } })).toBe(
      true
    );
    expect(
      shouldUseGeminiProvider({
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      })
    ).toBe(true);
    expect(
      shouldUseGeminiProvider({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        metadata: { family: 'openai-compatible' },
      })
    ).toBe(false);
    expect(
      shouldUseGeminiProvider({
        providerId: 'anthropic',
        metadata: { family: 'anthropic' },
      })
    ).toBe(false);
  });
});

describe('GeminiProvider', () => {
  it('parses streaming text deltas and stop', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse'
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-goog-api-key']).toBe('test-key');
      expect(headers['content-type']).toBe('application/json');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.contents).toBeDefined();
      expect(body.generationConfig).toMatchObject({
        maxOutputTokens: expect.any(Number),
      });

      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1,"totalTokenCount":11}}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4,"totalTokenCount":14}}\n\n',
      ]);
    };

    const provider = new GeminiProvider({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
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

  it('parses streaming functionCall parts', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"shell_command","args":{"command":"pwd"}}}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":12,"totalTokenCount":17}}\n\n',
      ]);

    const provider = new GeminiProvider({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'k',
      model: 'gemini-2.0-flash',
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
        id: 'gemini_fc_1',
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
          error: {
            code: 401,
            message: 'API key not valid',
            status: 'UNAUTHENTICATED',
          },
        }),
        {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
        }
      );

    const provider = new GeminiProvider({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'bad',
      model: 'gemini-2.0-flash',
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
    ).rejects.toThrow(/401.*UNAUTHENTICATED|API key not valid/i);
  });

  it('respects AbortSignal before fetch', async () => {
    let fetchCalls = 0;
    const fetchMock: typeof fetch = async () => {
      fetchCalls += 1;
      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"x"}],"role":"model"},"finishReason":"STOP"}]}\n\n',
      ]);
    };
    const controller = new AbortController();
    controller.abort();

    const provider = new GeminiProvider({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'k',
      model: 'gemini-2.0-flash',
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

  it('parses non-streaming JSON functionCall response', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'Using tool.' },
                  {
                    functionCall: {
                      id: 'fc_9',
                      name: 'shell_command',
                      args: { command: 'echo hi' },
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 3,
            candidatesTokenCount: 8,
            totalTokenCount: 11,
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      );

    const provider = new GeminiProvider({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'k',
      model: 'gemini-2.0-flash',
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
        id: 'fc_9',
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

  it('createGeminiProviderFromPlan wires credential and model', async () => {
    let seenUrl = '';
    let seenKey = '';
    const fetchMock: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenKey =
        (init?.headers as Record<string, string>)['x-goog-api-key'] ?? '';
      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":1,"totalTokenCount":1}}\n\n',
      ]);
    };

    const provider = createGeminiProviderFromPlan(
      {
        kind: 'provider-factory-plan',
        route: {
          routeId: 'gemini-default',
          providerId: 'gemini',
          requestedModel: 'gemini-2.0-flash',
          model: 'gemini-2.0-flash',
          upstreamModel: 'gemini-2.0-flash',
          priority: 100,
          routingWeight: 1,
          healthScore: 1,
          fallback: false,
          credentialSourceType: 'api-key',
          credentialSource: { type: 'api-key', providerId: 'gemini' },
        },
        credential: {
          id: 'cred',
          source: 'api-key',
          providerId: 'gemini',
          apiKey: 'g-test-key',
          baseUrl: 'https://generativelanguage.googleapis.com',
        },
      },
      { fetch: fetchMock }
    );

    expect(provider.id).toBe('gemini');
    const events = await collect(
      provider.stream({
        sessionId: 's',
        cwd: 'C:/repo',
        messages: [createTextMessage('user', 'hi')],
        tools: [],
        signal: new AbortController().signal,
      })
    );
    expect(seenUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse'
    );
    expect(seenKey).toBe('g-test-key');
    expect(
      events.some((e: ProviderStreamEvent) => e.type === 'text-delta')
    ).toBe(true);
  });
});
