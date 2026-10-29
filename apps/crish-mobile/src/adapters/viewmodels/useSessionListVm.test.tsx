// 抽屉会话列表视图模型测试：分组、搜索、空态判定。
import { Pressable } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useSessionListVm, type SessionListVm } from './useSessionListVm';
import { sessionStore } from '@/domain/store/sessionStore';
import type { SessionSummary } from '@/domain/store/sessionReducers';

jest.mock('@/adapters/wiring/observationWiring', () => ({
  getObservationWiring: () => null,
  ensureObservationWiring: () => null,
}));

const NOW = new Date(2026, 9, 29, 15, 0, 0).getTime();
const DAY = 86_400_000;

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    title: '今天的会话',
    updatedAt: NOW - 60_000,
    receivedAtMs: NOW,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    ...overrides,
  };
}

let latest: SessionListVm | null = null;

function Probe(): React.ReactElement {
  latest = useSessionListVm(NOW);
  return <Pressable testID="search" onPress={() => latest?.setQuery('更早')} />;
}

function currentVm(): SessionListVm {
  if (!latest) throw new Error('vm 未渲染');
  return latest;
}

beforeEach(() => {
  latest = null;
  sessionStore.setState({ sessions: [], selectedSessionId: null });
});

it('无会话时 hasSessions=false，两组为空', async () => {
  await render(<Probe />);
  expect(currentVm().hasSessions).toBe(false);
  expect(currentVm().today).toEqual([]);
  expect(currentVm().earlier).toEqual([]);
});

it('按天分组，搜索后只保留命中项', async () => {
  sessionStore.setState({
    sessions: [
      session(),
      session({ id: 's-2', title: '更早的会话', updatedAt: NOW - 2 * DAY }),
    ],
    selectedSessionId: null,
  });
  const view = await render(<Probe />);
  expect(currentVm().today.map((s) => s.id)).toEqual(['s-1']);
  expect(currentVm().earlier.map((s) => s.id)).toEqual(['s-2']);

  await act(async () => {
    await fireEvent.press(view.getByTestId('search'));
  });
  await waitFor(() => expect(currentVm().today).toEqual([]));
  expect(currentVm().query).toBe('更早');
  expect(currentVm().earlier.map((s) => s.id)).toEqual(['s-2']);
  expect(currentVm().hasSessions).toBe(true);
});
