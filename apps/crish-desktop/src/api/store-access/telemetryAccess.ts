/**
 * 遥测、Diff 与统计/定时任务门面 (Telemetry & Statistics Access Facade)
 */
import type { TelemetrySyncPayload } from '../../store/layoutStore';
import type { TokenUsageState } from '../../store/layoutStore';
import type { DiffChange, FileDiff } from '../../store/types';
import type { CronJob } from '../clientApi';
import { useTerminalStore } from '../../store/terminalStore';
import { useSettingsStore } from '../../store/settingsStore';
import { logger } from '../../services/LoggerService';

export type DiffFileInfo = FileDiff;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DIFF_CHANGE_TYPES = new Set(['addition', 'deletion', 'normal']);

export function isDiffChange(value: unknown): value is DiffChange {
  if (!isPlainRecord(value)) return false;
  if (!DIFF_CHANGE_TYPES.has(String(value.type))) return false;
  if (typeof value.content !== 'string') return false;
  if (value.lineNum !== undefined && typeof value.lineNum !== 'number')
    return false;
  return true;
}

export function isFileDiff(value: unknown): value is FileDiff {
  if (!isPlainRecord(value)) return false;
  if (
    typeof value.filePath !== 'string' ||
    value.filePath.trim().length === 0
  ) {
    return false;
  }
  if (typeof value.additions !== 'number' || Number.isNaN(value.additions)) {
    return false;
  }
  if (typeof value.deletions !== 'number' || Number.isNaN(value.deletions)) {
    return false;
  }
  if (!Array.isArray(value.changes)) return false;
  for (const c of value.changes) {
    if (!isDiffChange(c)) return false;
  }
  return true;
}

export function normalizeFileDiff(value: unknown): FileDiff | null {
  if (!isFileDiff(value)) return null;
  const changes: DiffChange[] = value.changes.map((c) => {
    const out: DiffChange = {
      type: c.type,
      content: c.content,
    };
    if (typeof c.lineNum === 'number') out.lineNum = c.lineNum;
    return out;
  });
  return {
    filePath: value.filePath.trim(),
    additions: value.additions,
    deletions: value.deletions,
    changes,
  };
}

export function pushDiffFile(diff: FileDiff): void {
  const normalized = normalizeFileDiff(diff);
  if (!normalized) return;
  useTerminalStore.getState().pushDiffFile(normalized);
}

export function setActiveDiffSource(diff: FileDiff | null): void {
  if (diff === null) {
    useTerminalStore.getState().setActiveDiffSource(null);
    return;
  }
  const normalized = normalizeFileDiff(diff);
  if (!normalized) return;
  useTerminalStore.getState().setActiveDiffSource(normalized);
}

export function getDiffFiles(): FileDiff[] {
  return useTerminalStore.getState().diffFiles;
}

export function getActiveDiffSource(): FileDiff | null {
  return useTerminalStore.getState().activeDiffSource;
}

export function syncTelemetryData(data: TelemetrySyncPayload): void {
  useSettingsStore.getState().syncTelemetryData(data);
}

/**
 * tokenUsage 增量（并发合并输入）。
 * cacheRead/cacheWrite/savedCost 为 4D 可选字段：undefined = 本次不涉及。
 * 费用（plans/05 T5.4）：引擎三态增量——costStatus/currency/costMicros/formattedCost。
 */
export type TokenUsageDelta = {
  input?: number;
  output?: number;
  /** 遗留 JS 浮点（δ 后不再写入；S7 删除） */
  cost?: number;
  /** 引擎三态（unpriced 可省略 = 本次不写费用） */
  costStatus?: 'unpriced' | 'free' | 'priced';
  currency?: 'CNY' | 'USD';
  costMicros?: number;
  formattedCost?: string;
  cacheRead?: number;
  cacheWrite?: number;
  savedCost?: number;
};

/** 非负有限化（NaN/负数/Infinity → 0），与 sanitizeTokenUsage 同口径 */
function nonNegFinite(v: number | undefined): number {
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : 0;
}

/**
 * 纯函数：将 delta 累加到 cur（保留 inputMax/outputMax 与未涉及的 4D 字段）。
 * 语义与 applyUsageDelta 的「next - cur」差值一致，但直接以最新状态为基底。
 * 费用微元只对同一币种 saturating 累加；混币种 → 不累加（展示最近 formatted）。
 */
export function mergeTokenUsageDelta(
  cur: TokenUsageState,
  delta: TokenUsageDelta
): TokenUsageState {
  const next: TokenUsageState = {
    input: cur.input + nonNegFinite(delta.input),
    inputMax: cur.inputMax,
    output: cur.output + nonNegFinite(delta.output),
    outputMax: cur.outputMax,
    costStatus: delta.costStatus ?? cur.costStatus,
    currency: delta.currency ?? cur.currency,
    costMicros: cur.costMicros,
    formattedCost: delta.formattedCost ?? cur.formattedCost,
    cost: cur.cost + nonNegFinite(delta.cost),
    ...(delta.cacheRead !== undefined && {
      cacheRead: (cur.cacheRead ?? 0) + nonNegFinite(delta.cacheRead),
    }),
    ...(delta.cacheWrite !== undefined && {
      cacheWrite: (cur.cacheWrite ?? 0) + nonNegFinite(delta.cacheWrite),
    }),
    ...(delta.savedCost !== undefined && {
      savedCost: (cur.savedCost ?? 0) + nonNegFinite(delta.savedCost),
    }),
  };
  // 有价微元累计：仅同币种累加（混币种保留原累计，展示最近 formatted）
  if (delta.costStatus === 'priced' && delta.costMicros !== undefined) {
    if (cur.costStatus === 'priced' && cur.currency === delta.currency) {
      next.costMicros = (cur.costMicros ?? 0) + delta.costMicros;
    } else {
      next.costMicros = delta.costMicros;
    }
  }
  return next;
}

/**
 * tokenUsage 并发安全的增量累计入口（F5 P2 修复）。
 *
 * 根因：useStreamCallbacks 的三处完成路径（snapshot 回填 / 估算兜底 / stop
 * 兜底）各自「读 getSettingsState().tokenUsage → 计算 next → syncTelemetryData
 * 整体替换」，两个完成窗口并发（多 run 同刻收尾、stop 与 message-end 竞速）时
 * 后写者覆盖先写者 → 增量丢失。
 *
 * 修复：模块级 promise 链串行化——每个 delta 在链上以「读最新状态 → 合并 →
 * 写回」原子完成；单次合并失败只影响该 delta（记 warn），不破坏后续累计。
 *
 * D4 收敛（T-E 批次 5）：历史流水 sink（usageStore.recordUsageDelta）委托内建——
 * 调用方（useStreamCallbacks）不再并列双写；同事件双 sink 单点完成，
 * usageStore 动态 import 失败静默（历史流水缺失不影响当前值累计）。
 */
let tokenUsageChain: Promise<void> = Promise.resolve();

export function accumulateTokenUsage(
  delta: TokenUsageDelta & { model?: string | null }
): Promise<void> {
  const next = tokenUsageChain.then(async () => {
    try {
      const cur = useSettingsStore.getState().tokenUsage;
      useSettingsStore
        .getState()
        .syncTelemetryData({ tokenUsage: mergeTokenUsageDelta(cur, delta) });
    } catch (err) {
      logger.warn('[accumulateTokenUsage] tokenUsage 合并失败', {
        module: 'telemetryAccess',
        err: err instanceof Error
          ? { message: err.message, stack: err.stack, name: err.name }
          : { message: String(err) },
      });
    }
    // 历史流水双 sink（口径不同：当前值 vs 日/模型历史）；失败静默
    try {
      const { recordUsageDelta } = await import('../usageStore');
      recordUsageDelta(delta);
    } catch {
      /* ignore */
    }
  });
  tokenUsageChain = next;
  return next;
}

const CRON_TARGET = new Set(['current-session', 'new-session']);
const CRON_STATUS = new Set(['active', 'paused']);

export function isCronJob(value: unknown): value is CronJob {
  if (!isPlainRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.trim().length === 0)
    return false;
  if (typeof value.cronExpression !== 'string') return false;
  if (typeof value.prompt !== 'string') return false;
  if (!CRON_TARGET.has(String(value.targetSession))) return false;
  if (!CRON_STATUS.has(String(value.status))) return false;
  if (typeof value.nextRun !== 'string') return false;
  return true;
}

export function normalizeCronJob(value: unknown): CronJob | null {
  if (!isCronJob(value)) return null;
  return {
    id: value.id.trim(),
    cronExpression: value.cronExpression,
    prompt: value.prompt,
    targetSession: value.targetSession,
    status: value.status,
    nextRun: value.nextRun,
  };
}

export function filterCronJobs(tasks: unknown): CronJob[] {
  if (!Array.isArray(tasks)) return [];
  const out: CronJob[] = [];
  for (const t of tasks) {
    const n = normalizeCronJob(t);
    if (n) out.push(n);
  }
  return out;
}

export function setScheduledTasks(tasks: CronJob[]): void {
  const list = filterCronJobs(tasks);
  useSettingsStore.getState().setScheduledTasks(list);
}

export function getScheduledTasks(): CronJob[] {
  return useSettingsStore.getState().scheduledTasks;
}
