// 主屏会话同步呈现测试（M1 → 2026-11-02 增量/悬浮口径）：同步错误悬浮
// 面板（在状态浮层内、绝对定位、不占布局高度；状态板行仍显 / 重试接线）、
// syncing 零呈现（无「正在同步…」）、下拉刷新接线、local 模式不双横幅。
// 与 homeScreen.test.tsx 分工：那边管状态板行/提交/本地模式，本文件只管
// 同步状态呈现面；observationWiring 以假 bridge 注入以便断言 refresh 接线。
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { RunTaskParams, RunTaskResult } from '@crish/shared-types';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { authStore } from '@/domain/store/authStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { eventStore } from '@/domain/store/eventStore';
import { notificationStore } from '@/domain/store/notificationStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { localChatStore } from '@/domain/store/localChatStore';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import { ToastProvider } from '@/presentation/ui';
import HomeScreen from './homeScreen';

const mockRunTask = jest.fn<Promise<RunTaskResult>, [RunTaskParams]>();
const mockRefreshNow = jest.fn(async () => {});
const mockRouterPush = jest.fn();

jest.mock('@/adapters/RemoteControlFacade', () => ({
  ...jest.requireActual('@/adapters/RemoteControlFacade'),
  getQuickRunContext: () => ({ repository: { runTask: mockRunTask } }),
  getModelsContext: () => null,
  remoteControlFacade: {
    ...jest.requireActual('@/adapters/RemoteControlFacade').remoteControlFacade,
    isAvailable: () => true,
    runTask: mockRunTask,
    quickRunRepo: { runTask: mockRunTask },
  },
}));

jest.mock('@/adapters/wiring/observationWiring', () => ({
  ...jest.requireActual('@/adapters/wiring/observationWiring'),
  // 假 wiring 须带 client.gateway：files/skills 等域的上下文工厂会读
  // wiring.client.gateway 装配仓库（缺字段即崩）。工厂内经 requireActual
  // 取真实 WsGateway（mock 工厂禁引用外部变量）——无传输注入时 invoke
  // 立即以 transport.closed 拒绝，各 VM 落 error 态自行收敛，不影响
  // 本文件的同步呈现断言。
  getObservationWiring: () => {
    const { WsGateway: GatewayCtor } = jest.requireActual(
      '@/network/WsGateway'
    );
    return {
      bridge: { refreshNow: mockRefreshNow },
      client: { gateway: new GatewayCtor() },
    };
  },
  ensureObservationWiring: () => null,
}));



jest.mock('expo-router', () => ({
  // 焦点钩子：测试环境无导航焦点变化，挂载即视为聚焦（与 homeScreen.test 同口径）
  useFocusEffect: (effect: () => void | (() => void)) => {
    effect();
  },
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

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const NOW = 1_800_000_000_000;

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    title: '残量会话',
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

function renderHome() {
  return render(
    <HomeScreen
      onOpenDrawer={jest.fn()}
      onOpenNotifications={jest.fn()}
      onOpenSession={jest.fn()}
      onOpenLocalThread={jest.fn()}
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
  mockRefreshNow.mockClear();
  mockRouterPush.mockReset();
  connectionStore.setState({
    phase: 'ready',
    lastError: null,
    sessionSyncStatus: 'idle',
    sessionSyncError: null,
    lastReconcileAt: null,
  });
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

describe('HomeScreen 会话同步呈现（M1 → 悬浮口径）', () => {
  it('error：悬浮错误面板 + 错误信息在位，状态板行仍显；面板在浮层内绝对定位（不占布局高度）', async () => {
    connectionStore.setState({
      sessionSyncStatus: 'error',
      sessionSyncError: '对账超时',
    });
    // 待审批资格 → 状态板行在位（错误呈现不藏行）
    sessionStore.setState({
      sessions: [session({ pendingApprovalCount: 1 })],
    });
    const view = await renderHome();
    expect(view.getByTestId('session-sync-bar')).toBeTruthy();
    expect(view.getByText('会话列表同步失败，可能不完整')).toBeTruthy();
    expect(view.getByText('对账超时')).toBeTruthy();
    expect(view.getByText('残量会话')).toBeTruthy();
    // 悬浮定位断言：浮层容器 position:absolute，错误面板是其后代
    const overlay = view.getByTestId('home-status-overlay');
    expect(StyleSheet.flatten(overlay.props.style)?.position).toBe('absolute');
    expect(within(overlay).getByTestId('session-sync-bar')).toBeTruthy();
  });

  it('error 条重试钮 → 走 useSessionsVm.refresh（bridge.refreshNow）', async () => {
    connectionStore.setState({
      sessionSyncStatus: 'error',
      sessionSyncError: '对账超时',
    });
    sessionStore.setState({ sessions: [session()] });
    const view = await renderHome();
    await fireEvent.press(view.getByLabelText('重试同步会话列表'));
    expect(mockRefreshNow).toHaveBeenCalledTimes(1);
  });

  it('syncing：零呈现（无「正在同步…」文案、无同步条）；ok：同样不呈现', async () => {
    connectionStore.setState({ sessionSyncStatus: 'syncing' });
    sessionStore.setState({
      sessions: [session({ pendingApprovalCount: 1 })],
    });
    const view = await renderHome();
    expect(view.queryByText('正在同步会话列表…')).toBeNull();
    expect(view.queryByTestId('session-sync-bar')).toBeNull();
    // 状态板行本身照常呈现（同步呈现降噪 ≠ 藏内容）
    expect(view.getByText('残量会话')).toBeTruthy();

    await act(async () => {
      connectionStore.setState({ sessionSyncStatus: 'ok' });
    });
    expect(view.queryByTestId('session-sync-bar')).toBeNull();
  });

  it('local 模式 + error：不呈同步条（连接横幅已说明，避免双横幅）', async () => {
    connectionStore.setState({
      phase: 'disconnected',
      sessionSyncStatus: 'error',
      sessionSyncError: '对账超时',
    });
    const view = await renderHome();
    expect(view.queryByTestId('session-sync-bar')).toBeNull();
    expect(view.getByText('桌面未连接 · 正在使用本地对话')).toBeTruthy();
  });
});

describe('HomeScreen 下拉刷新（M1 接线）', () => {
  it('FlatList 挂 RefreshControl；触发 onRefresh → bridge.refreshNow', async () => {
    sessionStore.setState({
      sessions: [session({ pendingApprovalCount: 1 })],
    });
    const view = await renderHome();
    const list = view.getByTestId('home-chat-list');
    const refreshControl = list.props.refreshControl as React.ReactElement<{
      refreshing: boolean;
      onRefresh: () => Promise<void>;
    }>;
    expect(refreshControl).toBeTruthy();
    expect(refreshControl.props.refreshing).toBe(false);
    await act(async () => {
      await refreshControl.props.onRefresh();
    });
    expect(mockRefreshNow).toHaveBeenCalledTimes(1);
  });
});

describe('HomeScreen 语音手势与输入框分流契约（方案 01 对齐）', () => {
  it('解耦远端连接：未连接状态（disconnected）下输入框保持 editable，长按手势分流层在场使能', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    const view = await renderHome();

    // 1. 输入框保持 editable=true（解耦远端连接）
    const input = view.getByTestId('home-composer');
    expect(input.props.editable).toBe(true);

    // 2. 透明手势分流层在场挂载
    const overlay = view.getByTestId('home-composer-voice-touch-overlay');
    expect(overlay).toBeTruthy();

    // 3. 未聚焦时 pointerEvents="auto" 接管触控
    expect(overlay.props.pointerEvents).toBe('auto');
  });

  it('占位文案统一：远端模式下占位提示为「点击发消息、长按语音输入」', async () => {
    connectionStore.setState({ phase: 'ready', lastError: null });
    const view = await renderHome();

    const input = view.getByTestId('home-composer');
    expect(input.props.placeholder).toBe('点击发消息、长按语音输入');
  });

  it('双模分流层拓扑契约：透明分流层绝对铺满，未聚焦时拦截触控', async () => {
    connectionStore.setState({ phase: 'ready', lastError: null });
    const view = await renderHome();

    const overlay = view.getByTestId('home-composer-voice-touch-overlay');
    const flat = StyleSheet.flatten(overlay.props.style);
    expect(flat.position).toBe('absolute');
    expect(flat.top).toBe(0);
    expect(flat.bottom).toBe(0);
    expect(flat.left).toBe(0);
    expect(flat.right).toBe(0);
    expect(overlay.props.pointerEvents).toBe('auto');
  });
});
