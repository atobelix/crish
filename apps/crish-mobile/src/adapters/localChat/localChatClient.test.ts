// 本地对话客户端测试：假传输注入——SSE 增量拼装、tool_calls 计数不执行、
// HTTP 错误分类穿透、停止生成、自检与模型列表的错误口径。
import {
  createLocalChatClient,
  type JsonFetch,
  type StreamHandlers,
  type StreamTransport,
} from './localChatClient';
import type { LocalChatError } from '@/domain/types/localChat';

interface FakeStream {
  transport: StreamTransport;
  emit: (chunk: string) => void;
  done: () => void;
  httpError: (status: number, body: string, retryAfterSec?: number) => void;
  networkError: () => void;
  aborted: () => boolean;
}

function makeFakeStream(): FakeStream {
  let handlers: StreamHandlers | null = null;
  let abortedFlag = false;
  return {
    transport: (_req, h) => {
      handlers = h;
      return {
        abort: () => {
          abortedFlag = true;
        },
      };
    },
    emit: (chunk) => handlers?.onChunk(chunk),
    done: () => handlers?.onDone(),
    httpError: (status, body, retryAfterSec) =>
      handlers?.onHttpError(status, body, retryAfterSec),
    networkError: () => handlers?.onNetworkError(),
    aborted: () => abortedFlag,
  };
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

const baseInput = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'm1',
  messages: [{ role: 'user' as const, content: '你好' }],
};

describe('streamChatCompletion', () => {
  it('SSE 增量拼装全文 + [DONE] 收尾；请求体不含 tools', () => {
    const fake = makeFakeStream();
    let capturedBody = '';
    const transport: StreamTransport = (req, h) => {
      capturedBody = req.body;
      return fake.transport(req, h);
    };
    const client = createLocalChatClient({ streamTransport: transport });
    const deltas: string[] = [];
    const completedList: Array<{ content: string; toolCallCount: number }> = [];
    client.streamChatCompletion(baseInput, {
      onTextDelta: (d) => deltas.push(d),
      onComplete: (r) => {
        completedList.push(r);
      },
      onError: () => {
        throw new Error('不应报错');
      },
    });
    expect(JSON.parse(capturedBody)).not.toHaveProperty('tools');
    fake.emit(
      sse({ choices: [{ delta: { content: '你' }, finish_reason: null }] })
    );
    fake.emit(
      sse({ choices: [{ delta: { content: '好' }, finish_reason: null }] }) +
        'data: [DONE]\n\n'
    );
    fake.done();
    expect(deltas).toEqual(['你', '好']);
    expect(completedList[0]?.content).toBe('你好');
    expect(completedList[0]?.toolCallCount).toBe(0);
  });

  it('tool_calls 只计数不执行（onComplete 携带计数，无任何执行面）', () => {
    const fake = makeFakeStream();
    const client = createLocalChatClient({ streamTransport: fake.transport });
    const completedList: Array<{ content: string; toolCallCount: number }> = [];
    client.streamChatCompletion(baseInput, {
      onTextDelta: () => {},
      onComplete: (r) => {
        completedList.push(r);
      },
      onError: () => {},
    });
    fake.emit(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: 'shell', arguments: '{"cmd":"rm"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    );
    fake.done();
    expect(completedList[0]?.toolCallCount).toBe(1);
    expect(completedList[0]?.content).toBe('');
  });

  it('401 → auth 错误穿透（message 已补齐中文）', () => {
    const fake = makeFakeStream();
    const client = createLocalChatClient({ streamTransport: fake.transport });
    const errors: LocalChatError[] = [];
    client.streamChatCompletion(baseInput, {
      onTextDelta: () => {},
      onComplete: () => {},
      onError: (e) => {
        errors.push(e);
      },
    });
    fake.httpError(401, '{"error":{"message":"invalid api key"}}');
    expect(errors[0]?.kind).toBe('auth');
    expect(errors[0]?.message).toContain('鉴权失败');
  });

  it('已出正文后网络失败 → stream 中断（非 network）', () => {
    const fake = makeFakeStream();
    const client = createLocalChatClient({ streamTransport: fake.transport });
    const errors: LocalChatError[] = [];
    client.streamChatCompletion(baseInput, {
      onTextDelta: () => {},
      onComplete: () => {},
      onError: (e) => {
        errors.push(e);
      },
    });
    fake.emit(
      sse({ choices: [{ delta: { content: '半' }, finish_reason: null }] })
    );
    fake.networkError();
    expect(errors[0]?.kind).toBe('stream');
  });

  it('abort 后迟到回调被吞（停止生成不报错、不完成）', () => {
    const fake = makeFakeStream();
    const client = createLocalChatClient({ streamTransport: fake.transport });
    let calls = 0;
    const handle = client.streamChatCompletion(baseInput, {
      onTextDelta: () => {
        calls += 1;
      },
      onComplete: () => {
        calls += 1;
      },
      onError: () => {
        calls += 1;
      },
    });
    handle.abort();
    expect(fake.aborted()).toBe(true);
    fake.emit(
      sse({ choices: [{ delta: { content: 'x' }, finish_reason: null }] })
    );
    fake.done();
    expect(calls).toBe(0);
  });
});

describe('fetchProviderModels / checkConnectivity', () => {
  it('模型列表成功解析；HTTP 404 模型字样外 → endpointUnavailable 抛出', async () => {
    const okFetch: JsonFetch = async () => ({
      status: 200,
      text: JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }),
    });
    const client = createLocalChatClient({ jsonFetch: okFetch });
    await expect(
      client.fetchProviderModels({ baseUrl: 'https://x/v1', apiKey: null })
    ).resolves.toEqual(['a', 'b']);

    const badFetch: JsonFetch = async () => ({ status: 404, text: 'nope' });
    const bad = createLocalChatClient({ jsonFetch: badFetch });
    await expect(
      bad.fetchProviderModels({ baseUrl: 'https://x/v1', apiKey: null })
    ).rejects.toMatchObject({ kind: 'endpointUnavailable' });
  });

  it('自检成功计耗时；鉴权失败如实分类；网络失败 → network', async () => {
    const okFetch: JsonFetch = async () => ({
      status: 200,
      text: '{"choices":[]}',
    });
    const client = createLocalChatClient({ jsonFetch: okFetch });
    const ok = await client.checkConnectivity({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
    });
    expect(ok.ok).toBe(true);
    expect(ok.error).toBeNull();

    const authFetch: JsonFetch = async () => ({ status: 401, text: '' });
    const authClient = createLocalChatClient({ jsonFetch: authFetch });
    const auth = await authClient.checkConnectivity({
      baseUrl: 'https://x/v1',
      apiKey: 'bad',
      model: 'm',
    });
    expect(auth.ok).toBe(false);
    expect(auth.error?.kind).toBe('auth');

    const downFetch: JsonFetch = async () => {
      throw new Error('offline');
    };
    const downClient = createLocalChatClient({ jsonFetch: downFetch });
    const down = await downClient.checkConnectivity({
      baseUrl: 'https://x/v1',
      apiKey: null,
      model: 'm',
    });
    expect(down.ok).toBe(false);
    expect(down.error?.kind).toBe('network');
  });
});

describe('completeChatCompletion（U4 一次性非流式补全）', () => {
  const completionInput = {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'm1',
    messages: [{ role: 'user' as const, content: '给这段对话起个标题' }],
  };

  it('成功：解析 message.content；请求体 stream=false/max_tokens=32/temperature=0.3 且无 tools', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    const jsonFetch: JsonFetch = async (url, init) => {
      capturedUrl = url;
      capturedBody = init.body ?? '';
      return {
        status: 200,
        text: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '秋日诗歌' } }],
        }),
      };
    };
    const client = createLocalChatClient({ jsonFetch });
    await expect(client.completeChatCompletion(completionInput)).resolves.toBe(
      '秋日诗歌'
    );
    expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions');
    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(32);
    expect(body.temperature).toBe(0.3);
    expect(body).not.toHaveProperty('tools');
  });

  it('HTTP 401 → reject auth 分类错误（与流式同分类口径）', async () => {
    const jsonFetch: JsonFetch = async () => ({
      status: 401,
      text: '{"error":{"message":"invalid api key"}}',
    });
    const client = createLocalChatClient({ jsonFetch });
    await expect(
      client.completeChatCompletion(completionInput)
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('网络失败 → reject network；响应非补全结构 → reject unknown', async () => {
    const downFetch: JsonFetch = async () => {
      throw new Error('offline');
    };
    const down = createLocalChatClient({ jsonFetch: downFetch });
    await expect(
      down.completeChatCompletion(completionInput)
    ).rejects.toMatchObject({ kind: 'network' });

    const junkFetch: JsonFetch = async () => ({
      status: 200,
      text: '{"hello":"world"}',
    });
    const junk = createLocalChatClient({ jsonFetch: junkFetch });
    await expect(
      junk.completeChatCompletion(completionInput)
    ).rejects.toMatchObject({ kind: 'unknown' });
  });
});
