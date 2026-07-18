/**
 * 引擎 workflow 调度 API（正式版 H3）
 */

import { getDesktopDaemonClient } from './daemonClient';
import { logInternalError } from './userFacingErrors';
import { getWorkspacePath } from './projectStore';

/** 与 daemon WorkflowSchedule 对齐（引擎仅 manual / daily / intervalMinutes） */
export type WorkflowSchedule =
  | { type: 'manual' }
  | { type: 'daily'; time: string; timezone: string }
  | { type: 'intervalMinutes'; intervalMinutes: number };

/** 引擎当前支持的调度类型（UI 下拉与说明共用） */
export const WORKFLOW_SCHEDULE_TYPES = [
  { value: 'manual' as const, label: '手动', hint: '仅手动触发，不自动运行' },
  { value: 'daily' as const, label: '每天', hint: '每日固定时刻（本机时区）' },
  { value: 'intervalMinutes' as const, label: '间隔（分钟）', hint: '按分钟周期轮询执行' },
];

export type WorkflowScheduleType = (typeof WORKFLOW_SCHEDULE_TYPES)[number]['value'];

/** 新建表单草稿字段（设置页 / 主区面板共用） */
export type WorkflowScheduleDraft = {
  name: string;
  prompt: string;
  scheduleType: WorkflowScheduleType;
  dailyTime: string;
  intervalMinutes: string;
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

/** 调度能力说明（无文件监听等 OS 级触发） */
export const WORKFLOW_SCHEDULE_CAPABILITY_NOTE =
  '当前引擎调度类型：手动、每天、间隔分钟。文件变更（fileWatch）/ Git 推送等触发需引擎侧支持，客户端不会独立监听磁盘或远程仓库；可用「间隔分钟」软轮询近似。';

/**
 * 规划中的调度类型（仅文案说明，不下发引擎、不进表单下拉）。
 * 硬文件监听不在客户端实现。
 */
export const WORKFLOW_SCHEDULE_PLANNED_TYPES = [
  {
    value: 'fileWatch' as const,
    label: '文件变更（规划中）',
    hint: '需引擎 file watcher；当前请用间隔分钟软轮询代替',
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

/** 默认每日时刻（与 empty draft / 引擎展示一致） */
export const DEFAULT_DAILY_TIME = '09:00';
/** 默认间隔分钟 */
export const DEFAULT_INTERVAL_MINUTES = 30;
/** 间隔下限（与 daemon intervalMinutes >= 1 对齐） */
export const WORKFLOW_INTERVAL_MINUTES_MIN = 1;
/** 间隔上限：7 天，防止 UI/草稿写成极端值 */
export const WORKFLOW_INTERVAL_MINUTES_MAX = 60 * 24 * 7;

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
  kind: WorkflowJobsEmptyKind = 'list',
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
 * 每日时刻 HH:mm（00:00–23:59），与 daemon isDailyTime 契约对齐。
 */
export function isValidDailyTime(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

/**
 * 尝试将输入收成 HH:mm；无法规范化时返回 null（不悄悄改成 09:00）。
 */
export function tryNormalizeDailyTime(value: unknown): string | null {
  const t = String(value ?? '').trim();
  if (!t) return null;
  if (isValidDailyTime(t)) return t;
  const m = t.match(/^(\d{1,2}):([0-5]\d)$/);
  if (m) {
    const h = Number(m[1]);
    if (Number.isInteger(h) && h >= 0 && h <= 23) {
      return `${String(h).padStart(2, '0')}:${m[2]}`;
    }
  }
  return null;
}

/**
 * 规范化每日时刻：合法则 trim；容忍 `9:00` → `09:00`；否则 fallback。
 */
export function normalizeDailyTime(
  value: unknown,
  fallback: string = DEFAULT_DAILY_TIME,
): string {
  const normalized = tryNormalizeDailyTime(value);
  if (normalized) return normalized;
  const fb = String(fallback ?? '').trim();
  return isValidDailyTime(fb) ? fb : DEFAULT_DAILY_TIME;
}

/** IANA 时区是否可用（非法则 Intl 抛错） */
export function isValidIanaTimezone(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const tz = value.trim();
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析间隔分钟：须为 [MIN, MAX] 整数。
 * 拒绝 NaN / 浮点 / 负数 / 超大 / 空串 / 含单位杂讯。
 */
export function parseIntervalMinutes(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) return null;
    if (raw < WORKFLOW_INTERVAL_MINUTES_MIN || raw > WORKFLOW_INTERVAL_MINUTES_MAX) {
      return null;
    }
    return raw;
  }
  const s = String(raw ?? '').trim();
  if (!s || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (
    !Number.isInteger(n) ||
    n < WORKFLOW_INTERVAL_MINUTES_MIN ||
    n > WORKFLOW_INTERVAL_MINUTES_MAX
  ) {
    return null;
  }
  return n;
}

/** 5 字段标准 cron：分 时 日 月 周（不支持秒字段 / 命名月） */
const CRON_FIELD_BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 与 7 = 周日)
];

function cronPartInRange(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

/** 校验单个 cron 字段（*, n, a-b, lists, star/step, range/step） */
function isValidCronField(field: string, min: number, max: number): boolean {
  const f = field.trim();
  if (!f) return false;
  if (f === '*') return true;
  // */n 或 a-b/n
  const stepMatch = f.match(/^(\*|\d{1,2}(?:-\d{1,2})?)\/(\d{1,2})$/);
  if (stepMatch) {
    const step = Number(stepMatch[2]);
    if (!Number.isInteger(step) || step < 1) return false;
    if (stepMatch[1] === '*') return step <= max;
    const range = stepMatch[1].split('-').map(Number);
    if (range.length === 1) {
      return cronPartInRange(range[0], min, max);
    }
    return (
      cronPartInRange(range[0], min, max) &&
      cronPartInRange(range[1], min, max) &&
      range[0] <= range[1]
    );
  }
  // list a,b,c 或 single / range
  const parts = f.split(',');
  if (parts.length === 0) return false;
  for (const part of parts) {
    const p = part.trim();
    if (!p) return false;
    if (p.includes('-')) {
      const [a, b, ...rest] = p.split('-');
      if (rest.length > 0 || a === undefined || b === undefined) return false;
      if (!/^\d{1,2}$/.test(a) || !/^\d{1,2}$/.test(b)) return false;
      const lo = Number(a);
      const hi = Number(b);
      if (!cronPartInRange(lo, min, max) || !cronPartInRange(hi, min, max) || lo > hi) {
        return false;
      }
    } else {
      if (!/^\d{1,2}$/.test(p)) return false;
      if (!cronPartInRange(Number(p), min, max)) return false;
    }
  }
  return true;
}

export type CronValidationResult =
  | { ok: true; expression: string }
  | { ok: false; error: string };

/**
 * 校验标准 5 字段 cron 表达式（展示/守卫用；引擎当前不下发 cron）。
 * 拒绝空串、秒级 6 字段、命名月/周、以及越界字段。
 */
export function validateCronExpression(expr: unknown): CronValidationResult {
  if (expr == null) {
    return { ok: false, error: 'cron 表达式不能为空' };
  }
  const raw = String(expr).trim().replace(/\s+/g, ' ');
  if (!raw) {
    return { ok: false, error: 'cron 表达式不能为空' };
  }
  // 拒绝 @yearly 等宏（引擎/本客户端均未支持）
  if (raw.startsWith('@')) {
    return { ok: false, error: '不支持 @yearly 等 cron 宏，请用 5 字段表达式' };
  }
  const fields = raw.split(' ');
  if (fields.length === 6) {
    return { ok: false, error: '不支持 6 字段（含秒）cron，请用 5 字段：分 时 日 月 周' };
  }
  if (fields.length !== 5) {
    return {
      ok: false,
      error: `cron 须为 5 个字段（分 时 日 月 周），当前 ${fields.length} 个`,
    };
  }
  for (let i = 0; i < 5; i++) {
    const [min, max] = CRON_FIELD_BOUNDS[i];
    if (!isValidCronField(fields[i], min, max)) {
      const names = ['分钟', '小时', '日', '月', '周'];
      return {
        ok: false,
        error: `cron ${names[i]}字段无效：${fields[i]}（范围 ${min}–${max}）`,
      };
    }
  }
  return { ok: true, expression: raw };
}

export function isValidCronExpression(expr: unknown): boolean {
  return validateCronExpression(expr).ok;
}

/**
 * cron 中文/可读标签：合法则回显表达式，常见模式给短标签；非法 →「无效 cron」。
 */
export function cronExpressionLabel(expr: unknown): string {
  const v = validateCronExpression(expr);
  if (v.ok === false) return '无效 cron';
  const e = v.expression;
  // 常见模式短标签（仍保留表达式后缀便于核对）
  if (e === '0 * * * *') return '每小时 · 0 * * * *';
  if (e === '0 0 * * *') return '每天 0 点 · 0 0 * * *';
  if (e === '0 9 * * *') return '每天 9 点 · 0 9 * * *';
  if (e === '*/5 * * * *') return '每 5 分钟 · */5 * * * *';
  if (e === '*/15 * * * *') return '每 15 分钟 · */15 * * * *';
  if (e === '*/30 * * * *') return '每 30 分钟 · */30 * * * *';
  if (e === '0 0 * * 0' || e === '0 0 * * 7') return '每周日 0 点 · ' + e;
  return e;
}

export type ScheduleValidationResult =
  | { ok: true; schedule: WorkflowSchedule }
  | { ok: false; error: string };

/**
 * 守卫坏调度：仅放行引擎支持的 manual / daily / intervalMinutes。
 * cron 即使表达式合法也拒绝下发（引擎未支持），返回中文错误。
 */
export function validateWorkflowSchedule(raw: unknown): ScheduleValidationResult {
  if (raw == null) {
    return { ok: true, schedule: { type: 'manual' } };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '调度配置无效' };
  }
  const o = raw as Record<string, unknown>;
  const t = String(o.type ?? 'manual').trim() || 'manual';

  if (t === 'manual') {
    return { ok: true, schedule: { type: 'manual' } };
  }

  if (t === 'daily') {
    const timeRaw = o.time;
    let time = DEFAULT_DAILY_TIME;
    if (timeRaw != null && String(timeRaw).trim() !== '') {
      const norm = tryNormalizeDailyTime(timeRaw);
      if (!norm) {
        return { ok: false, error: '每日时刻须为 HH:mm（00:00–23:59）' };
      }
      time = norm;
    }
    const tzRaw = o.timezone;
    const timezone =
      typeof tzRaw === 'string' && tzRaw.trim() ? tzRaw.trim() : defaultTimezone();
    if (!isValidIanaTimezone(timezone)) {
      return { ok: false, error: '时区无效，请使用 IANA 名称（如 Asia/Shanghai）' };
    }
    return { ok: true, schedule: { type: 'daily', time, timezone } };
  }

  if (t === 'intervalMinutes') {
    const n =
      parseIntervalMinutes(o.intervalMinutes) ??
      parseIntervalMinutes(o.minutes);
    if (n == null) {
      return {
        ok: false,
        error: `间隔分钟须为 ${WORKFLOW_INTERVAL_MINUTES_MIN}–${WORKFLOW_INTERVAL_MINUTES_MAX} 的整数`,
      };
    }
    return { ok: true, schedule: { type: 'intervalMinutes', intervalMinutes: n } };
  }

  if (t === 'cron') {
    const expr =
      o.expression ?? o.cron ?? o.cronExpression ?? o.expr ?? '';
    const cv = validateCronExpression(expr);
    if (cv.ok === false) {
      return { ok: false, error: cv.error };
    }
    // 表达式合法但引擎不下发
    return {
      ok: false,
      error: '引擎暂不支持 cron 调度，请改用「每天」或「间隔分钟」',
    };
  }

  if (t === 'weekly' || t === 'fileWatch' || t === 'onFileChange') {
    return {
      ok: false,
      error: `引擎暂不支持「${t}」调度，请改用「每天」或「间隔分钟」`,
    };
  }

  return { ok: false, error: `不支持的调度类型：${t}` };
}

/**
 * 将任意 schedule 收成引擎可接受形态；坏输入 → manual（不抛）。
 * 列表展示兜底用；创建前请先 validateWorkflowSchedule。
 */
export function normalizeWorkflowSchedule(raw: unknown): WorkflowSchedule {
  const v = validateWorkflowSchedule(raw);
  if (v.ok) return v.schedule;
  return { type: 'manual' };
}

/**
 * 新建草稿校验：名称/提示词必填 + 调度字段守卫。
 * 返回中文错误；通过则 null。
 */
export function validateWorkflowDraft(
  draft: WorkflowScheduleDraft | null | undefined,
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
  };
}

/**
 * 草稿 → 引擎 schedule。坏字段软回落（合法默认），不抛。
 * 严格错误请先调 validateWorkflowDraft。
 */
export function buildScheduleFromDraft(draft: WorkflowScheduleDraft): WorkflowSchedule {
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

export type WorkflowDefinition = {
  id: string;
  name: string;
  prompt: string;
  cwd?: string;
  mode?: string;
  enabled?: boolean;
  schedule?: WorkflowSchedule;
  createdAt?: string;
  updatedAt?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  [key: string]: unknown;
};

async function ensureClient() {
  const client = getDesktopDaemonClient();
  if (!client.isConnected()) {
    const ok = await client.waitUntilConnected(500);
    if (!ok) return null;
  }
  return client;
}

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  const client = await ensureClient();
  if (!client) return [];
  try {
    const res = (await client.request(
      { type: 'list-workflows' },
      'workflows-listed',
      10_000,
    )) as Record<string, unknown>;
    const list = res.workflows;
    if (!Array.isArray(list)) return [];
    return list
      .map((w) => {
        const o = w as WorkflowDefinition;
        if (!o || typeof o !== 'object' || typeof o.id !== 'string') return null;
        return {
          ...o,
          id: o.id,
          name: typeof o.name === 'string' ? o.name : o.id,
          prompt: typeof o.prompt === 'string' ? o.prompt : '',
        };
      })
      .filter(Boolean) as WorkflowDefinition[];
  } catch (e) {
    logInternalError('listWorkflows', e);
    return [];
  }
}

/**
 * 调度中文标签。坏字段守卫：无效时刻/间隔不展示脏值；cron 走可读标签。
 */
export function scheduleLabel(schedule?: WorkflowSchedule | Record<string, unknown>): string {
  if (!schedule || typeof schedule !== 'object') return '手动';
  const o = schedule as Record<string, unknown>;
  const t = String(o.type || 'manual');
  if (t === 'daily') {
    const rawTime = o.time;
    // 仅展示可规范化时刻；脏值用 —，绝不静默换成 09:00
    const displayTime =
      rawTime != null && String(rawTime).trim() !== ''
        ? tryNormalizeDailyTime(rawTime) || '—'
        : '—';
    const tz = typeof o.timezone === 'string' ? o.timezone.trim() : '';
    if (tz && isValidIanaTimezone(tz)) {
      return `每天 ${displayTime} (${tz})`;
    }
    return `每天 ${displayTime}`;
  }
  if (t === 'intervalMinutes') {
    const m =
      parseIntervalMinutes(o.intervalMinutes) ?? parseIntervalMinutes(o.minutes);
    return m != null ? `每 ${m} 分钟` : '间隔';
  }
  if (t === 'manual') return '手动';
  if (t === 'cron') {
    const expr = o.expression ?? o.cron ?? o.cronExpression ?? o.expr;
    if (expr != null && String(expr).trim()) {
      const label = cronExpressionLabel(expr);
      return label === '无效 cron' ? '高级 · cron（无效）' : `cron · ${label}`;
    }
    return '高级 · cron';
  }
  // 未知类型（未来引擎扩展）：原样展示，避免静默吞掉
  if (t === 'weekly' || t === 'fileWatch' || t === 'onFileChange') {
    return `高级 · ${t}`;
  }
  return t || '手动';
}

export async function createWorkflow(input: {
  name: string;
  prompt: string;
  schedule?: WorkflowSchedule;
  cwd?: string;
  enabled?: boolean;
}): Promise<{ ok: boolean; workflow?: WorkflowDefinition; error?: string }> {
  const client = await ensureClient();
  if (!client) return { ok: false, error: 'not_connected' };
  try {
    const schedule: WorkflowSchedule = input.schedule || { type: 'manual' };
    const res = (await client.request(
      {
        type: 'create-workflow',
        name: input.name.trim(),
        prompt: input.prompt.trim(),
        schedule,
        cwd: input.cwd || getWorkspacePath() || undefined,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
      'workflow-created',
      12_000,
    )) as Record<string, unknown>;
    return { ok: true, workflow: res.workflow as WorkflowDefinition };
  } catch (e) {
    logInternalError('createWorkflow', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function updateWorkflow(
  workflowId: string,
  patch: {
    name?: string;
    prompt?: string;
    schedule?: WorkflowSchedule;
    enabled?: boolean;
    cwd?: string;
  },
): Promise<{ ok: boolean; workflow?: WorkflowDefinition; error?: string }> {
  const client = await ensureClient();
  if (!client) return { ok: false, error: 'not_connected' };
  try {
    const res = (await client.request(
      {
        type: 'update-workflow',
        workflowId,
        ...patch,
      },
      'workflow-updated',
      12_000,
    )) as Record<string, unknown>;
    return { ok: true, workflow: res.workflow as WorkflowDefinition };
  } catch (e) {
    logInternalError('updateWorkflow', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteWorkflow(
  workflowId: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = await ensureClient();
  if (!client) return { ok: false, error: 'not_connected' };
  try {
    await client.request(
      { type: 'delete-workflow', workflowId },
      'workflow-deleted',
      10_000,
    );
    return { ok: true };
  } catch (e) {
    logInternalError('deleteWorkflow', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function triggerWorkflow(
  workflowId: string,
): Promise<{ ok: boolean; error?: string; runId?: string; sessionId?: string }> {
  const client = await ensureClient();
  if (!client) return { ok: false, error: 'not_connected' };
  try {
    const res = (await client.request(
      { type: 'trigger-workflow', workflowId },
      'workflow-triggered',
      15_000,
    )) as Record<string, unknown>;
    const accepted = (res as { accepted?: Record<string, unknown> }).accepted;
    const run =
      (res as { run?: Record<string, unknown> }).run ||
      (accepted && typeof accepted === 'object' ? (accepted as { run?: Record<string, unknown> }).run : undefined);
    const runId =
      typeof res.runId === 'string'
        ? res.runId
        : typeof accepted?.runId === 'string'
          ? (accepted.runId as string)
          : typeof run?.runId === 'string'
            ? (run.runId as string)
            : undefined;
    const sessionId =
      typeof run?.sessionId === 'string'
        ? (run.sessionId as string)
        : typeof accepted?.sessionId === 'string'
          ? (accepted.sessionId as string)
          : undefined;
    return { ok: true, runId, sessionId };
  } catch (e) {
    logInternalError('triggerWorkflow', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 引擎 workflow 运行历史 */
export type WorkflowRunEntry = {
  workflowId: string;
  runId: string;
  sessionId?: string;
  scheduledFor?: string;
  startedAt?: string;
  status?: string;
  error?: string;
};

export async function listWorkflowRuns(
  workflowId?: string,
): Promise<WorkflowRunEntry[]> {
  const client = await ensureClient();
  if (!client) return [];
  try {
    const res = (await client.request(
      {
        type: 'list-workflow-runs',
        ...(workflowId ? { workflowId } : {}),
      },
      'workflow-runs-listed',
      10_000,
    )) as Record<string, unknown>;
    const list = res.runs;
    if (!Array.isArray(list)) return [];
    return list
      .map((r) => {
        if (!r || typeof r !== 'object') return null;
        const o = r as Record<string, unknown>;
        const id = typeof o.runId === 'string' ? o.runId : typeof o.id === 'string' ? o.id : '';
        const wf =
          typeof o.workflowId === 'string' ? o.workflowId : workflowId || '';
        if (!id) return null;
        return {
          workflowId: wf,
          runId: id,
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : undefined,
          scheduledFor: typeof o.scheduledFor === 'string' ? o.scheduledFor : undefined,
          startedAt: typeof o.startedAt === 'string' ? o.startedAt : undefined,
          status: typeof o.status === 'string' ? o.status : undefined,
          error: typeof o.error === 'string' ? o.error : undefined,
        } satisfies WorkflowRunEntry;
      })
      .filter(Boolean) as WorkflowRunEntry[];
  } catch (e) {
    logInternalError('listWorkflowRuns', e);
    return [];
  }
}

export function workflowRunStatusLabel(status?: string): string {
  const s = (status || '').toLowerCase().trim();
  if (s === 'running' || s === 'accepted' || s === 'pending' || s === 'in_progress') {
    return '运行中';
  }
  if (s === 'awaiting-approval' || s === 'awaiting_approval' || s === 'awaitingapproval') {
    return '待审批';
  }
  if (s === 'completed' || s === 'success' || s === 'succeeded' || s === 'ok') {
    return '已完成';
  }
  if (s === 'failed' || s === 'error' || s === 'errored') return '失败';
  if (s === 'cancelled' || s === 'canceled') return '已取消';
  return status || '未知';
}

/**
 * 定时运行关联会话的侧栏标题前缀（与 sessionTitle.isScheduledSessionTitle 对齐）。
 * 必须是非默认标题，避免 findReusableEmptyShell / 剪枝把占位当成「新会话」空壳。
 */
export const SCHEDULED_SESSION_TITLE_PREFIX = '定时 ·';

/** 侧栏标题最大长度（与 renameSession 截断一致） */
const SCHEDULED_SESSION_TITLE_MAX = 48;

/**
 * 定时运行关联会话的侧栏标题。
 * 用真实标题（非「新会话」），避免被空壳复用/剪枝逻辑污染「新建对话」。
 * - 剥离已有「定时 ·」前缀，避免叠成「定时 · 定时 · x」
 * - 空名回落「定时 · 任务」
 */
export function scheduledSessionTitle(workflowName?: string | null): string {
  let n = String(workflowName || '').trim();
  // 去掉一层或多层系统前缀（含紧凑「定时·」）
  while (n.startsWith('定时 ·') || n.startsWith('定时·')) {
    n = n.replace(/^定时\s*·\s*/, '').trim();
  }
  const base = n || '任务';
  const out = `${SCHEDULED_SESSION_TITLE_PREFIX} ${base}`;
  return out.length > SCHEDULED_SESSION_TITLE_MAX
    ? `${out.slice(0, SCHEDULED_SESSION_TITLE_MAX - 1)}…`
    : out;
}

/**
 * 是否可用系统「定时 ·」标题覆盖当前侧栏标题。
 * - 默认/空壳标题：可覆盖
 * - 已是系统定时前缀：可刷新（工作流改名）
 * - 用户手动改名：不可覆盖（避免污染用户会话标题）
 *
 * 注意：此函数不依赖 sessionTitle 模块，避免循环引用；判定规则与 isDefault/isScheduled 对齐。
 */
export function canReplaceSessionTitleWithScheduled(
  currentTitle?: string | null,
): boolean {
  const t = String(currentTitle ?? '').trim();
  if (!t) return true;
  if (t.startsWith('定时 ·') || t.startsWith('定时·')) return true;
  // 与 isDefaultSessionTitle 常见占位对齐（勿引入 sessionTitle 依赖）
  if (
    t === '会话' ||
    t === '新会话' ||
    t === '新对话' ||
    t === '无标题' ||
    t.startsWith('新会话') ||
    t.startsWith('新对话')
  ) {
    return true;
  }
  const lower = t.toLowerCase();
  if (
    lower === 'new session' ||
    lower === 'new chat' ||
    lower === 'new conversation' ||
    lower === 'untitled' ||
    lower === 'untitled session' ||
    lower === 'untitled chat' ||
    lower === 'session' ||
    lower === 'chat' ||
    lower === 'conversation' ||
    lower === 'no title'
  ) {
    return true;
  }
  return false;
}

/** 触发成功的行内文案（禁止 toast；UI 状态即反馈） */
export function workflowTriggerOkMessage(runId?: string | null): string {
  const id = String(runId || '').trim();
  return id ? `已触发 · ${id.slice(0, 8)}` : '已触发';
}

/** 触发/创建失败的人话文案（供 toast / 行内错误共用） */
export function workflowActionErrorMessage(
  error: string | undefined,
  fallback: string,
  networkMsg: () => string,
): string {
  if (error === 'not_connected') return networkMsg();
  const t = String(error || '').trim();
  return t || fallback;
}

export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}
