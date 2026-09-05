/**
 * BrowserPanel 纯函数层：受管浏览器会话状态归一化 / payload 校验 / 按钮可用性矩阵。
 * 从 useBrowserSession / BrowserPanel 抽出，零副作用，可独立单测。
 *
 * 状态机（对齐引擎契约 browser_status / browser://state-changed）：
 *   idle → launching → running → stopping → stopped
 *     ↘  error / crashed（异常终态，可再次启动）
 * 归一化：browser_start 返回的 'starting' 视为 'launching'（UI 单一状态机）。
 */

export type BrowserSessionState =
  | 'idle'
  | 'launching'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'error';

export const BROWSER_SESSION_STATES: readonly BrowserSessionState[] = [
  'idle',
  'launching',
  'running',
  'stopping',
  'stopped',
  'crashed',
  'error',
];

/** 状态主文案（状态区标题） */
export const BROWSER_STATE_LABEL: Record<BrowserSessionState, string> = {
  idle: '未启动',
  launching: '启动中',
  running: '运行中',
  stopping: '停止中',
  stopped: '已停止',
  crashed: '已崩溃',
  error: '异常',
};

/** 状态描述（状态区副标题） */
export const BROWSER_STATE_DESC: Record<BrowserSessionState, string> = {
  idle: '浏览器未启动。启动后将打开专用 Chrome 窗口（headed 形态，无帧流）。',
  launching: '正在拉起浏览器窗口…',
  running: '浏览器窗口已运行，供自动化操作。',
  stopping: '正在关闭浏览器窗口…',
  stopped: '浏览器已停止，可随时重新启动。',
  crashed: '浏览器进程异常退出，可重新启动；详情见引擎日志。',
  error: '引擎未返回可用状态，可重新启动重试。',
};

/** 运行态就绪指示（AI 操作可用性提示，MVP 简单版） */
export const BROWSER_AI_READY_TEXT = 'AI 浏览器会话已就绪';

export function isBrowserSessionState(
  v: unknown,
): v is BrowserSessionState {
  return (
    typeof v === 'string' &&
    (BROWSER_SESSION_STATES as readonly string[]).includes(v)
  );
}

/**
 * 归一化状态值：'starting'（browser_start 返回值）并入 'launching'；
 * 未知 / 非法值返回 null（调用方静默丢弃）。
 */
export function normalizeBrowserState(
  v: unknown,
): BrowserSessionState | null {
  if (v === 'starting') return 'launching';
  return isBrowserSessionState(v) ? v : null;
}

/**
 * 解析 status 查询 / state-changed 事件 payload。
 * 非法载荷返回 null（静默丢弃——防御引擎异常载荷）；url 非字符串则忽略。
 */
export function parseBrowserStatePayload(
  payload: unknown,
): { state: BrowserSessionState; url?: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const o = payload as Record<string, unknown>;
  const state = normalizeBrowserState(o.state);
  if (!state) return null;
  const url = typeof o.url === 'string' && o.url ? o.url : undefined;
  return url ? { state, url } : { state };
}

// ── 按钮可用性矩阵 ──────────────────────────────────────────────
// 启动：空闲 / 已停止（含崩溃、异常——允许重启，避免异常终态无操作出口）
// 停止：运行中
// 急停：运行中 / 启动中（走 browser_stop，UI 标注「强制」）

export function canStartBrowserSession(state: BrowserSessionState): boolean {
  return (
    state === 'idle' ||
    state === 'stopped' ||
    state === 'crashed' ||
    state === 'error'
  );
}

export function canStopBrowserSession(state: BrowserSessionState): boolean {
  return state === 'running';
}

export function canKillBrowserSession(state: BrowserSessionState): boolean {
  return state === 'running' || state === 'launching';
}
