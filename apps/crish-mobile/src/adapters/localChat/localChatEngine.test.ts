// 本地对话引擎 · AI 标题触发测试（U4）：首轮完成点 fire-and-forget 生成——
// 成功落盘（经 store 来源阶梯 + DAO）、失败静默回退 derived、每线程至多
// 一次、用户改名后迟到结果被丢弃、首轮报错不触发。假传输 + 假 jsonFetch，
// 与本地引擎适配器测试同一装配口径。
import { waitFor } from '@testing-library/react-native';
import {
  resetLocalChatEngineForTest,
  sendLocalChatMessage,
} from './localChatEngine';
import {
  resetLocalChatClientForTest,
  setLocalChatClientForTest,
} from './localChatWiring';
import type {
  JsonFetch,
  StreamHandlers,
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

let streamHandlers: StreamHandlers | null = null;
const fakeTransport: StreamTransport = (_req, h) => {
  streamHandlers = h;
  return { abort: () => {} };
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
  streamHandlers = null;
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
