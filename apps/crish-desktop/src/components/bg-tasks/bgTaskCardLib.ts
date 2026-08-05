/**
 * 后台任务卡片纯函数层：时长 / 资源快照摘要 / 退出码 / 异常高亮 /
 * KillResult 三态反馈文案 / prompt 推荐输入 / 日志尾部截取。
 * 零副作用，可独立单测（T-AB-20）。
 */
import {
  BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
  buildBackgroundTaskTerminalLines,
  isBackgroundTaskActive,
  type BackgroundTaskInfo,
  type BackgroundTaskResourceSample,
  type KillBackgroundTaskResult,
} from '../../api/backgroundTasksApi';

/** 未启用资源监控时的占位文案（resource: None 缺失容忍） */
export const RESOURCE_MONITOR_DISABLED_TEXT = '未启用资源监控';

/** 疑似卡死标记文案（task-suspicious 事件 / 轮询快照字段） */
export const SUSPICIOUS_TASK_TEXT = '疑似卡死';

/** prompt 有值时的高亮横幅文案 */
export const TASK_AWAITING_INPUT_TEXT = '任务等待输入';

/** 日志尾部默认行数（卡片内展开展示） */
export const BGTASK_CARD_LOG_TAIL_LINES = 5;

// ── 时长 ───────────────────────────────────────────────────────────

/**
 * 解析任务展示时长（毫秒）：
 * 1. durationMs 已提供 → 直用；
 * 2. 仅 startedAt → 终态用 finishedAtMs - startedAt，活跃用 now - startedAt；
 * 3. 无时间依据 → null（不展示时长）。
 */
export function resolveBgTaskDurationMs(
  task: Pick<BackgroundTaskInfo, 'durationMs' | 'startedAt' | 'finishedAtMs'>,
  now?: number,
): number | null {
  if (typeof task.durationMs === 'number' && Number.isFinite(task.durationMs)) {
    return Math.max(0, task.durationMs);
  }
  if (typeof task.startedAt !== 'number' || !Number.isFinite(task.startedAt)) {
    return null;
  }
  if (typeof task.finishedAtMs === 'number' && Number.isFinite(task.finishedAtMs)) {
    return Math.max(0, task.finishedAtMs - task.startedAt);
  }
  const n = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  return Math.max(0, n - task.startedAt);
}

/** 毫秒 → 中文时长（对齐 runtimePanelLib.formatElapsed 口径） */
export function formatBgTaskDurationMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m} 分 ${r} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 时 ${m % 60} 分`;
}

/**
 * 时长展示标签：活跃任务前缀「已运行」，终态前缀「时长」；
 * 无时间依据（无 durationMs 且无 startedAt）→ null（不展示）。
 */
export function formatBgTaskDurationLabel(
  task: Pick<BackgroundTaskInfo, 'durationMs' | 'startedAt' | 'finishedAtMs' | 'state'>,
  now?: number,
): string | null {
  const ms = resolveBgTaskDurationMs(task, now);
  if (ms === null) return null;
  const prefix = isBackgroundTaskActive(task.state) ? '已运行' : '时长';
  return `${prefix} ${formatBgTaskDurationMs(ms)}`;
}

// ── 资源快照 ───────────────────────────────────────────────────────

/** 字节 → 可读大小（1024 进制；≥ 1 GB 显示 GB，否则 MB） */
export function formatRssBytes(bytes: number): string {
  const b = Math.max(0, bytes);
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 资源快照摘要：`CPU 12.5% · 内存 1.0 MB`。
 * resource 为 null / undefined（未启用 resourceMonitor）→ 返回
 * RESOURCE_MONITOR_DISABLED_TEXT（缺失容忍）。
 */
export function formatBgTaskResourceSummary(
  resource: BackgroundTaskResourceSample | null | undefined,
): string {
  if (resource == null) return RESOURCE_MONITOR_DISABLED_TEXT;
  const cpu =
    typeof resource.cpuPercent === 'number' && Number.isFinite(resource.cpuPercent)
      ? resource.cpuPercent.toFixed(1)
      : null;
  const rss =
    typeof resource.rssBytes === 'number' && Number.isFinite(resource.rssBytes)
      ? formatRssBytes(resource.rssBytes)
      : null;
  const parts: string[] = [];
  if (cpu !== null) parts.push(`CPU ${cpu}%`);
  if (rss !== null) parts.push(`内存 ${rss}`);
  if (parts.length === 0) return RESOURCE_MONITOR_DISABLED_TEXT;
  return parts.join(' · ');
}

// ── 退出码 / 异常高亮 ───────────────────────────────────────────────

/** 退出码展示文案；null / undefined（未知）→ null（不展示） */
export function formatBgTaskExitCode(exitCode: number | null | undefined): string | null {
  if (typeof exitCode !== 'number' || !Number.isFinite(exitCode)) return null;
  return `退出码 ${exitCode}`;
}

/**
 * 异常高亮判定：failed（异常退出）与 killed（被显式终止）两类卡片高亮，
 * 其余状态（running / succeeded / cancelled / timed-out / unknown）不高亮。
 */
export function isBgTaskAbnormalState(state: string): boolean {
  return state === 'failed' || state === 'killed';
}

// ── KillResult 三态反馈 ────────────────────────────────────────────

export type KillFeedbackTone = 'ok' | 'info' | 'error';

/** kill 失败兜底文案（invoke 失败 / 纯语义决策失败 → null 时用） */
export const KILL_FEEDBACK_INVOKE_FAILED_TEXT = '终止失败：命令不可用';

/**
 * KillResult 三态 → 反馈文案与语气：
 * - killed → 「已终止」（viaForce 时附「（强制升级）」）  tone=ok
 * - alreadyExited → 「进程已自然退出（退出码 N）」          tone=info
 * - failed → 「终止失败：<reason>」                        tone=error
 * - null → 「终止失败：命令不可用」                         tone=error
 */
export function formatKillResultFeedback(
  result: KillBackgroundTaskResult | null | undefined,
): { tone: KillFeedbackTone; text: string } {
  if (!result) return { tone: 'error', text: KILL_FEEDBACK_INVOKE_FAILED_TEXT };
  switch (result.kind) {
    case 'killed':
      return {
        tone: 'ok',
        text: result.viaForce ? '已终止（强制升级）' : '已终止',
      };
    case 'alreadyExited': {
      const code =
        typeof result.exitCode === 'number' ? `（退出码 ${result.exitCode}）` : '';
      return { tone: 'info', text: `进程已自然退出${code}` };
    }
    case 'failed':
      return {
        tone: 'error',
        text: `终止失败：${result.reason ?? '未知原因'}`,
      };
  }
}

/** kill 二次确认提示文案 */
export function buildKillConfirmPrompt(task: Pick<BackgroundTaskInfo, 'label'>): string {
  const label = (task.label || '').trim() || '该任务';
  return `确定终止任务「${label}」？将先发送优雅终止信号，5 秒内未退出则升级为强制终止。`;
}

// ── send_input 反馈 ────────────────────────────────────────────────

/** send_input 发送结果反馈文案 */
export function formatSendInputFeedback(ok: boolean): string {
  return ok ? '已发送' : '发送失败';
}

/**
 * 推荐输入：从检测到的交互提示推断合理回应。
 * - `[Y/n]` / `(yes/no)` / `(y/n)` → 'y'
 * - `[y/N]`（小写默认否）→ 'n'
 * - 其余（请输入 / Press Enter 等）→ null（不预填）
 * 注意：否定模式 `[y/N]` 必须大小写敏感匹配且先于肯定模式（`[Y/n]` 含 i 标志）。
 */
export function recommendPromptAnswer(prompt: string | null | undefined): string | null {
  if (!prompt || !prompt.trim()) return null;
  const p = prompt.trim();
  if (/\[y\/N\]/.test(p)) return 'n';
  if (/\[Y\/n\]|\(y(es)?\/n(o)?\)|\(y\/n\)/i.test(p)) return 'y';
  return null;
}

// ── 日志尾部 ───────────────────────────────────────────────────────

/**
 * 日志尾部截取：取输出最后 maxLines 行（复用 buildBackgroundTaskTerminalLines
 * 的空输出占位与分行语义）；空输出 → 占位单行。
 */
export function formatLogTailLines(
  output: string | null | undefined,
  maxLines: number = BGTASK_CARD_LOG_TAIL_LINES,
): string[] {
  const cap =
    typeof maxLines === 'number' && Number.isFinite(maxLines) && maxLines > 0
      ? Math.floor(maxLines)
      : BGTASK_CARD_LOG_TAIL_LINES;
  const all = buildBackgroundTaskTerminalLines(output);
  if (all.length <= cap) return all;
  return all.slice(-cap);
}

/** 空输出占位（与终端面板口径一致） */
export function bgTaskLogEmptyPlaceholder(): string {
  return BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER;
}
