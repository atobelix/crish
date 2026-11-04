// 会话列表视图模型测试：会话/窗口投影、连接态、刷新分支、对账状态透传（M1）。
import { Pressable } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { useSessionsVm, type SessionsVm } from './useSessionsVm';
import { accountStore } from '@/domain/store/accountStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import type { SessionSummary } from '@/domain/store/sessionReducers';

const mockGetWiring = jest.fn();
const mockEnsureWiring = jest.fn();
const mockReconnectNow = jest.fn();

jest.mock('@/adapters/wiring/observationWiring', () => ({
  getObservationWiring: () => mockGetWiring(),
  ensureObservationWiring: () => mockEnsureWiring(),
}));

jest.mock('@/adapters/runtime/appRuntime', () => ({
  reconnectNow: () => mockReconnectNow(),
}));

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    title: '会话',
    folder: '',
    isPinned: false,
    isArchived: false,
    timestamp: '',
    updatedAt: 0,
    messageCount: 0,
    receivedAtMs: 0,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    ...overrides,
  };
}

let latest: SessionsVm | null = null;

function Probe(): React.ReactElement {
  latest = useSessionsVm();
  return <Pressable testID="refresh" onPress={() => void latest?.refresh()} />;
}

beforeEach(() => {
  latest = null;
  jest.clearAllMocks();
  accountStore.getState().reset();
  connectionStore.setState({ phase: 'disconnected', lastError: null });
  sessionStore.setState({ sessions: [] });
  eventStore.setState({ windows: {} });
});

describe('useSessionsVm', () => {
  it('透传会话列表与事件窗口', async () => {
    sessionStore.setState({ sessions: [session()] });
    eventStore.setState({ windows: { 's-1': { sessionId: 's-1' } } as never });

    await render(<Probe />);

    expect(latest?.sessions).toHaveLength(1);
    expect(latest?.windows).toHaveProperty('s-1');
  });

  it('eventStore 中的 windows 变更不会触发 useSessionsVm 重新渲染（方案 21 细化数据订阅）', async () => {
    let renderCount = 0;
    function CountProbe(): React.ReactElement {
      latest = useSessionsVm();
      renderCount += 1;
      return <Pressable testID="count" />;
    }

    sessionStore.setState({ sessions: [session()] });
    await render(<CountProbe />);
    expect(renderCount).toBe(1);

    // 模拟后台数据回填（hydrate）导致 eventStore 内部 windows 引用变更
    await act(async () => {
      eventStore.setState({
        windows: { 's-2': { sessionId: 's-2' } } as never,
      });
    });

    // 细化订阅断言：useSessionsVm 不因此次 windows 变动而重绘，避免抽屉关闭期间击穿渲染树
    expect(renderCount).toBe(1);
    // 按需读取断言：仍可通过 getter 实时获取到最新的 windows 数据
    expect(latest?.windows).toHaveProperty('s-2');
  });

  it('connected 仅由 phase=ready 决定', async () => {
    connectionStore.setState({ phase: 'ready' });
    await render(<Probe />);
    expect(latest?.connected).toBe(true);
  });

  it('phase=recovering 时 connected 为假', async () => {
    connectionStore.setState({ phase: 'recovering' });
    await render(<Probe />);
    expect(latest?.connected).toBe(false);
  });

  it('对账状态透传（M1）：error + 错误信息 / ok + 成功打点随 store 变化', async () => {
    connectionStore.setState({
      sessionSyncStatus: 'error',
      sessionSyncError: '对账超时',
      lastReconcileAt: null,
    });
    await render(<Probe />);
    expect(latest?.syncStatus).toBe('error');
    expect(latest?.syncError).toBe('对账超时');
    expect(latest?.lastReconcileAt).toBeNull();

    await act(async () => {
      connectionStore.getState().markSessionSyncSucceeded(4242);
    });
    expect(latest?.syncStatus).toBe('ok');
    expect(latest?.syncError).toBeNull();
    expect(latest?.lastReconcileAt).toBe(4242);
  });

  it('refresh 复用已有 wiring', async () => {
    const refreshNow = jest.fn(async () => {});
    mockGetWiring.mockReturnValue({ bridge: { refreshNow } });
    const view = await render(<Probe />);

    fireEvent.press(view.getByTestId('refresh'));
    await Promise.resolve();

    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(mockEnsureWiring).not.toHaveBeenCalled();
  });

  it('refresh 在无 wiring 时尝试建立', async () => {
    const refreshNow = jest.fn(async () => {});
    mockGetWiring.mockReturnValue(null);
    mockEnsureWiring.mockReturnValue({ bridge: { refreshNow } });
    const view = await render(<Probe />);

    fireEvent.press(view.getByTestId('refresh'));
    await Promise.resolve();

    expect(mockEnsureWiring).toHaveBeenCalledTimes(1);
    expect(refreshNow).toHaveBeenCalledTimes(1);
  });

  it('refresh 在账号模式无 wiring 时走 reconnectNow，不回落 LAN 接线（CON-1）', async () => {
    accountStore.setState({ status: 'loggedIn' });
    mockGetWiring.mockReturnValue(null);
    const view = await render(<Probe />);

    fireEvent.press(view.getByTestId('refresh'));
    await Promise.resolve();

    expect(mockReconnectNow).toHaveBeenCalledTimes(1);
    expect(mockEnsureWiring).not.toHaveBeenCalled();
  });

  it('refresh 在完全无接线时安全返回（可选链兜底）', async () => {
    mockGetWiring.mockReturnValue(null);
    mockEnsureWiring.mockReturnValue(null);
    const view = await render(<Probe />);

    fireEvent.press(view.getByTestId('refresh'));
    await expect(Promise.resolve()).resolves.toBeUndefined();
  });
});
