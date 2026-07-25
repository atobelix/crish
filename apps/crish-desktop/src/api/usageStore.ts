/**
 * 用量历史：本机累计 token / 费用（按日 + 按模型），供设置「用量」页可视化。
 * 数据来源：对话流 telemetry 同步写入；不伪造演示数据。
 *
 * v2 新增 4D 字段：cacheRead / cacheWrite / savedCost（全部向下兼容：
 * 老数据加载时缺失字段归零）。
 */

export type UsageDayBucket = {
  /** YYYY-MM-DD 本地日 */
  day: string;
  input: number;
  output: number;
  cost: number;
  cacheRead: number;
  cacheWrite: number;
  savedCost: number;
};

export type UsageModelBucket = {
  model: string;
  input: number;
  output: number;
  cost: number;
  cacheRead: number;
  cacheWrite: number;
  savedCost: number;
};

export type UsageSnapshot = {
  days: UsageDayBucket[];
  models: UsageModelBucket[];
  /** 全量累计 */
  totalInput: number;
  totalOutput: number;
  totalCost: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalSavedCost: number;
  updatedAt: number;
};

const STORAGE_KEY = 'crish_usage_history_v1';
const MAX_DAYS = 30;
const MAX_MODELS = 40;

function emptySnapshot(): UsageSnapshot {
  return {
    days: [],
    models: [],
    totalInput: 0,
    totalOutput: 0,
    totalCost: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalSavedCost: 0,
    updatedAt: 0,
  };
}

function localDayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function finite(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function loadUsageSnapshot(): UsageSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptySnapshot();
    const o = JSON.parse(raw) as Partial<UsageSnapshot>;
    if (!o || typeof o !== 'object') return emptySnapshot();
    return {
      days: Array.isArray(o.days)
        ? o.days
            .filter((x) => x && typeof x.day === 'string')
            .map((x) => ({
              day: x.day,
              input: finite(x.input),
              output: finite(x.output),
              cost: finite(x.cost),
              cacheRead: finite(x.cacheRead),
              cacheWrite: finite(x.cacheWrite),
              savedCost: finite(x.savedCost),
            }))
        : [],
      models: Array.isArray(o.models)
        ? o.models
            .filter((x) => x && typeof x.model === 'string')
            .map((x) => ({
              model: x.model,
              input: finite(x.input),
              output: finite(x.output),
              cost: finite(x.cost),
              cacheRead: finite(x.cacheRead),
              cacheWrite: finite(x.cacheWrite),
              savedCost: finite(x.savedCost),
            }))
        : [],
      totalInput: finite(o.totalInput),
      totalOutput: finite(o.totalOutput),
      totalCost: finite(o.totalCost),
      totalCacheRead: finite(o.totalCacheRead),
      totalCacheWrite: finite(o.totalCacheWrite),
      totalSavedCost: finite(o.totalSavedCost),
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    };
  } catch {
    return emptySnapshot();
  }
}

function saveUsageSnapshot(s: UsageSnapshot): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/**
 * 累加一次用量增量（会话 telemetry 相对上一拍的 diff 由调用方计算）。
 * model 空则记入「未知」。
 */
export function recordUsageDelta(opts: {
  input?: number;
  output?: number;
  cost?: number;
  cacheRead?: number;
  cacheWrite?: number;
  savedCost?: number;
  model?: string | null;
}): UsageSnapshot {
  const input = finite(opts.input);
  const output = finite(opts.output);
  const cost = finite(opts.cost);
  const cacheRead = finite(opts.cacheRead);
  const cacheWrite = finite(opts.cacheWrite);
  const savedCost = finite(opts.savedCost);

  if (input <= 0 && output <= 0 && cost <= 0 && cacheRead <= 0 && cacheWrite <= 0 && savedCost <= 0) {
    return loadUsageSnapshot();
  }
  const snap = loadUsageSnapshot();
  const day = localDayKey();
  const model = (opts.model || '').trim() || '未知';

  const dayRow = snap.days.find((d) => d.day === day);
  if (dayRow) {
    dayRow.input += input;
    dayRow.output += output;
    dayRow.cost += cost;
    dayRow.cacheRead += cacheRead;
    dayRow.cacheWrite += cacheWrite;
    dayRow.savedCost += savedCost;
  } else {
    snap.days.push({ day, input, output, cost, cacheRead, cacheWrite, savedCost });
  }
  snap.days.sort((a, b) => a.day.localeCompare(b.day));
  if (snap.days.length > MAX_DAYS) {
    snap.days = snap.days.slice(-MAX_DAYS);
  }

  const modelRow = snap.models.find((m) => m.model === model);
  if (modelRow) {
    modelRow.input += input;
    modelRow.output += output;
    modelRow.cost += cost;
    modelRow.cacheRead += cacheRead;
    modelRow.cacheWrite += cacheWrite;
    modelRow.savedCost += savedCost;
  } else {
    snap.models.push({ model, input, output, cost, cacheRead, cacheWrite, savedCost });
  }
  snap.models.sort((a, b) => b.input + b.output - (a.input + a.output));
  if (snap.models.length > MAX_MODELS) {
    snap.models = snap.models.slice(0, MAX_MODELS);
  }

  snap.totalInput += input;
  snap.totalOutput += output;
  snap.totalCost += cost;
  snap.totalCacheRead += cacheRead;
  snap.totalCacheWrite += cacheWrite;
  snap.totalSavedCost += savedCost;
  snap.updatedAt = Date.now();
  saveUsageSnapshot(snap);
  return snap;
}

/** 清空历史（设置页「重置」） */
export function clearUsageHistory(): UsageSnapshot {
  const empty = emptySnapshot();
  saveUsageSnapshot(empty);
  return empty;
}

/** 最近 N 天（含今日空日补 0，便于柱状图） */
export function usageDaysForChart(days: number, snap?: UsageSnapshot): UsageDayBucket[] {
  const s = snap || loadUsageSnapshot();
  const map = new Map(s.days.map((d) => [d.day, d]));
  const out: UsageDayBucket[] = [];
  const n = Math.max(1, Math.min(30, Math.floor(days) || 7));
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = localDayKey(d);
    const hit = map.get(key);
    out.push(
      hit || {
        day: key,
        input: 0,
        output: 0,
        cost: 0,
        cacheRead: 0,
        cacheWrite: 0,
        savedCost: 0,
      },
    );
  }
  return out;
}
