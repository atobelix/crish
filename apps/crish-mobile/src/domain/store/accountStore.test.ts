// 账号 store：设备目标选择与登出复位。
import { accountStore } from './accountStore';
import type { AccountDevice } from '@/domain/types/account';

function device(
  id: string,
  online: boolean,
  platform = 'desktop'
): AccountDevice {
  return {
    id,
    name: id,
    platform,
    lastSeenAt: online ? Date.now() : 0,
    online,
  };
}

beforeEach(() => {
  accountStore.getState().reset();
});

describe('accountStore', () => {
  it('首次设备列表自动选择在线桌面', () => {
    accountStore
      .getState()
      .setDevices([
        device('mob', true, 'mobile'),
        device('desk-off', false),
        device('desk-on', true),
      ]);
    expect(accountStore.getState().targetDeviceId).toBe('desk-on');
  });

  it('当前目标离线时切换到另一台在线桌面', () => {
    accountStore.getState().setDevices([device('desk-a', false)]);
    expect(accountStore.getState().targetDeviceId).toBe('desk-a');
    accountStore
      .getState()
      .setDevices([device('desk-a', false), device('desk-b', true)]);
    expect(accountStore.getState().targetDeviceId).toBe('desk-b');
  });

  it('没有在线桌面时保留已存在目标（展示离线态）', () => {
    accountStore.getState().setDevices([device('desk-a', true)]);
    accountStore.getState().setDevices([device('desk-a', false)]);
    expect(accountStore.getState().targetDeviceId).toBe('desk-a');
  });

  it('reset 清空账号态并标记 hydrated', () => {
    accountStore.getState().setStatus('loggedIn');
    accountStore.getState().setDevices([device('desk-a', true)]);
    accountStore.getState().reset();
    expect(accountStore.getState().status).toBe('loggedOut');
    expect(accountStore.getState().hydrated).toBe(true);
    expect(accountStore.getState().devices).toEqual([]);
    expect(accountStore.getState().targetDeviceId).toBeNull();
  });
});
