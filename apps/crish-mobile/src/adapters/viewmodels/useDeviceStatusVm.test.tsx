// 设备状态 VM（G4）：双连接模型的生效设备判定、目录行、切换守卫。
import { act, renderHook } from '@testing-library/react-native';
import { authStore } from '@/domain/store/authStore';
import { accountStore } from '@/domain/store/accountStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { deviceDirectoryStore } from '@/domain/store/deviceDirectoryStore';
import type { AccountDevice } from '@/domain/types/account';

jest.mock('@/adapters/account/accountService', () => ({
  selectAccountTarget: jest.fn(),
  refreshAccountDevices: jest.fn(async () => {}),
}));

jest.mock('@/adapters/wiring/observationWiring', () => ({
  getObservationWiring: jest.fn(() => null),
  ensureObservationWiring: jest.fn(),
}));

import {
  refreshAccountDevices,
  selectAccountTarget,
} from '@/adapters/account/accountService';
import { useDeviceStatusVm } from './useDeviceStatusVm';

const selectTargetMock = selectAccountTarget as jest.Mock;
const refreshMock = refreshAccountDevices as jest.Mock;

function device(
  id: string,
  online: boolean,
  name = id,
  lastSeenAt = 0
): AccountDevice {
  return { id, name, platform: 'desktop', lastSeenAt, online };
}

beforeEach(() => {
  jest.clearAllMocks();
  authStore.setState({ host: null });
  connectionStore.setState({ phase: 'disconnected', lastError: null });
  accountStore.getState().reset();
  deviceDirectoryStore.getState().clear();
});

/** 置为「已登录 + 目标 A 在线」状态，并把目录喂成 A 在线 / B 离线。 */
function setAccountScene(): void {
  accountStore.setState({
    status: 'loggedIn',
    accessToken: 'at',
    targetDeviceId: 'desk-a',
    devices: [device('desk-a', true, '办公电脑', 100)],
  });
  deviceDirectoryStore
    .getState()
    .mergeFresh([device('desk-a', true, '办公电脑', 100)]);
  deviceDirectoryStore
    .getState()
    .mergeFresh([device('desk-b', true, '家里的电脑', 90)]);
  // 再来一轮只有 desk-a 的发现 → 目录中 desk-b 转离线保留
  deviceDirectoryStore
    .getState()
    .mergeFresh([device('desk-a', true, '办公电脑', 100)]);
}

describe('useDeviceStatusVm', () => {
  it('未登录：非账号模式，host 回落配对主机，目录行为空', async () => {
    authStore.setState({ host: '192.168.1.2' });
    deviceDirectoryStore
      .getState()
      .mergeFresh([device('desk-a', true, '办公电脑', 100)]);
    const { result } = await renderHook(() => useDeviceStatusVm());
    expect(result.current.accountMode).toBe(false);
    expect(result.current.relayEngaged).toBe(false);
    expect(result.current.host).toBe('192.168.1.2');
    expect(result.current.pairedHost).toBe('192.168.1.2');
    expect(result.current.devices).toEqual([]);
  });

  it('中继接管：host = 目标设备名（而非配对主机名），目录行含离线灰置项', async () => {
    authStore.setState({ host: '192.168.1.2' });
    setAccountScene();
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() => useDeviceStatusVm());
    expect(result.current.accountMode).toBe(true);
    expect(result.current.relayEngaged).toBe(true);
    expect(result.current.host).toBe('办公电脑');
    expect(result.current.connected).toBe(true);
    expect(result.current.devices).toEqual([
      { id: 'desk-a', name: '办公电脑', online: true, isTarget: true },
      { id: 'desk-b', name: '家里的电脑', online: false, isTarget: false },
    ]);
  });

  it('目标在最新发现中离线：中继未接管，host 回落配对主机', async () => {
    authStore.setState({ host: '192.168.1.2' });
    accountStore.setState({
      status: 'loggedIn',
      accessToken: 'at',
      targetDeviceId: 'desk-a',
      devices: [device('desk-a', false, '办公电脑', 100)],
    });
    const { result } = await renderHook(() => useDeviceStatusVm());
    expect(result.current.relayEngaged).toBe(false);
    expect(result.current.host).toBe('192.168.1.2');
    expect(result.current.targetDeviceId).toBe('desk-a');
  });

  it('switchDevice：在线非目标设备 → 真切换并补一轮发现', async () => {
    setAccountScene();
    accountStore.setState({
      devices: [
        device('desk-a', true, '办公电脑', 100),
        device('desk-c', true, '书房电脑', 80),
      ],
    });
    const { result } = await renderHook(() => useDeviceStatusVm());
    await act(async () => {
      result.current.switchDevice('desk-c');
    });
    expect(selectTargetMock).toHaveBeenCalledWith('desk-c');
    expect(refreshMock).toHaveBeenCalled();
  });

  it('switchDevice：离线设备 / 当前目标 / 未知 id 均为 no-op（不伪造切换）', async () => {
    setAccountScene();
    const { result } = await renderHook(() => useDeviceStatusVm());
    await act(async () => {
      result.current.switchDevice('desk-b');
    });
    await act(async () => {
      result.current.switchDevice('desk-a');
    });
    await act(async () => {
      result.current.switchDevice('missing');
    });
    expect(selectTargetMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('refreshDevices 触发一轮设备发现', async () => {
    const { result } = await renderHook(() => useDeviceStatusVm());
    await act(async () => {
      result.current.refreshDevices();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});
