/**
 * 电脑操作（Computer Use）会话 invoke 桥。
 *
 * 契约（与引擎已接线，三命令已登记于 Rust 侧，与 `commandManifest.ts` / `main.rs` 一致）：
 *   invoke('computer_session_enable')  -> { enabled: true }
 *   invoke('computer_session_disable') -> { enabled: false }
 *   invoke('computer_status')          -> { enabled: boolean, mode: 'idle'|'browser'|'desktop', reason?: string }
 *   事件 'computer://state-changed' payload { enabled?, mode?, reason? }
 *
 * 接线点（已登记，三命令与 Rust 侧 `command_manifest.rs` / `main.rs` 同步）：
 * - Rust 侧 Tauri 命令已登记（agent-workbench 已注册 computer_session_enable /
 *   computer_session_disable / computer_status 三命令），正常路径走引擎落盘与查询；
 *   missing 仅作兜底（非 Tauri 环境 / 旧版本兼容）；
 * - computer_session_enable/disable：落盘 session_meta
 *   computer_use_enabled（04 §4.1，持久化范式对齐 conex-types timer.rs:43
 *   session_meta 键约定；开关范式对齐 BrowserToolsConfig.mcp_attach_allowed）；
 * - computer_status：回传 SessionEnablement 标记 + ActivationGate 三态
 *   （04 §2 S3 SessionMode；本桥契约值 'idle'/'browser'/'desktop' 对齐
 *   Rust serde 枚举，UI 语义名 Idle/BrowserActive/DesktopActive）；
 * - 事件 'computer://state-changed'：由 ActivationGate 状态广播接线
 *   （04 §2 S3 项 4：变更 → 事件总线 → 面板指示条）。
 *
 * 错误处理对齐 tauriInvoke 三态：error = 命令报错（携带 kind/message）；
 * missing 为兜底（正常已接线不应命中，非 Tauri 环境才降级）。
 */

import { invokeTyped } from './tauriInvoke';
import type { InvokeTypedResult } from './tauriInvoke';
import type { ComputerActivation } from '../components/workspace/computer-panel/computerPanelLib';

export const COMPUTER_SESSION_ENABLE_CMD = 'computer_session_enable';
export const COMPUTER_SESSION_DISABLE_CMD = 'computer_session_disable';
export const COMPUTER_STATUS_CMD = 'computer_status';

/** 引擎电脑操作状态事件名（Tauri event channel；ActivationGate 状态广播）。 */
export const COMPUTER_STATE_EVENT = 'computer://state-changed';

export type ComputerSessionResult = { enabled: boolean };

export type ComputerStatusResult = {
  enabled: boolean;
  mode: ComputerActivation;
  reason?: string;
};

/** 状态事件/查询载荷（字段可选：事件可只携带变更域；兼容解析）。 */
export type ComputerStateEventPayload = {
  enabled?: boolean;
  mode?: ComputerActivation;
  reason?: string;
};

/** 显式开启电脑操作会话（04 §4.1：风险确认流在组件层完成后再调用）。 */
export function enableComputerSession(): Promise<
  InvokeTypedResult<ComputerSessionResult>
> {
  return invokeTyped<ComputerSessionResult>(COMPUTER_SESSION_ENABLE_CMD);
}

/** 停用电脑操作会话（解除授权；同 invoke 桥，无独立停用确认流）。 */
export function disableComputerSession(): Promise<
  InvokeTypedResult<ComputerSessionResult>
> {
  return invokeTyped<ComputerSessionResult>(COMPUTER_SESSION_DISABLE_CMD);
}

/** 查询电脑操作会话状态（挂载恢复/诊断用；兜底 missing 仅非 Tauri 环境）。 */
export function fetchComputerStatus(): Promise<
  InvokeTypedResult<ComputerStatusResult>
> {
  return invokeTyped<ComputerStatusResult>(COMPUTER_STATUS_CMD);
}

// ── 事件订阅（惰性加载 listen，非 Tauri 环境返回 noop——对齐 getTauriInvoke 降级策略） ──

export type ComputerStateEventHandler = (payload: unknown) => void;

/**
 * 订阅引擎电脑操作状态事件（ActivationGate 状态广播）。
 * 非 Tauri 环境（纯浏览器 / 测试未 mock）返回 noop 卸载函数，静默降级。
 */
export async function listenComputerStateEvent(
  handler: ComputerStateEventHandler
): Promise<() => void> {
  try {
    const mod = await import('@tauri-apps/api/event');
    if (typeof mod?.listen !== 'function') return () => {};
    return mod.listen(COMPUTER_STATE_EVENT, (e: { payload?: unknown }) => {
      handler(e?.payload);
    });
  } catch {
    return () => {};
  }
}
