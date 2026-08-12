/**
 * 电脑操作（Computer Use）会话 invoke 桥（二期 P2，S5 遗留⑩）。
 *
 * 契约（与引擎接线约定，定死；接线前 Rust 侧未注册 → invokeTyped 返回
 * missing，上层降级为「未接线」提示 + 开关状态本地化）：
 *   invoke('computer_session_enable')  -> { enabled: true }
 *   invoke('computer_session_disable') -> { enabled: false }
 *   invoke('computer_estop')           -> { stopped: true }（可带 reason 审计原因）
 *   invoke('computer_status')          -> { enabled: boolean, mode: 'idle'|'browser'|'desktop', reason?: string }
 *   事件 'computer://state-changed' payload { enabled?, mode?, reason? }
 *
 * 接线点登记（06 文档 §8 遗留项 9/10 + 04 §3 前端接线面）：
 * - Rust 侧 Tauri 命令未注册（agent-workbench 无 computer_* 命令）——
 *   invokeTyped 的 missing 语义即「引擎未接线」，上层本地化降级；
 * - computer_session_enable/disable：落盘 session_meta
 *   computer_use_enabled（04 §4.1，持久化范式对齐 conex-types timer.rs:43
 *   session_meta 键约定；开关范式对齐 BrowserToolsConfig.mcp_attach_allowed）；
 * - computer_status：回传 SessionEnablement 标记 + ActivationGate 三态
 *   （04 §2 S3 SessionMode；本桥契约值 'idle'/'browser'/'desktop' 对齐
 *   Rust serde 枚举，UI 语义名 Idle/BrowserActive/DesktopActive）；
 * - computer_estop：面板急停按钮 → 同一吊销链（04 §4.3 ③，
 *   AbortToken::abort 幂等；与 browser_* 会话级 estop 及 computer_estop
 *   工具共用全局急停链，来源记录为 User/Panel）；
 * - 事件 'computer://state-changed'：由 ActivationGate 状态广播接线
 *   （04 §2 S3 项 4：变更 → 事件总线 → 面板指示条）。
 *
 * 错误处理对齐 tauriInvoke 三态：missing = 引擎未接线（非 Tauri / 命令
 * 未注册），error = 命令报错（携带 kind/message）。命令面未接线期间不
 * 重复经 transport 清单校验，直接走 tauriInvoke（对齐 browserSessionApi
 * 既有策略）。
 */

import { invokeTyped } from './tauriInvoke';
import type { InvokeTypedResult } from './tauriInvoke';
import type { ComputerActivation } from '../components/workspace/computer-panel/computerPanelLib';

export const COMPUTER_SESSION_ENABLE_CMD = 'computer_session_enable';
export const COMPUTER_SESSION_DISABLE_CMD = 'computer_session_disable';
export const COMPUTER_ESTOP_CMD = 'computer_estop';
export const COMPUTER_STATUS_CMD = 'computer_status';

/** 引擎电脑操作状态事件名（Tauri event channel；ActivationGate 状态广播）。 */
export const COMPUTER_STATE_EVENT = 'computer://state-changed';

export type ComputerSessionResult = { enabled: boolean };

export type ComputerEstopResult = { stopped: boolean };

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

/**
 * 全局急停（04 §4.3 ③ 面板按钮 → 同一吊销链：中止在途注入 → 感知源停止 →
 * 会话回 Idle；恢复需重新显式开启）。reason 为审计原因（可选）。
 */
export function triggerComputerEstop(
  reason?: string
): Promise<InvokeTypedResult<ComputerEstopResult>> {
  return invokeTyped<ComputerEstopResult>(
    COMPUTER_ESTOP_CMD,
    reason ? { reason } : undefined
  );
}

/** 查询电脑操作会话状态（挂载恢复/诊断用；未接线 → missing）。 */
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
