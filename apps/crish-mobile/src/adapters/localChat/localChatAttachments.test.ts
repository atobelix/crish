// 本地对话引擎 · 附件接线回归（本地附件批）：
// - vision 模型（spec.modalities 含 image）→ 请求体真含 image_url part，
//   图片落存供后续轮次回放；
// - 能力未知（未声明 modalities）→ fail-closed 降级为元数据文本，
//   绝不直发 image_url、绝不静默丢弃；
// - 文本文件按桌面同口径内联（80000 字符截断）；
// - 超限在发送前拒收（线程 error 槽 payloadTooLarge，不起流、不落消息）；
// - 纯附件（空文本）可发送。
// 装配口径与 localChatEngine.test.ts 一致（假传输记录请求体 + 内存持久层）。
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
} from '@/domain/store/localChatSessionStore';
import { InMemorySecureStore } from '@/db/secureStore';
import type { SettingsPersist } from '@/domain/store/settingsStore';
import { MemorySqlDriver } from '@/db/driver';
import { migrateIfNeeded } from '@/db/db';
import {
  SqlLocalThreadsDao,
  type LocalThreadsDao,
} from '@/db/dao/localThreadsDao';
import type { ComposerAttachment } from '@/domain/pure/attachments';
import type { LocalProviderSpec } from '@/domain/types/localChat';

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
const requests: StreamRequest[] = [];
const recordingTransport: StreamTransport = (req, h) => {
  requests.push(req);
  streamHandlers = h;
  return { abort: () => {} };
};

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

/** 标题等一次性补全的假 jsonFetch（本文件不关心其内容，只需不报错） */
const stubJsonFetch: JsonFetch = async () => ({
  status: 200,
  text: JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '标题' } }],
  }),
});

const SMALL_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

function imageAttachment(
  overrides?: Partial<ComposerAttachment>
): ComposerAttachment {
  return {
    id: 'att-img',
    name: 'cat.png',
    kind: 'image',
    dataUrl: SMALL_DATA_URL,
    sizeBytes: 8,
    mime: 'image/png',
    ...overrides,
  };
}

async function setupProvider(
  spec: Partial<LocalProviderSpec> & Pick<LocalProviderSpec, 'models'>
): Promise<void> {
  await localChatStore.getState().upsertProvider(
    'p1',
    {
      displayName: '测试供应商',
      baseUrl: 'https://api.example.com/v1',
      protocol: 'openai/chat',
      ...spec,
    },
    'sk-attach'
  );
}

async function freshDao(): Promise<LocalThreadsDao> {
  const driver = new MemorySqlDriver();
  await migrateIfNeeded(driver);
  return new SqlLocalThreadsDao(driver);
}

/** 等若干拍，让异步落盘/标题链走完 */
async function flushAsync(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 完成当前在飞流（assistant 正文固定），并等待请求体被记录 */
async function completeCurrentStream(text = '好的'): Promise<void> {
  await waitFor(() => expect(streamHandlers).not.toBeNull());
  const handlers = streamHandlers!;
  streamHandlers = null;
  handlers.onChunk(
    sse({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })
  );
  handlers.onDone();
  await flushAsync();
}

interface WireMessageShape {
  role: string;
  content: unknown;
}

function lastRequestMessages(): WireMessageShape[] {
  const req = requests[requests.length - 1];
  if (!req) throw new Error('尚无请求被记录');
  const body = JSON.parse(req.body) as { messages: WireMessageShape[] };
  return body.messages;
}

function userMessagesOf(threadId: string) {
  const s = localChatSessionStore.getState();
  const runtime =
    s.activeThreadId === threadId
      ? { messages: s.messages }
      : s.inactive[threadId];
  return (runtime?.messages ?? []).filter((m) => m.role === 'user');
}

beforeEach(() => {
  streamHandlers = null;
  requests.length = 0;
  configureLocalChatPersistence(new MemoryPersist());
  configureLocalChatSecure(new InMemorySecureStore());
  setLocalChatClientForTest({
    streamTransport: recordingTransport,
    jsonFetch: stubJsonFetch,
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
});

afterEach(() => {
  resetLocalChatClientForTest();
  resetLocalChatEngineForTest();
  configureLocalChatPersistence(null);
  configureLocalChatSecure(null);
  configureLocalChatSessionPersistence(null);
});

describe('本地附件发送（引擎级）', () => {
  it('vision 模型 + 图片附件：请求体真含 image_url part，图片落存', async () => {
    await setupProvider({
      defaultModelId: 'mv',
      models: [
        {
          id: 'mv',
          enabled: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      ],
    });
    const threadId = localChatSessionStore.getState().createThread();
    expect(
      sendLocalChatMessage(threadId, '看看这张图', [imageAttachment()])
    ).toBe(true);
    await completeCurrentStream();

    const messages = lastRequestMessages();
    const userWire = messages[messages.length - 1];
    expect(Array.isArray(userWire?.content)).toBe(true);
    const parts = userWire?.content as Array<Record<string, unknown>>;
    expect(parts[0]?.type).toBe('text');
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: SMALL_DATA_URL, detail: 'auto' },
    });

    const stored = userMessagesOf(threadId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toContain('[附件]');
    expect(stored[0]?.attachments).toHaveLength(1);
    expect(stored[0]?.attachments?.[0]?.dataUrl).toBe(SMALL_DATA_URL);
  });

  it('多轮回放：第二轮请求里历史图片消息仍带 image_url part', async () => {
    await setupProvider({
      defaultModelId: 'mv',
      models: [
        {
          id: 'mv',
          enabled: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      ],
    });
    const threadId = localChatSessionStore.getState().createThread();
    expect(
      sendLocalChatMessage(threadId, '看看这张图', [imageAttachment()])
    ).toBe(true);
    await completeCurrentStream();
    expect(sendLocalChatMessage(threadId, '它是什么颜色')).toBe(true);
    await completeCurrentStream();

    const messages = lastRequestMessages();
    // [system, user(图), assistant, user(继续)]：历史图片消息仍为 parts
    const historyUser = messages[1];
    expect(Array.isArray(historyUser?.content)).toBe(true);
    const parts = historyUser?.content as Array<Record<string, unknown>>;
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
    const lastUser = messages[messages.length - 1];
    expect(lastUser?.content).toBe('它是什么颜色');
  });

  it('能力未知（未声明 modalities）+ 图片：降级元数据文本，绝不直发', async () => {
    await setupProvider({
      defaultModelId: 'mu',
      models: [{ id: 'mu', enabled: true }],
    });
    const threadId = localChatSessionStore.getState().createThread();
    expect(
      sendLocalChatMessage(threadId, '看看这张图', [imageAttachment()])
    ).toBe(true);
    await completeCurrentStream();

    const req = requests[requests.length - 1];
    expect(req?.body).not.toContain('image_url');
    const messages = lastRequestMessages();
    const userWire = messages[messages.length - 1];
    expect(typeof userWire?.content).toBe('string');
    expect(userWire?.content as string).toContain('[图片附件元数据: cat.png]');

    const stored = userMessagesOf(threadId);
    expect(stored[0]).not.toHaveProperty('attachments');
  });

  it('文本文件附件：正文内联进请求；超 80000 字符截断', async () => {
    await setupProvider({
      defaultModelId: 'mt',
      models: [{ id: 'mt', enabled: true }],
    });
    const threadId = localChatSessionStore.getState().createThread();
    const textFile: ComposerAttachment = {
      id: 'att-txt',
      name: 'notes.txt',
      kind: 'text',
      text: '文件正文内容',
      sizeBytes: 18,
    };
    expect(sendLocalChatMessage(threadId, '读一下', [textFile])).toBe(true);
    await completeCurrentStream();
    const messages = lastRequestMessages();
    const userWire = messages[messages.length - 1];
    expect(typeof userWire?.content).toBe('string');
    expect(userWire?.content as string).toContain('--- notes.txt ---');
    expect(userWire?.content as string).toContain('文件正文内容');

    const thread2 = localChatSessionStore.getState().createThread();
    const bigFile: ComposerAttachment = {
      id: 'att-big',
      name: 'big.txt',
      kind: 'text',
      text: 'x'.repeat(80_001),
    };
    expect(sendLocalChatMessage(thread2, '', [bigFile])).toBe(true);
    await completeCurrentStream();
    const stored2 = userMessagesOf(thread2);
    expect(stored2[0]?.content).toContain('…(截断)');
  });

  it('超限图片：发送前拒收（payloadTooLarge 进 error 槽，不起流不落消息）', async () => {
    await setupProvider({
      defaultModelId: 'mv',
      models: [
        {
          id: 'mv',
          enabled: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      ],
    });
    const threadId = localChatSessionStore.getState().createThread();
    const oversized = imageAttachment({
      dataUrl: `data:image/png;base64,${'A'.repeat(716_800)}`,
    });
    expect(sendLocalChatMessage(threadId, '看看', [oversized])).toBe(false);
    await flushAsync();
    expect(requests).toHaveLength(0);
    expect(userMessagesOf(threadId)).toHaveLength(0);
    const s = localChatSessionStore.getState();
    const err = s.activeThreadId === threadId ? s.error : null;
    expect(err?.kind).toBe('payloadTooLarge');
    expect(err?.message).toContain('cat.png');
  });

  it('纯附件（空文本）可发送：prompt 取附件块正文', async () => {
    await setupProvider({
      defaultModelId: 'mv',
      models: [
        {
          id: 'mv',
          enabled: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      ],
    });
    const threadId = localChatSessionStore.getState().createThread();
    expect(sendLocalChatMessage(threadId, '', [imageAttachment()])).toBe(true);
    await completeCurrentStream();
    const messages = lastRequestMessages();
    const userWire = messages[messages.length - 1];
    expect(Array.isArray(userWire?.content)).toBe(true);
    const parts = userWire?.content as Array<Record<string, unknown>>;
    expect(parts[0]?.type).toBe('text');
    expect(parts[0]?.text as string).toContain('[附件]');
  });

  it('落盘往返：DAO 读回的用户消息保留图片附件（v5 列）', async () => {
    const dao = await freshDao();
    configureLocalChatSessionPersistence(dao);
    await setupProvider({
      defaultModelId: 'mv',
      models: [
        {
          id: 'mv',
          enabled: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      ],
    });
    const threadId = localChatSessionStore.getState().createThread();
    expect(
      sendLocalChatMessage(threadId, '看看这张图', [imageAttachment()])
    ).toBe(true);
    await completeCurrentStream();
    await waitFor(async () => {
      const persisted = await dao.listMessages(threadId);
      const userRow = persisted.find((m) => m.role === 'user');
      expect(userRow?.attachments).toHaveLength(1);
      expect(userRow?.attachments?.[0]?.dataUrl).toBe(SMALL_DATA_URL);
    });
  });

  it('R12 排查：同一条图片消息在完整发送-收口-续问流程中的落存次数恰为 1', async () => {
    const dao = await freshDao();
    const saveMessageSpy = jest.spyOn(dao, 'saveMessage');
    configureLocalChatSessionPersistence(dao);
    await setupProvider({
      defaultModelId: 'mv',
      models: [
        {
          id: 'mv',
          enabled: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      ],
    });
    const threadId = localChatSessionStore.getState().createThread();
    expect(
      sendLocalChatMessage(threadId, '看看这张图', [imageAttachment()])
    ).toBe(true);
    await completeCurrentStream('第一轮回答');

    // 同一条图片消息的 saveMessage 次数（发送时恰好一次；finishAssistant
    // 只收口助手消息，不重写用户消息）
    const userSaves = saveMessageSpy.mock.calls.filter(
      ([, , m]) => m.role === 'user'
    );
    expect(userSaves).toHaveLength(1);
    expect(userSaves[0]![2].attachments).toHaveLength(1);

    // 第二轮续问（历史回放读侧）：不重写第一轮任何消息
    saveMessageSpy.mockClear();
    expect(sendLocalChatMessage(threadId, '再看看')).toBe(true);
    await completeCurrentStream('第二轮回答');
    const round2UserSaves = saveMessageSpy.mock.calls.filter(
      ([, , m]) => m.role === 'user' && m.content === '看看这张图'
    );
    expect(round2UserSaves).toHaveLength(0);

    saveMessageSpy.mockRestore();
  });
});
