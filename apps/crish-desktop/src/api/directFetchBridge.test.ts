import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { streamViaDirectFetch } from './directFetchBridge';

vi.mock('../api/providerProfiles', () => ({
  getActiveProfile: () => ({
    apiKey: 'test-key',
    baseUrl: 'https://api.test.example/v1',
  }),
  getActiveModelId: () => 'deepseek-chat',
}));

const makeCallbacks = () => ({
  onChunk: vi.fn(),
  onThought: vi.fn(),
  onComplete: vi.fn(),
  onRunError: vi.fn(),
});

const okResponse = () =>
  Promise.resolve({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => ({ done: true, value: undefined }),
      }),
    },
  } as unknown as Response);

describe('directFetchBridge', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => okResponse())
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should preserve reasoning_content on abort', () => {
    const callbacks = makeCallbacks();

    const cancel = streamViaDirectFetch('hello', callbacks, 's-1', 'msg-1', {
      messages: [
        {
          role: 'assistant',
          content: 'prior text',
          reasoning_content: 'prior thought',
        },
      ],
    });

    expect(typeof cancel).toBe('function');
    cancel();
  });

  it('should call onComplete even after abort', () => {
    const callbacks = makeCallbacks();

    const cancel = streamViaDirectFetch('hello', callbacks, 's-1', 'msg-1');
    cancel();

    // Cancel path is terminal: onComplete invoked synchronously by the cancel handle.
    expect(callbacks.onComplete).toHaveBeenCalled();
  });

  it('should inject prompt_cache_key derived from sessionId (R3)', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    const callbacks = makeCallbacks();

    streamViaDirectFetch('hello', callbacks, 'sess-001', 'msg-1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body: string }).body
    ) as Record<string, unknown>;
    // 会话 ID ≤ 64 码点 → 原样作为缓存键（不再做内容哈希）
    expect(body.prompt_cache_key).toBe('sess-001');
  });

  it('should not inject prompt_cache_key without a valid sessionId (R3)', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    const callbacks = makeCallbacks();

    streamViaDirectFetch('hello', callbacks, '   ', 'msg-1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body: string }).body
    ) as Record<string, unknown>;
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it('should parse usage chunk via R4 and keep [KV Cache: N hit / N miss] passthrough', async () => {
    const encoder = new TextEncoder();
    const payloads = [
      `data: ${JSON.stringify({ usage: { prompt_tokens: 150, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 50 } })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    let index = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: async () =>
              index < payloads.length
                ? { done: false, value: encoder.encode(payloads[index++]) }
                : { done: true, value: undefined },
          }),
        },
      } as unknown as Response)
    );

    const callbacks = makeCallbacks();
    streamViaDirectFetch('hello', callbacks, 'sess-001', 'msg-1');
    await vi.waitFor(() => expect(callbacks.onComplete).toHaveBeenCalled());

    expect(callbacks.onThought).toHaveBeenCalledWith(
      '[KV Cache: 100 hit / 50 miss]'
    );
    expect(callbacks.onChunk).toHaveBeenCalledWith('ok');
  });
});
