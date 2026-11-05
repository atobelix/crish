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

  it('成功但为空的发现不清既有目标（CON-1 空发现保护）', () => {
    accountStore.getState().setDevices([device('desk-a', true)]);
    expect(accountStore.getState().targetDeviceId).toBe('desk-a');
    accountStore.getState().setDevices([]);
    expect(accountStore.getState().devices).toEqual([]);
    expect(accountStore.getState().targetDeviceId).toBe('desk-a');
  });

  it('本地钉住：发现轮次不改选远端，目标恒为 null（选本机不被心跳撤销）', () => {
    accountStore.getState().selectLocalTarget();
    expect(accountStore.getState().localTargetPinned).toBe(true);
    accountStore.getState().setDevices([device('desk-a', true)]);
    expect(accountStore.getState().targetDeviceId).toBeNull();
    accountStore.getState().setDevices([]);
    expect(accountStore.getState().targetDeviceId).toBeNull();
    expect(accountStore.getState().localTargetPinned).toBe(true);
  });

  it('显式改选远端解钉：selectTarget 后目标与自动选靶恢复', () => {
    accountStore.getState().selectLocalTarget();
    accountStore.getState().selectTarget('desk-a');
    expect(accountStore.getState().localTargetPinned).toBe(false);
    expect(accountStore.getState().targetDeviceId).toBe('desk-a');
  });

  it('设备列表内容完全相同时直接返回原 state，不触发广播（阻断定时心跳重绘）', () => {
    const dev = device('desk-a', true);
    accountStore.getState().setDevices([dev]);
    const listener = jest.fn();
    const unsub = accountStore.subscribe(listener);

    // 传入相同关键属性的新对象数组（模拟 15s 定时心跳）
    accountStore.getState().setDevices([
      {
        id: 'desk-a',
        name: 'desk-a',
        platform: 'desktop',
        lastSeenAt: Date.now() + 15_000,
        online: true,
      },
    ]);

    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('设备关键属性（如在线状态或名称）改变时正常触发广播', () => {
    const dev = device('desk-a', true);
    accountStore.getState().setDevices([dev]);
    const listener = jest.fn();
    const unsub = accountStore.subscribe(listener);

    // 在线状态变化
    accountStore.getState().setDevices([
      {
        id: 'desk-a',
        name: 'desk-a',
        platform: 'desktop',
        lastSeenAt: Date.now() + 15_000,
        online: false,
      },
    ]);

    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it('reset 清空账号态并标记 hydrated', () => {
    accountStore.getState().setStatus('loggedIn');
    accountStore.getState().selectLocalTarget();
    accountStore.getState().setDevices([device('desk-a', true)]);
    accountStore.getState().reset();
    expect(accountStore.getState().localTargetPinned).toBe(false);
    expect(accountStore.getState().status).toBe('loggedOut');
    expect(accountStore.getState().hydrated).toBe(true);
    expect(accountStore.getState().devices).toEqual([]);
    expect(accountStore.getState().targetDeviceId).toBeNull();
  });
});
