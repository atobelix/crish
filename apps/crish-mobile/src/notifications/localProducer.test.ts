// 本地通知产生器测试（通知分寸批 2026-11-03）：
// - 投递语义与远端推送一致：先 ingest 入应用内通知中心（恒保留）→ 前台仅
//   应用内、后台经去重 + prefsGate 事件级门禁 → presentSystemPushAsync 呈现；
// - 本地线程终态：完成 → taskDone 门禁；失败 → error 恒放行（taskDone 关也达）；
// - 设备离线：deviceOffline 场景门禁（默认关拦截、开后放行），文案带设备名；
// - 去重键带 local: 前缀，与远端帧 dedupeKey 空间隔离。
import { PresentedKeyTracker } from './pushConsumer';
import {
  bindNotificationPrefs,
  unbindNotificationPrefsForTest,
  type NotificationPrefs,
} from './prefsGate';
import {
  emitLocalPush,
  notifyLocalThreadTerminal,
  notifySelectedDeviceOffline,
  type LocalPushDeps,
} from './localProducer';
import type { PushMessage } from './types';
import {
  notificationStore,
  resetNotificationsForTest,
} from '@/domain/store/notificationStore';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';

function makeDeps(appState: 'active' | 'background') {
  const presentSystem = jest.fn(async (_push: PushMessage) => 'notif-id');
  const tracker = new PresentedKeyTracker();
  const deps: LocalPushDeps = {
    getAppState: () => appState,
    presentSystem,
    tracker,
    now: () => 1786300000000,
  };
  return { deps, presentSystem, tracker };
}

function prefsOf(
  sceneFlags: Partial<NotificationPrefs['sceneFlags']>,
  masterOn = true
): NotificationPrefs {
  return {
    masterOn,
    sceneFlags: {
      message: true,
      taskDone: true,
      approval: true,
      error: true,
      deviceOffline: false,
      ...sceneFlags,
    },
  };
}

function seedThread(id: string, title: string) {
  localChatSessionStore.setState({
    threads: [
      {
        id,
        title,
        titleSource: 'derived',
        preview: '',
        modelRef: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
}

beforeEach(() => {
  resetNotificationsForTest();
  localChatSessionStore.setState({ threads: [] });
});

afterEach(() => {
  unbindNotificationPrefsForTest();
});

describe('emitLocalPush（投递语义与远端一致）', () => {
  it('前台：只入通知中心，不呈现系统通知', () => {
    const { deps, presentSystem } = makeDeps('active');
    emitLocalPush(
      {
        eventType: 'run-terminal',
        severity: 'important',
        category: 'run',
        channelId: 'run',
        title: '任务已完成',
        body: '线程甲',
        dedupeKey: 'run-terminal:t-1:a-1',
      },
      deps
    );
    expect(presentSystem).not.toHaveBeenCalled();
    const items = notificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('local:run-terminal:t-1:a-1');
    expect(items[0]!.title).toBe('任务已完成');
    expect(items[0]!.body).toBe('线程甲');
  });

  it('后台：入中心 + 呈现；去重键带 local: 前缀', () => {
    const { deps, presentSystem } = makeDeps('background');
    emitLocalPush(
      {
        eventType: 'run-terminal',
        severity: 'important',
        category: 'run',
        channelId: 'run',
        title: '任务已完成',
        body: null,
        dedupeKey: 'run-terminal:t-1:a-1',
      },
      deps
    );
    expect(presentSystem).toHaveBeenCalledTimes(1);
    const presented = presentSystem.mock.calls[0]![0];
    expect(presented.dedupeKey).toBe('local:run-terminal:t-1:a-1');
    expect(presented.id).toBe('local:run-terminal:t-1:a-1');
  });

  it('后台同键重复 → 只呈现一次（与远端同一去重表语义）', () => {
    const { deps, presentSystem } = makeDeps('background');
    const input = {
      eventType: 'run-terminal',
      severity: 'important' as const,
      category: 'run',
      channelId: 'run',
      title: '任务已完成',
      body: null,
      dedupeKey: 'run-terminal:t-1:a-1',
    };
    emitLocalPush(input, deps);
    emitLocalPush(input, deps);
    expect(presentSystem).toHaveBeenCalledTimes(1);
    expect(notificationStore.getState().items).toHaveLength(1);
  });
});

describe('notifyLocalThreadTerminal（本地线程终态）', () => {
  it('完成（后台，默认偏好）：呈现，标题/正文 = 类标签 + 线程名', () => {
    seedThread('t-1', '周报整理');
    const { deps, presentSystem } = makeDeps('background');
    notifyLocalThreadTerminal(
      { threadId: 't-1', assistantId: 'a-1', outcome: 'completed' },
      deps
    );
    expect(presentSystem).toHaveBeenCalledTimes(1);
    const presented = presentSystem.mock.calls[0]![0];
    expect(presented.title).toBe('任务已完成');
    expect(presented.body).toBe('周报整理');
    expect(presented.eventType).toBe('run-terminal');
    expect(presented.severity).toBe('important');
  });

  it('完成 + taskDone 关（后台）：被门禁拦截，但通知中心保留', () => {
    bindNotificationPrefs(() => prefsOf({ taskDone: false }));
    seedThread('t-1', '周报整理');
    const { deps, presentSystem } = makeDeps('background');
    notifyLocalThreadTerminal(
      { threadId: 't-1', assistantId: 'a-1', outcome: 'completed' },
      deps
    );
    expect(presentSystem).not.toHaveBeenCalled();
    expect(notificationStore.getState().items).toHaveLength(1);
  });

  it('失败 + taskDone 关（后台）：恒放行呈现（error 不读 taskDone）；正文含线程名与错误首行', () => {
    bindNotificationPrefs(() => prefsOf({ taskDone: false }));
    seedThread('t-2', '数据清洗');
    const { deps, presentSystem } = makeDeps('background');
    notifyLocalThreadTerminal(
      {
        threadId: 't-2',
        assistantId: 'a-9',
        outcome: 'failed',
        errorMessage: '请求超时，请稍后重试\n第二行细节',
      },
      deps
    );
    expect(presentSystem).toHaveBeenCalledTimes(1);
    const presented = presentSystem.mock.calls[0]![0];
    expect(presented.title).toBe('任务运行失败');
    expect(presented.body).toBe('数据清洗：请求超时，请稍后重试');
    expect(presented.severity).toBe('critical');
  });

  it('失败 + 总开关关（后台）：一票否决，不呈现（中心仍保留）', () => {
    bindNotificationPrefs(() => prefsOf({}, false));
    seedThread('t-2', '数据清洗');
    const { deps, presentSystem } = makeDeps('background');
    notifyLocalThreadTerminal(
      {
        threadId: 't-2',
        assistantId: 'a-9',
        outcome: 'failed',
        errorMessage: 'x',
      },
      deps
    );
    expect(presentSystem).not.toHaveBeenCalled();
    expect(notificationStore.getState().items).toHaveLength(1);
  });
});

describe('notifySelectedDeviceOffline（设备离线边沿）', () => {
  it('默认偏好（deviceOffline 关，后台）：不呈现、中心保留、标题带设备名', () => {
    const { deps, presentSystem } = makeDeps('background');
    notifySelectedDeviceOffline(
      {
        deviceId: 'dev-1',
        deviceName: '我的台式机',
        offlineAtMs: 1786300000000,
      },
      deps
    );
    expect(presentSystem).not.toHaveBeenCalled();
    const items = notificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('我的台式机 已离线');
    expect(items[0]!.id).toBe('local:device-offline:dev-1:1786300000000');
  });

  it('deviceOffline 开（后台）：呈现；标题为设备名、不含裸 id', () => {
    bindNotificationPrefs(() => prefsOf({ deviceOffline: true }));
    const { deps, presentSystem } = makeDeps('background');
    notifySelectedDeviceOffline(
      {
        deviceId: 'dev-1',
        deviceName: '我的台式机',
        offlineAtMs: 1786300000000,
      },
      deps
    );
    expect(presentSystem).toHaveBeenCalledTimes(1);
    const presented = presentSystem.mock.calls[0]![0];
    expect(presented.title).toBe('我的台式机 已离线');
    expect(presented.channelId).toBe('general');
    expect(presented.title).not.toContain('dev-1');
  });

  it('两次离线边沿（不同时刻）各自成记，不被去重误吞', () => {
    bindNotificationPrefs(() => prefsOf({ deviceOffline: true }));
    const { deps, presentSystem } = makeDeps('background');
    notifySelectedDeviceOffline(
      { deviceId: 'dev-1', deviceName: '我的台式机', offlineAtMs: 1000 },
      deps
    );
    notifySelectedDeviceOffline(
      { deviceId: 'dev-1', deviceName: '我的台式机', offlineAtMs: 2000 },
      deps
    );
    expect(presentSystem).toHaveBeenCalledTimes(2);
    expect(notificationStore.getState().items).toHaveLength(2);
  });
});
