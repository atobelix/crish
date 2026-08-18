/**
 * 后台任务单任务解析纯函数（从 backgroundTaskParser 拆分）。
 * 含 id / state / startedAt 解析与单对象 → BackgroundTaskInfo 解析。
 */

import {
  type BackgroundTaskInfo,
  type BackgroundTaskResourceSample,
} from './backgroundTaskTypes';
import { normalizeBackgroundTaskId, normalizeBackgroundTaskState } from './backgroundTaskState';

// ── 内部工具 ──────────────────────────────────────────────────────────

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** 折叠空白并 trim；空串 → '' */
function coerceText(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.trim();
}

export { coerceText };

// ── 纯：时间 ─────────────────────────────────────────────────────────

/**
 * 解析 startedAt / started_at：有限 number 或可 Date.parse 的 string。
 * 无效 → undefined。
 */
export function parseBackgroundTaskStartedAt(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return undefined;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

// ── 纯：单任务解析 ───────────────────────────────────────────────────

/**
 * 将 sidecar / daemon 原始对象解析为 BackgroundTaskInfo。
 * 缺 id → null；其余字段尽量容错。
 */
export function parseBackgroundTask(raw: unknown): BackgroundTaskInfo | null {
  const o = asRec(raw);
  if (!o) return null;

  const id = normalizeBackgroundTaskId(o.id ?? o.taskId ?? o.task_id);
  if (!id) return null;

  const state = normalizeBackgroundTaskState(o.state ?? o.status);

  const commandRaw =
    (typeof o.command === 'string' && o.command) ||
    (typeof o.cmd === 'string' && o.cmd) ||
    '';
  const command = commandRaw.trim() || undefined;

  const labelRaw =
    (typeof o.label === 'string' && o.label.trim()) ||
    (typeof o.name === 'string' && o.name.trim()) ||
    (typeof o.title === 'string' && o.title.trim()) ||
    '';
  const label = labelRaw || (command ? command.slice(0, 64) : id);

  const startedAt =
    parseBackgroundTaskStartedAt(o.startedAt) ??
    parseBackgroundTaskStartedAt(o.started_at);

  const summary =
    typeof o.summary === 'string' && o.summary.trim()
      ? o.summary.trim()
      : typeof o.outputPreview === 'string' && o.outputPreview.trim()
        ? o.outputPreview.trim()
        : typeof o.detail === 'string' && o.detail.trim()
          ? o.detail.trim()
          : undefined;

  // ── T-AB-20 增强字段：全部可选，缺失容忍 ─────────────────────────
  // 数值字段仅接受有限 number；string 时间戳一律不解析（避免 Date 时区歧义）。
  const exitCode =
    typeof o.exitCode === 'number' && Number.isFinite(o.exitCode)
      ? o.exitCode
      : typeof o.exit_code === 'number' && Number.isFinite(o.exit_code)
        ? o.exit_code
        : undefined;

  const durationRaw =
    typeof o.durationMs === 'number' && Number.isFinite(o.durationMs)
      ? o.durationMs
      : typeof o.duration === 'number' && Number.isFinite(o.duration)
        ? o.duration
        : undefined;

  const finishedRaw =
    typeof o.finishedAtMs === 'number' && Number.isFinite(o.finishedAtMs)
      ? o.finishedAtMs
      : typeof o.finished_at_ms === 'number' &&
          Number.isFinite(o.finished_at_ms)
        ? o.finished_at_ms
        : typeof o.finishedAt === 'number' && Number.isFinite(o.finishedAt)
          ? o.finishedAt
          : undefined;

  const lineCount =
    typeof o.lineCount === 'number' && Number.isFinite(o.lineCount)
      ? o.lineCount
      : typeof o.line_count === 'number' && Number.isFinite(o.line_count)
        ? o.line_count
        : undefined;

  const lastOutputAt =
    typeof o.lastOutputAtMs === 'number' && Number.isFinite(o.lastOutputAtMs)
      ? o.lastOutputAtMs
      : typeof o.last_output_at_ms === 'number' &&
          Number.isFinite(o.last_output_at_ms)
        ? o.last_output_at_ms
        : undefined;

  // resource：null 显式保留（未启用资源监控）；对象解析为快照；其余省略
  const resource =
    o.resource === null
      ? null
      : asRec(o.resource)
        ? parseBgTaskResourceSample(o.resource)
        : undefined;

  const promptRaw = typeof o.prompt === 'string' ? o.prompt.trim() : '';
  const prompt = promptRaw ? promptRaw : undefined;

  const sessionIdRaw =
    (typeof o.sessionId === 'string' && o.sessionId.trim()) ||
    (typeof o.session_id === 'string' && o.session_id.trim()) ||
    undefined;

  const suspicious =
    typeof o.suspicious === 'boolean' ? o.suspicious : undefined;

  return {
    id,
    label,
    state,
    ...(sessionIdRaw !== undefined && { sessionId: sessionIdRaw }),
    ...(command !== undefined && { command }),
    ...(startedAt !== undefined && { startedAt }),
    ...(summary !== undefined && { summary }),
    ...(exitCode !== undefined && { exitCode }),
    ...(durationRaw !== undefined && { durationMs: durationRaw }),
    ...(finishedRaw !== undefined && { finishedAtMs: finishedRaw }),
    ...(lineCount !== undefined && { lineCount }),
    ...(lastOutputAt !== undefined && { lastOutputAtMs: lastOutputAt }),
    ...(resource !== undefined && { resource }),
    ...(prompt !== undefined && { prompt }),
    ...(suspicious !== undefined && { suspicious }),
  };
}

/**
 * 解析资源采样快照：字段名容错 camelCase / snake_case，非数值忽略。
 * 空对象 / 畸形 → 空快照（永不抛）。
 */
export function parseBgTaskResourceSample(raw: unknown): BackgroundTaskResourceSample {
  const o = asRec(raw);
  if (!o) return {};
  const out: BackgroundTaskResourceSample = {};
  const sampled =
    typeof o.sampledAtMs === 'number' && Number.isFinite(o.sampledAtMs)
      ? o.sampledAtMs
      : typeof o.sampled_at_ms === 'number' && Number.isFinite(o.sampled_at_ms)
        ? o.sampled_at_ms
        : undefined;
  const cpu =
    typeof o.cpuPercent === 'number' && Number.isFinite(o.cpuPercent)
      ? o.cpuPercent
      : typeof o.cpu_percent === 'number' && Number.isFinite(o.cpu_percent)
        ? o.cpu_percent
        : undefined;
  const rss =
    typeof o.rssBytes === 'number' && Number.isFinite(o.rssBytes)
      ? o.rssBytes
      : typeof o.rss_bytes === 'number' && Number.isFinite(o.rss_bytes)
        ? o.rss_bytes
        : undefined;
  const last =
    typeof o.lastOutputAtMs === 'number' && Number.isFinite(o.lastOutputAtMs)
      ? o.lastOutputAtMs
      : typeof o.last_output_at_ms === 'number' &&
          Number.isFinite(o.last_output_at_ms)
        ? o.last_output_at_ms
        : undefined;
  if (sampled !== undefined) out.sampledAtMs = sampled;
  if (cpu !== undefined) out.cpuPercent = cpu;
  if (rss !== undefined) out.rssBytes = rss;
  if (last !== undefined) out.lastOutputAtMs = last;
  return out;
}
