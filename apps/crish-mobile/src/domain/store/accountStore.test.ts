// 账号 store：设备目标选择与登出复位。
// 2026-11-05 目标主权裁决：targetDeviceId 只由用户显式动作改变——
// setDevices 只更新设备表（旧自动选靶断言已随策略删除，逆断言钉死）。
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
  it('目标主权：无目标时发现到在线桌面也不自动认领（保持 null，本地模式生效）', () => {
    accountStore
      .getState()
      .setDevices([
        device('mob', true, 'mobile'),
        device('desk-off', false),
        device('desk-on', true),
      ]);
    expect(accountStore.getState().targetDeviceId).toBeNull();
    expect(accountStore.getState().devices).toHaveLength(3);
  });

  it('目标主权：目标离线时另一台桌面上线，目标不被心跳改写（不静默跳设备）', () => {
    accountStore.getState().selectTarget('desk-a');
    accountStore
      .getState()
      .setDevices([device('desk-a', false), device('desk-b', true)]);
    expect(accountStore.getState().targetDeviceId).toBe('desk-a');
  });

  it('目标主权：目标离线时保持目标（呈现离线态，资格门去抖裁决拆线）', () => {
    accountStore.getState().selectTarget('desk-a');
    accountStore.getState().setDevices([device('desk-a', true)]);
    accountStore.getState().setDevices([device('desk-a', false)]);
    expect(accountStore.getState().targetDeviceId).toBe('desk-a');
  });

  it('成功但为空的发现不清既有目标（CON-1 空发现保护）', () => {
    accountStore.getState().selectTarget('desk-a');
    accountStore.getState().setDevices([device('desk-a', true)]);
    accountStore.getState().setDevices([]);
    expect(accountStore.getState().devices).toEqual([]);
    expect(accountStore.getState().targetDeviceId).toBe('desk-a');
  });

  it('本地钉住：发现轮次不产生远端目标，钉住态保持', () => {
    accountStore.getState().selectLocalTarget();
    expect(accountStore.getState().localTargetPinned).toBe(true);
    accountStore.getState().setDevices([device('desk-a', true)]);
    expect(accountStore.getState().targetDeviceId).toBeNull();
    accountStore.getState().setDevices([]);
    expect(accountStore.getState().targetDeviceId).toBeNull();
    expect(accountStore.getState().localTargetPinned).toBe(true);
  });

  it('显式选择远端：selectTarget 是目标唯一变更通道（解钉生效）', () => {
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
