// 通知偏好接线测试（R3-04 部分 3）：设置变更 → 通知层过滤即时生效（store 联动）
import {
  settingsLocalStore,
  resetSettingsLocalStoreForTest,
} from './settingsLocalStore';
import {
  connectNotificationPrefs,
  disconnectNotificationPrefs,
} from './settingsNotificationWiring';
import {
  shouldShowSystemNotificationForPushLive,
  shouldShowSystemNotificationLive,
  unbindNotificationPrefsForTest,
} from '@/notifications/prefsGate';
import type { PushMessage } from '@/notifications/types';

/** 构造最小推送（channelId 可覆盖） */
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

beforeEach(() => {
  resetSettingsLocalStoreForTest();
  unbindNotificationPrefsForTest();
});

afterEach(() => {
  disconnectNotificationPrefs();
  unbindNotificationPrefsForTest();
});

describe('connectNotificationPrefs（设置页开关 → 通知层过滤接线）', () => {
  it('未接线 → 全放行（设置未接入通知层）', () => {
    settingsLocalStore.getState().setPreference('approvalNotifications', false);
    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
  });

  it('接线后：审批通知关 → approval 类推送过滤；应用内数据面不参与（系统通知面语义）', () => {
    connectNotificationPrefs();
    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
    expect(shouldShowSystemNotificationLive('run')).toBe(true);

    settingsLocalStore.getState().setPreference('approvalNotifications', false);
    expect(shouldShowSystemNotificationLive('approval')).toBe(false);
    expect(shouldShowSystemNotificationLive('run')).toBe(true);
    expect(shouldShowSystemNotificationLive('security')).toBe(true);

    settingsLocalStore.getState().setPreference('approvalNotifications', true);
    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
  });

  it('事件通知关 → run/general 通道过滤（含推送级入口）', () => {
    connectNotificationPrefs();
    settingsLocalStore.getState().setPreference('eventNotifications', false);

    expect(shouldShowSystemNotificationLive('run')).toBe(false);
    expect(shouldShowSystemNotificationLive('general')).toBe(false);
    expect(shouldShowSystemNotificationForPushLive(makePush('subagent'))).toBe(
      false
    );
    expect(shouldShowSystemNotificationForPushLive(makePush('summary'))).toBe(
      false
    );
    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
    expect(shouldShowSystemNotificationForPushLive(makePush('approval'))).toBe(
      true
    );
  });

  it('全关 → 仅 security 必达通道放行（S11 不可逆操作）', () => {
    connectNotificationPrefs();
    settingsLocalStore.getState().setPreference('approvalNotifications', false);
    settingsLocalStore.getState().setPreference('eventNotifications', false);

    expect(shouldShowSystemNotificationLive('approval')).toBe(false);
    expect(shouldShowSystemNotificationLive('run')).toBe(false);
    expect(shouldShowSystemNotificationLive('security')).toBe(true);
    expect(shouldShowSystemNotificationForPushLive(makePush('security'))).toBe(
      true
    );
  });

  it('disconnect 断开接线 → 回退全放行（即使存储仍为关）', () => {
    connectNotificationPrefs();
    settingsLocalStore.getState().setPreference('approvalNotifications', false);
    expect(shouldShowSystemNotificationLive('approval')).toBe(false);

    disconnectNotificationPrefs();
    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
  });
});
