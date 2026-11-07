// 本地对话引擎 · AI 标题触发测试（U4）：首轮完成点 fire-and-forget 生成——
// 成功落盘（经 store 来源阶梯 + DAO）、失败静默回退 derived、每线程至多
// 一次、用户改名后迟到结果被丢弃、首轮报错不触发。假传输 + 假 jsonFetch，
// 与本地引擎适配器测试同一装配口径。
import { waitFor } from '@testing-library/react-native';
import {
  CIRCUIT_BREAKER_MAX_ROUNDS_PROMPT,
  isLocalThreadStreaming,
  regenerateLocalThread,
  resetLocalChatEngineForTest,
  sendLocalChatMessage,
  setLocalChatToolExecutorForTest,
  stopLocalChatMessage,
} from './localChatEngine';
import {
  getLocalChatClient,
  resetLocalChatClientForTest,
  setLocalChatClientForTest,
} from './localChatWiring';
import type {
  JsonFetch,
  StreamHandlers,
  StreamRequest,
  StreamTransport,
} from './localChatClient';
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
import { MemorySqlDriver } from '@/db/driver';
import { migrateIfNeeded } from '@/db/db';
import {
  SqlLocalThreadsDao,
  type LocalThreadsDao,
} from '@/db/dao/localThreadsDao';

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

let capturedRequests: StreamRequest[] = [];
let streamHandlers: StreamHandlers | null = null;
let abortTriggered = false;

const fakeTransport: StreamTransport = (req, h) => {
  capturedRequests.push(req);
  streamHandlers = h;
  return {
    abort: () => {
      abortTriggered = true;
    },
  };
};

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

/** 标题请求计数 + 最近一次请求体（jsonFetch 只被一次性补全使用） */
let titleCalls: Array<{ url: string; body?: string }> = [];
let titleResponder: JsonFetch = async () => ({
  status: 200,
  text: JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '默认标题' } }],
  }),
});
const countingJsonFetch: JsonFetch = async (url, init) => {
  titleCalls.push({ url, body: init.body });
  return titleResponder(url, init);
};

async function freshDao(): Promise<LocalThreadsDao> {
  const driver = new MemorySqlDriver();
  await migrateIfNeeded(driver);
  return new SqlLocalThreadsDao(driver);
}

/** 等若干拍，让 fire-and-forget 的标题链（读密钥 → 请求 → 落盘）走完 */
async function flushAsync(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(async () => {
  capturedRequests = [];
  streamHandlers = null;
  abortTriggered = false;
  titleCalls = [];
  titleResponder = async () => ({
    status: 200,
    text: JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '默认标题' } }],
    }),
  });
  configureLocalChatPersistence(new MemoryPersist());
  configureLocalChatSecure(new InMemorySecureStore());
  setLocalChatClientForTest({
    streamTransport: fakeTransport,
    jsonFetch: countingJsonFetch,
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
  configureLocalChatSessionPersistence(null);
  await localChatStore.getState().upsertProvider(
    'p1',
    {
      displayName: '测试供应商',
      baseUrl: 'https://api.example.com/v1',
      protocol: 'openai/chat',
      models: [{ id: 'm1', enabled: true }],
    },
    'sk-engine'
  );
});

afterEach(() => {
  resetLocalChatClientForTest();
  resetLocalChatEngineForTest();
  configureLocalChatPersistence(null);
  configureLocalChatSecure(null);
  configureLocalChatSessionPersistence(null);
});

/** 发送一轮并以假传输完成流式（assistant 正文 = assistantText） */
async function sendAndComplete(
  threadId: string,
  userText: string,
  assistantText: string
): Promise<void> {
  streamHandlers = null;
  expect(sendLocalChatMessage(threadId, userText)).toBe(true);
  await waitFor(() => expect(streamHandlers).not.toBeNull());
  const handlers = streamHandlers!;
  handlers.onChunk(
    sse({
      choices: [{ delta: { content: assistantText }, finish_reason: 'stop' }],
    })
  );
  handlers.onDone();
}

function metaOf(threadId: string) {
  return localChatSessionStore
    .getState()
    .threads.find((t) => t.id === threadId);
}

describe('AI 标题触发（首轮完成点）', () => {
  it('生成成功：消毒后以 ai 来源落盘（DAO 读回一致），请求为非流式小调用', async () => {
    const dao = await freshDao();
    configureLocalChatSessionPersistence(dao);
    titleResponder = async () => ({
      status: 200,
      text: JSON.stringify({
        choices: [
          { message: { role: 'assistant', content: '“秋日诗歌创作”' } },
        ],
      }),
    });
    const threadId = localChatSessionStore.getState().createThread();
    await sendAndComplete(threadId, '帮我写一首关于秋天的诗', '秋叶飘落的回答');

    await waitFor(() => expect(metaOf(threadId)?.titleSource).toBe('ai'));
    expect(metaOf(threadId)?.title).toBe('秋日诗歌创作');
    expect(titleCalls).toHaveLength(1);
    const body = JSON.parse(titleCalls[0]?.body ?? '{}') as {
      stream?: boolean;
      max_tokens?: number;
      messages?: Array<{ role: string }>;
    };
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(32);
    expect(body.messages?.[0]?.role).toBe('system');
    // 落盘：DAO 直读标题与来源
    await flushAsync();
    const persisted = await dao.listThreads();
    expect(persisted.find((t) => t.id === threadId)).toMatchObject({
      title: '秋日诗歌创作',
      titleSource: 'ai',
    });
  });

  it('生成失败（HTTP 500）：静默回退 derived 截断标题，不进线程错误槽', async () => {
    titleResponder = async () => ({
      status: 500,
      text: '{"error":{"message":"server boom"}}',
    });
    const threadId = localChatSessionStore.getState().createThread();
    await sendAndComplete(threadId, '帮我写一首关于秋天的诗', '回答内容');
    await flushAsync();
    expect(titleCalls).toHaveLength(1);
    const meta = metaOf(threadId);
    expect(meta?.title).toBe('帮我写一首关于秋天的诗');
    expect(meta?.titleSource).toBe('derived');
    expect(localChatSessionStore.getState().error).toBeNull();
  });

  it('每线程至多一次：第二轮完成不再发起标题请求', async () => {
    const threadId = localChatSessionStore.getState().createThread();
    await sendAndComplete(threadId, '第一个问题', '第一个回答');
    await waitFor(() => expect(metaOf(threadId)?.titleSource).toBe('ai'));
    expect(titleCalls).toHaveLength(1);
    await sendAndComplete(threadId, '第二个问题', '第二个回答');
    await flushAsync();
    expect(titleCalls).toHaveLength(1);
  });

  it('迟到结果丢弃：生成在途时用户改名（user），AI 结果到达后不覆盖', async () => {
    const titleGate: {
      resolve: ((v: { status: number; text: string }) => void) | null;
    } = { resolve: null };
    titleResponder = () =>
      new Promise((resolve) => {
        titleGate.resolve = resolve;
      });
    const threadId = localChatSessionStore.getState().createThread();
    await sendAndComplete(threadId, '问题', '回答');
    await waitFor(() => expect(titleCalls).toHaveLength(1));
    // 用户在 AI 结果回来前改名
    expect(
      localChatSessionStore
        .getState()
        .setThreadTitle(threadId, '用户标题', 'user')
    ).toBe(true);
    titleGate.resolve?.({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'AI 迟到标题' } }],
      }),
    });
    await flushAsync();
    expect(metaOf(threadId)?.title).toBe('用户标题');
    expect(metaOf(threadId)?.titleSource).toBe('user');
  });

  it('首轮流式报错不触发标题生成（只在 onComplete 触发）', async () => {
    const threadId = localChatSessionStore.getState().createThread();
    streamHandlers = null;
    expect(sendLocalChatMessage(threadId, '会失败的问题')).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());
    streamHandlers!.onHttpError(500, '{"error":{"message":"boom"}}');
    await flushAsync();
    expect(titleCalls).toHaveLength(0);
    expect(metaOf(threadId)?.titleSource).toBe('derived');
  });
});

describe('思考档位决策与流式编排（Thinking Orchestration）', () => {
  it('在 localChatStore 中配置支持深度思考且 defaultTier 为 xhigh 的模型，sendLocalChatMessage 时向 streamChatCompletion 正确传入 thinkingTier 与 thinkingFormat', async () => {
    await localChatStore.getState().upsertProvider(
      'p-deepseek',
      {
        vendor: 'deepseek',
        displayName: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        protocol: 'openai/chat',
        models: [
          {
            id: 'deepseek-reasoner',
            enabled: true,
            maxOutputTokens: 16384,
            thinking: {
              supported: true,
              availableTiers: ['off', 'low', 'medium', 'high', 'xhigh'],
              defaultTier: 'xhigh',
            },
          },
        ],
      },
      'sk-deepseek'
    );

    const client = getLocalChatClient();
    const streamSpy = jest.spyOn(client, 'streamChatCompletion');

    const threadId = localChatSessionStore.getState().createThread({
      providerId: 'p-deepseek',
      modelId: 'deepseek-reasoner',
    });

    expect(sendLocalChatMessage(threadId, '请开始深度推理')).toBe(true);

    await waitFor(() => expect(streamSpy).toHaveBeenCalled());
    const [streamInput] = streamSpy.mock.calls[0]!;

    expect(streamInput.model).toBe('deepseek-reasoner');
    expect(streamInput.thinkingTier).toBe('xhigh');
    expect(streamInput.thinkingFormat).toBe('deepseek');
    expect(streamInput.maxTokens).toBe(16384);

    streamSpy.mockRestore();
  });

  it('当模型未开启深度思考时，thinkingTier 保持 undefined', async () => {
    await localChatStore.getState().upsertProvider(
      'p-openai',
      {
        vendor: 'openai',
        displayName: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        protocol: 'openai/chat',
        models: [
          {
            id: 'gpt-4o',
            enabled: true,
            thinking: {
              supported: false,
              availableTiers: ['off'],
              defaultTier: 'off',
            },
          },
        ],
      },
      'sk-openai'
    );

    const client = getLocalChatClient();
    const streamSpy = jest.spyOn(client, 'streamChatCompletion');

    const threadId = localChatSessionStore.getState().createThread({
      providerId: 'p-openai',
      modelId: 'gpt-4o',
    });

    expect(sendLocalChatMessage(threadId, '普通对话')).toBe(true);

    await waitFor(() => expect(streamSpy).toHaveBeenCalled());
    const [streamInput] = streamSpy.mock.calls[0]!;

    expect(streamInput.model).toBe('gpt-4o');
    expect(streamInput.thinkingTier).toBeUndefined();
    expect(streamInput.thinkingFormat).toBe('openai');

    streamSpy.mockRestore();
  });

  it('当收到思考流式增量回调时，会触发 localChatSessionStore.appendAssistantReasoningDelta', async () => {
    await localChatStore.getState().upsertProvider(
      'p-deepseek',
      {
        vendor: 'deepseek',
        displayName: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        protocol: 'openai/chat',
        models: [
          {
            id: 'deepseek-reasoner',
            enabled: true,
            thinking: {
              supported: true,
              availableTiers: ['off', 'xhigh'],
              defaultTier: 'xhigh',
            },
          },
        ],
      },
      'sk-deepseek'
    );

    const client = getLocalChatClient();
    const streamSpy = jest.spyOn(client, 'streamChatCompletion');
    const appendReasoningSpy = jest.spyOn(
      localChatSessionStore.getState(),
      'appendAssistantReasoningDelta'
    );

    const threadId = localChatSessionStore.getState().createThread({
      providerId: 'p-deepseek',
      modelId: 'deepseek-reasoner',
    });

    expect(sendLocalChatMessage(threadId, '思考测试')).toBe(true);
    await waitFor(() => expect(streamSpy).toHaveBeenCalled());
    const [, callbacks] = streamSpy.mock.calls[0]!;

    // 触发思考增量回调：在微批窗口内密集合并
    callbacks.onReasoningDelta?.('步骤 1：分析输入参数...');
    callbacks.onReasoningDelta?.('步骤 2：完成推导。');
    await waitFor(() => expect(appendReasoningSpy).toHaveBeenCalledTimes(1));
    expect(appendReasoningSpy).toHaveBeenCalledWith(
      expect.any(String),
      '步骤 1：分析输入参数...步骤 2：完成推导。'
    );

    // 验证 store 中的助手消息状态
    const snapshot = threadRuntimeSnapshot(threadId);
    const assistantMsg = snapshot?.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.reasoning).toBe(
      '步骤 1：分析输入参数...步骤 2：完成推导。'
    );
    expect(assistantMsg?.isThinking).toBe(true);

    // 模拟正文增量到达与完成（onComplete 强制立即 flush 未派发的增量）
    callbacks.onTextDelta('最终结论：证明成立。');
    await callbacks.onComplete({
      content: '最终结论：证明成立。',
      finishReason: 'stop',
      toolCallCount: 0,
    });

    const finalSnapshot = threadRuntimeSnapshot(threadId);
    const finalAssistant = finalSnapshot?.messages.find(
      (m) => m.role === 'assistant'
    );
    expect(finalAssistant?.content).toBe('最终结论：证明成立。');
    expect(finalAssistant?.reasoning).toBe(
      '步骤 1：分析输入参数...步骤 2：完成推导。'
    );
    expect(finalAssistant?.isThinking).toBe(false);

    streamSpy.mockRestore();
    appendReasoningSpy.mockRestore();
  });
});

describe('时间线流式微批调度器（StreamBatchScheduler）', () => {
  it('生成中密集吐词在 33ms 缓冲窗口内微批合并推入 store，削减状态派发', async () => {
    const threadId = localChatSessionStore.getState().createThread();
    streamHandlers = null;
    expect(sendLocalChatMessage(threadId, '微批合并测试')).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());
    const handlers = streamHandlers!;

    let notifyCount = 0;
    const unsub = localChatSessionStore.subscribe(() => {
      notifyCount++;
    });

    // 连续密集吐出 4 个 SSE chunk
    handlers.onChunk(
      sse({ choices: [{ delta: { content: '微' }, finish_reason: null }] })
    );
    handlers.onChunk(
      sse({ choices: [{ delta: { content: '批' }, finish_reason: null }] })
    );
    handlers.onChunk(
      sse({ choices: [{ delta: { content: '调' }, finish_reason: null }] })
    );
    handlers.onChunk(
      sse({ choices: [{ delta: { content: '度' }, finish_reason: null }] })
    );

    // 此时在 33ms 缓冲窗口内，未向 store 派发
    expect(threadRuntimeSnapshot(threadId)?.messages[1]?.content).toBe('');
    expect(notifyCount).toBe(0);

    // 33ms 窗口超时后，合并为 1 次派发
    await waitFor(() =>
      expect(threadRuntimeSnapshot(threadId)?.messages[1]?.content).toBe(
        '微批调度'
      )
    );
    expect(notifyCount).toBe(1);

    handlers.onDone();
    await waitFor(() => expect(isLocalThreadStreaming(threadId)).toBe(false));
    unsub();
  });

  it('生成完成 onDone 时强制同步立即 flush 未派发的缓冲增量，确保 100% 内容无损落盘', async () => {
    const threadId = localChatSessionStore.getState().createThread();
    streamHandlers = null;
    expect(sendLocalChatMessage(threadId, '完成刷新测试')).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());
    const handlers = streamHandlers!;

    handlers.onChunk(
      sse({
        choices: [
          { delta: { content: '未出缓冲区的尾巴' }, finish_reason: 'stop' },
        ],
      })
    );
    // 立即结束流，不等 33ms 定时器
    handlers.onDone();

    await waitFor(() => expect(isLocalThreadStreaming(threadId)).toBe(false));
    const snap = threadRuntimeSnapshot(threadId);
    expect(snap?.messages[1]?.content).toBe('未出缓冲区的尾巴');
  });

  it('用户主动停止 stopLocalChatMessage 时强制同步立即 flush 未派发的缓冲增量', async () => {
    const threadId = localChatSessionStore.getState().createThread();
    streamHandlers = null;
    expect(sendLocalChatMessage(threadId, '停止刷新测试')).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());
    const handlers = streamHandlers!;

    handlers.onChunk(
      sse({
        choices: [
          {
            delta: { content: '停止前缓冲区内的内容' },
            finish_reason: null,
          },
        ],
      })
    );
    // 立即停止
    stopLocalChatMessage(threadId);

    expect(isLocalThreadStreaming(threadId)).toBe(false);
    const snap = threadRuntimeSnapshot(threadId);
    expect(snap?.messages[1]?.content).toBe('停止前缓冲区内的内容');
    expect(snap?.messages[1]?.stopped).toBe(true);
  });

  it('流式异常 onHttpError 时强制同步立即 flush 未派发的缓冲增量', async () => {
    const threadId = localChatSessionStore.getState().createThread();
    streamHandlers = null;
    expect(sendLocalChatMessage(threadId, '异常刷新测试')).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());
    const handlers = streamHandlers!;

    handlers.onChunk(
      sse({
        choices: [
          {
            delta: { content: '错误发生前的有效文字' },
            finish_reason: null,
          },
        ],
      })
    );
    // 立即触发错误
    handlers.onHttpError(500, 'Internal Server Error');

    await waitFor(() => expect(isLocalThreadStreaming(threadId)).toBe(false));
    const snap = threadRuntimeSnapshot(threadId);
    expect(snap?.messages[1]?.content).toBe('错误发生前的有效文字');
    expect(snap?.messages[1]?.streaming).toBeFalsy();
  });
});

describe('多轮本地 Agent 循环（Local Agent Loop）', () => {
  it('纯文本单轮流式输出正常完成', async () => {
    const threadId = localChatSessionStore.getState().createThread();
    streamHandlers = null;
    expect(sendLocalChatMessage(threadId, '你好，测试纯文本')).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());
    expect(isLocalThreadStreaming(threadId)).toBe(true);

    const handlers = streamHandlers!;
    handlers.onChunk(
      sse({
        choices: [{ delta: { content: '你好！我是' }, finish_reason: null }],
      })
    );
    handlers.onChunk(
      sse({
        choices: [
          { delta: { content: '你的本地助手。' }, finish_reason: 'stop' },
        ],
      })
    );
    handlers.onDone();

    await waitFor(() => expect(isLocalThreadStreaming(threadId)).toBe(false));

    const snap = threadRuntimeSnapshot(threadId);
    expect(snap?.messages).toHaveLength(2);
    expect(snap?.messages[0]?.role).toBe('user');
    expect(snap?.messages[0]?.content).toBe('你好，测试纯文本');
    expect(snap?.messages[1]?.role).toBe('assistant');
    expect(snap?.messages[1]?.content).toBe('你好！我是你的本地助手。');
    expect(snap?.messages[1]?.streaming).toBeFalsy();
    expect(localChatSessionStore.getState().streaming).toBe(false);
  });

  it('重新生成（D-REGEN）：截断旧回答及其后轮次，保留提问并重启新一轮流式', async () => {
    const threadId = localChatSessionStore.getState().createThread();
    streamHandlers = null;
    expect(sendLocalChatMessage(threadId, '重新生成的锚点提问')).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());
    const first = streamHandlers!;
    first.onChunk(
      sse({
        choices: [{ delta: { content: '第一版回答' }, finish_reason: 'stop' }],
      })
    );
    first.onDone();
    await waitFor(() => expect(isLocalThreadStreaming(threadId)).toBe(false));

    const before = threadRuntimeSnapshot(threadId)!;
    expect(before.messages).toHaveLength(2);
    const oldAssistantId = before.messages[1]!.id;

    // 重新生成：旧回答及其后全部消息被截断，提问保留，新一轮开始流式
    expect(regenerateLocalThread(threadId, oldAssistantId)).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());

    const after = threadRuntimeSnapshot(threadId)!;
    expect(after.messages).toHaveLength(2);
    expect(after.messages[0]!.content).toBe('重新生成的锚点提问');
    expect(after.messages[1]!.id).not.toBe(oldAssistantId);
    expect(after.messages[1]!.role).toBe('assistant');
    expect(after.messages[1]!.streaming).toBe(true);
    expect(isLocalThreadStreaming(threadId)).toBe(true);

    // 新一轮内容到达并收口
    streamHandlers!.onChunk(
      sse({
        choices: [{ delta: { content: '第二版回答' }, finish_reason: 'stop' }],
      })
    );
    streamHandlers!.onDone();
    await waitFor(() => expect(isLocalThreadStreaming(threadId)).toBe(false));

    const final = threadRuntimeSnapshot(threadId)!;
    expect(final.messages).toHaveLength(2);
    expect(final.messages[1]!.content).toBe('第二版回答');
    expect(final.messages[1]!.streaming).toBeFalsy();
  });

  it('重新生成诚实 no-op：生成中 / 助手消息不存在 / 无锚点提问 / 线程不存在', async () => {
    const threadId = localChatSessionStore.getState().createThread();
    streamHandlers = null;
    expect(sendLocalChatMessage(threadId, '生成中的提问')).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());

    // 生成中：拒绝重新生成
    expect(regenerateLocalThread(threadId, '不存在的助手消息')).toBe(false);
    expect(isLocalThreadStreaming(threadId)).toBe(true);
    stopLocalChatMessage(threadId);
    await waitFor(() => expect(isLocalThreadStreaming(threadId)).toBe(false));

    // 无锚点提问（截断点前没有 user）：全新线程直接放一条助手消息
    const noAnchorThread = localChatSessionStore.getState().createThread();
    localChatSessionStore.getState().beginAssistant({
      id: 'lcm-noanchor',
      role: 'assistant',
      content: '',
    });
    localChatSessionStore.getState().finishAssistant('lcm-noanchor', {
      content: '无锚点回答',
    });
    expect(regenerateLocalThread(noAnchorThread, 'lcm-noanchor')).toBe(false);

    // 线程不存在
    expect(regenerateLocalThread('lth-not-exist', 'lcm-x')).toBe(false);
  });

  it('单轮工具调用并返回最终总结（多轮 Agent Loop 流转断言）', async () => {
    const executedCalls: any[] = [];
    setLocalChatToolExecutorForTest(async (tc, ctx) => {
      executedCalls.push({ tc, signalAborted: ctx.signal.aborted });
      return JSON.stringify({
        results: [
          {
            title: 'React Native 0.76 Release',
            snippet: 'New Architecture is enabled by default in 0.76.',
          },
        ],
      });
    });

    const threadId = localChatSessionStore.getState().createThread();
    expect(
      sendLocalChatMessage(threadId, '请帮我搜索 React Native 0.76 新特性')
    ).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());
    expect(capturedRequests).toHaveLength(1);

    // 第一轮：模型请求调用 web_search
    const round1Handlers = streamHandlers!;
    round1Handlers.onChunk(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_search_1',
                  function: {
                    name: 'web_search',
                    arguments: JSON.stringify({ query: 'React Native 0.76' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    );
    round1Handlers.onDone();

    // 等待工具执行并进入第二轮
    await waitFor(() => expect(capturedRequests.length).toBe(2));
    expect(executedCalls).toHaveLength(1);
    expect(executedCalls[0].tc.name).toBe('web_search');
    expect(executedCalls[0].signalAborted).toBe(false);

    // 检查第二轮请求入参中的 wire messages
    const round2Req = capturedRequests[1]!;
    const round2Body = JSON.parse(round2Req.body) as {
      messages: Array<{
        role: string;
        content?: any;
        tool_calls?: any;
        tool_call_id?: string;
      }>;
    };
    expect(
      round2Body.messages.some(
        (m) => m.role === 'tool' && m.tool_call_id === 'call_search_1'
      )
    ).toBe(true);
    const assistantWithToolCalls = round2Body.messages.find(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.length > 0
    );
    expect(assistantWithToolCalls).toBeDefined();

    // 第二轮：模型输出最终总结
    const round2Handlers = streamHandlers!;
    round2Handlers.onChunk(
      sse({
        choices: [
          {
            delta: { content: 'React Native 0.76 默认启用了新架构。' },
            finish_reason: 'stop',
          },
        ],
      })
    );
    round2Handlers.onDone();

    await waitFor(() => expect(isLocalThreadStreaming(threadId)).toBe(false));

    // 验证线程消息链完整性：user -> assistant(tool_calls) -> tool -> assistant(summary)
    const snap = threadRuntimeSnapshot(threadId);
    expect(snap?.messages).toHaveLength(4);
    expect(snap?.messages[0]?.role).toBe('user');
    expect(snap?.messages[1]?.role).toBe('assistant');
    expect(snap?.messages[1]?.toolCalls).toBeDefined();
    expect(snap?.messages[1]?.toolCalls?.[0]?.id).toBe('call_search_1');
    expect(snap?.messages[2]?.role).toBe('tool');
    expect(snap?.messages[2]?.toolCallId).toBe('call_search_1');
    expect(snap?.messages[3]?.role).toBe('assistant');
    expect(snap?.messages[3]?.content).toBe(
      'React Native 0.76 默认启用了新架构。'
    );
  });

  it('多轮工具级联调用断言（Round 1 search -> Round 2 fetch -> Round 3 终答）', async () => {
    const executedTools: string[] = [];
    setLocalChatToolExecutorForTest(async (tc) => {
      executedTools.push(tc.name);
      if (tc.name === 'web_search') {
        return JSON.stringify({ url: 'https://example.com/rn076' });
      }
      if (tc.name === 'web_fetch') {
        return 'Detailed article text on New Architecture in React Native 0.76.';
      }
      return 'ok';
    });

    const threadId = localChatSessionStore.getState().createThread();
    expect(sendLocalChatMessage(threadId, '请深入调研 RN 0.76 并总结')).toBe(
      true
    );
    await waitFor(() => expect(capturedRequests.length).toBe(1));

    // Round 1 -> web_search
    streamHandlers!.onChunk(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_search',
                  function: {
                    name: 'web_search',
                    arguments: '{"query":"rn076"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    );
    streamHandlers!.onDone();

    // 等待进入 Round 2
    await waitFor(() => expect(capturedRequests.length).toBe(2));
    expect(executedTools).toEqual(['web_search']);

    // Round 2 -> web_fetch
    streamHandlers!.onChunk(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_fetch',
                  function: {
                    name: 'web_fetch',
                    arguments: '{"url":"https://example.com/rn076"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    );
    streamHandlers!.onDone();

    // 等待进入 Round 3
    await waitFor(() => expect(capturedRequests.length).toBe(3));
    expect(executedTools).toEqual(['web_search', 'web_fetch']);

    // Round 3 -> 最终总结
    streamHandlers!.onChunk(
      sse({
        choices: [
          {
            delta: {
              content:
                '总结：经过网页检索与深度抓取，确认 RN 0.76 新架构全面默认开启。',
            },
            finish_reason: 'stop',
          },
        ],
      })
    );
    streamHandlers!.onDone();

    await waitFor(() => expect(isLocalThreadStreaming(threadId)).toBe(false));

    // 验证全链条 6 条消息
    const messages = threadRuntimeSnapshot(threadId)?.messages ?? [];
    expect(messages).toHaveLength(6);
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(messages[5]?.content).toContain('总结：经过网页检索与深度抓取');
  });

  it('单轮查询幂等缓存（同参数调用底层 executor 仅执行 1 次）', async () => {
    let callCount = 0;
    setLocalChatToolExecutorForTest(async (tc) => {
      callCount++;
      return `result for ${tc.name}`;
    });

    const threadId = localChatSessionStore.getState().createThread();
    expect(sendLocalChatMessage(threadId, '测试缓存')).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());

    // 第一轮：模型同时发起两个完全相同参数的工具调用
    streamHandlers!.onChunk(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: {
                    name: 'web_search',
                    arguments: '{"query":"same_query"}',
                  },
                },
                {
                  index: 1,
                  id: 'call_2',
                  function: {
                    name: 'web_search',
                    arguments: '{"query":"same_query"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    );
    streamHandlers!.onDone();

    await waitFor(() => expect(capturedRequests.length).toBe(2));
    // 底层 executor 仅执行 1 次（runCache 命中）
    expect(callCount).toBe(1);

    // 终态收尾
    streamHandlers!.onChunk(
      sse({
        choices: [
          { delta: { content: '已获取相同信息。' }, finish_reason: 'stop' },
        ],
      })
    );
    streamHandlers!.onDone();

    await waitFor(() => expect(isLocalThreadStreaming(threadId)).toBe(false));
  });

  it('用户中途 AbortSignal 强行中断（打断工具执行与网络请求，状态置为 stopped）', async () => {
    let toolSignalAborted = false;
    let releaseToolGate: (() => void) | null = null;

    setLocalChatToolExecutorForTest(async (_tc, ctx) => {
      ctx.signal.addEventListener('abort', () => {
        toolSignalAborted = true;
      });
      return new Promise<string>((resolve) => {
        releaseToolGate = () => resolve('late result');
      });
    });

    const threadId = localChatSessionStore.getState().createThread();
    expect(sendLocalChatMessage(threadId, '中断测试')).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());

    // 第一轮发起工具调用
    streamHandlers!.onChunk(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_slow',
                  function: {
                    name: 'web_search',
                    arguments: '{"query":"slow"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    );
    streamHandlers!.onDone();

    // 等待工具开始执行（gate 已就绪）
    await waitFor(() => expect(releaseToolGate).not.toBeNull());

    // 用户在此时点击“停止生成”
    stopLocalChatMessage(threadId);

    // 验证级联中断信号已触发且引擎状态已收敛
    expect(toolSignalAborted).toBe(true);
    expect(isLocalThreadStreaming(threadId)).toBe(false);

    // 放行迟到工具回调，验证不会发起下一轮
    if (releaseToolGate) {
      (releaseToolGate as () => void)();
    }
    await flushAsync();

    expect(capturedRequests).toHaveLength(1);
    const snap = threadRuntimeSnapshot(threadId);
    expect(snap?.streaming).toBe(false);

    // 补充验证：在流式正文接收中用户点击停止，底层网络 streamTransport.abort 会被立即触发
    abortTriggered = false;
    const threadId2 = localChatSessionStore.getState().createThread();
    expect(sendLocalChatMessage(threadId2, '网络流中断测试')).toBe(true);
    await waitFor(() => expect(streamHandlers).not.toBeNull());
    streamHandlers!.onChunk(
      sse({
        choices: [
          { delta: { content: '部分正在输出的内容' }, finish_reason: null },
        ],
      })
    );
    stopLocalChatMessage(threadId2);
    expect(abortTriggered).toBe(true);
    expect(isLocalThreadStreaming(threadId2)).toBe(false);
  });

  it('超过 6 轮硬性熔断（第 6 轮强制剔除 tools 声明并注入熔断提示迫使模型终结）', async () => {
    setLocalChatToolExecutorForTest(async (tc) => {
      return `executed ${tc.name}`;
    });

    const threadId = localChatSessionStore.getState().createThread();
    expect(sendLocalChatMessage(threadId, '反复循环测试')).toBe(true);

    // 循环模拟 1 到 5 轮，模型每次都输出 tool_call
    for (let round = 1; round <= 5; round++) {
      await waitFor(() => expect(capturedRequests.length).toBe(round));
      streamHandlers!.onChunk(
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${round}`,
                    function: {
                      name: 'web_search',
                      arguments: `{"query":"round_${round}"}`,
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })
      );
      streamHandlers!.onDone();
    }

    // 等待触发第 6 轮
    await waitFor(() => expect(capturedRequests.length).toBe(6));

    // 检验第 6 轮出站请求契约：强制剔除 tools，且注入 CIRCUIT_BREAKER_MAX_ROUNDS_PROMPT
    const lastReq = capturedRequests[capturedRequests.length - 1]!;
    const lastBody = JSON.parse(lastReq.body) as {
      tools?: unknown[];
      messages: Array<{ role: string; content?: string }>;
    };
    expect(lastBody.tools).toBeUndefined();
    const systemMsg = lastBody.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toContain(CIRCUIT_BREAKER_MAX_ROUNDS_PROMPT);

    // 第 6 轮模型即便妄图输出 tool_calls，引擎也绝不进入第 7 轮
    streamHandlers!.onChunk(
      sse({
        choices: [
          {
            delta: {
              content: '达到最大推理轮数，给出最终总结。',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_rogue_7',
                  function: { name: 'web_search', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    );
    streamHandlers!.onDone();

    await waitFor(() => expect(isLocalThreadStreaming(threadId)).toBe(false));
    // 确认绝无第 7 轮请求发起
    expect(capturedRequests).toHaveLength(6);
    const snap = threadRuntimeSnapshot(threadId);
    expect(snap?.messages[snap.messages.length - 1]?.content).toBe(
      '达到最大推理轮数，给出最终总结。'
    );
  });
});
