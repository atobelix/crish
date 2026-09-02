/**
 * apps/crish-desktop/src/api/workflow-api/workflowGrillMeStateMachine.test.ts
 * Grill-Me 四要素提取器单测（正逆向、伪监听判定、退化输入）。
 */
import { describe, expect, it } from 'vitest';
import {
  extractPillarsFromText,
  missingPillars,
} from './workflowGrillMeStateMachine';

describe('extractPillarsFromText 四要素提取', () => {
  it('每天 HH:mm → daily 候选（时区取本机默认）', () => {
    const p = extractPillarsFromText('帮我每天 9:30 总结未解决 PR', '');
    expect(p.schedule).toMatchObject({ type: 'daily', time: '09:30' });
    expect((p.schedule as { timezone?: string }).timezone).toBeTruthy();
  });

  it('每天 HH:mm 零填充与中文冒号兼容', () => {
    const p = extractPillarsFromText('每天09：05巡检', '');
    expect(p.schedule).toMatchObject({ type: 'daily', time: '09:05' });
  });

  it('每周一 09:00 → cron 周字段候选（0=周日口径；零填充等价合法）', () => {
    const p = extractPillarsFromText('每周一 09:00 代码体检', '');
    expect(p.schedule).toMatchObject({ type: 'cron', expression: '00 09 * * 1' });
  });

  it('每 N 分钟 → intervalMinutes 候选（含越界拒绝）', () => {
    expect(extractPillarsFromText('每 30 分钟扫一次依赖', '')).toMatchObject({
      schedule: { type: 'intervalMinutes', intervalMinutes: 30 },
    });
    // 越界（> 10080）不产生周期候选
    expect(
      extractPillarsFromText('每 20000 分钟执行一次', '').schedule
    ).toBeUndefined();
  });

  it('裸 5 段 cron 表达式 → cron 候选', () => {
    const p = extractPillarsFromText('按 0 9 * * 1-5 巡检仓库', '');
    expect(p.schedule).toMatchObject({ type: 'cron', expression: '0 9 * * 1-5' });
  });

  it('任务名称标签提取（至逗号/行尾止）', () => {
    const p = extractPillarsFromText(
      '任务名称：每日代码体检，每天 09:00 执行',
      ''
    );
    expect(p.name).toBe('每日代码体检');
    expect(p.schedule).toMatchObject({ type: 'daily', time: '09:00' });
  });

  it('伪监听判定：git push / 文件变更命中 isWatchRequest 且不产周期候选', () => {
    const p = extractPillarsFromText('每当 git push 后自动体检仓库', '');
    expect(p.isWatchRequest).toBe(true);
    expect(p.schedule).toBeUndefined();

    const p2 = extractPillarsFromText('文件变更时触发格式检查', '');
    expect(p2.isWatchRequest).toBe(true);
  });

  it('缺项追问聚焦：missing 清单按缺什么报什么', () => {
    expect(missingPillars({})).toEqual({
      missing: ['name', 'schedule'],
      isWatchRequest: false,
    });
    expect(
      missingPillars({ name: 'x', schedule: { type: 'manual' } })
    ).toEqual({ missing: [], isWatchRequest: false });
    expect(
      missingPillars({ isWatchRequest: true }).isWatchRequest
    ).toBe(true);
  });

  it('退化输入：空串/无要素文本不产候选、不抛异常', () => {
    expect(extractPillarsFromText('', '')).toEqual({});
    expect(extractPillarsFromText('   ', '')).toEqual({});
    const p = extractPillarsFromText('随便说点什么', 'C:/workspace');
    expect(p.schedule).toBeUndefined();
    expect(p.name).toBeUndefined();
    expect(p.cwd).toBe('C:/workspace');
  });
});
