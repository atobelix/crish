// 本地引擎适配器测试（统一方案 §2.1 / U2）：重建旧本地对话 VM
// 的钉住行为（挂载激活 / 多线程隔离 / 发送即受理 / 停止保留内容）
// 并钉死统一屏四态——流式中 / 完成 / 错误（error 槽全量字段）/
// 未配置（emptyState 引导）——与能力面如实声明（不供 contextBar /
// submitWithAttachments，供 stop / submitText / modelControl）。
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

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    navigate: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
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

let handlers: StreamHandlers | null = null;
const fakeTransport: StreamTransport = (_req, h) => {
  handlers = h;
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
  handlers = null;
  mockPush.mockClear();
  secure = new InMemorySecureStore();
  configureLocalChatPersistence(new MemoryPersist());
  configureLocalChatSecure(secure);
  setLocalChatClientForTest({ streamTransport: fakeTransport });
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
});

afterEach(() => {
  resetLocalChatClientForTest();
  resetLocalChatEngineForTest();
  configureLocalChatPersistence(null);
  configureLocalChatSecure(null);
  configureLocalChatSessionPersistence(null);
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
  // L3：默认不再自动落位，测试显式选定活动模型
  localChatStore.getState().setActiveModel('p1', 'm1');
}

function createThreadWithSeed(seed: string): string {
  const id = localChatSessionStore.getState().createThread();
  localChatSessionStore.getState().appendUserAndBeginAssistant(
    { id: `seed-${id}`, role: 'user', content: seed },
    null
  );
  return id;
}

describe('useLocalConversationEngine', () => {
  it('挂载激活所绑线程；blocks 只含该线程消息（多线程隔离）', async () => {
    const a = createThreadWithSeed('甲种子');
    const b = createThreadWithSeed('乙种子');
    expect(localChatSessionStore.getState().activeThreadId).toBe(b);

    const { result } = await renderHook(() => useLocalConversationEngine(a), {
      wrapper: Wrapper,
    });
    expect(localChatSessionStore.getState().activeThreadId).toBe(a);
    expect(result.current.kind).toBe('local');
    expect(result.current.id).toBe(a);
    expect(result.current.blocks).toEqual([
      {
        kind: 'message',
        id: `seed-${a}`,
        role: 'user',
        text: '甲种子',
        streaming: false,
        atMs: 0,
      },
    ]);
    expect(result.current.title).toBe('甲种子');
  });

  it('未配置态：emptyState = 标题 + 去配置动作；提交被拦下并进 error 槽，原文保留', async () => {
    const id = localChatSessionStore.getState().createThread();
    const { result } = await renderHook(() => useLocalConversationEngine(id), {
      wrapper: Wrapper,
    });
    expect(result.current.emptyState.title).toBe('尚未配置本地供应商');
    expect(result.current.emptyState.actionLabel).toBe('去配置供应商');
    expect(result.current.emptyState.hint).toBeUndefined();
    expect(result.current.composer.placeholder).toBe('先配置供应商后即可发送');
    expect(result.current.composer.modelControl.label).toBe('未配置供应商');

    await act(async () => {
      result.current.composer.setPrompt('你好');
    });
    await act(async () => {
      result.current.composer.submit();
    });
    expect(localChatSessionStore.getState().error?.kind).toBe('notConfigured');
    expect(result.current.error?.message).toBeTruthy();
    expect(result.current.error?.onDismiss).toBeDefined();
    // 失败不吞原文：补好配置可直接重发
    expect(result.current.composer.prompt).toBe('你好');
    expect(result.current.blocks).toHaveLength(0);

    // 空态动作落点 = 供应商配置页
    await act(async () => {
      result.current.emptyState.onAction?.();
    });
    expect(mockPush).toHaveBeenCalledWith('/settings-local-providers');
  });

  it('流式中 → 完成：blocks 透传 streaming，收尾后文本齐全、busy 回落', async () => {
    await configureOneProvider();
    const id = localChatSessionStore.getState().createThread();
    const onSendSuccess = jest.fn();
    const { result } = await renderHook(
      () => useLocalConversationEngine(id, { onSendSuccess }),
      { wrapper: Wrapper }
    );
    expect(result.current.composer.modelControl.label).toBe('测试供应商 · m1');
    expect(result.current.emptyState).toEqual({ title: '本地助手已就绪' });
    expect(result.current.composer.placeholder).toBe(
      '点击发消息、长按语音输入'
    );
    expect(result.current.composer.placeholder).not.toMatch(/^本地对话/);

    await act(async () => {
      result.current.composer.setPrompt('第一问');
    });
    await act(async () => {
      result.current.composer.submit();
    });
    expect(result.current.composer.prompt).toBe('');
    expect(onSendSuccess).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(handlers).not.toBeNull());

    // 流式中：用户块落位，助手块 streaming 透传，busy=true
    expect(result.current.busy).toBe(true);
    expect(result.current.blocks.map((b) => b.kind)).toEqual(['message']);
    await act(async () => {
      handlers?.onChunk(
        sse({ choices: [{ delta: { content: '回答' }, finish_reason: null }] })
      );
    });
    expect(result.current.blocks[1]).toMatchObject({
      kind: 'message',
      role: 'assistant',
      text: '回答',
      streaming: true,
    });

    await act(async () => {
      handlers?.onChunk(
        sse({
          choices: [{ delta: { content: '完毕' }, finish_reason: 'stop' }],
        })
      );
      handlers?.onDone();
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.blocks[1]).toMatchObject({
      kind: 'message',
      role: 'assistant',
      text: '回答完毕',
      streaming: false,
    });
  });

  it('错误态：HTTP 401 分类的 message + detail 进 error 槽，onDismiss 清除', async () => {
    await configureOneProvider();
    const id = localChatSessionStore.getState().createThread();
    const { result } = await renderHook(() => useLocalConversationEngine(id), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.composer.setPrompt('问');
    });
    await act(async () => {
      result.current.composer.submit();
    });
    await waitFor(() => expect(handlers).not.toBeNull());
    await act(async () => {
      handlers?.onHttpError(
        401,
        '{"error":{"message":"Incorrect API key provided"}}'
      );
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error?.message).toContain('鉴权失败');
    expect(result.current.error?.detail).toContain('Incorrect API key');
    // 已发送的用户消息保留（错误不吞内容）
    expect(result.current.blocks.map((b) => b.kind)).toEqual(['message']);

    await act(async () => {
      result.current.error?.onDismiss?.();
    });
    expect(result.current.error).toBeNull();
  });

  it('停止：保留已生成内容，blocks 补「已停止生成」标注，无错误', async () => {
    await configureOneProvider();
    const id = localChatSessionStore.getState().createThread();
    const { result } = await renderHook(() => useLocalConversationEngine(id), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.composer.setPrompt('问');
    });
    await act(async () => {
      result.current.composer.submit();
    });
    await waitFor(() => expect(handlers).not.toBeNull());
    await act(async () => {
      handlers?.onChunk(
        sse({ choices: [{ delta: { content: '一半' }, finish_reason: null }] })
      );
    });
    await act(async () => {
      result.current.stop?.();
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.blocks[1]).toMatchObject({
      kind: 'message',
      text: '一半',
      streaming: false,
    });
    expect(result.current.blocks[2]).toMatchObject({
      kind: 'notice',
      text: '已停止生成',
      tone: 'muted',
    });
  });

  it('能力面如实声明：无 contextBar / 无附件提交 / 不锁定；菜单含供应商设置与清空', async () => {
    await configureOneProvider();
    const a = createThreadWithSeed('有内容');
    const { result } = await renderHook(() => useLocalConversationEngine(a), {
      wrapper: Wrapper,
    });
    expect(result.current.available).toBe(true);
    expect(result.current.stop).toBeDefined();
    expect(result.current.composer.contextBar).toBeUndefined();
    expect(result.current.composer.submitWithAttachments).toBeUndefined();
    expect(result.current.composer.locked).toBe(false);
    expect(result.current.composer.hasAttachments).toBe(false);
    // 批 C ② 起本地引擎供 renderComposerLead（排队行呈现面）；无排队
    // 条目时组件自守为空——能力面变化在此钉住，不再断言缺席
    expect(typeof result.current.renderComposerLead).toBe('function');

    const keys = result.current.menuEntries.map((e) => e.key);
    expect(keys).toEqual(['providers', 'ops-divider', 'clear']);
    const clear = result.current.menuEntries.find((e) => e.key === 'clear');
    expect(clear && 'danger' in clear && clear.danger).toBe(true);

    await act(async () => {
      if (clear && 'onPress' in clear) clear.onPress();
    });
    expect(result.current.blocks).toHaveLength(0);
    // 清空后菜单收起清空项（无内容不在场）
    expect(result.current.menuEntries.map((e) => e.key)).toEqual(['providers']);
  });

  it('submitText（语音直发）：不经输入框直接发送并受理', async () => {
    await configureOneProvider();
    const id = localChatSessionStore.getState().createThread();
    const { result } = await renderHook(() => useLocalConversationEngine(id), {
      wrapper: Wrapper,
    });
    let accepted = false;
    await act(async () => {
      accepted =
        (await result.current.composer.submitText('语音问题')) === true;
    });
    expect(accepted).toBe(true);
    await waitFor(() => expect(handlers).not.toBeNull());
    expect(result.current.blocks[0]).toMatchObject({
      kind: 'message',
      role: 'user',
      text: '语音问题',
    });
    expect(result.current.busy).toBe(true);
  });

  it('多轮上下文：第二问出站消息含首轮问答（经 buildWireMessages 组装）', async () => {
    await configureOneProvider();
    let lastBody = '';
    setLocalChatClientForTest({
      streamTransport: (req, h) => {
        lastBody = req.body;
        handlers = h;
        return { abort: () => {} };
      },
    });
    const id = localChatSessionStore.getState().createThread();
    const { result } = await renderHook(() => useLocalConversationEngine(id), {
      wrapper: Wrapper,
    });
    await act(async () => {
      result.current.composer.setPrompt('一');
    });
    await act(async () => {
      result.current.composer.submit();
    });
    await waitFor(() => expect(handlers).not.toBeNull());
    await act(async () => {
      handlers?.onChunk(
        sse({
          choices: [{ delta: { content: '答一' }, finish_reason: 'stop' }],
        })
      );
      handlers?.onDone();
    });
    await act(async () => {
      result.current.composer.setPrompt('二');
    });
    await act(async () => {
      result.current.composer.submit();
    });
    await waitFor(() =>
      expect((JSON.parse(lastBody).messages as unknown[]).length).toBe(4)
    );
    const messages = JSON.parse(lastBody).messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages.slice(1).map((m) => m.content)).toEqual([
      '一',
      '答一',
      '二',
    ]);
  });

  it('双线程发送隔离：甲线程发送/完成不串扰乙线程的块与生成态', async () => {
    await configureOneProvider();
    const a = createThreadWithSeed('甲种子');
    const b = createThreadWithSeed('乙种子');
    const vmA = await renderHook(() => useLocalConversationEngine(a), {
      wrapper: Wrapper,
    });
    const vmB = await renderHook(() => useLocalConversationEngine(b), {
      wrapper: Wrapper,
    });
    expect(vmA.result.current.id).toBe(a);
    expect(vmB.result.current.id).toBe(b);

    await act(async () => {
      vmA.result.current.composer.setPrompt('甲的问题');
    });
    await act(async () => {
      vmA.result.current.composer.submit();
    });
    await waitFor(() => expect(handlers).not.toBeNull());
    await waitFor(() => expect(vmA.result.current.busy).toBe(true));
    expect(vmB.result.current.busy).toBe(false);

    await act(async () => {
      handlers?.onChunk(
        sse({
          choices: [{ delta: { content: '甲的回答' }, finish_reason: 'stop' }],
        })
      );
      handlers?.onDone();
    });
    await waitFor(() => expect(vmA.result.current.busy).toBe(false));
    expect(
      vmA.result.current.blocks.some(
        (x) => x.kind === 'message' && x.text === '甲的回答'
      )
    ).toBe(true);
    // 乙线程不受影响：仍只有种子消息、无生成态
    expect(vmB.result.current.busy).toBe(false);
    expect(vmB.result.current.blocks).toEqual([
      {
        kind: 'message',
        id: `seed-${b}`,
        role: 'user',
        text: '乙种子',
        streaming: false,
        atMs: 0,
      },
    ]);
  });
});
