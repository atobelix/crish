// 通知偏好过滤测试（R3-04 部分 3 · R4 批次2 单真源）：
// 通道×场景组合 / 总开关一票否决 / 推送级归一 / 权限联动 / 实时接线
import { requestPermissionsAsync } from 'expo-notifications';
import {
  bindNotificationPrefs,
  decideForegroundPresentationFor,
  DEFAULT_NOTIFICATION_PREFS,
  notifySwitchGate,
  NOTIFICATION_PERMISSION_DENIED_HINT,
  requestPermissionOnEnable,
  shouldShowSystemNotification,
  shouldShowSystemNotificationForPush,
  shouldShowSystemNotificationForPushLive,
  shouldShowSystemNotificationLive,
  unbindNotificationPrefsForTest,
  type NotificationPrefs,
} from './prefsGate';
import { notificationPermissionStore } from './permissions';
import type { PushMessage } from './types';
import type { NotifyScene } from '@/domain/store/settingsReducers';

/** 构造最小推送（channelId 可覆盖；其余字段对齐 schema v1 子集） */
function makePush(channelId: string): PushMessage {
  return {
    schemaVersion: 1,
    id: 'p-1',
    eventType: 'run-terminal',
    seq: 1,
    tsMs: 1000,
    severity: 'normal',
    category: 'run',
    title: 't',
    body: null,
    dedupeKey: 'run-terminal:r-1',
    collapseKey: null,
    channelId,
    target: { screen: 'session', sessionId: 's-1', params: {} },
  };
}

/** 偏好构造助手：场景覆盖 + 总开关（未提及场景 = 默认开） */
function prefsOf(
  overrides: Partial<Record<NotifyScene, boolean>> = {},
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
      ...overrides,
    },
  };
}

const APPROVAL_OFF = prefsOf({ approval: false });
const TASK_DONE_OFF = prefsOf({ taskDone: false });
const MESSAGE_OFF = prefsOf({ message: false });
const ALL_OFF = prefsOf({ approval: false, taskDone: false, message: false });
const MASTER_OFF = prefsOf({}, false);

beforeEach(() => {
  unbindNotificationPrefsForTest();
  notificationPermissionStore.setState({
    status: 'undetermined',
    checked: false,
    refreshing: false,
  });
});

describe('shouldShowSystemNotification（通道×场景组合，Z0 §7.4 × F6 §10.1）', () => {
  it('默认全开 → 四通道全部放行（审批/任务结果/消息/安全）', () => {
    expect(
      shouldShowSystemNotification('approval', DEFAULT_NOTIFICATION_PREFS)
    ).toBe(true);
    expect(
      shouldShowSystemNotification('run', DEFAULT_NOTIFICATION_PREFS)
    ).toBe(true);
    expect(
      shouldShowSystemNotification('general', DEFAULT_NOTIFICATION_PREFS)
    ).toBe(true);
    expect(
      shouldShowSystemNotification('security', DEFAULT_NOTIFICATION_PREFS)
    ).toBe(true);
  });

  it('审批场景关 → approval 过滤；run/general/security 不受影响', () => {
    expect(shouldShowSystemNotification('approval', APPROVAL_OFF)).toBe(false);
    expect(shouldShowSystemNotification('run', APPROVAL_OFF)).toBe(true);
    expect(shouldShowSystemNotification('general', APPROVAL_OFF)).toBe(true);
    expect(shouldShowSystemNotification('security', APPROVAL_OFF)).toBe(true);
  });

  it('任务结果关 → run 过滤；消息关 → general 过滤；approval/security 不受影响', () => {
    expect(shouldShowSystemNotification('run', TASK_DONE_OFF)).toBe(false);
    expect(shouldShowSystemNotification('general', TASK_DONE_OFF)).toBe(true);
    expect(shouldShowSystemNotification('general', MESSAGE_OFF)).toBe(false);
    expect(shouldShowSystemNotification('run', MESSAGE_OFF)).toBe(true);
    expect(shouldShowSystemNotification('approval', MESSAGE_OFF)).toBe(true);
    expect(shouldShowSystemNotification('security', MESSAGE_OFF)).toBe(true);
  });

  it('场景全关 → 仅 security 恒放行（S11 不可逆操作必达，无场景开关覆盖）', () => {
    expect(shouldShowSystemNotification('approval', ALL_OFF)).toBe(false);
    expect(shouldShowSystemNotification('run', ALL_OFF)).toBe(false);
    expect(shouldShowSystemNotification('general', ALL_OFF)).toBe(false);
    expect(shouldShowSystemNotification('security', ALL_OFF)).toBe(true);
  });

  it('总开关关 → 一票否决（含场景全开的通道；security 例外恒放行）', () => {
    expect(shouldShowSystemNotification('approval', MASTER_OFF)).toBe(false);
    expect(shouldShowSystemNotification('run', MASTER_OFF)).toBe(false);
    expect(shouldShowSystemNotification('general', MASTER_OFF)).toBe(false);
    expect(shouldShowSystemNotification('security', MASTER_OFF)).toBe(true);
  });
});

describe('shouldShowSystemNotificationForPush（D7 七渠道 → Z0 四类归一后过滤）', () => {
  it('approval 推送受审批场景开关控制', () => {
    expect(
      shouldShowSystemNotificationForPush(makePush('approval'), APPROVAL_OFF)
    ).toBe(false);
    expect(
      shouldShowSystemNotificationForPush(makePush('approval'), TASK_DONE_OFF)
    ).toBe(true);
  });

  it('run/subagent/task/timer 折叠进 run 通道 → 任务结果场景开关（D7 §7.7 归一表）', () => {
    for (const raw of ['run', 'subagent', 'task', 'timer']) {
      expect(
        shouldShowSystemNotificationForPush(makePush(raw), TASK_DONE_OFF)
      ).toBe(false);
      expect(
        shouldShowSystemNotificationForPush(makePush(raw), APPROVAL_OFF)
      ).toBe(true);
    }
  });

  it('summary/未知通道兜底 general → 消息场景开关（低打扰安全收敛）', () => {
    expect(
      shouldShowSystemNotificationForPush(makePush('summary'), MESSAGE_OFF)
    ).toBe(false);
    expect(
      shouldShowSystemNotificationForPush(makePush('unknown'), MESSAGE_OFF)
    ).toBe(false);
  });

  it('security 推送恒放行（S11 必达，不受场景/总开关影响）', () => {
    expect(
      shouldShowSystemNotificationForPush(makePush('security'), ALL_OFF)
    ).toBe(true);
    expect(
      shouldShowSystemNotificationForPush(makePush('security'), MASTER_OFF)
    ).toBe(true);
  });
});

describe('权限联动（F6 §10.3 / M5 §8.3：denied → 开关禁用 + 引导）', () => {
  it('denied → 场景开关禁用 + 前往系统设置引导文案', () => {
    expect(notifySwitchGate('denied')).toEqual({
      enabled: false,
      hint: NOTIFICATION_PERMISSION_DENIED_HINT,
    });
  });

  it('granted / undetermined → 开关可用、无引导文案', () => {
    expect(notifySwitchGate('granted')).toEqual({
      enabled: true,
      hint: null,
    });
    expect(notifySwitchGate('undetermined')).toEqual({
      enabled: true,
      hint: null,
    });
  });

  it('开关开（undetermined 首次）→ 请求权限（弹系统框）', async () => {
    jest.clearAllMocks();
    const result = await requestPermissionOnEnable('undetermined');
    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(result).toBe('granted');
  });

  it('granted → 静默返回，不再请求；denied → 防御式返回（开关已禁用）', async () => {
    jest.clearAllMocks();
    notificationPermissionStore.getState().setStatus('granted');
    await expect(requestPermissionOnEnable('granted')).resolves.toBe('granted');
    notificationPermissionStore.getState().setStatus('denied');
    await expect(requestPermissionOnEnable('denied')).resolves.toBe('denied');
    expect(requestPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe('decideForegroundPresentationFor（偏好过滤合成）', () => {
  it('通道被过滤 → 恒不弹系统通知（四呈现全 false）', () => {
    const pres = decideForegroundPresentationFor(
      makePush('approval'),
      APPROVAL_OFF
    );
    expect(pres).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  it('通道放行 → 沿用前台策略（当前恒不弹——app 内已展示，双通道去重）', () => {
    const pres = decideForegroundPresentationFor(
      makePush('approval'),
      TASK_DONE_OFF
    );
    expect(pres.shouldShowBanner).toBe(false);
    expect(pres.shouldShowList).toBe(false);
  });
});

describe('实时接线（bindNotificationPrefs 读取器）', () => {
  it('未接线 → 全放行（缺省偏好）', () => {
    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
    expect(shouldShowSystemNotificationLive('run')).toBe(true);
    expect(shouldShowSystemNotificationForPushLive(makePush('approval'))).toBe(
      true
    );
  });

  it('接线后实时生效：偏好快照变更立即反映到过滤结果（store 联动）', () => {
    let prefs = { ...DEFAULT_NOTIFICATION_PREFS };
    bindNotificationPrefs(() => prefs);

    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
    prefs = prefsOf({ approval: false });
    expect(shouldShowSystemNotificationLive('approval')).toBe(false);
    expect(shouldShowSystemNotificationLive('security')).toBe(true);
    expect(shouldShowSystemNotificationForPushLive(makePush('run'))).toBe(true);
    prefs = prefsOf({}, false);
    expect(shouldShowSystemNotificationLive('run')).toBe(false);
    expect(shouldShowSystemNotificationForPushLive(makePush('general'))).toBe(
      false
    );
  });

  it('unbind 复位 → 回退全放行', () => {
    bindNotificationPrefs(() => prefsOf({ approval: false }));
    expect(shouldShowSystemNotificationLive('approval')).toBe(false);
    unbindNotificationPrefsForTest();
    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
  });
});
