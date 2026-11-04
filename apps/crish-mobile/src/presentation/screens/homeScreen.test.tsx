// 主屏测试：问候、空态、平铺会话列表（状态/时间/摘要）、更多下拉与提交回执。
// CON-2 起补：本地模式（未连接）解封、提交分发两路；hub 同列接线后，
// 本地行断言改逐线程形态（每线程一行、点按直达线程页、发送直达线程页）。
import { Keyboard, View } from 'react-native';
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { RunTaskParams, RunTaskResult } from '@crish/shared-types';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { authStore } from '@/domain/store/authStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { deviceSnapshotStore } from '@/domain/store/deviceSnapshotStore';
import { eventStore } from '@/domain/store/eventStore';
import { notificationStore } from '@/domain/store/notificationStore';
import { sessionStore } from '@/domain/store/sessionStore';
import {
  configureLocalChatPersistence,
  configureLocalChatSecure,
  localChatStore,
} from '@/domain/store/localChatStore';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import type { SettingsPersist } from '@/domain/store/settingsStore';
import { InMemorySecureStore } from '@/db/secureStore';
import {
  resetLocalChatClientForTest,
  setLocalChatClientForTest,
} from '@/adapters/localChat/localChatWiring';
import { resetLocalChatEngineForTest } from '@/adapters/localChat/localChatEngine';
import { ToastProvider } from '@/presentation/ui';
import HomeScreen, { greetingFor, useEverOpened } from './homeScreen';

const mockRunTask = jest.fn<Promise<RunTaskResult>, [RunTaskParams]>();
const mockRouterPush = jest.fn();
/** 本地线程打开落点（U3：壳内 /thread replace 由宿主回调承接） */
const mockOpenLocalThread = jest.fn();

jest.mock('@/adapters/quickRunWiring', () => ({
  ...jest.requireActual('@/adapters/quickRunWiring'),
  getQuickRunContext: () => ({ repository: { runTask: mockRunTask } }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => false,
  }),
  router: {
    push: mockRouterPush,
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => false,
  },
  usePathname: () => '/',
  Redirect: () => null,
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

/** 配置一位本地供应商（假传输：流保持开启，断言只看入列与导航） */
async function configureOneLocalProvider() {
  configureLocalChatPersistence(new MemoryPersist());
  configureLocalChatSecure(new InMemorySecureStore());
  setLocalChatClientForTest({
    streamTransport: () => ({ abort: () => {} }),
  });
  await localChatStore.getState().upsertProvider(
    'p1',
    {
      displayName: '测试供应商',
      baseUrl: 'https://api.example.com/v1',
      protocol: 'openai/chat',
      models: [{ id: 'm1', enabled: true }],
    },
    'sk-home'
  );
}

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const NOW = 1_800_000_000_000;

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    title: '修复登录页样式',
    folder: '常规会话',
    isPinned: false,
    isArchived: false,
    timestamp: '',
    updatedAt: NOW - 60_000,
    messageCount: 2,
    receivedAtMs: NOW,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    ...overrides,
  };
}

function renderHome(props: Partial<Parameters<typeof HomeScreen>[0]> = {}) {
  return render(
    <HomeScreen
      onOpenDrawer={jest.fn()}
      onOpenNotifications={jest.fn()}
      onOpenSession={jest.fn()}
      onOpenLocalThread={mockOpenLocalThread}
      {...props}
    />,
    {
      wrapper: ({ children }) => (
        <SafeAreaProvider initialMetrics={metrics}>
          <ToastProvider>{children}</ToastProvider>
        </SafeAreaProvider>
      ),
    }
  );
}

beforeEach(() => {
  mockRunTask.mockReset();
  mockRouterPush.mockReset();
  mockOpenLocalThread.mockReset();
  connectionStore.setState({ phase: 'ready', lastError: null });
  authStore.setState({ host: '192.168.1.2' });
  sessionStore.setState({ sessions: [], selectedSessionId: null });
  eventStore.setState({ windows: {}, network: 'live' });
  notificationStore.setState({ items: [], unreadCount: 0, hydrated: true });
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
    messages: [],
    streaming: false,
    error: null,
    completedAtByThread: {},
  });
});

afterEach(() => {
  resetLocalChatClientForTest();
  resetLocalChatEngineForTest();
  configureLocalChatPersistence(null);
  configureLocalChatSecure(null);
});

describe('greetingFor', () => {
  it.each([
    [3, '夜深了'],
    [9, '早上好'],
    [14, '下午好'],
    [21, '晚上好'],
  ])('%i 点 → %s', (hour, text) => {
    expect(greetingFor(hour)).toBe(text);
  });
});

describe('HomeScreen 空态', () => {
  it('在线时显示设备胶囊与问候，不显示断线横幅', async () => {
    const view = await renderHome();
    expect(view.getByTestId('device-pill')).toBeTruthy();
    expect(view.getByText('192.168.1.2')).toBeTruthy();
    expect(view.getByText('今天想让它做点什么？')).toBeTruthy();
    expect(view.queryByLabelText('重新连接')).toBeNull();
  });

  it('未连接（本地模式）时横幅改述本地口径，输入框可编辑（CON-2 解封）', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    const view = await renderHome();
    expect(view.getByLabelText('重新连接')).toBeTruthy();
    // 横幅两件事都说清：桌面未连接 + 正在使用本地对话
    expect(view.getByText('桌面未连接 · 正在使用本地对话')).toBeTruthy();
    expect(view.getByTestId('home-composer').props.editable).toBe(true);
    // 本地未配置时 placeholder 是诚实引导，不再是写死的「未连接」
    expect(view.getByTestId('home-composer').props.placeholder).toBe(
      '先配置本地供应商后即可对话'
    );
  });

  it('本地已配置（密钥已填）时本地横幅不再显示（2026-11-02 抑制裁决）', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    await configureOneLocalProvider();
    const view = await renderHome();
    // 横幅整卡消失：文案与排障入口都不再常驻（设备身份由设备胶囊承载）
    expect(view.queryByText('桌面未连接 · 正在使用本地对话')).toBeNull();
    expect(view.queryByLabelText('重新连接')).toBeNull();
    // 本地能力本身不受影响：输入框仍可编辑、placeholder 彻底切除冗余前缀
    expect(view.getByTestId('home-composer').props.editable).toBe(true);
    expect(view.getByTestId('home-composer').props.placeholder).toBe(
      '点击发消息、长按语音输入'
    );
    expect(view.getByTestId('home-composer').props.placeholder).not.toContain(
      '本地对话 · '
    );
  });

  it('本地模式输入框：远端选择行（工作区/权限）不显示，附件钮与模型钮在场（两行形态不分模式）', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    const view = await renderHome();
    // 工作区/权限是远端专属概念（2026-11-02 22:05 裁决细化）：本地
    // 模式不渲染选择行——旧口径「假显示 + 点按解释 toast」已废止
    expect(view.queryByTestId('home-composer-workspace')).toBeNull();
    expect(view.queryByTestId('home-composer-permission')).toBeNull();
    // 附件钮在场（本地点按走诚实提示，不藏钮）
    expect(view.getByLabelText('添加附件')).toBeTruthy();
    // 聚焦展开第二行：模型钮在场（本地标签 = 本地供应商口径）
    await fireEvent(view.getByTestId('home-composer'), 'focus');
    expect(view.getByTestId('home-composer-model')).toBeTruthy();
  });

  it('未连接时设备胶囊显示当前设备「本机」而非裸「未连接」', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    const view = await renderHome();
    expect(view.getByText('本机')).toBeTruthy();
    const pill = view.getByTestId('device-pill');
    expect(pill.props.accessibilityLabel).toBe('本机');
  });
});

describe('HomeScreen 状态板', () => {
  it('渲染标题 / 时间 / 摘要，点按回调会话 id', async () => {
    // 状态板口径：运行中的会话才上主页（普通历史会话只在完整列表页）
    sessionStore.setState({
      sessions: [session({ activeRunIds: ['r-1'] })],
    });
    eventStore.getState().ingest(
      's-1',
      {
        type: 'message-end',
        sessionId: 's-1',
        sequence: 1,
        message: {
          id: 'm-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: '登录页的主要问题已定位' }],
        },
      } as never,
      false,
      NOW
    );
    const onOpenSession = jest.fn();
    const view = await renderHome({ onOpenSession });
    expect(view.getByTestId('home-chat-list')).toBeTruthy();
    expect(view.getByText('修复登录页样式')).toBeTruthy();
    expect(view.getByText('登录页的主要问题已定位')).toBeTruthy();
    await fireEvent.press(view.getByTestId('chat-item-s-1'));
    expect(onOpenSession).toHaveBeenCalledWith('s-1');
  });

  it('待审批会话渲染橙点 + 文案，运行中渲染灰环', async () => {
    sessionStore.setState({
      sessions: [
        session({ id: 's-run', title: '运行中会话', activeRunIds: ['r-1'] }),
        session({
          id: 's-approval',
          title: '待审批会话',
          pendingApprovalCount: 2,
        }),
      ],
    });
    const view = await renderHome();
    expect(view.getByTestId('chat-item-running')).toBeTruthy();
    expect(view.getByTestId('chat-item-pending')).toBeTruthy();
    expect(view.getByText('待审批')).toBeTruthy();
  });
});

describe('HomeScreen 更多下拉', () => {
  it('展开后可进入通知中心与偏好设置', async () => {
    const onOpenNotifications = jest.fn();
    const view = await renderHome({ onOpenNotifications });
    await fireEvent.press(view.getByTestId('home-more'));
    await fireEvent.press(view.getByTestId('home-menu-notifications'));
    expect(onOpenNotifications).toHaveBeenCalledTimes(1);
  });
});

describe('HomeScreen 附件入口（G5b）', () => {
  it('Composer 渲染 ＋ 附件钮，点开附件面板呈现拍照/相册/文件三入口', async () => {
    const view = await renderHome();
    const attachButton = view.getByLabelText('添加附件');
    expect(attachButton).toBeTruthy();
    await fireEvent.press(attachButton);
    expect(view.getByTestId('home-attachment-sheet-camera')).toBeTruthy();
    expect(view.getByTestId('home-attachment-sheet-library')).toBeTruthy();
    expect(view.getByTestId('home-attachment-sheet-files')).toBeTruthy();
    expect(view.getByText('拍照')).toBeTruthy();
    expect(view.getByText('相册')).toBeTruthy();
    expect(view.getByText('文件')).toBeTruthy();
  });
});

describe('HomeScreen 提交', () => {
  it('提交后新建会话（不带 sessionId），成功回执跳转到该会话', async () => {
    mockRunTask.mockResolvedValue({ runId: 'r-9', sessionId: 's-9' });
    const onOpenSession = jest.fn();
    const view = await renderHome({ onOpenSession });
    await fireEvent.changeText(
      view.getByTestId('home-composer'),
      '整理一下登录页'
    );
    await act(async () => {
      await fireEvent.press(view.getByTestId('home-composer-send'));
    });
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('s-9'));
    expect(mockRunTask).toHaveBeenCalledWith({
      prompt: '整理一下登录页',
      // G1：权限改读持久化偏好，默认 smart（与桌面 DEFAULT_PERMISSION_MODE 一致）
      permissionMode: 'smart',
    });
  });
});

describe('HomeScreen 本地模式（CON-2 + hub 同列）', () => {
  it('本地线程（本进程刚完成）上状态板呈现（标题/摘要/「本地」标识），点按直达该线程页', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    localChatSessionStore.setState({
      threads: [
        {
          id: 'lth-1',
          title: '离线问题咨询',
          titleSource: 'derived',
          preview: '上次的回答摘要',
          modelRef: null,
          createdAt: NOW - 120_000,
          updatedAt: NOW - 60_000,
        },
      ],
      activeThreadId: 'lth-1',
      // 本进程内刚完成（状态板本地完成资格）
      completedAtByThread: { 'lth-1': NOW - 30_000 },
    });
    const view = await renderHome();
    expect(view.getByTestId('home-chat-list')).toBeTruthy();
    expect(view.getByTestId('chat-item-local-lth-1')).toBeTruthy();
    expect(view.getByText('离线问题咨询')).toBeTruthy();
    expect(view.getByText('上次的回答摘要')).toBeTruthy();
    expect(view.getByText('本地')).toBeTruthy();
    await fireEvent.press(view.getByTestId('chat-item-local-lth-1'));
    // 落点 = 宿主壳内回调（(main)/thread replace），不再 router.push 旧页
    expect(mockOpenLocalThread).toHaveBeenCalledWith('lth-1');
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('本地空闲线程不上状态板（无运行/无本进程完成 → 问候空态，线程在本地列表页）', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    localChatSessionStore.setState({
      threads: [
        {
          id: 'lth-1',
          title: '离线问题咨询',
          titleSource: 'derived',
          preview: '上次的回答摘要',
          modelRef: null,
          createdAt: NOW - 120_000,
          updatedAt: NOW - 60_000,
        },
      ],
      activeThreadId: 'lth-1',
      completedAtByThread: {},
    });
    const view = await renderHome();
    expect(view.queryByTestId('home-chat-list')).toBeNull();
    expect(view.queryByTestId('chat-item-local-lth-1')).toBeNull();
    expect(view.getByText('今天想让它做点什么？')).toBeTruthy();
  });

  it('已连接时本地线程行仍在（运行中同段混排，按 updatedAt 定序）', async () => {
    sessionStore.setState({
      sessions: [session({ activeRunIds: ['r-1'] })],
    });
    localChatSessionStore.setState({
      threads: [
        {
          id: 'lth-1',
          title: '本地新话题',
          titleSource: 'derived',
          preview: '',
          modelRef: null,
          createdAt: NOW - 30_000,
          updatedAt: NOW - 30_000,
        },
      ],
      activeThreadId: 'lth-1',
      streaming: true,
    });
    const view = await renderHome();
    expect(view.getByTestId('chat-item-s-1')).toBeTruthy();
    expect(view.getByTestId('chat-item-local-lth-1')).toBeTruthy();
    // 运行中段定序：本地线程更新更近（NOW-30s > 远端运行 NOW-60s），排在其前
    const data = view.getByTestId('home-chat-list').props.data as Array<{
      kind: string;
      id: string;
    }>;
    expect(
      data.map((r) => (r.kind === 'local' ? `local-${r.id}` : r.id))
    ).toEqual(['local-lth-1', 's-1']);
  });

  it('生成中的本地线程进运行中段：排在更新更近的已完成远端会话之前', async () => {
    connectionStore.setState({ connectedSinceMs: NOW - 60_000 });
    sessionStore.setState({
      sessions: [
        session({ updatedAt: NOW - 10_000, completedAtMs: NOW - 5_000 }),
      ],
    });
    localChatSessionStore.setState({
      threads: [
        {
          id: 'lth-1',
          title: '正在生成的本地线程',
          titleSource: 'derived',
          preview: '',
          modelRef: null,
          createdAt: NOW - 90_000,
          updatedAt: NOW - 90_000,
        },
      ],
      activeThreadId: 'lth-1',
      streaming: true,
    });
    const view = await renderHome();
    expect(view.getByText('生成中…')).toBeTruthy();
    const data = view.getByTestId('home-chat-list').props.data as Array<{
      kind: string;
      id: string;
    }>;
    expect(
      data.map((r) => (r.kind === 'local' ? `local-${r.id}` : r.id))
    ).toEqual(['local-lth-1', 's-1']);
  });

  it('未连接时主页发送走本地：消息落本地线程、清稿并导航，不触远程管线', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    await configureOneLocalProvider();
    const view = await renderHome();
    // 已配置：placeholder 切本地口径（无冗余前缀）
    expect(view.getByTestId('home-composer').props.placeholder).toBe(
      '点击发消息、长按语音输入'
    );
    await fireEvent.changeText(
      view.getByTestId('home-composer'),
      '离线也能聊吗'
    );
    await act(async () => {
      await fireEvent.press(view.getByTestId('home-composer-send'));
    });
    const messages = localChatSessionStore.getState().messages;
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('离线也能聊吗');
    // 落点 = 宿主壳内回调直达统一线程屏（U3），不再经旧本地页中转
    const threadId = localChatSessionStore.getState().activeThreadId;
    expect(threadId).toBeTruthy();
    expect(mockOpenLocalThread).toHaveBeenCalledWith(threadId);
    expect(mockRunTask).not.toHaveBeenCalled();
    expect(view.getByTestId('home-composer').props.value).toBe('');
  });

  it('未连接且未配置本地供应商：发送不落消息，进线程页看诚实引导', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    const view = await renderHome();
    await fireEvent.changeText(view.getByTestId('home-composer'), '你好');
    await act(async () => {
      await fireEvent.press(view.getByTestId('home-composer-send'));
    });
    // 未配置错误落本地线程 store（线程页横幅呈现），消息不入列、不走远程
    expect(localChatSessionStore.getState().messages).toHaveLength(0);
    expect(localChatSessionStore.getState().error?.kind).toBe('notConfigured');
    const threadId = localChatSessionStore.getState().activeThreadId;
    expect(threadId).toBeTruthy();
    expect(mockOpenLocalThread).toHaveBeenCalledWith(threadId);
    expect(mockRunTask).not.toHaveBeenCalled();
  });

  it('当本地 Store 已有活动历史会话时，主页发送依然无条件创建全新独立线程，绝不污染历史', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    await configureOneLocalProvider();

    // 模拟存在历史会话，且当前 activeThreadId 指向它
    localChatSessionStore.setState({
      threads: [
        {
          id: 'lth-history-1',
          title: '历史会话',
          titleSource: 'user',
          preview: '旧内容',
          modelRef: null,
          createdAt: NOW - 100_000,
          updatedAt: NOW - 50_000,
        },
      ],
      activeThreadId: 'lth-history-1',
      messages: [
        {
          id: 'm-old',
          role: 'user',
          content: '旧提问',
        },
      ],
      streaming: false,
      error: null,
      inactive: {},
      hydrated: true,
      completedAtByThread: {},
    });

    const view = await renderHome();

    // 在主页输入新提问
    await fireEvent.changeText(
      view.getByTestId('home-composer'),
      '这是主页发起的全新提问'
    );
    await act(async () => {
      await fireEvent.press(view.getByTestId('home-composer-send'));
    });

    const state = localChatSessionStore.getState();
    // 必须生成新的线程 ID，绝非 lth-history-1
    const newThreadId = state.activeThreadId;
    expect(newThreadId).toBeTruthy();
    expect(newThreadId).not.toBe('lth-history-1');

    // 新线程中的首条消息仅包含当前全新提问，绝无旧提问
    expect(state.messages[0]?.role).toBe('user');
    expect(state.messages[0]?.content).toBe('这是主页发起的全新提问');
    expect(state.messages.some((m) => m.content === '旧提问')).toBe(false);

    // 历史会话依然在 inactive 中完好无损，未受任何污染
    expect(state.inactive['lth-history-1']?.messages).toHaveLength(1);
    expect(state.inactive['lth-history-1']?.messages[0]?.content).toBe(
      '旧提问'
    );

    // 导航回调直达新线程
    expect(mockOpenLocalThread).toHaveBeenCalledWith(newThreadId);
  });
});

describe('HomeScreen 陈旧标注（CON-3）', () => {
  afterEach(() => {
    deviceSnapshotStore.setState({
      snapshots: {},
      liveStale: false,
      liveSnapshotAt: null,
    });
  });

  it('断线保留的远端列表带「未连接 · 显示上次同步内容」标注', async () => {
    sessionStore.setState({
      sessions: [session({ activeRunIds: ['r-1'] })],
    });
    deviceSnapshotStore.setState({
      liveStale: true,
      liveSnapshotAt: NOW - 60_000,
    });
    const view = await renderHome();
    expect(view.getByTestId('home-snapshot-stale')).toBeTruthy();
    expect(view.getByText('未连接 · 显示上次同步内容')).toBeTruthy();
    // 保留的行本身仍在（保留 ≠ 清空），只是被诚实标注
    expect(view.getByTestId('chat-item-s-1')).toBeTruthy();
  });

  it('数据新鲜（对账成功后）不呈陈旧标注', async () => {
    sessionStore.setState({
      sessions: [session({ activeRunIds: ['r-1'] })],
    });
    deviceSnapshotStore.setState({ liveStale: false, liveSnapshotAt: null });
    const view = await renderHome();
    expect(view.queryByTestId('home-snapshot-stale')).toBeNull();
    expect(view.getByTestId('chat-item-s-1')).toBeTruthy();
  });
});

describe('HomeScreen 输入态浮层豁免（M6）', () => {
  it('状态浮层在输入淡出容器（home-board）之外：本地横幅不被中段淡出吞没', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    const view = await renderHome();
    const board = view.getByTestId('home-board');
    const overlay = view.getByTestId('home-status-overlay');
    // 浮层与淡出容器同层并列，不是其后代——within(board) 找不到浮层
    expect(within(board).queryByTestId('home-status-overlay')).toBeNull();
    // 横幅本体仍在浮层内、正常呈现
    expect(
      within(overlay).getByText('桌面未连接 · 正在使用本地对话')
    ).toBeTruthy();
  });

  it('状态板行在淡出容器内（home-chat-list 仍属 home-board）', async () => {
    sessionStore.setState({
      sessions: [session({ pendingApprovalCount: 1 })],
    });
    const view = await renderHome();
    const board = view.getByTestId('home-board');
    expect(within(board).getByTestId('home-chat-list')).toBeTruthy();
    expect(within(board).getByTestId('chat-item-s-1')).toBeTruthy();
  });
});

describe('HomeScreen 点外失焦（2026-11-03）', () => {
  it('点中段内容区（问候空态面）→ 收键盘', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    try {
      const view = await renderHome();
      await fireEvent(view.getByTestId('home-board'), 'touchStart');
      expect(dismiss).toHaveBeenCalledTimes(1);
    } finally {
      dismiss.mockRestore();
    }
  });

  it('点状态板行 → 触摸冒泡到中段容器、同样收键盘（行点按语义由既有套件覆盖，此处只钉失焦接线）', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    try {
      sessionStore.setState({
        sessions: [session({ pendingApprovalCount: 1 })],
      });
      const view = await renderHome();
      await fireEvent(view.getByTestId('chat-item-s-1'), 'touchStart');
      expect(dismiss).toHaveBeenCalledTimes(1);
    } finally {
      dismiss.mockRestore();
    }
  });

  it('点 Composer 输入框 → 不收键盘（输入区在中段容器之外）', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    try {
      const view = await renderHome();
      await fireEvent(view.getByTestId('home-composer'), 'touchStart');
      expect(dismiss).not.toHaveBeenCalled();
    } finally {
      dismiss.mockRestore();
    }
  });
});

describe('useEverOpened 同步闩断言（方案 03 §3.1）', () => {
  it('当 open 从 false 变为 true 时，必须在 Commit 1 阶段立即返回 true，绝不延后至 Commit 2', async () => {
    let currentEver: boolean | null = null;
    function TestComponent({ open }: { open: boolean }) {
      currentEver = useEverOpened(open);
      return <View testID={currentEver ? 'mounted' : 'unmounted'} />;
    }

    const { rerender, getByTestId } = await render(
      <TestComponent open={false} />
    );
    expect(currentEver).toBe(false);
    expect(getByTestId('unmounted')).toBeTruthy();

    // 同步更新 open 为 true
    await rerender(<TestComponent open={true} />);
    // 刚性断言：不依赖 act 刷新 effect，必须在当前渲染帧即刻同步挂载！
    expect(currentEver).toBe(true);
    expect(getByTestId('mounted')).toBeTruthy();
  });

  it('当 open 恢复为 false 时，ever 恒保持 true 以便退出动画正常渲染', async () => {
    function TestComponent({ open }: { open: boolean }) {
      const ever = useEverOpened(open);
      return <View testID={ever ? 'mounted' : 'unmounted'} />;
    }

    const { rerender, getByTestId } = await render(
      <TestComponent open={true} />
    );
    expect(getByTestId('mounted')).toBeTruthy();

    await rerender(<TestComponent open={false} />);
    // 依然保持 mounted
    expect(getByTestId('mounted')).toBeTruthy();
  });
});
