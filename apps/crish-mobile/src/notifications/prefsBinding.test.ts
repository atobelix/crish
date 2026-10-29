// 通知偏好接线测试（R3-04 部分 3 · R4 批次2 单真源）：
// 设置变更（settingsStore.notification）→ 通知层过滤即时生效（store 联动）
import { settingsStore } from '@/domain/store/settingsStore';
import {
  connectNotificationPrefs,
  disconnectNotificationPrefs,
} from './prefsBinding';
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

/** 复位通知分组为出厂默认（隔离跨用例污染） */
function resetNotifyGroups(): void {
  const groups = settingsStore.getState().groups;
  settingsStore.setState({
    groups: {
      ...groups,
      notification: {
        masterOn: true,
        sceneFlags: {
          message: true,
          taskDone: true,
          approval: true,
          error: true,
          deviceOffline: false,
        },
      },
    },
    hydrated: false,
  });
}

beforeEach(() => {
  resetNotifyGroups();
  unbindNotificationPrefsForTest();
});

afterEach(() => {
  disconnectNotificationPrefs();
  unbindNotificationPrefsForTest();
});

describe('connectNotificationPrefs（设置页开关 → 通知层过滤接线）', () => {
  it('未接线 → 全放行（设置未接入通知层）', () => {
    settingsStore
      .getState()
      .update('notification', { sceneFlags: { approval: false } });
    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
  });

  it('接线后：审批场景关 → approval 通道过滤；总开/其它场景不受影响', () => {
    connectNotificationPrefs();
    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
    expect(shouldShowSystemNotificationLive('run')).toBe(true);

    settingsStore
      .getState()
      .update('notification', { sceneFlags: { approval: false } });
    expect(shouldShowSystemNotificationLive('approval')).toBe(false);
    expect(shouldShowSystemNotificationLive('run')).toBe(true);
    expect(shouldShowSystemNotificationLive('security')).toBe(true);

    settingsStore
      .getState()
      .update('notification', { sceneFlags: { approval: true } });
    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
  });

  it('任务结果场景关 → run 通道过滤；消息场景关 → general 通道过滤（含七渠道归一推送）', () => {
    connectNotificationPrefs();
    settingsStore
      .getState()
      .update('notification', { sceneFlags: { taskDone: false } });
    expect(shouldShowSystemNotificationLive('run')).toBe(false);
    expect(shouldShowSystemNotificationLive('general')).toBe(true);
    expect(shouldShowSystemNotificationForPushLive(makePush('subagent'))).toBe(
      false
    );

    settingsStore
      .getState()
      .update('notification', { sceneFlags: { message: false } });
    expect(shouldShowSystemNotificationLive('general')).toBe(false);
    expect(shouldShowSystemNotificationForPushLive(makePush('summary'))).toBe(
      false
    );
    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
    expect(shouldShowSystemNotificationForPushLive(makePush('approval'))).toBe(
      true
    );
  });

  it('总开关关 → 除 security 必达通道外全部过滤（S11 不可逆操作；总开关一票否决）', () => {
    connectNotificationPrefs();
    settingsStore.getState().update('notification', { masterOn: false });

    expect(shouldShowSystemNotificationLive('approval')).toBe(false);
    expect(shouldShowSystemNotificationLive('run')).toBe(false);
    expect(shouldShowSystemNotificationLive('general')).toBe(false);
    expect(shouldShowSystemNotificationLive('security')).toBe(true);
    expect(shouldShowSystemNotificationForPushLive(makePush('security'))).toBe(
      true
    );
  });

  it('disconnect 断开接线 → 回退全放行（即使存储仍为关）', () => {
    connectNotificationPrefs();
    settingsStore
      .getState()
      .update('notification', { sceneFlags: { approval: false } });
    expect(shouldShowSystemNotificationLive('approval')).toBe(false);

    disconnectNotificationPrefs();
    expect(shouldShowSystemNotificationLive('approval')).toBe(true);
  });
});
