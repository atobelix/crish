/**
 * 受管浏览器（AI 浏览器）会话 invoke 桥。
 *
 * 契约（与引擎接线约定，定死）：
 *   invoke('browser_start')   -> { state: 'running'|'starting'|'error', reason?: string }
 *   invoke('browser_stop')    -> { state: 'stopped' }（可选参数 force?: boolean——
 *                                  true = 急停，引擎走强制杀树路径，评审 F3）
 *   invoke('browser_status')  -> { state: 'idle'|'launching'|'running'|'stopping'|'stopped'|'crashed'|'error', url?: string }
 *   事件 'browser://state-changed' payload { state, url?, reason? }（评审 F7：
 *   crashed 事件携带 reason 原因字段，本桥透传解析）
 *
 * P1-B1 帧流/输入契约（U-13 主控裁决：帧下行 Tauri Channel / 输入上行 invoke）：
 *   invoke('browser_start_frames', { onFrame: Channel }) -> { state: 'starting'|'active'|'stopped', reason? }
 *     帧二进制 = 12 字节小端定长头（seq/width/height u32）+ JPEG 负载（12 文档
 *     §2.2）；消息为 ArrayBuffer。无订阅者时引擎不启帧流（省资源）。
 *   invoke('browser_stop_frames') -> { state: 'stopped' }（退订，幂等）
 *   invoke('browser_frame_status') -> { state }
 *   invoke('browser_input', { event }) -> void（输入上行；no-wait 语义——
 *     引擎侧只路由/合并后即返回，派发由注入管线后台进行；高频 mousemove/wheel
 *     由引擎侧按帧间隔合并，前端 rAF 合并仅为 IPC 预过滤）
 *   事件 'browser://frame-state-changed' payload { state, reason? }
 *
 * 错误处理对齐 tauriInvoke 三态：missing = 引擎未接线（非 Tauri / 命令未注册），
 * error = 命令报错（携带 kind/message）。browser_* 命令已在
 * core_list_commands 清单登记（Rust command_manifest.rs:182-184 与前端
 * transport/commandManifest.ts:168-170 双端同步），此处不重复经 transport
 * 清单校验，直接走 tauriInvoke（missing 语义兜底未接线场景）。
 */

import { invokeTyped } from './tauriInvoke';
import type { InvokeTypedResult } from './tauriInvoke';
import type { BrowserSessionState } from '../components/workspace/browserSessionLib';
import type { BrowserInputEventPayload } from '../components/workspace/browser-panel/browserPanelTypes';

export const BROWSER_START_CMD = 'browser_start';
export const BROWSER_STOP_CMD = 'browser_stop';
export const BROWSER_STATUS_CMD = 'browser_status';

/** P1-B1 帧流命令（browser_start_frames / browser_stop_frames / browser_input） */
export const BROWSER_START_FRAMES_CMD = 'browser_start_frames';
export const BROWSER_STOP_FRAMES_CMD = 'browser_stop_frames';
export const BROWSER_FRAME_STATUS_CMD = 'browser_frame_status';
export const BROWSER_INPUT_CMD = 'browser_input';

/** 引擎浏览器状态事件名（Tauri event channel） */
export const BROWSER_STATE_EVENT = 'browser://state-changed';

/** 帧流状态事件名（P1-B1：starting/active/stopped，独立事件不与面板状态机混流） */
export const BROWSER_FRAME_STATE_EVENT = 'browser://frame-state-changed';

export type BrowserStartResult = {
  state: 'running' | 'starting' | 'error';
  reason?: string;
};

export type BrowserStopResult = { state: 'stopped' };

export type BrowserStatusResult = {
  state: BrowserSessionState;
  url?: string;
};

/** 帧流状态（引擎 browser_frame_status / frame-state-changed 契约）。 */
export type BrowserFrameState = 'starting' | 'active' | 'stopped';

/** 帧流状态载荷（查询返回 + 事件 payload）。 */
export type BrowserFrameStatePayload = {
  state: BrowserFrameState;
  reason?: string;
};

/** 状态事件/查询载荷（评审 F7：reason 为崩溃事件扩展字段，兼容解析）。 */
export type BrowserStateEventPayload = {
  state: BrowserSessionState | 'starting';
  url?: string;
  reason?: string;
};

export function startBrowserSession(): Promise<InvokeTypedResult<BrowserStartResult>> {
  return invokeTyped<BrowserStartResult>(BROWSER_START_CMD);
}

/**
 * 停止浏览器会话。`force=true`（急停）→ 引擎走强制杀树路径（不等会话锁，
 * launching 中不被阻塞至首启超时）；缺省/`false` = 正常停止（Graceful）。
 */
export function stopBrowserSession(
  force = false,
): Promise<InvokeTypedResult<BrowserStopResult>> {
  return invokeTyped<BrowserStopResult>(
    BROWSER_STOP_CMD,
    force ? { force: true } : undefined,
  );
}

export function fetchBrowserStatus(): Promise<InvokeTypedResult<BrowserStatusResult>> {
  return invokeTyped<BrowserStatusResult>(BROWSER_STATUS_CMD);
}

// ── P1-B1 帧流/输入（U-13：帧下行 Channel / 输入上行 invoke） ──

/**
 * 订阅帧流：注册帧通道（onFrame → ArrayBuffer 帧消息）。
 * 通道由引擎侧控制器持活（ActiveStream）；退订/替换时前端收到 end 事件。
 */
export function startBrowserFrames(
  onFrame: import('@tauri-apps/api/core').Channel<ArrayBuffer>,
): Promise<InvokeTypedResult<BrowserFrameStatePayload>> {
  return invokeTyped<BrowserFrameStatePayload>(BROWSER_START_FRAMES_CMD, { onFrame });
}

/** 退订帧流（幂等）：引擎停止帧泵 + stopScreencast。 */
export function stopBrowserFrames(): Promise<InvokeTypedResult<BrowserFrameStatePayload>> {
  return invokeTyped<BrowserFrameStatePayload>(BROWSER_STOP_FRAMES_CMD);
}

/** 帧流状态查询（挂载恢复/诊断用）。 */
export function fetchBrowserFrameStatus(): Promise<
  InvokeTypedResult<BrowserFrameStatePayload>
> {
  return invokeTyped<BrowserFrameStatePayload>(BROWSER_FRAME_STATUS_CMD);
}

/**
 * 输入上行（no-wait）：仅入队即返回，引擎侧路由/合并后由注入管线后台派发。
 * 高频事件（mousemove/wheel）引擎侧按帧间隔合并——前端无需精细节流，
 * rAF 合并仅为 IPC 预过滤（见 usePanelInput 注释）。
 */
export function sendBrowserInput(
  event: BrowserInputEventPayload,
): Promise<InvokeTypedResult<unknown>> {
  return invokeTyped<unknown>(BROWSER_INPUT_CMD, { event });
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

/** 订阅帧流状态事件（P1-B1；同 listenBrowserStateEvent 降级策略）。 */
export async function listenBrowserFrameStateEvent(
  handler: BrowserStateEventHandler,
): Promise<() => void> {
  try {
    const mod = await import('@tauri-apps/api/event');
    if (typeof mod?.listen !== 'function') return () => {};
    return mod.listen(BROWSER_FRAME_STATE_EVENT, (e: { payload?: unknown }) => {
      handler(e?.payload);
    });
  } catch {
    return () => {};
  }
}
