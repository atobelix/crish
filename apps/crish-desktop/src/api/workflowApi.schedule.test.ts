import { describe, expect, it } from 'vitest';
import {
  isDefaultSessionTitle,
  isEmptyShellSession,
  isScheduledSessionTitle,
} from './sessionTitle';
import {
  DEFAULT_DAILY_TIME,
  DEFAULT_INTERVAL_MINUTES,
  SCHEDULED_SESSION_TITLE_PREFIX,
  WORKFLOW_INTERVAL_MINUTES_MAX,
  WORKFLOW_INTERVAL_MINUTES_MIN,
  WORKFLOW_JOBS_EMPTY_LABELS,
  buildScheduleFromDraft,
  canReplaceSessionTitleWithScheduled,
  cronExpressionLabel,
  emptyWorkflowDraft,
  isValidCronExpression,
  isValidDailyTime,
  isValidIanaTimezone,
  normalizeDailyTime,
  normalizeWorkflowSchedule,
  parseIntervalMinutes,
  resolveWorkflowJobsEmptyCopy,
  scheduleLabel,
  scheduledSessionTitle,
  validateCronExpression,
  validateWorkflowDraft,
  validateWorkflowSchedule,
  watchTriggerHint,
  workflowActionErrorMessage,
  workflowEnabledLabel,
  workflowJobsEmptyLabel,
  workflowRunStatusLabel,
  workflowTriggerOkMessage,
} from './workflowApi';

describe('scheduledSessionTitle', () => {
  it('prefixes workflow name with system marker', () => {
    expect(scheduledSessionTitle('每日 PR 总结')).toBe('定时 · 每日 PR 总结');
    expect(
      scheduledSessionTitle('每日 PR 总结').startsWith(
        SCHEDULED_SESSION_TITLE_PREFIX
      )
    ).toBe(true);
  });

  it('falls back when name empty', () => {
    expect(scheduledSessionTitle('')).toBe('定时 · 任务');
    expect(scheduledSessionTitle(null)).toBe('定时 · 任务');
    expect(scheduledSessionTitle('  ')).toBe('定时 · 任务');
    expect(scheduledSessionTitle(undefined)).toBe('定时 · 任务');
  });

  it('strips nested 定时 · prefixes (no double prefix pollution)', () => {
    expect(scheduledSessionTitle('定时 · 代码体检')).toBe('定时 · 代码体检');
    expect(scheduledSessionTitle('定时·巡检')).toBe('定时 · 巡检');
    expect(scheduledSessionTitle('定时 · 定时 · 叠层')).toBe('定时 · 叠层');
  });

  it('truncates long names to sidebar max', () => {
    const long = '很长的工作流名称'.repeat(20);
    const title = scheduledSessionTitle(long);
    expect(title.length).toBeLessThanOrEqual(48);
    expect(title.endsWith('…')).toBe(true);
    expect(title.startsWith('定时 ·')).toBe(true);
  });

  it('is not a default title — will not be treated as empty shell / 新建 placeholder', () => {
    const title = scheduledSessionTitle('代码体检');
    expect(isScheduledSessionTitle(title)).toBe(true);
    expect(isDefaultSessionTitle(title)).toBe(false);
    // 定时占位：非默认标题 → 不是 isEmptyShellSession，剪枝不会当幽灵壳清掉
    expect(
      isEmptyShellSession({
        title,
        messages: [],
        isPinned: false,
      })
    ).toBe(false);
    // 对比：默认「新会话」空壳仍会被识别
    expect(
      isEmptyShellSession({
        title: '新会话',
        messages: [],
        isPinned: false,
      })
    ).toBe(true);
  });
});

describe('canReplaceSessionTitleWithScheduled', () => {
  it('allows default and system scheduled titles', () => {
    expect(canReplaceSessionTitleWithScheduled('')).toBe(true);
    expect(canReplaceSessionTitleWithScheduled(null)).toBe(true);
    expect(canReplaceSessionTitleWithScheduled('新会话')).toBe(true);
    expect(canReplaceSessionTitleWithScheduled('新会话 2')).toBe(true);
    expect(canReplaceSessionTitleWithScheduled('New Session')).toBe(true);
    expect(canReplaceSessionTitleWithScheduled('定时 · 旧名')).toBe(true);
    expect(canReplaceSessionTitleWithScheduled('定时·紧凑')).toBe(true);
  });

  it('rejects user-renamed titles (do not overwrite)', () => {
    expect(canReplaceSessionTitleWithScheduled('我的巡检笔记')).toBe(false);
    expect(canReplaceSessionTitleWithScheduled('PR review')).toBe(false);
  });
});

describe('workflowTriggerOkMessage', () => {
  it('formats success inline status (not for toast)', () => {
    expect(workflowTriggerOkMessage('abcdefghij')).toBe('已触发 · abcdefgh');
    expect(workflowTriggerOkMessage('short')).toBe('已触发 · short');
    expect(workflowTriggerOkMessage('')).toBe('已触发');
    expect(workflowTriggerOkMessage(null)).toBe('已触发');
    expect(workflowTriggerOkMessage(undefined)).toBe('已触发');
  });
});

describe('workflowActionErrorMessage', () => {
  it('maps not_connected via network callback', () => {
    expect(
      workflowActionErrorMessage(
        'not_connected',
        '触发失败',
        () => '请先连接引擎'
      )
    ).toBe('请先连接引擎');
  });

  it('prefers explicit error then fallback', () => {
    expect(workflowActionErrorMessage('boom', '触发失败', () => 'net')).toBe(
      'boom'
    );
    expect(workflowActionErrorMessage('', '触发失败', () => 'net')).toBe(
      '触发失败'
    );
    expect(workflowActionErrorMessage(undefined, '创建失败', () => 'net')).toBe(
      '创建失败'
    );
  });
});

describe('workflowRunStatusLabel', () => {
  it('labels common statuses', () => {
    expect(workflowRunStatusLabel('running')).toBe('运行中');
    expect(workflowRunStatusLabel('accepted')).toBe('运行中');
    expect(workflowRunStatusLabel('completed')).toBe('已完成');
    expect(workflowRunStatusLabel('success')).toBe('已完成');
    expect(workflowRunStatusLabel('failed')).toBe('失败');
    expect(workflowRunStatusLabel('error')).toBe('失败');
    expect(workflowRunStatusLabel('cancelled')).toBe('已取消');
    expect(workflowRunStatusLabel(undefined)).toBe('未知');
  });

  it('labels awaiting-approval and aliases', () => {
    expect(workflowRunStatusLabel('awaiting-approval')).toBe('待审批');
    expect(workflowRunStatusLabel('awaiting_approval')).toBe('待审批');
    expect(workflowRunStatusLabel('in_progress')).toBe('运行中');
  });
});

describe('isValidDailyTime / normalizeDailyTime', () => {
  it('accepts HH:mm in 00:00–23:59', () => {
    expect(isValidDailyTime('00:00')).toBe(true);
    expect(isValidDailyTime('09:00')).toBe(true);
    expect(isValidDailyTime('23:59')).toBe(true);
    expect(isValidDailyTime('18:30')).toBe(true);
  });

  it('rejects bad daily times', () => {
    expect(isValidDailyTime('')).toBe(false);
    expect(isValidDailyTime('9:00')).toBe(false);
    expect(isValidDailyTime('24:00')).toBe(false);
    expect(isValidDailyTime('12:60')).toBe(false);
    expect(isValidDailyTime('ab:cd')).toBe(false);
    expect(isValidDailyTime(null)).toBe(false);
    expect(isValidDailyTime(900)).toBe(false);
  });

  it('normalizes H:mm and falls back', () => {
    expect(normalizeDailyTime('9:05')).toBe('09:05');
    expect(normalizeDailyTime('18:30')).toBe('18:30');
    expect(normalizeDailyTime('')).toBe(DEFAULT_DAILY_TIME);
    expect(normalizeDailyTime('25:99')).toBe(DEFAULT_DAILY_TIME);
    expect(normalizeDailyTime('xx', '07:15')).toBe('07:15');
  });
});

describe('isValidIanaTimezone', () => {
  it('accepts common IANA zones and rejects garbage', () => {
    expect(isValidIanaTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidIanaTimezone('UTC')).toBe(true);
    expect(isValidIanaTimezone('')).toBe(false);
    expect(isValidIanaTimezone('Not/AZone')).toBe(false);
    expect(isValidIanaTimezone(null)).toBe(false);
  });
});

describe('parseIntervalMinutes', () => {
  it('parses integers in range', () => {
    expect(parseIntervalMinutes(1)).toBe(WORKFLOW_INTERVAL_MINUTES_MIN);
    expect(parseIntervalMinutes(30)).toBe(30);
    expect(parseIntervalMinutes('15')).toBe(15);
    expect(parseIntervalMinutes(String(WORKFLOW_INTERVAL_MINUTES_MAX))).toBe(
      WORKFLOW_INTERVAL_MINUTES_MAX
    );
  });

  it('rejects bad intervals', () => {
    expect(parseIntervalMinutes(0)).toBeNull();
    expect(parseIntervalMinutes(-5)).toBeNull();
    expect(parseIntervalMinutes(1.5)).toBeNull();
    expect(parseIntervalMinutes('')).toBeNull();
    expect(parseIntervalMinutes('30m')).toBeNull();
    expect(parseIntervalMinutes('abc')).toBeNull();
    expect(parseIntervalMinutes(WORKFLOW_INTERVAL_MINUTES_MAX + 1)).toBeNull();
    expect(parseIntervalMinutes(NaN)).toBeNull();
  });
});

describe('validateCronExpression / isValidCronExpression / cronExpressionLabel', () => {
  it('accepts standard 5-field cron', () => {
    expect(isValidCronExpression('0 9 * * *')).toBe(true);
    expect(isValidCronExpression('*/5 * * * *')).toBe(true);
    expect(isValidCronExpression('0 0 1 1 *')).toBe(true);
    expect(isValidCronExpression('0-30/5 8-18 * * 1-5')).toBe(true);
    expect(validateCronExpression('  0   9  * * *  ')).toEqual({
      ok: true,
      expression: '0 9 * * *',
    });
  });

  it('rejects empty, 6-field, macros, and out-of-range fields', () => {
    expect(validateCronExpression('').ok).toBe(false);
    expect(validateCronExpression(null).ok).toBe(false);
    const six = validateCronExpression('0 0 * * * *');
    expect(six.ok).toBe(false);
    if (six.ok === false) expect(six.error).toMatch(/6 字段/);
    const macro = validateCronExpression('@daily');
    expect(macro.ok).toBe(false);
    if (macro.ok === false) expect(macro.error).toMatch(/宏/);
    expect(validateCronExpression('60 * * * *').ok).toBe(false);
    expect(validateCronExpression('0 24 * * *').ok).toBe(false);
    expect(validateCronExpression('0 9').ok).toBe(false);
    expect(isValidCronExpression('not cron')).toBe(false);
  });

  it('labels common patterns in Chinese; invalid → 无效 cron', () => {
    expect(cronExpressionLabel('*/5 * * * *')).toMatch(/每 5 分钟/);
    expect(cronExpressionLabel('0 9 * * *')).toMatch(/每天 9 点/);
    expect(cronExpressionLabel('0 0 * * *')).toMatch(/每天 0 点/);
    expect(cronExpressionLabel('1 2 3 4 5')).toBe('1 2 3 4 5');
    expect(cronExpressionLabel('')).toBe('无效 cron');
    expect(cronExpressionLabel('@hourly')).toBe('无效 cron');
  });
});

describe('validateWorkflowSchedule / normalizeWorkflowSchedule', () => {
  it('accepts engine-supported schedules', () => {
    expect(validateWorkflowSchedule({ type: 'manual' })).toEqual({
      ok: true,
      schedule: { type: 'manual' },
    });
    expect(validateWorkflowSchedule(null)).toEqual({
      ok: true,
      schedule: { type: 'manual' },
    });
    const daily = validateWorkflowSchedule({
      type: 'daily',
      time: '18:00',
      timezone: 'Asia/Shanghai',
    });
    expect(daily.ok).toBe(true);
    if (daily.ok) {
      expect(daily.schedule).toEqual({
        type: 'daily',
        time: '18:00',
        timezone: 'Asia/Shanghai',
      });
    }
    expect(
      validateWorkflowSchedule({ type: 'intervalMinutes', intervalMinutes: 15 })
    ).toEqual({
      ok: true,
      schedule: { type: 'intervalMinutes', intervalMinutes: 15 },
    });
  });

  it('guards bad daily / interval / timezone', () => {
    expect(validateWorkflowSchedule({ type: 'daily', time: '25:99' }).ok).toBe(
      false
    );
    expect(
      validateWorkflowSchedule({
        type: 'daily',
        time: '09:00',
        timezone: 'Not/AZone',
      }).ok
    ).toBe(false);
    const zero = validateWorkflowSchedule({
      type: 'intervalMinutes',
      intervalMinutes: 0,
    });
    expect(zero.ok).toBe(false);
    if (zero.ok === false) expect(zero.error).toMatch(/间隔分钟/);
    expect(
      validateWorkflowSchedule({
        type: 'intervalMinutes',
        intervalMinutes: 'x',
      }).ok
    ).toBe(false);
    expect(validateWorkflowSchedule('nope').ok).toBe(false);
  });

  it('accepts valid cron expressions (F9 engine support unblocked)', () => {
    const r = validateWorkflowSchedule({
      type: 'cron',
      cronExpression: '0 9 * * *',
    });
    expect(r.ok).toBe(true);
    const bad = validateWorkflowSchedule({ type: 'cron', expression: 'bad' });
    expect(bad.ok).toBe(false);
    if (bad.ok === false) expect(bad.error).toMatch(/cron/);
  });

  it('rejects planned advanced types with Chinese errors', () => {
    const fw = validateWorkflowSchedule({ type: 'fileWatch' });
    expect(fw.ok).toBe(false);
    if (fw.ok === false) expect(fw.error).toMatch(/fileWatch/);
    expect(validateWorkflowSchedule({ type: 'weekly' }).ok).toBe(false);
  });

  it('normalize falls back to manual on bad input', () => {
    expect(
      normalizeWorkflowSchedule({ type: 'cron', expression: '0 * * * *' })
    ).toEqual({
      type: 'cron',
      expression: '0 * * * *',
    });
    expect(
      normalizeWorkflowSchedule({
        type: 'intervalMinutes',
        intervalMinutes: -1,
      })
    ).toEqual({
      type: 'manual',
    });
    expect(
      normalizeWorkflowSchedule({
        type: 'daily',
        time: '10:00',
        timezone: 'UTC',
      })
    ).toEqual({
      type: 'daily',
      time: '10:00',
      timezone: 'UTC',
    });
  });
});

describe('validateWorkflowDraft', () => {
  it('requires name and prompt; 空 cwd = 全局工作区沙箱（UI 下拉首项，合法）', () => {
    const base = emptyWorkflowDraft('/test/workspace');
    expect(validateWorkflowDraft(base)).toBe('请填写名称与提示词');
    expect(validateWorkflowDraft({ ...base, name: 'n' })).toBe('请填写提示词');
    expect(validateWorkflowDraft({ ...base, prompt: 'p' })).toBe('请填写名称');
    // 产品契约：WorkflowForm.tsx:135 关联项目首项固定「全局工作区」（cwd=''）——合法
    expect(
      validateWorkflowDraft({ ...base, name: 'n', prompt: 'p', cwd: '' })
    ).toBeNull();
    expect(
      validateWorkflowDraft({ ...base, name: 'n', prompt: 'p' })
    ).toBeNull();
    expect(validateWorkflowDraft(null)).toBe('请填写名称与提示词');
  });

  it('guards daily time, interval, and 5-field cron fields', () => {
    const base = emptyWorkflowDraft('/test/workspace');
    expect(
      validateWorkflowDraft({
        ...base,
        name: 'n',
        prompt: 'p',
        scheduleType: 'daily',
        dailyTime: '25:00',
      })
    ).toMatch(/HH:mm/);
    expect(
      validateWorkflowDraft({
        ...base,
        name: 'n',
        prompt: 'p',
        scheduleType: 'daily',
        dailyTime: '09:00',
      })
    ).toBeNull();
    expect(
      validateWorkflowDraft({
        ...base,
        name: 'n',
        prompt: 'p',
        scheduleType: 'intervalMinutes',
        intervalMinutes: '',
      })
    ).toMatch(/间隔/);
    expect(
      validateWorkflowDraft({
        ...base,
        name: 'n',
        prompt: 'p',
        scheduleType: 'intervalMinutes',
        intervalMinutes: '0',
      })
    ).toMatch(/间隔/);
    expect(
      validateWorkflowDraft({
        ...base,
        name: 'n',
        prompt: 'p',
        scheduleType: 'intervalMinutes',
        intervalMinutes: '45',
      })
    ).toBeNull();
    expect(
      validateWorkflowDraft({
        ...base,
        name: 'n',
        prompt: 'p',
        scheduleType: 'cron',
        cronExpression: '',
      })
    ).toBe('请填写 Cron 表达式');
    expect(
      validateWorkflowDraft({
        ...base,
        name: 'n',
        prompt: 'p',
        scheduleType: 'cron',
        cronExpression: '0 0 0 * * *',
      })
    ).toMatch(/5 字段/);
    expect(
      validateWorkflowDraft({
        ...base,
        name: 'n',
        prompt: 'p',
        scheduleType: 'cron',
        cronExpression: '0 9,18 * * 1-5',
      })
    ).toBeNull();
  });
});

describe('draftFromWorkflow & validateCronExpressionClient', () => {
  it('preserves complex 5-field cron expressions without downgrading and maps targetSessionId / executionTarget', async () => {
    const { draftFromWorkflow, validateCronExpressionClient } =
      await import('../components/settings/workflowsSharedLib');

    const complexCronWf = {
      id: 'wf-cron-1',
      name: '工作日双次巡检',
      prompt: '检查 PR 状态',
      cwd: '',
      targetSessionId: 'sess-bound-42',
      schedule: { type: 'cron' as const, expression: '0 9,18 * * 1-5' },
    };
    const draft1 = draftFromWorkflow(complexCronWf);
    expect(draft1.scheduleType).toBe('cron');
    expect(draft1.cronExpression).toBe('0 9,18 * * 1-5');
    expect(draft1.targetSessionId).toBe('sess-bound-42');
    expect(draft1.executionTarget).toBe('current_session');

    const stepHourWf = {
      id: 'wf-cron-2',
      name: '每4小时检查',
      prompt: '检查构建',
      targetSessionId: null,
      schedule: { type: 'cron' as const, expression: '15 */4 * * *' },
    };
    const draft2 = draftFromWorkflow(stepHourWf);
    expect(draft2.scheduleType).toBe('cron');
    expect(draft2.cronExpression).toBe('15 */4 * * *');
    expect(draft2.targetSessionId).toBe('');
    expect(draft2.executionTarget).toBe('isolated_session');

    const intervalWf = {
      id: 'wf-int-1',
      name: '间隔任务',
      prompt: '执行检查',
      schedule: { type: 'intervalMinutes' as const, intervalMinutes: 45 },
    };
    const draft3 = draftFromWorkflow(intervalWf);
    expect(draft3.scheduleType).toBe('intervalMinutes');
    expect(draft3.intervalMinutes).toBe('45');

    const validPreview = validateCronExpressionClient('0 9,18 * * 1-5');
    expect(validPreview.valid).toBe(true);
    expect(validPreview.label).toContain('工作日');
    expect(validPreview.error).toBeUndefined();

    const invalidPreview = validateCronExpressionClient('60 9 * * *');
    expect(invalidPreview.valid).toBe(false);
    expect(invalidPreview.error).toMatch(/分钟/);
  });
});

describe('empty jobs Chinese labels', () => {
  it('exposes stable empty labels', () => {
    expect(workflowJobsEmptyLabel('list')).toBe('暂无任务');
    expect(workflowJobsEmptyLabel('settings')).toBe('暂无计划任务');
    expect(workflowJobsEmptyLabel('runtime')).toMatch(/暂无计划任务/);
    expect(WORKFLOW_JOBS_EMPTY_LABELS.listHint).toBe('用上方模板创建');
    expect(workflowEnabledLabel(true)).toBe('已启用');
    expect(workflowEnabledLabel(false)).toBe('已暂停');
    expect(workflowEnabledLabel(undefined)).toBe('已启用');
  });

  it('resolveWorkflowJobsEmptyCopy covers loading / empty / filter / surfaces', () => {
    expect(
      resolveWorkflowJobsEmptyCopy({ loading: true, totalCount: 0 })
    ).toEqual({
      title: '加载中…',
    });
    expect(
      resolveWorkflowJobsEmptyCopy({ totalCount: 0, surface: 'list' })
    ).toEqual({
      title: '暂无任务',
      hint: '用上方模板创建',
    });
    expect(
      resolveWorkflowJobsEmptyCopy({ totalCount: 0, surface: 'settings' })
    ).toEqual({
      title: '暂无计划任务',
    });
    expect(
      resolveWorkflowJobsEmptyCopy({ totalCount: 0, surface: 'runtime' })?.title
    ).toMatch(/引擎 workflow/);
    expect(
      resolveWorkflowJobsEmptyCopy({
        totalCount: 3,
        filteredCount: 0,
        surface: 'settings',
      })
    ).toEqual({ title: '没有符合筛选的任务' });
    expect(
      resolveWorkflowJobsEmptyCopy({ totalCount: 2, filteredCount: 2 })
    ).toBeNull();
  });
});

describe('scheduleLabel / buildScheduleFromDraft', () => {
  it('labels known schedule types', () => {
    expect(scheduleLabel({ type: 'manual' })).toBe('手动');
    expect(
      scheduleLabel({ type: 'daily', time: '09:00', timezone: 'Asia/Shanghai' })
    ).toBe('每天 09:00 (Asia/Shanghai)');
    expect(
      scheduleLabel({ type: 'intervalMinutes', intervalMinutes: 30 })
    ).toBe('每 30 分钟');
    expect(scheduleLabel(undefined)).toBe('手动');
  });

  it('guards bad schedule fields in labels', () => {
    expect(scheduleLabel({ type: 'daily', time: '99:99' })).toBe('每天 —');
    expect(scheduleLabel({ type: 'intervalMinutes', intervalMinutes: 0 })).toBe(
      '间隔'
    );
    expect(scheduleLabel({ type: 'intervalMinutes' })).toBe('间隔');
    expect(
      scheduleLabel({ type: 'cron', cronExpression: '*/15 * * * *' })
    ).toMatch(/cron · 每 15 分钟/);
    expect(scheduleLabel({ type: 'cron', expression: 'bad' })).toBe(
      '高级 · cron（无效）'
    );
    expect(scheduleLabel({ type: 'fileWatch' })).toBe('高级 · fileWatch');
  });

  it('builds schedule from draft with soft fallbacks', () => {
    const base = emptyWorkflowDraft();
    expect(base.dailyTime).toBe(DEFAULT_DAILY_TIME);
    expect(base.intervalMinutes).toBe(String(DEFAULT_INTERVAL_MINUTES));
    expect(buildScheduleFromDraft({ ...base, scheduleType: 'manual' })).toEqual(
      {
        type: 'manual',
      }
    );
    const daily = buildScheduleFromDraft({
      ...base,
      scheduleType: 'daily',
      dailyTime: '18:30',
    });
    expect(daily).toMatchObject({ type: 'daily', time: '18:30' });
    expect(
      buildScheduleFromDraft({
        ...base,
        scheduleType: 'intervalMinutes',
        intervalMinutes: '15',
      })
    ).toEqual({ type: 'intervalMinutes', intervalMinutes: 15 });
    // bad interval → default 30
    expect(
      buildScheduleFromDraft({
        ...base,
        scheduleType: 'intervalMinutes',
        intervalMinutes: 'nope',
      })
    ).toEqual({
      type: 'intervalMinutes',
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    });
    // H:mm → HH:mm
    expect(
      buildScheduleFromDraft({
        ...base,
        scheduleType: 'daily',
        dailyTime: '9:00',
      })
    ).toMatchObject({ type: 'daily', time: '09:00' });
    // nullish draft → manual
    expect(
      buildScheduleFromDraft(
        null as unknown as ReturnType<typeof emptyWorkflowDraft>
      )
    ).toEqual({
      type: 'manual',
    });
  });
});

describe('watchTriggerHint', () => {
  it('returns inline tip for watch-like keywords (caller must not toast)', () => {
    expect(watchTriggerHint('文件变更巡检')).toMatch(/提示：/);
    expect(watchTriggerHint('file watch')).toMatch(/提示：/);
    expect(watchTriggerHint('普通任务')).toBeNull();
    expect(watchTriggerHint('')).toBeNull();
  });
});
