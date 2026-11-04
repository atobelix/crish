// 物理返回键双击退出防抖状态机与根路由判定纯逻辑（实现波方案 01）
// 零 React 依赖、零 Native 依赖，纯 Jest 毫秒级直测。

export const DOUBLE_BACK_EXIT_INTERVAL_MS = 2000;

export interface BackPressExitState {
  lastPressTimeMs: number | null;
}

export type BackPressExitDecision =
  | { action: 'toast'; nextState: BackPressExitState; message: string }
  | { action: 'exit'; nextState: BackPressExitState };

export const INITIAL_BACK_PRESS_EXIT_STATE: BackPressExitState = {
  lastPressTimeMs: null,
};

/**
 * 评估返回键按下动作（2000ms 黄金防抖窗口，首击 toast 拦截，双击放行）
 * @param state 当前防抖状态
 * @param nowMs 当前时间戳（毫秒）
 * @param intervalMs 判定时间窗口（默认 2000ms）
 */
export function evaluateBackPressExit(
  state: BackPressExitState,
  nowMs: number,
  intervalMs: number = DOUBLE_BACK_EXIT_INTERVAL_MS
): BackPressExitDecision {
  const { lastPressTimeMs } = state;

  if (
    lastPressTimeMs !== null &&
    nowMs >= lastPressTimeMs &&
    nowMs - lastPressTimeMs <= intervalMs
  ) {
    // 2000ms 内连击：触发退出桌面，状态重置
    return {
      action: 'exit',
      nextState: { lastPressTimeMs: null },
    };
  }

  // 初次点击或超时或时钟回拨：触发 Toast 提示，更新时间戳
  return {
    action: 'toast',
    nextState: { lastPressTimeMs: nowMs },
    message: '再按一次退出应用',
  };
}

/**
 * 判断指定路径是否为当前认证状态下的根路径（不可退栈、只能双击退出的页面）
 */
export function isRouteCurrentRoot(
  pathname: string,
  isAuthenticated: boolean
): boolean {
  const normalized = pathname.trim().replace(/\/+$/, '') || '/';
  if (isAuthenticated) {
    // 已登录模式下，主页为根路径
    return (
      normalized === '/' ||
      normalized === '/(main)' ||
      normalized === '/(main)/index'
    );
  }
  // 未登录模式下，欢迎登录选择页为根路径
  return normalized === '/welcome';
}

/**
 * 判断指定路径是否为会话单屏页面（需要返回主对话页）
 */
export function isSessionSubRoute(pathname: string): boolean {
  const normalized = pathname.trim();
  return (
    normalized.startsWith('/session/') ||
    normalized.startsWith('/thread/') ||
    normalized.startsWith('/(main)/session/') ||
    normalized.startsWith('/(main)/thread/')
  );
}
