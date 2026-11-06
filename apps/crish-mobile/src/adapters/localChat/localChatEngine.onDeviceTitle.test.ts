// 引擎 · 端侧线程 AI 标题 providerId 透传测试（O4 补 O3 登记缺口）：
// 端侧线程首轮完成后，标题生成必须经分发客户端按 providerId 走端侧
// completeChatCompletion，不得误走 HTTP 路径（baseUrl 为空必然失败、
// 静默回退截断标题）。装配与 O3 引擎集成测试同口径：真引擎 + 真
// store + 假端侧客户端 + 计数型 HTTP 假传输。
import { waitFor } from '@testing-library/react-native';
import {
  resetLocalChatEngineForTest,
  sendLocalChatMessage,
} from './localChatEngine';
import {
  resetLocalChatClientForTest,
  setLocalChatClientForTest,
  setOnDeviceClientForTest,
} from './localChatWiring';
import type {
  CompleteChatInput,
  StreamChatInput,
} from './localChatClient';
import {
  configureLocalChatPersistence,
  configureLocalChatSecure,
  localChatStore,
} from '@/domain/store/localChatStore';
import {
  configureLocalChatSessionPersistence,
  localChatSessionStore,
} from '@/domain/store/localChatSessionStore';
import { InMemorySecureStore } from '@/db/secureStore';
import type { SettingsPersist } from '@/domain/store/settingsStore';

const MODEL_15B = 'qwen2.5-1.5b-instruct-q4_k_m';

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

describe('端侧线程 AI 标题（providerId 透传）', () => {
  let httpStreamCalls: unknown[];
  let httpJsonCalls: unknown[];
  let odStreamInputs: StreamChatInput[];
  let odCompleteInputs: CompleteChatInput[];

  beforeEach(() => {
    httpStreamCalls = [];
    httpJsonCalls = [];
    odStreamInputs = [];
    odCompleteInputs = [];
    configureLocalChatPersistence(new MemoryPersist());
    configureLocalChatSecure(new InMemorySecureStore());
    configureLocalChatSessionPersistence(null);
    setLocalChatClientForTest({
      streamTransport: (req) => {
        httpStreamCalls.push(req);
        return { abort: () => undefined };
      },
      jsonFetch: async (url, init) => {
        httpJsonCalls.push({ url, init });
        return {
          status: 200,
          text: JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'HTTP标题' } }],
          }),
        };
      },
    });
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
      completeChatCompletion: async (input) => {
        odCompleteInputs.push(input);
        return '本机标题';
      },
      fetchProviderModels: async () => [],
      checkConnectivity: async () => ({ ok: true, latencyMs: 1, error: null }),
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

  it('首轮完成 → 标题经端侧 complete 生成并以 ai 来源落盘，HTTP 面零触碰', async () => {
    await localChatStore.getState().upsertProvider('ondevice', {
      displayName: '本机模型',
      protocol: 'ondevice/gguf',
      models: [{ id: MODEL_15B, enabled: true }],
    });
    const threadId = localChatSessionStore.getState().createThread({
      providerId: 'ondevice',
      modelId: MODEL_15B,
    });

    expect(sendLocalChatMessage(threadId, '你好，本机模型')).toBe(true);

    // 标题调用带线程自己的 providerId（分发据此走端侧而非 HTTP）
    await waitFor(() => expect(odCompleteInputs.length).toBe(1));
    expect(odCompleteInputs[0]?.providerId).toBe('ondevice');
    expect(odCompleteInputs[0]?.model).toBe(MODEL_15B);
    expect(odStreamInputs[0]?.providerId).toBe('ondevice');
    expect(httpStreamCalls).toEqual([]);
    expect(httpJsonCalls).toEqual([]);

    // 标题以 ai 来源落盘（不再回退 derived 截断标题）
    await waitFor(() => {
      const meta = localChatSessionStore
        .getState()
        .threads.find((t) => t.id === threadId);
      expect(meta?.title).toBe('本机标题');
      expect(meta?.titleSource).toBe('ai');
    });
  });
});
