/**
 * ChatStatusRibbons 纯函数：goal / plan ribbon、setup 文案、
 * approval dock a11y 与挂载门闩（无幽灵条）。
 */
import { describe, expect, it } from 'vitest';
import {
  formatGoalRibbonLabel,
  formatGoalRibbonPreview,
  formatPlanModeRibbonLabel,
  GOAL_RIBBON_PREVIEW_MAX_LEN,
  goalRibbonProgressPercent,
  goalRibbonProgressRatio,
  resolveApprovalDockAriaLabel,
  resolveApprovalDockLabelText,
  resolveEngineDownSoftHintText,
  resolveGoalRibbonAriaLabel,
  resolvePlanModeAriaLabel,
  resolvePlanModeTitle,
  resolveRunNoticeAriaLabel,
  resolveRunNoticeAriaLive,
  resolveSetupHintAction,
  resolveSyncEngineSoftHintText,
  shouldRenderApprovalDock,
  shouldRenderRunNotice,
  shouldShowPlanApproveAction,
  type SetupHintKind,
} from './chatStatusRibbonsLib';

describe('formatGoalRibbonPreview', () => {
  it('returns empty for blank goal', () => {
    expect(formatGoalRibbonPreview('')).toBe('');
    expect(formatGoalRibbonPreview('   ')).toBe('');
  });

  it('keeps short text intact', () => {
    expect(formatGoalRibbonPreview('修登录闪退')).toBe('修登录闪退');
  });

  it('truncates long text with ellipsis', () => {
    const long = '这是一段非常非常非常非常非常非常非常非常非常长的目标描述';
    const out = formatGoalRibbonPreview(long, 12);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(13); // 12 + …
  });

  it('clamps tiny maxLen to a readable floor', () => {
    const out = formatGoalRibbonPreview('abcdefghij', 1);
    expect(out.endsWith('…')).toBe(true);
    // floor 4 chars + ellipsis
    expect(out.length).toBe(5);
  });

  it('defaults to dense slim maxLen', () => {
    expect(GOAL_RIBBON_PREVIEW_MAX_LEN).toBe(28);
    const long = '字'.repeat(40);
    const out = formatGoalRibbonPreview(long);
    expect(out.length).toBe(GOAL_RIBBON_PREVIEW_MAX_LEN + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('formatGoalRibbonLabel', () => {
  it('uses 1-based iteration and omits score without tasks', () => {
    expect(
      formatGoalRibbonLabel({
        goalText: '落地 soft-hint',
        goalIteration: 0,
        goalTasksDone: 0,
        goalTasksTotal: 0,
      }),
    ).toBe('目标 · 第 1 轮 · 落地 soft-hint');
  });

  it('includes done/total when task list exists', () => {
    expect(
      formatGoalRibbonLabel({
        goalText: '收口 dock',
        goalIteration: 2,
        goalTasksDone: 1,
        goalTasksTotal: 3,
      }),
    ).toBe('目标 · 第 3 轮 · 1/3 · 收口 dock');
  });

  it('clamps done to total for display', () => {
    expect(
      formatGoalRibbonLabel({
        goalText: '',
        goalIteration: 0,
        goalTasksDone: 9,
        goalTasksTotal: 2,
      }),
    ).toBe('目标 · 第 1 轮 · 2/2');
  });

  it('treats NaN / negative iteration as round 1', () => {
    expect(
      formatGoalRibbonLabel({
        goalText: 'x',
        goalIteration: Number.NaN,
        goalTasksDone: Number.NaN,
        goalTasksTotal: -2,
      }),
    ).toBe('目标 · 第 1 轮 · x');
  });
});

describe('resolveGoalRibbonAriaLabel', () => {
  it('uses full goal text (not truncated preview) and spoken progress', () => {
    const long = '这是一段需要完整朗读的目标描述内容不要被截断';
    const aria = resolveGoalRibbonAriaLabel({
      goalText: long,
      goalIteration: 1,
      goalTasksDone: 2,
      goalTasksTotal: 5,
    });
    expect(aria).toContain('目标模式，第 2 轮');
    expect(aria).toContain('进度 2 之 5');
    expect(aria).toContain(long);
    expect(aria.includes('…')).toBe(false);
  });

  it('omits progress clause without task list', () => {
    const aria = resolveGoalRibbonAriaLabel({
      goalText: '修 bug',
      goalIteration: 0,
      goalTasksDone: 0,
      goalTasksTotal: 0,
    });
    expect(aria).toBe('目标模式，第 1 轮，修 bug');
  });
});

describe('goalRibbonProgressRatio / percent', () => {
  it('returns null without tasks (no meter)', () => {
    expect(goalRibbonProgressRatio(0, 0)).toBeNull();
    expect(goalRibbonProgressRatio(3, 0)).toBeNull();
    expect(goalRibbonProgressPercent(1, 0)).toBeNull();
  });

  it('returns 0–1 ratio and clamps overshoot', () => {
    expect(goalRibbonProgressRatio(0, 4)).toBe(0);
    expect(goalRibbonProgressRatio(2, 4)).toBe(0.5);
    expect(goalRibbonProgressRatio(5, 4)).toBe(1);
  });

  it('maps ratio to integer percent for CSS width', () => {
    expect(goalRibbonProgressPercent(1, 3)).toBe(33);
    expect(goalRibbonProgressPercent(1, 2)).toBe(50);
    expect(goalRibbonProgressPercent(3, 3)).toBe(100);
  });

  it('ignores NaN total (no meter)', () => {
    expect(goalRibbonProgressRatio(1, Number.NaN)).toBeNull();
    expect(goalRibbonProgressPercent(1, Number.NaN)).toBeNull();
  });
});

describe('plan mode ribbon copy', () => {
  it('formats slim label and aria for approved / planning', () => {
    expect(formatPlanModeRibbonLabel(false)).toBe('计划模式 · 只规划');
    expect(formatPlanModeRibbonLabel(true)).toBe('计划模式 · 已批准');
    expect(resolvePlanModeAriaLabel(false)).toBe('计划模式，只规划不改文件');
    expect(resolvePlanModeAriaLabel(true)).toBe('计划模式，已批准');
  });

  it('title follows approve state (no stale 不改文件 when approved)', () => {
    expect(resolvePlanModeTitle(false)).toMatch(/只规划/);
    expect(resolvePlanModeTitle(true)).toMatch(/已批准/);
    expect(resolvePlanModeTitle(true)).not.toMatch(/不改文件/);
  });

  it('hides approve action after plan is approved (no ghost button)', () => {
    expect(shouldShowPlanApproveAction(false)).toBe(true);
    expect(shouldShowPlanApproveAction(true)).toBe(false);
  });
});

describe('engine-down vs key-setup copy', () => {
  it('engine-down text talks about 恢复/连接, never 密钥 or 恐吓离线', () => {
    const full = resolveEngineDownSoftHintText({ onEmptySurface: false });
    const compact = resolveEngineDownSoftHintText({ onEmptySurface: true });
    expect(full).toMatch(/引擎|恢复|连接/);
    expect(compact).toMatch(/引擎|恢复|连接/);
    expect(full).not.toMatch(/密钥/);
    expect(compact).not.toMatch(/密钥/);
    // 产品策略：文案不恐吓「离线」
    expect(full).not.toMatch(/离线/);
    expect(compact).not.toMatch(/离线/);
  });

  it('sync-engine has compact empty-surface copy', () => {
    const full = resolveSyncEngineSoftHintText({ onEmptySurface: false });
    const compact = resolveSyncEngineSoftHintText({ onEmptySurface: true });
    expect(full).toMatch(/密钥/);
    expect(compact).toMatch(/密钥|同步/);
    expect(compact.length).toBeLessThan(full.length);
  });

  it('setup actions distinguish engine-offline from key-setup', () => {
    const engine = resolveSetupHintAction('engine-down');
    const key = resolveSetupHintAction('needs-key');
    expect(engine.label).toBe('模型设置');
    expect(engine.ariaLabel).toMatch(/引擎/);
    expect(engine.ariaLabel).not.toMatch(/密钥/);
    expect(key.label).toBe('去配置');
    expect(key.ariaLabel).toMatch(/密钥/);
  });

  it('covers all setup kinds with non-empty label + aria', () => {
    const kinds: SetupHintKind[] = [
      'engine-down',
      'needs-key',
      'needs-model',
      'sync-engine',
    ];
    for (const k of kinds) {
      const a = resolveSetupHintAction(k);
      expect(a.label.trim().length).toBeGreaterThan(0);
      expect(a.ariaLabel.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('shouldRenderRunNotice / run-notice a11y', () => {
  it('suppresses null and blank text (no ghost notice)', () => {
    expect(shouldRenderRunNotice(null)).toBe(false);
    expect(shouldRenderRunNotice(undefined)).toBe(false);
    expect(shouldRenderRunNotice({ text: '' })).toBe(false);
    expect(shouldRenderRunNotice({ text: '   ' })).toBe(false);
  });

  it('renders non-empty text', () => {
    expect(shouldRenderRunNotice({ text: '空回复' })).toBe(true);
    expect(shouldRenderRunNotice({ text: ' 有内容 ', kind: 'empty' })).toBe(
      true,
    );
  });

  it('builds spoken aria and urgency by kind', () => {
    expect(resolveRunNoticeAriaLabel('网络中断')).toBe('系统提示：网络中断');
    expect(resolveRunNoticeAriaLabel('  ')).toBe('系统提示');
    expect(resolveRunNoticeAriaLive('error')).toBe('assertive');
    expect(resolveRunNoticeAriaLive('fail')).toBe('assertive');
    expect(resolveRunNoticeAriaLive('empty')).toBe('polite');
    expect(resolveRunNoticeAriaLive(undefined)).toBe('polite');
  });
});

describe('resolveApprovalDockAriaLabel / label text', () => {
  it('prefers full summary when present', () => {
    expect(
      resolveApprovalDockAriaLabel(3, '3 待审批 · 队列 · shell'),
    ).toBe('3 待审批 · 队列 · shell');
    expect(
      resolveApprovalDockLabelText(3, '3 待审批 · 队列 · shell'),
    ).toBe('3 待审批 · 队列 · shell');
  });

  it('falls back to count phrasing (aria more spoken)', () => {
    expect(resolveApprovalDockAriaLabel(2, '')).toBe('2 项等待确认');
    expect(resolveApprovalDockAriaLabel(0, '  ')).toBe('待确认项');
    expect(resolveApprovalDockLabelText(2, '')).toBe('2 待审批');
    expect(resolveApprovalDockLabelText(0, '  ')).toBe('待审批');
  });

  it('treats non-finite count as zero for fallbacks', () => {
    expect(resolveApprovalDockAriaLabel(Number.NaN, '')).toBe('待确认项');
    expect(resolveApprovalDockLabelText(Number.NaN, '')).toBe('待审批');
  });
});

describe('shouldRenderApprovalDock', () => {
  it('defaults off when flag false (anti double-render)', () => {
    expect(shouldRenderApprovalDock(false, 5)).toBe(false);
    expect(shouldRenderApprovalDock(false, 0)).toBe(false);
  });

  it('requires positive count when flag true', () => {
    expect(shouldRenderApprovalDock(true, 0)).toBe(false);
    expect(shouldRenderApprovalDock(true, -1)).toBe(false);
    expect(shouldRenderApprovalDock(true, 1)).toBe(true);
    expect(shouldRenderApprovalDock(true, 3)).toBe(true);
  });

  it('rejects non-finite count', () => {
    expect(shouldRenderApprovalDock(true, Number.NaN)).toBe(false);
  });
});
