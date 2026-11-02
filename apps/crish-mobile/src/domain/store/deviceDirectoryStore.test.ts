// 已知设备目录 store：跨轮次累积与清空边界。
import { deviceDirectoryStore } from './deviceDirectoryStore';
import type { AccountDevice } from '@/domain/types/account';

function device(id: string, online: boolean, lastSeenAt = 0): AccountDevice {
  return { id, name: id, platform: 'desktop', lastSeenAt, online };
}

beforeEach(() => {
  deviceDirectoryStore.getState().clear();
});

describe('deviceDirectoryStore', () => {
  it('mergeFresh 累积多轮发现：消失的设备转离线保留', () => {
    deviceDirectoryStore.getState().mergeFresh([device('desk-a', true, 10)]);
    deviceDirectoryStore.getState().mergeFresh([device('desk-b', true, 20)]);
    const known = deviceDirectoryStore.getState().knownDevices;
    expect(known.map((d) => d.id)).toEqual(['desk-b', 'desk-a']);
    expect(known.find((d) => d.id === 'desk-a')?.online).toBe(false);
    expect(known.find((d) => d.id === 'desk-b')?.online).toBe(true);
  });

  it('clear 清空目录（登出边界）', () => {
    deviceDirectoryStore.getState().mergeFresh([device('desk-a', true, 10)]);
    deviceDirectoryStore.getState().clear();
    expect(deviceDirectoryStore.getState().knownDevices).toEqual([]);
  });
});
