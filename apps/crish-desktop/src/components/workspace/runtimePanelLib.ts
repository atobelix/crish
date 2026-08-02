/**
 * RuntimePanel 纯函数层：中文文案 / 空态 / a11y / 计数格式化。
 * 从 RuntimePanel.tsx 顶部抽出，零副作用，可独立单测。
 */
import { backgroundTaskStateLabel } from '../../api/backgroundTasksApi';

/** 引擎连接短标签（状态点旁） */
export function formatEngineStatusShort(online: boolean): string {
  return online ? '就绪' : '未就绪';
}

/** 引擎连接完整 aria / title */
export function formatEngineStatusFull(online: boolean): string {
  return online ? '引擎就绪' : '引擎未就绪';
}

/** 引擎 title 补充说明 */
export function formatEngineStatusTitle(online: boolean): string {
  return online
    ? '引擎已连接，可接收任务'
    : '引擎未连接；活动任务与计划可能不完整';
}

/** 活动任务空态：离线与空列表分流 */
export function emptyLiveTasksHint(online: boolean): string {
  return online ? '暂无进行中的任务' : '未连接';
}

/** 后台任务空态 */
export function emptyBgTasksHint(online: boolean): string {
  return online ? '暂无后台任务' : '未连接';
}

/** 计划任务空态 */
export function emptyPlansHint(online: boolean): string {
  return online ? '暂无计划' : '未连接';
}

/** 区段计数（0 不显示，避免空数字噪音） */
export function formatSectionCount(n: number): string | null {
  const c = Math.max(0, n | 0);
  return c > 0 ? String(c) : null;
}

/** 已运行时长中文 */
export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m} 分 ${r} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 时 ${m % 60} 分`;
}

/** 活动行 aria-label */
export function liveTaskAriaLabel(opts: {
  taskName: string;
  elapsedSeconds: number;
  hasSession: boolean;
}): string {
  const name = (opts.taskName || '引擎任务').trim() || '引擎任务';
  const elapsed = formatElapsed(opts.elapsedSeconds);
  const open = opts.hasSession ? '，点击打开对应会话' : '';
  return `${name}，已运行 ${elapsed}${open}`;
}

/** 后台行 meta：中文状态 + 可选命令摘要 */
export function formatBgTaskMeta(opts: {
  state: unknown;
  command?: string | undefined;
  opening?: boolean | undefined;
}): string {
  if (opts.opening) return '打开中…';
  const label = backgroundTaskStateLabel(opts.state);
  const cmd = (opts.command || '').trim();
  if (!cmd) return label;
  return `${label} · ${cmd.slice(0, 40)}`;
}

/** 用量环 aria */
export function formatUsageRingAria(tokenPercent: number): string {
  const p = Math.max(0, Math.min(100, tokenPercent | 0));
  return `上下文占用约 ${p}%`;
}
