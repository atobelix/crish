// 端侧客户端与路由测试（O3）：
// - 客户端单测：假管理器 + 假 llama.rn 桥，验纯对话口径（带 tools
//   也不下发、onComplete 无 toolCalls）、错误映射（未下载 notConfigured、
//   损坏 unknown、init 失败带原始信息）、abort 转 stopCompletion、
//   上下文单例复用/切换、Qwen3 关思考、思考增量分离、零网络模型面；
// - 分发路由单测：按 providerId → protocol 走对客户端；
// - 引擎集成：真引擎 + 真 store + 假端侧客户端，验工具闸（端侧线程
//   不取工具声明、系统提示词无工具段、providerId 已填）与 HTTP 面零触碰。
import { waitFor } from '@testing-library/react-native';
import {
  createOnDeviceChatClient,
  type OnDeviceCompletionParams,
  type OnDeviceCompletionResult,
  type OnDeviceLlamaBridge,
  type OnDeviceLlamaContext,
  type OnDeviceTokenData,
} from './onDeviceChatClient';
import {
  findOnDeviceModel,
  ON_DEVICE_MODEL_CATALOG,
} from './onDeviceModelCatalog';
import type { OnDeviceModelState } from './onDeviceModelManager';
import type {
  LocalChatClient,
  StreamChatCallbacks,
  StreamChatInput,
} from '../localChat/localChatClient';
import {
  createDispatchingLocalChatClient,
  getLocalChatClient,
  resetLocalChatClientForTest,
  setLocalChatClientForTest,
  setOnDeviceClientForTest,
} from '../localChat/localChatWiring';
import {
  resetLocalChatEngineForTest,
  sendLocalChatMessage,
} from '../localChat/localChatEngine';
import {
  configureLocalChatPersistence,
  configureLocalChatSecure,
  localChatStore,
} from '@/domain/store/localChatStore';
import {
  configureLocalChatSessionPersistence,
  localChatSessionStore,
  threadRuntimeSnapshot,
} from '@/domain/store/localChatSessionStore';
import { InMemorySecureStore } from '@/db/secureStore';
import type { SettingsPersist } from '@/domain/store/settingsStore';
import type { LocalChatError } from '@/domain/types/localChat';

const MODEL_15B = 'qwen2.5-1.5b-instruct-q4_k_m';
const MODEL_QWEN3 = 'qwen3-1.7b-q4_k_m';
const MODEL_3B = 'qwen2.5-3b-instruct-q4_k_m';

// ── 假管理器 ──

type FakeManager = Pick<
  import('./onDeviceModelManager').OnDeviceModelManager,
  'check' | 'checkAll' | 'usageBytes' | 'spec'
>;

function makeFakeManager(opts: {
  readyIds?: ReadonlySet<string>;
  usage?: ReadonlyMap<string, number>;
}): FakeManager {
  const ready = opts.readyIds ?? new Set<string>();
  const stateOf = (modelId: string): OnDeviceModelState =>
    ready.has(modelId)
      ? {
          kind: 'ready',
          modelId,
          path: `/fake/crish-llm-models/${modelId}.gguf`,
          sizeBytes: 1000,
        }
      : { kind: 'missing', modelId };
  return {
    check: async (modelId: string) => stateOf(modelId),
    checkAll: async () => ON_DEVICE_MODEL_CATALOG.map((s) => stateOf(s.id)),
    usageBytes: async (modelId: string) => opts.usage?.get(modelId) ?? 0,
    spec: (modelId: string) => findOnDeviceModel(modelId),
  };
}

// ── 假 llama.rn 桥 ──

interface FakeScript {
  tokens?: OnDeviceTokenData[];
  result?: Partial<OnDeviceCompletionResult>;
  error?: Error;
  /** 挂起门：completion 等此 Promise 才返回（abort 测试用） */
  gate?: Promise<void>;
  /** release 失败注入（显式释放必须把失败抛给调用方） */
  releaseError?: Error;
}

const BASE_RESULT: OnDeviceCompletionResult = {
  text: '',
  content: '',
  reasoning_content: '',
  truncated: false,
  stopped_eos: true,
  stopped_word: '',
  stopped_limit: 0,
  interrupted: false,
};

class FakeContext implements OnDeviceLlamaContext {
  completionCalls: OnDeviceCompletionParams[] = [];
  stopCalls = 0;
  releaseCalls = 0;

  constructor(private readonly script: FakeScript) {}

  async completion(
    params: OnDeviceCompletionParams,
    onToken?: (data: OnDeviceTokenData) => void
  ): Promise<OnDeviceCompletionResult> {
    this.completionCalls.push(params);
    if (this.script.gate) await this.script.gate;
    if (this.script.error) throw this.script.error;
    for (const t of this.script.tokens ?? []) onToken?.(t);
    return { ...BASE_RESULT, ...this.script.result };
  }

  async stopCompletion(): Promise<void> {
    this.stopCalls += 1;
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
    if (this.script.releaseError) throw this.script.releaseError;
  }
}

class FakeBridge implements OnDeviceLlamaBridge {
  initCalls: Array<{
    model: string;
    n_ctx: number;
    n_gpu_layers: number;
    use_mlock: boolean;
  }> = [];
  contexts: FakeContext[] = [];
  script: FakeScript = {};
  initError: Error | null = null;

  async initLlama(params: {
    model: string;
    n_ctx: number;
    n_gpu_layers: number;
    use_mlock: boolean;
  }): Promise<OnDeviceLlamaContext> {
    this.initCalls.push(params);
    if (this.initError) throw this.initError;
    const ctx = new FakeContext(this.script);
    this.contexts.push(ctx);
    return ctx;
  }
}

// ── 回调记录 ──

interface CompleteResult {
  content: string;
  finishReason: string | null;
  toolCallCount: number;
  toolCalls?: unknown[];
  reasoning?: string;
}

function makeCallbacks() {
  const rec = {
    texts: [] as string[],
    reasonings: [] as string[],
    completes: [] as CompleteResult[],
    errors: [] as LocalChatError[],
    activities: 0,
  };
  const callbacks: StreamChatCallbacks = {
    onTextDelta: (d) => {
      rec.texts.push(d);
    },
    onReasoningDelta: (d) => {
      rec.reasonings.push(d);
    },
    onActivity: () => {
      rec.activities += 1;
    },
    onComplete: (r) => {
      rec.completes.push(r as CompleteResult);
    },
    onError: (e) => {
      rec.errors.push(e);
    },
  };
  return { rec, callbacks };
}

function streamInput(extra?: Partial<StreamChatInput>): StreamChatInput {
  return {
    baseUrl: '',
    apiKey: null,
    model: MODEL_15B,
    messages: [{ role: 'user', content: '你好' }],
    ...extra,
  };
}

async function flushAsync(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ── 客户端单测 ──

describe('onDeviceChatClient 流式', () => {
  it('带 tools 的输入也不下发：completion 参数无 tools/tool_choice，onComplete 无 toolCalls', async () => {
    const bridge = new FakeBridge();
    bridge.script = {
      tokens: [
        { token: '你', content: '你' },
        { token: '好', content: '好' },
      ],
      result: { content: '你好' },
    };
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_15B]) }),
      llama: bridge,
    });
    const { rec, callbacks } = makeCallbacks();

    client.streamChatCompletion(
      streamInput({
        tools: [{ type: 'function', function: { name: 'web_search' } }],
        toolChoice: 'auto',
      }),
      callbacks
    );

    await waitFor(() => expect(rec.completes.length).toBe(1));
    const params = bridge.contexts[0]!.completionCalls[0]!;
    expect(params).not.toHaveProperty('tools');
    expect(params).not.toHaveProperty('tool_choice');
    expect(rec.texts).toEqual(['你', '好']);
    expect(rec.completes[0]!.content).toBe('你好');
    expect(rec.completes[0]!.finishReason).toBe('stop');
    expect(rec.completes[0]!.toolCallCount).toBe(0);
    expect(rec.completes[0]!.toolCalls).toBeUndefined();
    expect(rec.errors).toEqual([]);
    // init 口径：纯 CPU + mlock + 默认上下文
    expect(bridge.initCalls[0]).toMatchObject({
      n_ctx: 4096,
      n_gpu_layers: 0,
      use_mlock: true,
    });
  });

  it('未下载模型 → onError notConfigured，且不触碰原生 init', async () => {
    const bridge = new FakeBridge();
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set() }),
      llama: bridge,
    });
    const { rec, callbacks } = makeCallbacks();
    client.streamChatCompletion(streamInput(), callbacks);
    await waitFor(() => expect(rec.errors.length).toBe(1));
    expect(rec.errors[0]!.kind).toBe('notConfigured');
    expect(rec.errors[0]!.message).not.toBe('');
    expect(rec.errors[0]!.detail).toContain('尚未下载');
    expect(bridge.initCalls).toEqual([]);
  });

  it('未知模型 id → notConfigured', async () => {
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set() }),
      llama: new FakeBridge(),
    });
    const { rec, callbacks } = makeCallbacks();
    client.streamChatCompletion(
      streamInput({ model: 'no-such-model' }),
      callbacks
    );
    await waitFor(() => expect(rec.errors.length).toBe(1));
    expect(rec.errors[0]!.kind).toBe('notConfigured');
    expect(rec.errors[0]!.detail).toContain('不在本机模型目录中');
  });

  it('文件在盘但未过就绪校验（损坏/未下完）→ unknown + 引导删除重下', async () => {
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({
        readyIds: new Set(),
        usage: new Map([[MODEL_15B, 123456]]),
      }),
      llama: new FakeBridge(),
    });
    const { rec, callbacks } = makeCallbacks();
    client.streamChatCompletion(streamInput(), callbacks);
    await waitFor(() => expect(rec.errors.length).toBe(1));
    expect(rec.errors[0]!.kind).toBe('unknown');
    expect(rec.errors[0]!.detail).toContain('删除后重新下载');
  });

  it('abort 转 stopCompletion，且迟到的 completion 结果不再触发任何回调', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const bridge = new FakeBridge();
    bridge.script = {
      gate,
      tokens: [{ token: '晚', content: '晚' }],
      result: { content: '晚' },
    };
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_15B]) }),
      llama: bridge,
    });
    const { rec, callbacks } = makeCallbacks();
    const handle = client.streamChatCompletion(streamInput(), callbacks);
    // 等 init 完成、completion 已挂起在 gate 上
    await waitFor(() =>
      expect(bridge.contexts[0]?.completionCalls.length ?? 0).toBe(1)
    );
    handle.abort();
    expect(bridge.contexts[0]!.stopCalls).toBe(1);
    releaseGate();
    await flushAsync();
    expect(rec.completes).toEqual([]);
    expect(rec.errors).toEqual([]);
    expect(rec.texts).toEqual([]);
  });

  it('initLlama 失败 → onError unknown 并带原始信息', async () => {
    const bridge = new FakeBridge();
    bridge.initError = new Error('boom-init');
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_15B]) }),
      llama: bridge,
    });
    const { rec, callbacks } = makeCallbacks();
    client.streamChatCompletion(streamInput(), callbacks);
    await waitFor(() => expect(rec.errors.length).toBe(1));
    expect(rec.errors[0]!.kind).toBe('unknown');
    expect(rec.errors[0]!.detail).toContain('boom-init');
  });

  it('上下文单例复用；切换模型 release 旧上下文且 3B 用 2048 上下文', async () => {
    const bridge = new FakeBridge();
    bridge.script = { result: { content: 'ok' } };
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({
        readyIds: new Set([MODEL_15B, MODEL_3B]),
      }),
      llama: bridge,
    });
    const run = async (model: string) => {
      const { rec, callbacks } = makeCallbacks();
      client.streamChatCompletion(streamInput({ model }), callbacks);
      await waitFor(() => expect(rec.completes.length).toBe(1));
    };
    await run(MODEL_15B);
    await run(MODEL_15B);
    expect(bridge.initCalls.length).toBe(1);
    await run(MODEL_3B);
    expect(bridge.initCalls.length).toBe(2);
    expect(bridge.initCalls[1]!.n_ctx).toBe(2048);
    expect(bridge.contexts[0]!.releaseCalls).toBe(1);
  });

  it('Qwen3 关思考：enable_thinking 与 chat_template_kwargs 双路下发 + im_end 停止词', async () => {
    const bridge = new FakeBridge();
    bridge.script = { result: { content: 'ok' } };
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_QWEN3]) }),
      llama: bridge,
    });
    const { rec, callbacks } = makeCallbacks();
    client.streamChatCompletion(
      streamInput({ model: MODEL_QWEN3 }),
      callbacks
    );
    await waitFor(() => expect(rec.completes.length).toBe(1));
    const params = bridge.contexts[0]!.completionCalls[0]!;
    expect(params.enable_thinking).toBe(false);
    expect(params.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(params.stop).toEqual(['<|im_end|>']);
  });

  it('思考增量经 reasoning_content 分离，正文不被污染', async () => {
    const bridge = new FakeBridge();
    bridge.script = {
      tokens: [
        { token: '想', content: '', reasoning_content: '想' },
        { token: '答', content: '答' },
      ],
      result: { content: '答', reasoning_content: '想' },
    };
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_QWEN3]) }),
      llama: bridge,
    });
    const { rec, callbacks } = makeCallbacks();
    client.streamChatCompletion(
      streamInput({ model: MODEL_QWEN3 }),
      callbacks
    );
    await waitFor(() => expect(rec.completes.length).toBe(1));
    expect(rec.reasonings).toEqual(['想']);
    expect(rec.texts).toEqual(['答']);
    expect(rec.completes[0]!.reasoning).toBe('想');
  });

  it('截断结束映射 finishReason=length', async () => {
    const bridge = new FakeBridge();
    bridge.script = {
      result: { content: '半截', truncated: true, stopped_eos: false },
    };
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_15B]) }),
      llama: bridge,
    });
    const { rec, callbacks } = makeCallbacks();
    client.streamChatCompletion(streamInput(), callbacks);
    await waitFor(() => expect(rec.completes.length).toBe(1));
    expect(rec.completes[0]!.finishReason).toBe('length');
  });

  it('消息映射：user 多模态 parts 只取文本、tool 消息跳过、assistant 空内容补空串', async () => {
    const bridge = new FakeBridge();
    bridge.script = { result: { content: 'ok' } };
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_15B]) }),
      llama: bridge,
    });
    const { rec, callbacks } = makeCallbacks();
    client.streamChatCompletion(
      streamInput({
        messages: [
          { role: 'system', content: '系统' },
          {
            role: 'user',
            content: [
              { type: 'text', text: '看图' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,x', detail: 'auto' },
              },
            ],
          },
          { role: 'assistant', content: null },
          { role: 'tool', tool_call_id: 'c1', content: '工具结果' },
          { role: 'user', content: '继续' },
        ],
      }),
      callbacks
    );
    await waitFor(() => expect(rec.completes.length).toBe(1));
    const params = bridge.contexts[0]!.completionCalls[0]!;
    expect(params.messages).toEqual([
      { role: 'system', content: '系统' },
      { role: 'user', content: '看图' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '继续' },
    ]);
  });
});

describe('onDeviceChatClient 非流式与模型面', () => {
  it('completeChatCompletion 返回正文全文（标题通道）', async () => {
    const bridge = new FakeBridge();
    bridge.script = { result: { content: '生成的标题' } };
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_15B]) }),
      llama: bridge,
    });
    const text = await client.completeChatCompletion({
      baseUrl: '',
      apiKey: null,
      model: MODEL_15B,
      messages: [{ role: 'user', content: '起个标题' }],
    });
    expect(text).toBe('生成的标题');
    const params = bridge.contexts[0]!.completionCalls[0]!;
    expect(params.n_predict).toBe(32);
    expect(params.temperature).toBe(0.3);
  });

  it('completeChatCompletion 未下载 → reject notConfigured', async () => {
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set() }),
      llama: new FakeBridge(),
    });
    await expect(
      client.completeChatCompletion({
        baseUrl: '',
        apiKey: null,
        model: MODEL_15B,
        messages: [{ role: 'user', content: 'x' }],
      })
    ).rejects.toMatchObject({ kind: 'notConfigured' });
  });

  it('fetchProviderModels 只列就绪模型（零网络）', async () => {
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({
        readyIds: new Set([MODEL_15B, MODEL_3B]),
      }),
      llama: new FakeBridge(),
    });
    await expect(
      client.fetchProviderModels({ baseUrl: '', apiKey: null })
    ).resolves.toEqual([MODEL_15B, MODEL_3B]);
    const robust = await client.fetchProviderModelsRobust({
      baseUrl: '',
      apiKey: null,
    });
    expect(robust.map((m) => m.id)).toEqual([MODEL_15B, MODEL_3B]);
    expect(robust[0]!.displayName).toContain('Qwen2.5-1.5B');
  });

  it('checkConnectivity / ping 以文件在位为真值', async () => {
    const ready = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_15B]) }),
      llama: new FakeBridge(),
    });
    const okRes = await ready.checkConnectivity({
      baseUrl: '',
      apiKey: null,
      model: MODEL_15B,
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.error).toBeNull();
    const pingOk = await ready.pingProviderEndpoint({ baseUrl: '' });
    expect(pingOk.ok).toBe(true);
    expect(pingOk.models?.length).toBe(1);

    const empty = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set() }),
      llama: new FakeBridge(),
    });
    const ngRes = await empty.checkConnectivity({
      baseUrl: '',
      apiKey: null,
      model: MODEL_15B,
    });
    expect(ngRes.ok).toBe(false);
    expect(ngRes.error?.kind).toBe('notConfigured');
    const pingNg = await empty.pingProviderEndpoint({ baseUrl: '' });
    expect(pingNg.ok).toBe(false);
    expect(pingNg.error?.kind).toBe('notConfigured');
  });
});

// ── 分发路由单测 ──

function makeMarkerClient(tag: string, calls: string[]): LocalChatClient {
  return {
    streamChatCompletion: (_input, callbacks) => {
      calls.push(`${tag}:stream`);
      callbacks.onComplete({
        content: tag,
        finishReason: 'stop',
        toolCallCount: 0,
      });
      return { abort: () => undefined };
    },
    completeChatCompletion: async () => {
      calls.push(`${tag}:complete`);
      return tag;
    },
    fetchProviderModels: async () => {
      calls.push(`${tag}:models`);
      return [tag];
    },
    checkConnectivity: async () => {
      calls.push(`${tag}:check`);
      return { ok: true, latencyMs: 1, error: null };
    },
    pingProviderEndpoint: async () => {
      calls.push(`${tag}:ping`);
      return { ok: true, latencyMs: 1, error: null };
    },
    fetchProviderModelsRobust: async () => {
      calls.push(`${tag}:robust`);
      return [];
    },
  };
}

describe('分发客户端按 protocol 路由', () => {
  it('ondevice/gguf 走端侧、其余走 HTTP；端侧工厂惰性且只组装一次', async () => {
    const calls: string[] = [];
    let factoryCalls = 0;
    const dispatch = createDispatchingLocalChatClient({
      http: makeMarkerClient('http', calls),
      onDevice: () => {
        factoryCalls += 1;
        return makeMarkerClient('od', calls);
      },
      resolveProtocol: (id) =>
        id === 'ondevice' ? 'ondevice/gguf' : 'openai/chat',
    });
    const { callbacks } = makeCallbacks();

    dispatch.streamChatCompletion(
      streamInput({ providerId: 'ondevice' }),
      callbacks
    );
    dispatch.streamChatCompletion(
      streamInput({ providerId: 'ondevice' }),
      callbacks
    );
    dispatch.streamChatCompletion(
      streamInput({ providerId: 'other' }),
      callbacks
    );
    dispatch.streamChatCompletion(streamInput(), callbacks);
    await dispatch.completeChatCompletion({
      baseUrl: '',
      apiKey: null,
      model: 'm',
      providerId: 'ondevice',
      messages: [],
    });
    await dispatch.fetchProviderModels({ baseUrl: '', apiKey: null });

    expect(calls).toEqual([
      'od:stream',
      'od:stream',
      'http:stream',
      'http:stream',
      'od:complete',
      'http:models',
    ]);
    expect(factoryCalls).toBe(1);
  });
});

// ── 引擎集成：工具闸 + providerId + 分发 ──

class MemoryPersist implements SettingsPersist {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async getAll(): Promise<ReadonlyArray<{ key: string; value: string }>> {
    return [...this.map.entries()].map(([key, value]) => ({ key, value }));
  }
}

describe('引擎工具闸（端侧线程）', () => {
  let httpStreamCalls: unknown[];
  let odStreamInputs: StreamChatInput[];

  beforeEach(() => {
    httpStreamCalls = [];
    odStreamInputs = [];
    configureLocalChatPersistence(new MemoryPersist());
    configureLocalChatSecure(new InMemorySecureStore());
    configureLocalChatSessionPersistence(null);
    setLocalChatClientForTest({
      streamTransport: (req) => {
        httpStreamCalls.push(req);
        return { abort: () => undefined };
      },
      jsonFetch: async () => ({
        status: 200,
        text: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '标题' } }],
        }),
      }),
    });
    // 假端侧客户端：记录入参，先流式增量再以纯文本完成（与真客户端
    // 同形：引擎正文只走 onTextDelta 增量通道，onComplete 不带正文）
    setOnDeviceClientForTest({
      streamChatCompletion: (input, callbacks) => {
        odStreamInputs.push(input);
        callbacks.onTextDelta('本机回复');
        callbacks.onComplete({
          content: '本机回复',
          finishReason: 'stop',
          toolCallCount: 0,
        });
        return { abort: () => undefined };
      },
      completeChatCompletion: async () => '本机标题',
      fetchProviderModels: async () => [],
      checkConnectivity: async () => ({
        ok: true,
        latencyMs: 1,
        error: null,
      }),
      pingProviderEndpoint: async () => ({
        ok: true,
        latencyMs: 1,
        error: null,
      }),
      fetchProviderModelsRobust: async () => [],
    });
    localChatStore.setState({
      config: { version: 2, providers: {}, activeModel: null },
      hydrated: true,
      keyPresence: {},
    });
    localChatSessionStore.setState({
      threads: [],
      activeThreadId: null,
      inactive: {},
      hydrated: true,
      completedAtByThread: {},
      messages: [],
      streaming: false,
      error: null,
    });
    resetLocalChatEngineForTest();
  });

  afterEach(() => {
    resetLocalChatClientForTest();
    resetLocalChatEngineForTest();
    configureLocalChatPersistence(null);
    configureLocalChatSecure(null);
    configureLocalChatSessionPersistence(null);
  });

  it('端侧线程：不取工具声明、系统提示词无工具段、providerId 已填、HTTP 面零触碰', async () => {
    await localChatStore.getState().upsertProvider('ondevice', {
      displayName: '本机模型',
      // vendor 字段可选：端侧内置条目不挂厂商预置（'ondevice' 枚举
      // 扩展涉及预置字典与多处 UI 映射，归 O4 裁决，本批不加）
      protocol: 'ondevice/gguf',
      models: [{ id: MODEL_15B, enabled: true }],
    });
    const threadId = localChatSessionStore.getState().createThread({
      providerId: 'ondevice',
      modelId: MODEL_15B,
    });

    expect(sendLocalChatMessage(threadId, '你好，本机模型')).toBe(true);
    await waitFor(() => expect(odStreamInputs.length).toBe(1));

    const input = odStreamInputs[0]!;
    expect(input.providerId).toBe('ondevice');
    expect(input.model).toBe(MODEL_15B);
    // 工具闸：入参根本不带工具声明
    expect(input.tools).toBeUndefined();
    expect(input.toolChoice).toBeUndefined();
    // 系统提示词走无工具版（无工具段标题）
    const system = input.messages.find((m) => m.role === 'system');
    expect(system?.content ?? '').not.toContain('端侧工具来辅助完成任务');
    // HTTP 传输零触碰（分发未误走 HTTP）
    expect(httpStreamCalls).toEqual([]);
    // 引擎经端侧完成回调正常收尾
    await waitFor(() => {
      const snap = threadRuntimeSnapshot(threadId);
      expect(
        snap?.messages.some(
          (m) => m.role === 'assistant' && m.content === '本机回复'
        )
      ).toBe(true);
    });
    expect(getLocalChatClient()).toBeDefined();
  });
});

describe('onDeviceChatClient 运行时只读面（L2 / IA §3.8）', () => {
  it('初始未加载：loadedModelId 为 null、isLoading 为 false', async () => {
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_15B]) }),
      llama: new FakeBridge(),
    });
    expect(client.loadedModelId()).toBeNull();
    expect(client.isLoading()).toBe(false);
  });

  it('loadModel 后可查已加载；releaseLoaded 后回 null 且原生 release 被调用', async () => {
    const bridge = new FakeBridge();
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_15B]) }),
      llama: bridge,
    });
    await client.loadModel(MODEL_15B);
    expect(client.loadedModelId()).toBe(MODEL_15B);
    expect(bridge.initCalls).toHaveLength(1);
    await client.releaseLoaded();
    expect(client.loadedModelId()).toBeNull();
    expect(bridge.contexts[0]!.releaseCalls).toBe(1);
  });

  it('loadModel 未就绪模型：抛诚实错误且不调 initLlama', async () => {
    const bridge = new FakeBridge();
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set() }),
      llama: bridge,
    });
    await expect(client.loadModel(MODEL_15B)).rejects.toMatchObject({
      kind: 'notConfigured',
    });
    expect(bridge.initCalls).toHaveLength(0);
    expect(client.loadedModelId()).toBeNull();
  });

  it('releaseLoaded 未加载时无操作不抛；释放失败时抛出（删文件前据此中止）', async () => {
    const bridge = new FakeBridge();
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_15B]) }),
      llama: bridge,
    });
    await expect(client.releaseLoaded()).resolves.toBeUndefined();
    await client.loadModel(MODEL_15B);
    // FakeContext 持有 script 引用：突变字段即可让已建上下文的 release 失败
    bridge.script.releaseError = new Error('native release boom');
    await expect(client.releaseLoaded()).rejects.toThrow(
      'native release boom'
    );
  });

  it('对话路径加载后运行时面同步可见（同一内存真源，不写 store）', async () => {
    const bridge = new FakeBridge();
    const client = createOnDeviceChatClient({
      manager: makeFakeManager({ readyIds: new Set([MODEL_15B]) }),
      llama: bridge,
    });
    const { rec, callbacks } = makeCallbacks();
    client.streamChatCompletion(streamInput(), callbacks);
    await flushAsync();
    expect(rec.errors).toHaveLength(0);
    expect(client.loadedModelId()).toBe(MODEL_15B);
  });
});
