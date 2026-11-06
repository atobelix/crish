// 本地引擎排队附件回归测试（2026-11-05 返工，核查 P2）：
// 缺陷原形——本地会话生成中再发送走排队路径时，submit 只把文本入队、
// 随即清掉已选附件，排空发送又不读条目附件，用户补发的图片/文件被
// 静默丢弃（且当时相邻注释声称「sendQueuedItem 携带」，与事实相反）。
// 本套件钉死整条链：入队条目携带附件快照 → 排空经 sendLocalChatMessage
// 的组装链真实发出（出站请求含附件正文）→ 条目出队不重发。
// 附件选取面（useComposerAttachments）以可控替身注入（选取本身归其
// 自有套件），引擎与其余链路（会话存储 / 发送队列 / 本地引擎 / 协议
// 组装）全部走真实实现，出站请求由记录型假传输捕获。
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { ToastProvider } from '@/presentation/ui';
import { useLocalConversationEngine } from './useLocalConversationEngine';
import { localChatStore } from '@/domain/store/localChatStore';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import { InMemorySecureStore, type SecureStoreDriver } from '@/db/secureStore';
import type { SettingsPersist } from '@/domain/store/settingsStore';
import {
  configureLocalChatPersistence,
  configureLocalChatSecure,
} from '@/domain/store/localChatStore';
import {
  resetLocalChatClientForTest,
  setLocalChatClientForTest,
} from '@/adapters/localChat/localChatWiring';
import { configureLocalChatSessionPersistence } from '@/domain/store/localChatSessionStore';
import {
  resetLocalChatEngineForTest,
  setStreamBatchWindowMsForTest,
} from '@/adapters/localChat/localChatEngine';
import type {
  StreamHandlers,
  StreamTransport,
} from '@/adapters/localChat/localChatClient';
import {
  resetSendQueueForTest,
  sendQueueStore,
} from '@/domain/store/sendQueueStore';
import type { ComposerAttachment } from '@/domain/pure/attachments';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    navigate: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
  }),
}));

// 附件已选区的可控替身：测试直接摆放已选附件并观察 clear 调用；
// 选取管线本身（相机/相册/文件）不在本套件范围。
const mockAttachmentBox: {
  items: ComposerAttachment[];
  clear: jest.Mock;
} = { items: [], clear: jest.fn() };
jest.mock('@/adapters/viewmodels/useComposerAttachments', () => ({
  useComposerAttachments: () => ({
    attachments: mockAttachmentBox.items,
    picking: false,
    pickFromCamera: jest.fn(),
    pickFromLibrary: jest.fn(),
    pickFromFiles: jest.fn(),
    remove: jest.fn(),
    clear: mockAttachmentBox.clear,
  }),
}));

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

interface RecordedCall {
  body: string;
  handlers: StreamHandlers;
}
const calls: RecordedCall[] = [];
const recordingTransport: StreamTransport = (req, h) => {
  calls.push({ body: req.body, handlers: h });
  return { abort: () => {} };
};

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
let secure: SecureStoreDriver;

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

beforeEach(async () => {
  calls.length = 0;
  mockPush.mockClear();
  mockAttachmentBox.items = [];
  mockAttachmentBox.clear.mockClear();
  secure = new InMemorySecureStore();
  configureLocalChatPersistence(new MemoryPersist());
  configureLocalChatSecure(secure);
  setLocalChatClientForTest({ streamTransport: recordingTransport });
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
  setStreamBatchWindowMsForTest(0);
  configureLocalChatSessionPersistence(null);
  resetSendQueueForTest();
});

afterEach(() => {
  resetLocalChatClientForTest();
  resetLocalChatEngineForTest();
  configureLocalChatPersistence(null);
  configureLocalChatSecure(null);
  configureLocalChatSessionPersistence(null);
  resetSendQueueForTest();
});

async function configureOneProvider() {
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
}

describe('useLocalConversationEngine 生成中排队发送（附件不丢）', () => {
  it('带附件入队：条目携带附件快照；排空后出站请求真带附件正文', async () => {
    await configureOneProvider();
    const id = localChatSessionStore.getState().createThread();
    const { result, rerender } = await renderHook(
      () => useLocalConversationEngine(id),
      { wrapper: Wrapper }
    );

    // 第一问进入生成中（假传输挂起，等待测试收尾）
    await act(async () => {
      result.current.composer.setPrompt('第一问');
    });
    await act(async () => {
      result.current.composer.submit();
    });
    await waitFor(() => expect(calls.length).toBe(1));
    expect(result.current.busy).toBe(true);
    mockAttachmentBox.clear.mockClear();

    // 生成中选好一个文本文件附件，再发送第二问 → 走入队路径
    const textFile: ComposerAttachment = {
      id: 'att-q',
      name: 'notes.txt',
      kind: 'text',
      text: '排队文件正文',
      sizeBytes: 18,
    };
    mockAttachmentBox.items = [textFile];
    await rerender({});
    expect(result.current.composer.hasAttachments).toBe(true);
    await act(async () => {
      result.current.composer.setPrompt('第二问带附件');
    });
    await act(async () => {
      result.current.composer.submit();
    });

    // 入队条目必须携带附件快照（缺陷原形：只有文本、附件被清掉）
    const queued = sendQueueStore.getState().queues[`local:${id}`] ?? [];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.text).toBe('第二问带附件');
    expect(queued[0]?.attachments).toEqual([textFile]);
    // 入队成功才清输入与已选区；第二问此时尚未真正发出
    expect(mockAttachmentBox.clear).toHaveBeenCalledTimes(1);
    expect(result.current.composer.prompt).toBe('');
    expect(calls.length).toBe(1);

    // 第一轮生成结束 → 排空状态机续发第二问
    await act(async () => {
      calls[0]?.handlers.onChunk(
        sse({
          choices: [{ delta: { content: '答一' }, finish_reason: 'stop' }],
        })
      );
      calls[0]?.handlers.onDone();
    });
    await waitFor(() => expect(calls.length).toBe(2));

    // 出站请求真带附件：文本文件经组装链内联进最后一条 user 消息
    const secondMessages = JSON.parse(calls[1]!.body).messages as Array<{
      role: string;
      content: unknown;
    }>;
    const lastUser = secondMessages[secondMessages.length - 1];
    expect(lastUser?.role).toBe('user');
    expect(typeof lastUser?.content).toBe('string');
    expect(lastUser?.content as string).toContain('--- notes.txt ---');
    expect(lastUser?.content as string).toContain('排队文件正文');

    // 条目已出队，不重复发送
    expect(sendQueueStore.getState().queues[`local:${id}`] ?? []).toHaveLength(
      0
    );
  });
});
