/**
 * 引擎 workflow 草稿、预设模板与空态文案契约
 */

import {
  DEFAULT_DAILY_TIME,
  DEFAULT_INTERVAL_MINUTES,
  WORKFLOW_INTERVAL_MINUTES_MAX,
  WORKFLOW_INTERVAL_MINUTES_MIN,
  defaultTimezone,
  normalizeDailyTime,
  parseIntervalMinutes,
  tryNormalizeDailyTime,
  validateCronExpression,
  type WorkflowSchedule,
} from './workflowScheduler';
import {
  DEFAULT_PERMISSION_MODE,
  coercePermissionMode,
  type PermissionMode,
} from '../permissionModes';

/** 引擎支持的四大标准调度类型（单轨契约） */
export const WORKFLOW_SCHEDULE_TYPES = [
  { value: 'manual' as const, label: '手动', hint: '仅手动触发，不自动运行' },
  { value: 'daily' as const, label: '每天', hint: '每日固定时刻（本机时区）' },
  {
    value: 'intervalMinutes' as const,
    label: '间隔（分钟）',
    hint: '按分钟周期轮询执行',
  },
  {
    value: 'cron' as const,
    label: 'Cron 表达式',
    hint: '标准 5 字段 cron（分 时 日 月 周）',
  },
] as const;

export type WorkflowScheduleType =
  | (typeof WORKFLOW_SCHEDULE_TYPES)[number]['value']
  | 'interval'
  | 'weekly'
  | 'once';

/** 执行输出目标模式：当前活跃对话 vs 独立新后台会话 */
export type WorkflowExecutionTarget = 'current_session' | 'isolated_session';

/** 新建与编辑表单受控草稿结构（设置页 / 主区面板共用） */
export type WorkflowScheduleDraft = {
  name: string;
  prompt: string;
  scheduleType: WorkflowScheduleType;
  dailyTime: string;
  intervalMinutes: string;
  cronExpression: string;
  cwd?: string;
  targetSessionId?: string;
  executionTarget: WorkflowExecutionTarget;
  /** 该定时任务执行时使用的权限模式（缺省 smart，不继承创建者会话） */
  permissionMode?: PermissionMode;
};

/** WorkflowScheduleDraft 别名 */
export type WorkflowDraft = WorkflowScheduleDraft;

export type WorkflowSchedulePreset = {
  id: string;
  label: string;
  draft: WorkflowScheduleDraft;
};

/** 一键预填模板芯片 */
export const WORKFLOW_SCHEDULE_PRESETS: WorkflowSchedulePreset[] = [
  {
    id: 'daily-pr-summary',
    label: '每日 PR 总结',
    draft: {
      name: '每日 PR 总结',
      prompt:
        '请基于当前仓库，总结今日相关的 PR / 合并请求与未合入变更：列出标题、作者、状态与风险点；如有阻塞请标出。用简洁中文汇报。',
      scheduleType: 'daily',
      dailyTime: '18:00',
      intervalMinutes: '30',
      cronExpression: '0 18 * * *',
      targetSessionId: '',
      executionTarget: 'current_session',
    },
  },
  {
    id: 'daily-code-check',
    label: '每日代码体检',
    draft: {
      name: '每日代码体检',
      prompt:
        '请对当前工作区做一次代码体检：检查明显错误、类型/ lint 风险、可疑改动与待办；给出优先修复建议与简短结论。用简洁中文。',
      scheduleType: 'daily',
      dailyTime: '09:00',
      intervalMinutes: '30',
      cronExpression: '0 9 * * *',
      targetSessionId: '',
      executionTarget: 'isolated_session',
    },
  },
  {
    id: 'every-30m',
    label: '每 30 分钟检查',
    draft: {
      name: '每 30 分钟检查',
      prompt:
        '快速巡检当前项目状态：未提交变更、失败测试/构建线索、明显阻塞。仅报告重要项，无事则简短回复「正常」。',
      scheduleType: 'intervalMinutes',
      dailyTime: '09:00',
      intervalMinutes: '30',
      cronExpression: '*/30 * * * *',
      targetSessionId: '',
      executionTarget: 'current_session',
    },
  },
  {
    id: 'weekday-morning-sync',
    label: '工作日早 9 点巡检',
    draft: {
      name: '工作日早 9 点巡检',
      prompt:
        '早上好！请汇总昨日至今日未解决的 Issue 与待办事项，按优先级排布。用结构化中文汇报。',
      scheduleType: 'cron',
      dailyTime: '09:00',
      intervalMinutes: '60',
      cronExpression: '0 9 * * 1-5',
      targetSessionId: '',
      executionTarget: 'current_session',
    },
  },
];

/** 名称/说明含「监听类」关键词时的软提示（非真实 file watcher） */
const WATCH_HINT_RE =
  /文件变更|文件监听|改动触发|on\s*file|file[\s_-]?change|file[\s_-]?watch|watch(er)?|监听|推送提醒|git\s*push|after\s*push/i;

/**
 * 监听类关键词软提示文案。
 * 调用方须行内展示（setOk / setWfOk），禁止 toast（策略：仅错误+可撤销）。
 */
export function watchTriggerHint(text: string): string | null {
  const t = String(text || '').trim();
  if (!t || !WATCH_HINT_RE.test(t)) return null;
  return '提示：名称含文件/推送类关键词时，引擎仍不会自动监听仓库。请用「间隔分钟」软轮询，或等引擎支持文件触发后再改调度类型。';
}

/**
 * 计划任务空列表中文文案（list / settings / runtime 共用契约）。
 * UI 可直接取 title/hint，禁止自造「Untitled cron」类幽灵标签。
 */
export const WORKFLOW_JOBS_EMPTY_LABELS = {
  list: '暂无任务',
  listHint: '用上方模板创建',
  settings: '暂无计划任务',
  settingsFilter: '没有符合筛选的任务',
  runtime: '引擎 workflow 暂无计划任务',
  loading: '加载中…',
} as const;

export type WorkflowJobsEmptyKind = keyof typeof WORKFLOW_JOBS_EMPTY_LABELS;

/** 取单一空态标签 */
export function workflowJobsEmptyLabel(
  kind: WorkflowJobsEmptyKind = 'list'
): string {
  return WORKFLOW_JOBS_EMPTY_LABELS[kind] ?? WORKFLOW_JOBS_EMPTY_LABELS.list;
}

/**
 * 按表面与计数解析空态文案（pure：不读 store）。
 * - loading 优先
 * - total=0 → 全空
 * - total>0 且 filtered=0 → 筛选空（settings）
 */
export function resolveWorkflowJobsEmptyCopy(opts: {
  loading?: boolean;
  totalCount: number;
  filteredCount?: number;
  surface?: 'list' | 'settings' | 'runtime';
}): { title: string; hint?: string } | null {
  if (opts.loading) {
    return { title: WORKFLOW_JOBS_EMPTY_LABELS.loading };
  }
  const total = Math.max(0, Number(opts.totalCount) || 0);
  const filtered =
    opts.filteredCount === undefined
      ? total
      : Math.max(0, Number(opts.filteredCount) || 0);
  if (total > 0 && filtered > 0) return null;
  if (total > 0 && filtered === 0) {
    return { title: WORKFLOW_JOBS_EMPTY_LABELS.settingsFilter };
  }
  const surface = opts.surface || 'list';
  if (surface === 'settings') {
    return { title: WORKFLOW_JOBS_EMPTY_LABELS.settings };
  }
  if (surface === 'runtime') {
    return { title: WORKFLOW_JOBS_EMPTY_LABELS.runtime };
  }
  return {
    title: WORKFLOW_JOBS_EMPTY_LABELS.list,
    hint: WORKFLOW_JOBS_EMPTY_LABELS.listHint,
  };
}

/** 启用/暂停中文标签 */
export function workflowEnabledLabel(enabled?: boolean | null): string {
  return enabled === false ? '已暂停' : '已启用';
}

/**
 * 新建草稿校验：名称/提示词必填 + 调度字段守卫。
 * 解绑强制项目路径校验（允许 cwd 为空字符串，代表全局工作区沙箱）。
 * 返回中文错误；通过则 null。
 */
export function validateWorkflowDraft(
  draft: WorkflowScheduleDraft | null | undefined
): string | null {
  if (!draft || typeof draft !== 'object') {
    return '请填写名称与提示词';
  }
  const name = String(draft.name ?? '').trim();
  const prompt = String(draft.prompt ?? '').trim();
  if (!name && !prompt) return '请填写名称与提示词';
  if (!name) return '请填写名称';
  if (!prompt) return '请填写提示词';

  const st = draft.scheduleType;
  if (st === 'daily') {
    const t = String(draft.dailyTime ?? '').trim();
    if (t && !tryNormalizeDailyTime(t)) {
      return '每日时刻须为 HH:mm（00:00–23:59）';
    }
    return null;
  }
  if (st === 'intervalMinutes' || st === 'interval') {
    const raw = String(draft.intervalMinutes ?? '').trim();
    if (!raw) return '请填写间隔分钟';
    if (parseIntervalMinutes(raw) == null) {
      return `间隔分钟须为 ${WORKFLOW_INTERVAL_MINUTES_MIN}–${WORKFLOW_INTERVAL_MINUTES_MAX} 的整数`;
    }
    return null;
  }
  if (st === 'cron') {
    const expr = String(draft.cronExpression ?? '').trim();
    if (!expr) return '请填写 Cron 表达式';
    const validation = validateCronExpression(expr);
    if (validation.ok === false) {
      return validation.error;
    }
    return null;
  }
  if (st === 'manual' || st === 'once') return null;
  return '不支持的调度类型';
}

export function emptyWorkflowDraft(defaultCwd?: string): WorkflowScheduleDraft {
  return {
    name: '',
    prompt: '',
    scheduleType: 'manual',
    dailyTime: DEFAULT_DAILY_TIME,
    intervalMinutes: String(DEFAULT_INTERVAL_MINUTES),
    cronExpression: '0 9 * * *',
    cwd: defaultCwd ? defaultCwd.trim() : '',
    targetSessionId: '',
    executionTarget: 'isolated_session',
    permissionMode: DEFAULT_PERMISSION_MODE,
  };
}

/**
 * 草稿 → 引擎 schedule。坏字段软回落（合法默认），不抛。
 * 严格错误请先调 validateWorkflowDraft。
 */
export function buildScheduleFromDraft(
  draft: WorkflowScheduleDraft
): WorkflowSchedule {
  if (!draft || typeof draft !== 'object') {
    return { type: 'manual' };
  }
  if (draft.scheduleType === 'daily') {
    return {
      type: 'daily',
      time: normalizeDailyTime(draft.dailyTime, DEFAULT_DAILY_TIME),
      timezone: defaultTimezone(),
    };
  }
  if (
    draft.scheduleType === 'intervalMinutes' ||
    draft.scheduleType === 'interval'
  ) {
    const n =
      parseIntervalMinutes(draft.intervalMinutes) ?? DEFAULT_INTERVAL_MINUTES;
    return { type: 'intervalMinutes', intervalMinutes: n };
  }
  if (draft.scheduleType === 'cron') {
    const expr = String(draft.cronExpression ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    return { type: 'cron', expression: expr || '0 9 * * *' };
  }
  return { type: 'manual' };
}

/** 供 draftFromWorkflow 接收的最小结构契约（与 WorkflowDefinition 兼容且零循环依赖） */
export type WorkflowDraftSource = {
  name?: string | null;
  prompt?: string | null;
  cwd?: string | null;
  targetSessionId?: string | null;
  permissionMode?: string | null;
  schedule?: WorkflowSchedule | Record<string, unknown> | null;
};

/**
 * 从服务端实体回填表单草稿（单轨纯净实现，去兼容）：
 * - intervalMinutes 单轨读取 sch.intervalMinutes（不再读取旧 sch.minutes）；
 * - cron 5 段式表达式保持 scheduleType: 'cron' 与完整 cronExpression，绝不降级为 manual 或 interval 60；
 * - 回填 targetSessionId 与 executionTarget。
 */
export function draftFromWorkflow(
  w: WorkflowDraftSource,
  currentActiveSessionId?: string
): WorkflowScheduleDraft {
  const d = emptyWorkflowDraft();
  d.name = String(w.name ?? '');
  d.prompt = String(w.prompt || '');
  d.cwd = String(w.cwd || '');
  d.permissionMode = coercePermissionMode(
    w.permissionMode ?? DEFAULT_PERMISSION_MODE
  );

  const rawTargetId = w.targetSessionId;
  const targetId = typeof rawTargetId === 'string' ? rawTargetId.trim() : '';
  if (targetId) {
    d.targetSessionId = targetId;
    d.executionTarget = 'current_session';
  } else {
    d.targetSessionId = currentActiveSessionId ?? '';
    d.executionTarget = 'isolated_session';
  }

  const s = w.schedule;
  if (s && typeof s === 'object') {
    const sch = s as {
      type?: string;
      time?: string;
      intervalMinutes?: number;
      expression?: string;
    };
    if (sch.type === 'daily') {
      d.scheduleType = 'daily';
      d.dailyTime = sch.time || '';
      if (d.dailyTime) {
        const norm = tryNormalizeDailyTime(d.dailyTime);
        if (norm) {
          const [hh, mm] = norm.split(':');
          d.cronExpression = `${Number(mm ?? 0)} ${Number(hh ?? 9)} * * *`;
        }
      }
    } else if (sch.type === 'intervalMinutes') {
      d.scheduleType = 'intervalMinutes';
      const mins = parseIntervalMinutes(sch.intervalMinutes);
      d.intervalMinutes =
        mins != null ? String(mins) : String(DEFAULT_INTERVAL_MINUTES);
      if (mins != null && mins >= 1 && mins <= 59) {
        d.cronExpression = `*/${mins} * * * *`;
      }
    } else if (sch.type === 'cron') {
      const expr = String(sch.expression ?? '')
        .trim()
        .replace(/\s+/g, ' ');
      d.scheduleType = 'cron';
      d.cronExpression = expr || '0 9 * * *';
      const parts = d.cronExpression.split(' ');
      if (parts.length === 5) {
        const [min, hour, dom, mon, dow] = parts;
        if (
          dom === '*' &&
          mon === '*' &&
          dow === '*' &&
          /^\d+$/.test(min!) &&
          /^\d+$/.test(hour!)
        ) {
          const normTime = tryNormalizeDailyTime(
            `${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`
          );
          if (normTime) d.dailyTime = normTime;
        } else if (
          dom === '*' &&
          mon === '*' &&
          dow === '*' &&
          hour === '*' &&
          /^\*\/\d+$/.test(min!)
        ) {
          const step = parseIntervalMinutes(min!.slice(2));
          if (step != null) d.intervalMinutes = String(step);
        }
      }
    } else {
      d.scheduleType = 'manual';
    }
  } else {
    d.scheduleType = 'manual';
  }
  return d;
}
