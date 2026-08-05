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

  it('validates and builds schedules from drafts', () => {
    const draft = { ...emptyWorkflowDraft(), name: 'Test', prompt: 'Do something' };
    expect(validateWorkflowDraft(draft)).toBeNull();
    expect(buildScheduleFromDraft(draft)).toEqual({ type: 'manual' });

    const valid = validateWorkflowSchedule({ type: 'daily', time: '12:00' });
    expect(valid.ok).toBe(true);
  });
});
