// 通知元信息纯函数单测（R2-04 部分 5）：类型三分映射 / 角标 99+ 收敛 / 深链白名单翻译
import {
  NOTIFICATION_BADGE_CAP,
  NOTIFICATION_CATEGORY_LABEL,
  notificationBadgeLabel,
  notificationKindCategory,
  notificationRouteToPath,
  type NotificationDeepLinkSource,
} from './notificationMeta';

function makeSource(
  overrides: Partial<NotificationDeepLinkSource> = {}
): NotificationDeepLinkSource {
  return {
    route: null,
    kind: 'approval-requested',
    toolCallId: 'tc-1',
    runId: null,
    ...overrides,
  };
}

describe('notificationKindCategory（类型三分）', () => {
  it('approval-* 前缀 → 审批', () => {
    expect(notificationKindCategory('approval-requested')).toBe('approval');
    expect(notificationKindCategory('approval-resolved')).toBe('approval');
    expect(notificationKindCategory('approval-expired')).toBe('approval');
  });

  it('系统类 kind → 系统（security/runtime/cache/compression/system/night-summary）', () => {
    expect(notificationKindCategory('security-audit')).toBe('system');
    expect(notificationKindCategory('runtime-error')).toBe('system');
    expect(notificationKindCategory('cache-waste-alert')).toBe('system');
    expect(notificationKindCategory('context-compression-start')).toBe(
      'system'
    );
    expect(notificationKindCategory('system')).toBe('system');
    expect(notificationKindCategory('night-summary')).toBe('system');
  });

  it('事件类 kind → 事件（run/task/subagent/timer/cron/未登记前缀）', () => {
    expect(notificationKindCategory('run-ended')).toBe('event');
    expect(notificationKindCategory('task-failed')).toBe('event');
    expect(notificationKindCategory('subagent-ended')).toBe('event');
    expect(notificationKindCategory('timer-fired')).toBe('event');
    expect(notificationKindCategory('cron-fired')).toBe('event');
    expect(notificationKindCategory('unknown-kind')).toBe('event');
    expect(notificationKindCategory('')).toBe('event');
  });

  it('类别文案表齐全（审批/事件/系统）', () => {
    expect(NOTIFICATION_CATEGORY_LABEL).toEqual({
      approval: '审批',
      event: '事件',
      system: '系统',
    });
  });
});

describe('notificationBadgeLabel（99+ 收敛，F1 §4.8）', () => {
  it('≤99 原样显示，>99 收敛 99+', () => {
    expect(notificationBadgeLabel(0)).toBe('0');
    expect(notificationBadgeLabel(1)).toBe('1');
    expect(notificationBadgeLabel(99)).toBe('99');
    expect(notificationBadgeLabel(100)).toBe('99+');
    expect(notificationBadgeLabel(999)).toBe('99+');
    expect(NOTIFICATION_BADGE_CAP).toBe(99);
  });
});

describe('notificationRouteToPath（深链白名单翻译）', () => {
  it('crish://approval/{toolCallId} → /approval/{toolCallId}（M4 §4.3 形态）', () => {
    expect(
      notificationRouteToPath(makeSource({ route: 'crish://approval/tc-9f3a' }))
    ).toBe('/approval/tc-9f3a');
  });

  it('crish://session/{sessionId} → /session/{sessionId}（事件通知会话深链）', () => {
    expect(
      notificationRouteToPath(
        makeSource({ kind: 'run-ended', route: 'crish://session/s-42' })
      )
    ).toBe('/session/s-42');
  });

  it('crish://run/{runId} / crish://terminal/{runId} → 对应详情路由', () => {
    expect(
      notificationRouteToPath(
        makeSource({ kind: 'run-ended', route: 'crish://run/run-7' })
      )
    ).toBe('/run/run-7');
    expect(
      notificationRouteToPath(makeSource({ route: 'crish://terminal/run-7' }))
    ).toBe('/terminal/run-7');
  });

  it('无参目标：crish://approvals / crish://dashboard → 既有路由', () => {
    expect(
      notificationRouteToPath(makeSource({ route: 'crish://approvals' }))
    ).toBe('/approvals');
    expect(
      notificationRouteToPath(makeSource({ route: 'crish://dashboard' }))
    ).toBe('/');
  });

  it('F2 §6.2 形态 conex://approval?toolCallId=… → /approval/…（查询参数取 id）', () => {
    expect(
      notificationRouteToPath(
        makeSource({ route: 'conex://approval?toolCallId=tc-x&runId=run-1' })
      )
    ).toBe('/approval/tc-x');
  });

  it('expo-router 相对路径透传（白名单内）；白名单外相对路径拒绝', () => {
    expect(
      notificationRouteToPath(makeSource({ route: '/approval/tc-1' }))
    ).toBe('/approval/tc-1');
    expect(
      notificationRouteToPath(makeSource({ route: '/evil/abc' }))
    ).toBeNull();
  });

  it('未知 screen / 缺 id → null（白名单外不导航，M4 §4.3）', () => {
    expect(
      notificationRouteToPath(makeSource({ route: 'crish://unknown/tc-1' }))
    ).toBeNull();
    expect(
      notificationRouteToPath(makeSource({ route: 'crish://approval/' }))
    ).toBeNull();
    expect(
      notificationRouteToPath(makeSource({ route: 'crish://approval' }))
    ).toBeNull();
    expect(
      notificationRouteToPath(makeSource({ route: 'ftp://approval/tc-1' }))
    ).toBeNull();
  });

  it('route 缺失兜底：审批 + toolCallId → /approval/…；run/task 事件 + runId → /run/…', () => {
    expect(notificationRouteToPath(makeSource({ route: null }))).toBe(
      '/approval/tc-1'
    );
    expect(
      notificationRouteToPath(
        makeSource({
          route: null,
          kind: 'task-failed',
          runId: 'run-9',
          toolCallId: null,
        })
      )
    ).toBe('/run/run-9');
    expect(
      notificationRouteToPath(
        makeSource({
          route: null,
          kind: 'run-ended',
          runId: 'run-9',
          toolCallId: null,
        })
      )
    ).toBe('/run/run-9');
  });

  it('route 缺失且无可用字段 → null（不导航，仅已读）', () => {
    expect(
      notificationRouteToPath(
        makeSource({
          route: null,
          kind: 'timer-fired',
          toolCallId: null,
          runId: null,
        })
      )
    ).toBeNull();
    expect(
      notificationRouteToPath(
        makeSource({
          route: null,
          kind: 'approval-requested',
          toolCallId: null,
        })
      )
    ).toBeNull();
  });
});
