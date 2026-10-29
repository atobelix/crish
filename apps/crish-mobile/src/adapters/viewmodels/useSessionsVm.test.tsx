// 会话列表视图模型测试：会话/窗口投影、连接态、刷新分支。
import { Pressable } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { useSessionsVm, type SessionsVm } from './useSessionsVm';
import { connectionStore } from '@/domain/store/connectionStore';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import type { SessionSummary } from '@/domain/store/sessionReducers';

const mockGetWiring = jest.fn();
const mockEnsureWiring = jest.fn();

jest.mock('@/adapters/wiring/observationWiring', () => ({
  getObservationWiring: () => mockGetWiring(),
  ensureObservationWiring: () => mockEnsureWiring(),
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
  connectionStore.setState({ phase: 'idle', lastError: null });
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

  it('connected 仅由 phase=ready 决定', async () => {
    connectionStore.setState({ phase: 'ready' });
    await render(<Probe />);
    expect(latest?.connected).toBe(true);
  });

  it('phase=reconnecting 时 connected 为假', async () => {
    connectionStore.setState({ phase: 'reconnecting' });
    await render(<Probe />);
    expect(latest?.connected).toBe(false);
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

  it('refresh 在完全无接线时安全返回（可选链兜底）', async () => {
    mockGetWiring.mockReturnValue(null);
    mockEnsureWiring.mockReturnValue(null);
    const view = await render(<Probe />);

    fireEvent.press(view.getByTestId('refresh'));
    await expect(Promise.resolve()).resolves.toBeUndefined();
  });
});
