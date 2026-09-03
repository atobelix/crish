/**
 * 引擎 workflow 调度与触发配置管理
 */

/** 与 daemon WorkflowSchedule 对齐（引擎 manual / daily / intervalMinutes；
 * T-CF-14 起 cron 5 字段表达式亦可下发——前端校验通过即放行，Rust 侧
 * parse_cron 二次校验，失败返回 Rust 侧真实错误文案） */
export type WorkflowSchedule =
  | { type: 'manual' }
  | { type: 'daily'; time: string; timezone: string }
  | { type: 'intervalMinutes'; intervalMinutes: number }
  | { type: 'cron'; expression: string };

/** 默认每日时刻（与 empty draft / 引擎展示一致） */
export const DEFAULT_DAILY_TIME = '09:00';
/** 默认间隔分钟 */
export const DEFAULT_INTERVAL_MINUTES = 30;
/** 间隔下限（与 daemon intervalMinutes >= 1 对齐） */
export const WORKFLOW_INTERVAL_MINUTES_MIN = 1;
/** 间隔上限：7 天，防止 UI/草稿写成极端值 */
export const WORKFLOW_INTERVAL_MINUTES_MAX = 60 * 24 * 7;

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
  fallback: string = DEFAULT_DAILY_TIME
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
    if (
      raw < WORKFLOW_INTERVAL_MINUTES_MIN ||
      raw > WORKFLOW_INTERVAL_MINUTES_MAX
    ) {
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
    const range = stepMatch[1]!.split('-').map(Number);
    if (range.length === 1) {
      return cronPartInRange(range[0]!, min, max);
    }
    return (
      cronPartInRange(range[0]!, min, max) &&
      cronPartInRange(range[1]!, min, max) &&
      range[0]! <= range[1]!
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
      if (
        !cronPartInRange(lo, min, max) ||
        !cronPartInRange(hi, min, max) ||
        lo > hi
      ) {
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
 * 校验标准 5 字段 cron 表达式（展示/守卫用；T-CF-14 起表达式合法即可下发，
 * 本校验器保留作前端双重校验的第一道，第二道是 Rust 侧 parse_cron）。
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
    return {
      ok: false,
      error: '不支持 6 字段（含秒）cron，请用 5 字段：分 时 日 月 周',
    };
  }
  if (fields.length !== 5) {
    return {
      ok: false,
      error: `cron 须为 5 个字段（分 时 日 月 周），当前 ${fields.length} 个`,
    };
  }
  for (let i = 0; i < 5; i++) {
    const [min, max] = CRON_FIELD_BOUNDS[i]!;
    if (!isValidCronField(fields[i]!, min, max)) {
      const names = ['分钟', '小时', '日', '月', '周'];
      return {
        ok: false,
        error: `cron ${names[i]}字段无效：${fields[i]!}（范围 ${min}–${max}）`,
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

export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

/**
 * 守卫坏调度：放行引擎支持的 manual / daily / intervalMinutes / cron。
 * cron 表达式合法即放行（原样下发；Rust 侧 parse_cron 二次校验，失败
 * 返回 Rust 侧真实错误文案——前端校验器保留作双重校验的第一道）。
 */
export function validateWorkflowSchedule(
  raw: unknown
): ScheduleValidationResult {
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
      typeof tzRaw === 'string' && tzRaw.trim()
        ? tzRaw.trim()
        : defaultTimezone();
    if (!isValidIanaTimezone(timezone)) {
      return {
        ok: false,
        error: '时区无效，请使用 IANA 名称（如 Asia/Shanghai）',
      };
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
    return {
      ok: true,
      schedule: { type: 'intervalMinutes', intervalMinutes: n },
    };
  }

  if (t === 'cron') {
    const expr = o.expression ?? o.cron ?? o.cronExpression ?? o.expr ?? '';
    const cv = validateCronExpression(expr);
    if (cv.ok === false) {
      return { ok: false, error: cv.error };
    }
    // 表达式合法即可下发（T-CF-14 解除拒绝；Rust 侧 parse_cron 兜底）
    return { ok: true, schedule: { type: 'cron', expression: cv.expression } };
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
 * 调度中文标签。坏字段守卫：无效时刻/间隔不展示脏值；cron 走可读标签。
 */
export function scheduleLabel(
  schedule?: WorkflowSchedule | Record<string, unknown>
): string {
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
      parseIntervalMinutes(o.intervalMinutes) ??
      parseIntervalMinutes(o.minutes);
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

/**
 * 规范化工作区路径（纯函数）
 */
export function normalizeWorkspacePath(p?: string | null): string {
  if (!p) return '';
  let s = p.trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) {
    s = s.replace(/\/+$/, '');
  }
  return s;
}

/**
 * 跨平台物理工作区路径等价性比对：
 * 1. 统一正斜杠与去末尾斜杠；
 * 2. 针对 Windows 盘符（如 c:/ vs C:/）不敏感比对。
 */
export function areWorkspacePathsEqual(
  a?: string | null,
  b?: string | null
): boolean {
  const normA = normalizeWorkspacePath(a);
  const normB = normalizeWorkspacePath(b);
  if (!normA || !normB) return false;
  if (/^[a-zA-Z]:\//.test(normA) || /^[a-zA-Z]:\//.test(normB)) {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return normA === normB;
}

/**
 * 按物理工作区路径过滤定时任务：
 * 严格只保留属于指定 workspacePath 的任务；若 workspacePath 为空或未指定，返回空列表。
 */
export function filterWorkflowsByWorkspace<T extends { cwd?: string | null }>(
  workflows: readonly T[] | undefined | null,
  workspacePath?: string | null
): T[] {
  if (!workflows || !Array.isArray(workflows) || !workspacePath?.trim()) {
    return [];
  }
  return workflows.filter((w) => areWorkspacePathsEqual(w.cwd, workspacePath));
}
