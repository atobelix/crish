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
  type WorkflowSchedule,
} from './workflowScheduler';

/** 引擎当前支持的调度类型（UI 下拉与说明共用） */
export const WORKFLOW_SCHEDULE_TYPES = [
  { value: 'manual' as const, label: '手动', hint: '仅手动触发，不自动运行' },
  { value: 'daily' as const, label: '每天', hint: '每日固定时刻（本机时区）' },
  {
    value: 'intervalMinutes' as const,
    label: '间隔（分钟）',
    hint: '按分钟周期轮询执行',
  },
];

export type WorkflowScheduleType =
  (typeof WORKFLOW_SCHEDULE_TYPES)[number]['value'];

/** 新建表单草稿字段（设置页 / 主区面板共用） */
export type WorkflowScheduleDraft = {
  name: string;
  prompt: string;
  scheduleType: WorkflowScheduleType;
  dailyTime: string;
  intervalMinutes: string;
  cwd?: string;
};

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
  if (st === 'intervalMinutes') {
    const raw = String(draft.intervalMinutes ?? '').trim();
    if (!raw) return '请填写间隔分钟';
    if (parseIntervalMinutes(raw) == null) {
      return `间隔分钟须为 ${WORKFLOW_INTERVAL_MINUTES_MIN}–${WORKFLOW_INTERVAL_MINUTES_MAX} 的整数`;
    }
    return null;
  }
  if (st === 'manual') return null;
  return '不支持的调度类型';
}

export function emptyWorkflowDraft(): WorkflowScheduleDraft {
  return {
    name: '',
    prompt: '',
    scheduleType: 'manual',
    dailyTime: DEFAULT_DAILY_TIME,
    intervalMinutes: String(DEFAULT_INTERVAL_MINUTES),
    cwd: '',
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
  if (draft.scheduleType === 'intervalMinutes') {
    const n =
      parseIntervalMinutes(draft.intervalMinutes) ?? DEFAULT_INTERVAL_MINUTES;
    return { type: 'intervalMinutes', intervalMinutes: n };
  }
  return { type: 'manual' };
}
