// 账号远程运行时测试：资格判定、接线建立/销毁、目标切换、心跳定时器清理。
//
// 这是账号远程模式的核心状态机（旧覆盖率 4.54%）：判定错误会导致「已登录但
// 永远连不上」或「换目标后仍连旧设备」。
import { accountStore } from '@/domain/store/accountStore';
import { connectionStore } from '@/domain/store/connectionStore';
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
}));

import {
  startAccountRuntime,
  stopAccountRuntime,
  accountRemoteTargetId,
} from './accountRuntime';
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
