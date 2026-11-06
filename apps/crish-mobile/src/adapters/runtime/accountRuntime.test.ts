// 账号远程运行时测试：资格判定、接线建立/销毁、目标切换、心跳定时器清理。
//
// 这是账号远程模式的核心状态机（旧覆盖率 4.54%）：判定错误会导致「已登录但
// 永远连不上」或「换目标后仍连旧设备」。
import { accountStore } from '@/domain/store/accountStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { deviceDirectoryStore } from '@/domain/store/deviceDirectoryStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { eventStore, lastSeqOf } from '@/domain/store/eventStore';
import { approvalStore } from '@/domain/store/approvalStore';
import { deviceSnapshotStore } from '@/domain/store/deviceSnapshotStore';
import type { EventEnvelopeFrame } from '@/domain/store/eventReducers';
import type { SessionIndexEntry } from '@crish/shared-types';
import type { AccountDevice } from '@/domain/types/account';

jest.mock('@/adapters/wiring/observationWiring', () => ({
  ensureRelayObservationWiring: jest.fn(),
  disposeObservationWiring: jest.fn(),
  getObservationWiring: jest.fn(() => null),
}));

jest.mock('@/adapters/wiring/approvalWiring', () => ({
  ensureApprovalWiring: jest.fn(),
  disposeApprovalWiring: jest.fn(),
}));

jest.mock('@/network/RelaySocket', () => ({
  RelaySocket: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@/adapters/account/accountService', () => ({
  hydrateAccount: jest.fn(async () => {}),
  reconcileAccountRemote: jest.fn(async () => {}),
  refreshAccountDevices: jest.fn(async () => {}),
  requestClientTicket: jest.fn(async () => ({
    ticket: 'tk',
    relayUrl: 'wss://r',
    exp: 1,
  })),
  selectAccountTarget: jest.fn(() => {}),
}));

import {
  startAccountRuntime,
  stopAccountRuntime,
  accountRemoteTargetId,
  refreshAndSyncAccountRemote,
} from './accountRuntime';
import { subscribeHostToasts } from '@/presentation/ui/toastBus';
import {
  ensureRelayObservationWiring,
  disposeObservationWiring,
  getObservationWiring,
} from '@/adapters/wiring/observationWiring';
import {
  ensureApprovalWiring,
  disposeApprovalWiring,
} from '@/adapters/wiring/approvalWiring';

const ensureRelayMock = ensureRelayObservationWiring as jest.Mock;
const disposeObsMock = disposeObservationWiring as jest.Mock;
const getObsMock = getObservationWiring as jest.Mock;
const ensureApprovalMock = ensureApprovalWiring as jest.Mock;
const disposeApprovalMock = disposeApprovalWiring as jest.Mock;

function device(overrides: Partial<AccountDevice> = {}): AccountDevice {
  return {
    id: 'd-1',
    name: '桌面',
    platform: 'desktop',
    lastSeenAt: Date.now(),
    online: true,
    ...overrides,
  };
}

/** 把 store 置为「可建立远程连接」的完整状态 */
function setEligible(targetId = 'd-1', online = true): void {
  accountStore.setState({
    status: 'loggedIn',
    accessToken: 'at',
    targetDeviceId: targetId,
    devices: [device({ id: targetId, online })],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  stopAccountRuntime();
  accountStore.getState().reset();
  deviceDirectoryStore.getState().clear();
  getObsMock.mockReturnValue(null);
});

afterEach(() => {
  stopAccountRuntime();
  jest.useRealTimers();
});

describe('startAccountRuntime / stopAccountRuntime', () => {
  it('启动幂等（重复调用不重复订阅）', () => {
    startAccountRuntime();
    startAccountRuntime();
    // 停止一次即可完全收口；若重复订阅，stop 后仍会有监听残留（此处以定时器数量间接验证）
    stopAccountRuntime();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stop 清理发现定时器', () => {
    startAccountRuntime();
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    stopAccountRuntime();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('未启动时 stop 是空操作', () => {
    expect(() => stopAccountRuntime()).not.toThrow();
  });

  it('发现定时器仅在 loggedIn 时刷新设备', async () => {
    const { refreshAccountDevices } = jest.requireMock(
      '@/adapters/account/accountService'
    ) as { refreshAccountDevices: jest.Mock };
    startAccountRuntime();
    refreshAccountDevices.mockClear();

    // 未登录：不应刷新
    jest.advanceTimersByTime(15_000);
    expect(refreshAccountDevices).not.toHaveBeenCalled();

    // 登录后：应刷新
    accountStore.setState({ status: 'loggedIn' });
    jest.advanceTimersByTime(15_000);
    expect(refreshAccountDevices).toHaveBeenCalled();
  });
});

describe('syncRemote 资格判定', () => {
  it('未登录时不建立 relay 接线', () => {
    startAccountRuntime();
    accountStore.setState({ status: 'loggedOut', targetDeviceId: 'd-1' });
    expect(ensureRelayMock).not.toHaveBeenCalled();
  });

  it('缺少 targetDeviceId 时不建立接线', () => {
    startAccountRuntime();
    accountStore.setState({
      status: 'loggedIn',
      accessToken: 'at',
      targetDeviceId: null,
      devices: [device()],
    });
    expect(ensureRelayMock).not.toHaveBeenCalled();
  });

  it('目标设备离线时不建立接线', () => {
    startAccountRuntime();
    setEligible('d-1', false);
    expect(ensureRelayMock).not.toHaveBeenCalled();
  });

  it('目标设备不在列表中时不建立接线', () => {
    startAccountRuntime();
    accountStore.setState({
      status: 'loggedIn',
      accessToken: 'at',
      targetDeviceId: 'missing',
      devices: [device({ id: 'd-1' })],
    });
    expect(ensureRelayMock).not.toHaveBeenCalled();
  });

  it('全部条件满足时建立 relay 接线与审批接线', () => {
    startAccountRuntime();
    setEligible('d-1');

    expect(ensureRelayMock).toHaveBeenCalledTimes(1);
    expect(ensureApprovalMock).toHaveBeenCalledTimes(1);
    expect(accountRemoteTargetId()).toBe('d-1');
  });

  it('接线 url 携带目标设备标识', () => {
    startAccountRuntime();
    setEligible('d-7');

    expect(ensureRelayMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'relay://d-7' })
    );
  });
});

describe('目标切换与销毁', () => {
  it('切换到新目标时先销毁旧接线再建立新接线', () => {
    startAccountRuntime();
    setEligible('d-1');
    expect(accountRemoteTargetId()).toBe('d-1');

    accountStore.setState({
      targetDeviceId: 'd-2',
      devices: [device({ id: 'd-1' }), device({ id: 'd-2' })],
    });

    expect(disposeObsMock).toHaveBeenCalled();
    expect(disposeApprovalMock).toHaveBeenCalled();
    expect(accountRemoteTargetId()).toBe('d-2');
  });

  it('同一目标重复同步不重建接线', () => {
    startAccountRuntime();
    setEligible('d-1');
    ensureRelayMock.mockClear();

    // 触发一次同目标的状态更新
    accountStore.setState({ devices: [device({ id: 'd-1' })] });

    expect(ensureRelayMock).not.toHaveBeenCalled();
  });

  it('失去资格时销毁接线并重置连接态', () => {
    startAccountRuntime();
    setEligible('d-1');
    connectionStore.getState().setPhase('ready');

    accountStore.setState({ targetDeviceId: null });

    expect(disposeObsMock).toHaveBeenCalled();
    expect(accountRemoteTargetId()).toBeNull();
    expect(connectionStore.getState().phase).toBe('disconnected');
  });
});

describe('资格门去抖（CON-1）', () => {
  it('目标第一轮发现未命中保留接线，第二轮未命中才拆线', () => {
    startAccountRuntime();
    setEligible('d-1');
    expect(accountRemoteTargetId()).toBe('d-1');

    // 第 1 轮未命中（新发现快照：目标离线）→ 保留
    accountStore.setState({ devices: [device({ id: 'd-1', online: false })] });
    expect(disposeObsMock).not.toHaveBeenCalled();
    expect(accountRemoteTargetId()).toBe('d-1');

    // 第 2 轮未命中（又一轮新快照）→ 拆线
    accountStore.setState({ devices: [device({ id: 'd-1', online: false })] });
    expect(disposeObsMock).toHaveBeenCalled();
    expect(accountRemoteTargetId()).toBeNull();
  });

  it('同一轮快照内的重复 sync 不重复计未命中（引用未变不算新轮次）', () => {
    startAccountRuntime();
    setEligible('d-1');
    const missSnapshot = [device({ id: 'd-1', online: false })];
    accountStore.setState({ devices: missSnapshot });
    // 同一引用再触发若干次 sync（其它字段变化）仍只算 1 轮
    accountStore.setState({ error: 'x' });
    accountStore.setState({ devices: missSnapshot });
    expect(disposeObsMock).not.toHaveBeenCalled();
    expect(accountRemoteTargetId()).toBe('d-1');
  });

  it('未命中后目标恢复在线：不拆线且未命中计数清零', () => {
    startAccountRuntime();
    setEligible('d-1');

    accountStore.setState({ devices: [device({ id: 'd-1', online: false })] });
    accountStore.setState({ devices: [device({ id: 'd-1', online: true })] });
    expect(disposeObsMock).not.toHaveBeenCalled();
    expect(accountRemoteTargetId()).toBe('d-1');

    // 计数已清零：再来一轮未命中仍保留（须连续 2 轮才拆）
    accountStore.setState({ devices: [device({ id: 'd-1', online: false })] });
    expect(disposeObsMock).not.toHaveBeenCalled();
    expect(accountRemoteTargetId()).toBe('d-1');
  });

  it('硬资格丢失（登出）立即拆线，不去抖', () => {
    startAccountRuntime();
    setEligible('d-1');

    accountStore.setState({ status: 'loggedOut' });

    expect(disposeObsMock).toHaveBeenCalled();
    expect(accountRemoteTargetId()).toBeNull();
  });

  it('目标从发现中整轮消失同样计未命中（缺席与离线同口径）', () => {
    startAccountRuntime();
    setEligible('d-1');

    accountStore.setState({ devices: [] });
    expect(disposeObsMock).not.toHaveBeenCalled();
    accountStore.setState({ devices: [device({ id: 'other' })] });
    expect(disposeObsMock).toHaveBeenCalled();
    expect(accountRemoteTargetId()).toBeNull();
  });
});

describe('发现后显式同步与 dead 复活（CON-1）', () => {
  it('refreshAndSyncAccountRemote：dead 接线被同步复活并补一轮发现', () => {
    const { refreshAccountDevices } = jest.requireMock(
      '@/adapters/account/accountService'
    ) as { refreshAccountDevices: jest.Mock };
    startAccountRuntime();
    setEligible('d-1');
    const connect = jest.fn();
    getObsMock.mockReturnValue({ client: { phase: 'dead', connect } });
    refreshAccountDevices.mockClear();

    refreshAndSyncAccountRemote();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(refreshAccountDevices).toHaveBeenCalledTimes(1);
  });

  it('发现心跳 tick 主动 sync：发现未产生 store 变化时 dead 接线也被复活', () => {
    startAccountRuntime();
    setEligible('d-1');
    const connect = jest.fn();
    getObsMock.mockReturnValue({ client: { phase: 'dead', connect } });

    jest.advanceTimersByTime(15_000);

    expect(connect).toHaveBeenCalled();
  });
});

describe('已知设备目录喂数（G4）', () => {
  it('登录态同步把最新发现并入目录', () => {
    startAccountRuntime();
    setEligible('d-1');
    expect(deviceDirectoryStore.getState().knownDevices).toEqual([
      expect.objectContaining({ id: 'd-1', online: true }),
    ]);
  });

  it('后续发现中消失的设备在目录里转离线保留（不谎报在线）', () => {
    startAccountRuntime();
    setEligible('d-1');
    accountStore.setState({
      targetDeviceId: 'd-2',
      devices: [device({ id: 'd-2' })],
    });
    const known = deviceDirectoryStore.getState().knownDevices;
    expect(known.find((d) => d.id === 'd-1')?.online).toBe(false);
    expect(known.find((d) => d.id === 'd-2')?.online).toBe(true);
  });

  it('登出清空目录（账号作用域，不残留上一账号设备）', () => {
    startAccountRuntime();
    setEligible('d-1');
    expect(deviceDirectoryStore.getState().knownDevices.length).toBe(1);
    accountStore.setState({ status: 'loggedOut' });
    expect(deviceDirectoryStore.getState().knownDevices).toEqual([]);
  });
});

describe('CON-3 断线保留与设备分区', () => {
  function entry(id: string): SessionIndexEntry {
    return { id, title: `会话 ${id}`, updatedAt: 1000 };
  }

  function frame(sessionId: string, sequence: number): EventEnvelopeFrame {
    return { sessionId, type: 'message-end', sequence } as EventEnvelopeFrame;
  }

  function seedSession(id: string): void {
    sessionStore.getState().upsert(entry(id));
  }

  /** 两轮发现未命中（去抖到期）→ 拆线断开 */
  function disconnectByMisses(id = 'd-1'): void {
    accountStore.setState({ devices: [device({ id, online: false })] });
    accountStore.setState({ devices: [device({ id, online: false })] });
  }

  beforeEach(() => {
    sessionStore.getState().reset();
    eventStore.getState().reset();
    approvalStore.getState().reset();
    deviceSnapshotStore.setState({
      snapshots: {},
      liveStale: false,
      liveSnapshotAt: null,
    });
  });

  it('同设备断线（去抖到期拆线）后会话列表原地保留 + 陈旧标记，不再 wipe', () => {
    startAccountRuntime();
    setEligible('d-1');
    seedSession('a-1');

    disconnectByMisses();

    expect(disposeObsMock).toHaveBeenCalled();
    expect(accountRemoteTargetId()).toBeNull();
    expect(connectionStore.getState().phase).toBe('disconnected');
    // 数据面保留（CON-3 前 disposeRemote 在此处连带 reset 三店）
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual(['a-1']);
    expect(sessionStore.getState().ownerDeviceId).toBe('d-1');
    expect(deviceSnapshotStore.getState().liveStale).toBe(true);
  });

  it('断线后同设备重连：数据仍在 live、盖章不变、接线以同目标重建', () => {
    startAccountRuntime();
    setEligible('d-1');
    seedSession('a-1');
    disconnectByMisses();
    ensureRelayMock.mockClear();

    accountStore.setState({ devices: [device({ id: 'd-1', online: true })] });

    expect(ensureRelayMock).toHaveBeenCalledTimes(1);
    expect(accountRemoteTargetId()).toBe('d-1');
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual(['a-1']);
    expect(sessionStore.getState().ownerDeviceId).toBe('d-1');
  });

  it('切换设备往返：A 列表分键保留、B 只见自己、切回 A 原样恢复（绝不串）', () => {
    startAccountRuntime();
    setEligible('d-1');
    seedSession('a-1');
    seedSession('a-2');

    accountStore.setState({
      targetDeviceId: 'd-2',
      devices: [device({ id: 'd-1' }), device({ id: 'd-2' })],
    });
    // B 呈现空表（无 B 快照）；A 数据进 A 分区
    expect(sessionStore.getState().sessions).toEqual([]);
    expect(sessionStore.getState().ownerDeviceId).toBe('d-2');
    expect(
      deviceSnapshotStore.getState().snapshots['d-1']?.sessions.map((s) => s.id)
    ).toEqual(['a-1', 'a-2']);

    seedSession('b-1');
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual(['b-1']);

    // 切回 A：A 快照恢复 + 陈旧标记；B 数据进 B 分区、不混入
    accountStore.setState({
      targetDeviceId: 'd-1',
      devices: [device({ id: 'd-1' }), device({ id: 'd-2' })],
    });
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual([
      'a-1',
      'a-2',
    ]);
    expect(deviceSnapshotStore.getState().liveStale).toBe(true);
    expect(
      deviceSnapshotStore.getState().snapshots['d-2']?.sessions.map((s) => s.id)
    ).toEqual(['b-1']);

    // 再切 B：只见 b-1
    accountStore.setState({
      targetDeviceId: 'd-2',
      devices: [device({ id: 'd-1' }), device({ id: 'd-2' })],
    });
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual(['b-1']);
  });

  it('切到离线设备（暂不合资格）：旧设备数据同样分键保留，新目标呈空表', () => {
    startAccountRuntime();
    setEligible('d-1');
    seedSession('a-1');

    accountStore.setState({
      targetDeviceId: 'd-2',
      devices: [device({ id: 'd-1' }), device({ id: 'd-2', online: false })],
    });

    expect(accountRemoteTargetId()).toBeNull();
    expect(sessionStore.getState().sessions).toEqual([]);
    expect(sessionStore.getState().ownerDeviceId).toBe('d-2');
    expect(
      deviceSnapshotStore.getState().snapshots['d-1']?.sessions.map((s) => s.id)
    ).toEqual(['a-1']);

    // d-2 上线建线后切回 d-1：A 快照仍可恢复
    accountStore.setState({
      devices: [device({ id: 'd-1' }), device({ id: 'd-2', online: true })],
    });
    expect(accountRemoteTargetId()).toBe('d-2');
    accountStore.setState({
      targetDeviceId: 'd-1',
      devices: [device({ id: 'd-1' }), device({ id: 'd-2' })],
    });
    expect(sessionStore.getState().sessions.map((s) => s.id)).toEqual(['a-1']);
  });

  it('事件窗口随数据面一同保留/分区（断线不清窗、切换不串窗）', () => {
    startAccountRuntime();
    setEligible('d-1');
    seedSession('a-1');
    eventStore.getState().ingest('a-1', frame('a-1', 3), false, 1000);
    expect(lastSeqOf('a-1')).toBe(3);

    disconnectByMisses();
    expect(lastSeqOf('a-1')).toBe(3);

    accountStore.setState({
      targetDeviceId: 'd-2',
      devices: [device({ id: 'd-1' }), device({ id: 'd-2' })],
    });
    expect(eventStore.getState().windows).toEqual({});

    accountStore.setState({
      targetDeviceId: 'd-1',
      devices: [device({ id: 'd-1' }), device({ id: 'd-2' })],
    });
    expect(lastSeqOf('a-1')).toBe(3);
  });

  it('登出：live 与全部分区快照一并清除，盖章归零', () => {
    startAccountRuntime();
    setEligible('d-1');
    seedSession('a-1');
    accountStore.setState({
      targetDeviceId: 'd-2',
      devices: [device({ id: 'd-1' }), device({ id: 'd-2' })],
    });
    seedSession('b-1');
    // 前置状态：注册表有 d-1 分区，live 是 d-2 的 b-1
    expect(deviceSnapshotStore.getState().snapshots['d-1']).toBeDefined();

    accountStore.setState({ status: 'loggedOut' });

    expect(sessionStore.getState().sessions).toEqual([]);
    expect(deviceSnapshotStore.getState().snapshots).toEqual({});
    expect(sessionStore.getState().ownerDeviceId).toBeNull();
    expect(deviceSnapshotStore.getState().liveStale).toBe(false);
  });
});

describe('发现心跳与列表同步解耦（2026-11-02 增量口径）', () => {
  it('心跳 tick 只维护设备表：目标未变 + 接线存活 → 不重建接线、会话数据面零写入', () => {
    const { refreshAccountDevices } = jest.requireMock(
      '@/adapters/account/accountService'
    ) as { refreshAccountDevices: jest.Mock };
    startAccountRuntime();
    setEligible('d-1');
    getObsMock.mockReturnValue({
      client: { phase: 'open', connect: jest.fn() },
    });
    ensureRelayMock.mockClear();
    refreshAccountDevices.mockClear();
    const sessionsBefore = sessionStore.getState().sessions;

    jest.advanceTimersByTime(45_000);

    // 设备发现轮次在推进（设备表维护面存活）
    expect(refreshAccountDevices).toHaveBeenCalled();
    // 接线零重建：无新桥即无从触发任何列表对账/同步（心跳与列表同步解耦）
    expect(ensureRelayMock).not.toHaveBeenCalled();
    // 会话数据面引用不变（零写入）
    expect(sessionStore.getState().sessions).toBe(sessionsBefore);
  });
});

describe('设备上线边沿提醒（2026-11-05 目标主权对称面）', () => {
  function makeDevice(id: string, online: boolean): AccountDevice {
    return {
      id,
      name: `桌面-${id}`,
      platform: 'desktop',
      lastSeenAt: Date.now(),
      online,
    };
  }

  it('非目标桌面上线发纯提醒（无直达动作）；目标上线与冷启动首轮不提醒', () => {
    const seen: Array<Record<string, any>> = [];
    const unsub = subscribeHostToasts((options) => {
      seen.push(typeof options === 'string' ? { message: options } : options);
    });
    try {
      startAccountRuntime();

      // 冷启动首轮发现（prev = null）：即使有非目标在线也不产生边沿
      accountStore.setState({
        status: 'loggedIn',
        accessToken: 'at',
        targetDeviceId: 'd-1',
        devices: [makeDevice('d-1', true), makeDevice('d-2', true)],
      });
      expect(seen).toHaveLength(0);

      // 下一轮：新桌面 d-3 上线 → 一条纯提醒（定案形态：不带「切换」
      // 直达动作，切换由用户开 DeviceSheet 手动完成，提醒绝不代选）
      accountStore.setState({
        devices: [
          makeDevice('d-1', true),
          makeDevice('d-2', false),
          makeDevice('d-3', true),
        ],
      });
      expect(seen).toHaveLength(1);
      const toast = seen[0]!;
      expect(toast.message).toContain('桌面-d-3');
      expect(toast.actions).toBeUndefined();
      const { selectAccountTarget } = jest.requireMock(
        '@/adapters/account/accountService'
      );
      expect(selectAccountTarget).not.toHaveBeenCalled();

      // 稳态轮次（引用变化但无新上线边沿）：不重复提醒
      accountStore.setState({
        devices: [
          makeDevice('d-1', true),
          makeDevice('d-2', false),
          makeDevice('d-3', true),
        ].map((d) => ({ ...d, lastSeenAt: d.lastSeenAt + 1000 })),
      });
      expect(seen).toHaveLength(1);
    } finally {
      unsub();
      stopAccountRuntime();
    }
  });

  it('同一轮多台桌面上线合并为一条提醒（防扰约束③）', () => {
    const seen: Array<Record<string, any>> = [];
    const unsub = subscribeHostToasts((options) => {
      seen.push(typeof options === 'string' ? { message: options } : options);
    });
    try {
      startAccountRuntime();

      // 首轮：只有目标在线
      accountStore.setState({
        status: 'loggedIn',
        accessToken: 'at',
        targetDeviceId: 'd-1',
        devices: [makeDevice('d-1', true)],
      });
      expect(seen).toHaveLength(0);

      // 下一轮：d-2 与 d-3 同时上线 → 合并为一条（不是逐台两条）
      accountStore.setState({
        devices: [
          makeDevice('d-1', true),
          makeDevice('d-2', true),
          makeDevice('d-3', true),
        ],
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.message).toContain('桌面-d-2');
      expect(seen[0]!.message).toContain('桌面-d-3');
      expect(seen[0]!.message).toContain('2 台');
      expect(seen[0]!.actions).toBeUndefined();
    } finally {
      unsub();
      stopAccountRuntime();
    }
  });

  it('当前目标自身上线不提醒（接线恢复已在连接横幅可见）', () => {
    const seen: Array<Record<string, any>> = [];
    const unsub = subscribeHostToasts((options) => {
      seen.push(typeof options === 'string' ? { message: options } : options);
    });
    try {
      startAccountRuntime();
      accountStore.setState({
        status: 'loggedIn',
        accessToken: 'at',
        targetDeviceId: 'd-1',
        devices: [makeDevice('d-1', false)],
      });
      expect(seen).toHaveLength(0);
      // 目标从离线恢复在线：资格门接线恢复，但不上线提醒
      accountStore.setState({
        devices: [makeDevice('d-1', true)],
      });
      expect(seen).toHaveLength(0);
    } finally {
      unsub();
      stopAccountRuntime();
    }
  });
});
