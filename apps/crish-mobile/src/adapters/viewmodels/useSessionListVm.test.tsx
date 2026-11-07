// 抽屉会话列表视图模型测试：分区呈现（本地/远程互斥）、分组、搜索、
// 空态判定。分区环境与 useDeviceStatusVm.test 同摆法（真实 store）。
import { Pressable } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useSessionListVm, type SessionListVm } from './useSessionListVm';
import { sessionStore } from '@/domain/store/sessionStore';
import { accountStore } from '@/domain/store/accountStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import type { LocalThreadMeta } from '@/domain/types/localChat';

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

function thread(overrides: Partial<LocalThreadMeta> = {}): LocalThreadMeta {
  return {
    id: 'lth-1',
    title: '本地线程',
    titleSource: 'derived',
    preview: '',
    modelRef: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
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
  // 分区环境默认 = 本机当值（未登录 + 未连接，设备身份派生同口径）
  connectionStore.setState({ phase: 'disconnected', lastError: null });
  accountStore.getState().reset();
  localChatSessionStore.setState({
    threads: [],
    activeThreadId: null,
    streaming: false,
    inactive: {},
    hydrated: true,
  });
});

it('无会话时 hasSessions=false，两组为空（默认本地分区）', async () => {
  await render(<Probe />);
  expect(currentVm().partition).toBe('local');
  expect(currentVm().partitionLabel).toBe('本机');
  expect(currentVm().hasSessions).toBe(false);
  expect(currentVm().today).toEqual([]);
  expect(currentVm().earlier).toEqual([]);
});

it('按天分组，搜索后只保留命中项（远端分区）', async () => {
  // 非账号模式下链路 ready → 远端设备当值 → 远端分区
  connectionStore.setState({ phase: 'ready' });
  sessionStore.setState({
    sessions: [
      session(),
      session({ id: 's-2', title: '更早的会话', updatedAt: NOW - 2 * DAY }),
    ],
    selectedSessionId: null,
  });
  const view = await render(<Probe />);
  expect(currentVm().partition).toBe('remote');
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

it('分区互斥：本地分区只列本地线程，远端当值后只列远端会话', async () => {
  sessionStore.setState({ sessions: [session()], selectedSessionId: null });
  localChatSessionStore.setState({
    threads: [thread()],
    activeThreadId: null,
    streaming: false,
    inactive: {},
    hydrated: true,
  });
  await render(<Probe />);
  // 默认本机当值：远端会话存在也不进列表；空态按本地分区事实判定
  expect(currentVm().partition).toBe('local');
  expect(currentVm().partitionLabel).toBe('本机');
  expect(currentVm().today.map((r) => r.id)).toEqual(['lth-1']);
  expect(currentVm().today[0]?.kind).toBe('local');
  expect(currentVm().hasSessions).toBe(true);

  await act(async () => {
    connectionStore.setState({ phase: 'ready' });
  });
  // 链路 ready → 远端分区：本地线程退出列表，只剩远端会话
  expect(currentVm().partition).toBe('remote');
  expect(currentVm().today.map((r) => r.id)).toEqual(['s-1']);
  expect(currentVm().today[0]?.kind).toBe('remote');
  expect(currentVm().hasSessions).toBe(true);
});

// ── R10 关闭态冻结订阅 ────────────────────────────────────────────────────
describe('R10 关闭态冻结订阅（useSessionListVm active）', () => {
  function ActiveProbe(props: { active: boolean }): React.ReactElement | null {
    latest = useSessionListVm(NOW, { active: props.active });
    return null;
  }

  beforeEach(() => {
    latest = null;
    sessionStore.setState({ sessions: [], selectedSessionId: null });
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    accountStore.getState().reset();
    localChatSessionStore.setState({
      threads: [],
      activeThreadId: null,
      streaming: false,
      inactive: {},
      hydrated: true,
    });
  });

  it('关闭期间本地会话面高频变更不重算（快照冻结）；重开首帧即最新', async () => {
    localChatSessionStore.setState({
      threads: [thread()],
      activeThreadId: null,
      streaming: false,
      inactive: {},
      hydrated: true,
    });
    const view = await render(<ActiveProbe active={false} />);
    // 关闭态首帧：冻结快照照常呈现既有数据
    expect(currentVm().today.map((r) => r.id)).toEqual(['lth-1']);

    // 关闭期间流式高频变更（新线程 + 生成态），VM 不追新
    await act(async () => {
      localChatSessionStore.setState((s) => ({
        threads: [...s.threads, thread({ id: 'lth-2', title: '关闭中新增' })],
        streaming: true,
      }));
    });
    expect(currentVm().today.map((r) => r.id)).toEqual(['lth-1']);

    // 重开：回到实时读取，首帧即最新（订阅始终在线，无需补挂）
    await act(async () => {
      view.rerender(<ActiveProbe active={true} />);
    });
    expect(currentVm().today.map((r) => r.id)).toEqual(['lth-1', 'lth-2']);
  });

  it('活跃期间订阅实时（默认 active=true 行为不变）', async () => {
    const view = await render(<ActiveProbe active={true} />);
    expect(currentVm().today).toEqual([]);
    await act(async () => {
      localChatSessionStore.setState({
        threads: [thread()],
        activeThreadId: null,
        streaming: false,
        inactive: {},
        hydrated: true,
      });
    });
    expect(currentVm().today.map((r) => r.id)).toEqual(['lth-1']);
    await view.unmount();
  });
});
