import { describe, expect, it } from 'vitest';
import {
  buildScheduleFromDraft,
  emptyWorkflowDraft,
  isValidDailyTime,
  isValidIanaTimezone,
  parseIntervalMinutes,
  validateCronExpression,
  validateWorkflowDraft,
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

  it('validates and builds schedules from drafts', () => {
    const draft = { ...emptyWorkflowDraft(), name: 'Test', prompt: 'Do something' };
    expect(validateWorkflowDraft(draft)).toBeNull();
    expect(buildScheduleFromDraft(draft)).toEqual({ type: 'manual' });

    const valid = validateWorkflowSchedule({ type: 'daily', time: '12:00' });
    expect(valid.ok).toBe(true);
  });
});
