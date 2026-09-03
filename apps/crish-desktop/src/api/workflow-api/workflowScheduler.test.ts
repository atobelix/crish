import { describe, expect, it } from 'vitest';
import {
  buildScheduleFromDraft,
  emptyWorkflowDraft,
  validateWorkflowDraft,
} from './workflowDraft';
import {
  isValidDailyTime,
  isValidIanaTimezone,
  parseIntervalMinutes,
  validateCronExpression,
  validateWorkflowSchedule,
} from './workflowScheduler';

describe('workflowScheduler', () => {
  it('validates daily time format', () => {
    expect(isValidDailyTime('09:00')).toBe(true);
    expect(isValidDailyTime('23:59')).toBe(true);
    expect(isValidDailyTime('24:00')).toBe(false);
    expect(isValidDailyTime('9:00')).toBe(false);
  });

  it('validates IANA timezones', () => {
    expect(isValidIanaTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidIanaTimezone('UTC')).toBe(true);
    expect(isValidIanaTimezone('Invalid/TZ')).toBe(false);
  });

  it('parses interval minutes strictly', () => {
    expect(parseIntervalMinutes(30)).toBe(30);
    expect(parseIntervalMinutes('15')).toBe(15);
    expect(parseIntervalMinutes(0)).toBeNull();
    expect(parseIntervalMinutes('abc')).toBeNull();
  });

  it('validates 5-field cron expressions', () => {
    expect(validateCronExpression('0 * * * *')).toEqual({
      ok: true,
      expression: '0 * * * *',
    });
    expect(validateCronExpression('0 0 0 * * *').ok).toBe(false); // 6 fields
  });

  it('放行合法 cron 调度（T-CF-14 解除拒绝）', () => {
    const v = validateWorkflowSchedule({ type: 'cron', expression: '0 9 * * *' });
    expect(v).toEqual({
      ok: true,
      schedule: { type: 'cron', expression: '0 9 * * *' },
    });
    // 步进 / 范围 / 列表表达式同样放行
    expect(validateWorkflowSchedule({ type: 'cron', expression: '*/30 * * * *' }).ok).toBe(
      true
    );
    expect(
      validateWorkflowSchedule({ type: 'cron', expression: '0,30 9-18 * * 1-5' }).ok
    ).toBe(true);
  });

  it('非法 cron 仍拒绝（双重校验第一道）', () => {
    // 6 字段（含秒）
    const six = validateWorkflowSchedule({ type: 'cron', expression: '0 0 0 * * *' });
    expect(six.ok).toBe(false);
    // 越界字段
    const bad = validateWorkflowSchedule({ type: 'cron', expression: '60 * * * *' });
    expect(bad.ok).toBe(false);
    // @ 宏
    expect(validateWorkflowSchedule({ type: 'cron', expression: '@daily' }).ok).toBe(
      false
    );
    // 空表达式
    expect(validateWorkflowSchedule({ type: 'cron', expression: '' }).ok).toBe(false);
  });

  it('validates and builds schedules from drafts with required cwd', () => {
    const draftWithoutCwd = { ...emptyWorkflowDraft(), name: 'Test', prompt: 'Do something' };
    expect(validateWorkflowDraft(draftWithoutCwd)).toBe('请选择所属工作区项目');

    const draftWithCwd = { ...draftWithoutCwd, cwd: 'c:/Software/conex' };
    expect(validateWorkflowDraft(draftWithCwd)).toBeNull();
    expect(buildScheduleFromDraft(draftWithCwd)).toEqual({ type: 'manual' });

    const valid = validateWorkflowSchedule({ type: 'daily', time: '12:00' });
    expect(valid.ok).toBe(true);
  });

  describe('areWorkspacePathsEqual and filterWorkflowsByWorkspace', () => {
    it('handles Windows drive casing and slash normalization', async () => {
      const { areWorkspacePathsEqual, normalizeWorkspacePath } = await import(
        './workflowScheduler'
      );
      expect(normalizeWorkspacePath('  "C:\\Software\\conex\\" ')).toBe('C:/Software/conex');
      expect(areWorkspacePathsEqual('c:/software/conex', 'C:/Software/conex/')).toBe(true);
      expect(areWorkspacePathsEqual('c:\\Software\\conex', 'C:/Software/conex')).toBe(true);
      expect(areWorkspacePathsEqual('c:/project-a', 'c:/project-b')).toBe(false);
      expect(areWorkspacePathsEqual(null, 'c:/project-b')).toBe(false);
      expect(areWorkspacePathsEqual('', '')).toBe(false);
    });

    it('filters workflows strictly by workspace path', async () => {
      const { filterWorkflowsByWorkspace } = await import('./workflowScheduler');
      const list = [
        { id: '1', name: 'Task A', cwd: 'c:/Software/conex' },
        { id: '2', name: 'Task B', cwd: 'C:\\Software\\conex' },
        { id: '3', name: 'Task C', cwd: 'c:/Software/other-project' },
        { id: '4', name: 'Task D', cwd: '' },
        { id: '5', name: 'Task E' },
      ];

      const filtered = filterWorkflowsByWorkspace(list, 'C:/Software/conex/');
      expect(filtered.map((w) => w.id)).toEqual(['1', '2']);

      expect(filterWorkflowsByWorkspace(list, 'c:/Software/empty-project')).toEqual([]);
      expect(filterWorkflowsByWorkspace(list, '')).toEqual([]);
      expect(filterWorkflowsByWorkspace(list, undefined)).toEqual([]);
    });
  });
});
