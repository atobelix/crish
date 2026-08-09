/**
 * 受管浏览器（AI 浏览器）会话 invoke 桥。
 *
 * 契约（与引擎接线约定，定死）：
 *   invoke('browser_start')   -> { state: 'running'|'starting'|'error', reason?: string }
 *   invoke('browser_stop')    -> { state: 'stopped' }
 *   invoke('browser_status')  -> { state: 'idle'|'launching'|'running'|'stopping'|'stopped'|'crashed'|'error', url?: string }
 *   事件 'browser://state-changed' payload { state, url? }
 *
 * 错误处理对齐 tauriInvoke 三态：missing = 引擎未接线（非 Tauri / 命令未注册），
 * error = 命令报错（携带 kind/message）。不经过 transport 清单校验
 * （browser_* 为独立命令域，未纳入 core_list_commands）。
 */

import { invokeTyped } from './tauriInvoke';
import type { InvokeTypedResult } from './tauriInvoke';
import type { BrowserSessionState } from '../components/workspace/browserSessionLib';

export const BROWSER_START_CMD = 'browser_start';
export const BROWSER_STOP_CMD = 'browser_stop';
export const BROWSER_STATUS_CMD = 'browser_status';

/** 引擎浏览器状态事件名（Tauri event channel） */
export const BROWSER_STATE_EVENT = 'browser://state-changed';

export type BrowserStartResult = {
  state: 'running' | 'starting' | 'error';
  reason?: string;
};

export type BrowserStopResult = { state: 'stopped' };

export type BrowserStatusResult = {
  state: BrowserSessionState;
  url?: string;
};

export function startBrowserSession(): Promise<InvokeTypedResult<BrowserStartResult>> {
  return invokeTyped<BrowserStartResult>(BROWSER_START_CMD);
}

export function stopBrowserSession(): Promise<InvokeTypedResult<BrowserStopResult>> {
  return invokeTyped<BrowserStopResult>(BROWSER_STOP_CMD);
}

export function fetchBrowserStatus(): Promise<InvokeTypedResult<BrowserStatusResult>> {
  return invokeTyped<BrowserStatusResult>(BROWSER_STATUS_CMD);
}

// ── 事件订阅（惰性加载 listen，非 Tauri 环境返回 noop——对齐 getTauriInvoke 降级策略） ──

export type BrowserStateEventHandler = (payload: unknown) => void;

/**
 * 订阅引擎浏览器状态事件。
 * 非 Tauri 环境（纯浏览器 / 测试未 mock）返回 noop 卸载函数，静默降级。
 */
export async function listenBrowserStateEvent(
  handler: BrowserStateEventHandler,
): Promise<() => void> {
  try {
    const mod = await import('@tauri-apps/api/event');
    if (typeof mod?.listen !== 'function') return () => {};
    return mod.listen(BROWSER_STATE_EVENT, (e: { payload?: unknown }) => {
      handler(e?.payload);
    });
  } catch {
    return () => {};
  }
}
