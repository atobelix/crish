/**
 * 遥测、Diff 与统计/定时任务门面 (Telemetry & Statistics Access Facade)
 */
import type { TelemetrySyncPayload } from '../../store/layoutStore';
import type { DiffChange, FileDiff } from '../../store/types';
import type { CronJob } from '../clientApi';
import { getLayoutState } from './storeAccessCore';

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
  getLayoutState().pushDiffFile(normalized);
}

export function setActiveDiffSource(diff: FileDiff | null): void {
  if (diff === null) {
    getLayoutState().setActiveDiffSource(null);
    return;
  }
  const normalized = normalizeFileDiff(diff);
  if (!normalized) return;
  getLayoutState().setActiveDiffSource(normalized);
}

export function getDiffFiles(): FileDiff[] {
  return getLayoutState().diffFiles;
}

export function getActiveDiffSource(): FileDiff | null {
  return getLayoutState().activeDiffSource;
}

export function syncTelemetryData(data: TelemetrySyncPayload): void {
  getLayoutState().syncTelemetryData(data);
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
  getLayoutState().setScheduledTasks(list);
}

export function getScheduledTasks(): CronJob[] {
  return getLayoutState().scheduledTasks;
}
