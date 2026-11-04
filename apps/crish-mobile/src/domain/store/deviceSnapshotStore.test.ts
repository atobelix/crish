// deviceSnapshotStore 单测（CON-3）：设备分区注册表（分键/取出即移/
// 全清）与 live 陈旧标记。分区纪律见 deviceSnapshotStore 文件头：
// 快照按 deviceId 分键、全局单槽禁止、仅同设备重选才恢复。
import {
  deviceSnapshotStore,
  markLiveDataFresh,
  takeDeviceSnapshot,
  type DeviceDataSnapshot,
} from './deviceSnapshotStore';

function snap(savedAt: number): DeviceDataSnapshot {
  return {
    sessions: [],
    selectedSessionId: null,
    windows: {},
    approvals: {
      pending: [],
      decisionBusy: {},
      history: [],
      lastReconcileAt: null,
      outboxCount: 0,
    },
    savedAt,
  };
}

beforeEach(() => {
  deviceSnapshotStore.setState({
    snapshots: {},
    liveStale: false,
    liveSnapshotAt: null,
  });
});

describe('deviceSnapshotStore 分区注册表', () => {
  it('按 deviceId 分键并存互不覆盖（全局单槽的反面断言）', () => {
    const store = deviceSnapshotStore.getState();
    store.setSnapshot('dev-a', snap(100));
    store.setSnapshot('dev-b', snap(200));
    const { snapshots } = deviceSnapshotStore.getState();
    expect(Object.keys(snapshots).sort()).toEqual(['dev-a', 'dev-b']);
    expect(snapshots['dev-a']?.savedAt).toBe(100);
    expect(snapshots['dev-b']?.savedAt).toBe(200);
  });

  it('take 取出即移除：一份数据同一时刻只存一处', () => {
    const store = deviceSnapshotStore.getState();
    store.setSnapshot('dev-a', snap(100));
    expect(takeDeviceSnapshot('dev-a')?.savedAt).toBe(100);
    expect(takeDeviceSnapshot('dev-a')).toBeNull();
    expect(deviceSnapshotStore.getState().snapshots).toEqual({});
    expect(takeDeviceSnapshot('dev-none')).toBeNull();
  });

  it('同键再存覆盖该分区（不影响其他分区）', () => {
    const store = deviceSnapshotStore.getState();
    store.setSnapshot('dev-a', snap(100));
    store.setSnapshot('dev-b', snap(200));
    store.setSnapshot('dev-a', snap(300));
    expect(deviceSnapshotStore.getState().snapshots['dev-a']?.savedAt).toBe(
      300
    );
    expect(deviceSnapshotStore.getState().snapshots['dev-b']?.savedAt).toBe(
      200
    );
  });

  it('clearSnapshots 全清（登出/换账号口径）', () => {
    const store = deviceSnapshotStore.getState();
    store.setSnapshot('dev-a', snap(100));
    store.setSnapshot('dev-b', snap(200));
    store.clearSnapshots();
    expect(deviceSnapshotStore.getState().snapshots).toEqual({});
  });
});

describe('deviceSnapshotStore 陈旧标记', () => {
  it('setLiveStale 记录快照时刻；markLiveDataFresh 清标（对账成功口径）', () => {
    const store = deviceSnapshotStore.getState();
    store.setLiveStale(true, 555);
    expect(deviceSnapshotStore.getState().liveStale).toBe(true);
    expect(deviceSnapshotStore.getState().liveSnapshotAt).toBe(555);
    markLiveDataFresh();
    expect(deviceSnapshotStore.getState().liveStale).toBe(false);
    expect(deviceSnapshotStore.getState().liveSnapshotAt).toBeNull();
  });
});
