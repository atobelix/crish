// run 控制接线（R2-05 部分 6：run 详情页控制面发送面）
//
// - 仓库：GatewayRunControlRepository（WsGateway.invoke remote.runControl /
//   remote.cancelRun → 生成面解析，对齐 quickRunWiring / filesRepository 同构；
//   命令构造复用 R2-10 已交付的 buildRunControlRequest / buildCancelRunRequest）；
// - 分级语义（C25 L0-L3，commands.rs:330-342 / D4 §5.6 / M4 §5.6）：L0 continue =
//   恢复、L2 cooperative_stop = 暂停（单点确认）、L3 force_cancel = 取消（二次确认）。
//   本接线只做发送/解析，分级按钮编排在 UI 层（RunControlBar）；
// - 错误归一化：GatewayError（transport.closed / cmd.timeout / 服务端 error 帧）
//   → RunControlCommandError{code, message, retryable}，UI 层按
//   RUN_CONTROL_ERROR_TEXT 映射人话文案（M6 §11.3 错误码表；runControl 错误码面：
//   cmd.not_found / cmd.invalid / cmd.denied，M6 §4.4.2）；
// - 注入模式：gateway 实例构造注入（测试 mock；生产 = observationWiring 单例网关，
//   对齐 quickRunWiring.getQuickRunContext 先例）；未装配 → getRunControlContext()
//   null，VM 投影「未连接」禁用态；
// - permissionMode 约束（R2-07 B4）：runControl 参数面无 permissionMode 字段，
//   授权面 = 配对/连接层能力申报（D5 §3.5）；桌面侧对远程控制恒按 ask 降级执行
//   （apply_remote_mode，D5 §4.6.1），本接线不申报权限位、UI 不提供权限选项。
//
// 纪律：本文件为新增文件，不改动 src/domain、src/network、src/adapters/wiring。

import { WsGateway } from '@/network/WsGateway';
import { invokeCommand } from '@/adapters/wiring/gatewayCommand';
import { getObservationWiring } from '@/adapters/wiring/observationWiring';
import { createContextSingleton } from '@/adapters/wiring/contextSingleton';
import {
  buildRunControlRequest,
  buildCancelRunRequest,
  parseSessionCommandResult,
} from '@/domain/repositories/sessionCommands';
import type {
  RunControlParams,
  RunControlResult,
  CancelRunParams,
  CancelRunResult,
} from '@crish/shared-types';

// ── 错误类型与文案映射 ────────────────────────────────────────────────────

/** run 控制命令错误（code = 协议错误码 / 本地映射码；retryable 供重试提示） */
export class RunControlCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'RunControlCommandError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 未知错误兜底码（解析失败 / 非 GatewayError 异常） */
export const RUN_CONTROL_ERROR_INTERNAL = 'internal';

/**
 * 错误码 → 人话文案（M6 §11.3 错误码表 + GatewayError 本地码）：
 * - transport.closed：未连接（M6 §6.2.1，重连兜底）；
 * - cmd.timeout：本地超时（M6 §6.2.2）；
 * - cmd.session_busy：桌面会话串行守卫命中；
 * - cmd.invalid / cmd.denied / cmd.not_found：参数/授权/目标缺失
 *   （runControl 错误码面，M6 §4.4.2；终态拒绝 TerminalImmutable 属桌面内部
 *   语义，run.rs:340-364，wire 面以 cmd.not_found/cmd.invalid 形式送达）；
 * - RUN_CONTROL_ERROR_INTERNAL：解析失败等本地兜底。
 */
export const RUN_CONTROL_ERROR_TEXT: Record<string, string> = {
  'transport.closed': '未连接，请检查连接后重试',
  'cmd.timeout': '请求超时，请重试',
  'cmd.session_busy': '桌面正在处理该会话，请稍后再试',
  'cmd.invalid': '控制参数无效',
  'cmd.denied': '控制操作未获授权',
  'cmd.not_found': 'run 不存在或已结束',
  [RUN_CONTROL_ERROR_INTERNAL]: '控制操作失败，请重试',
};

/** 错误码 → 人话文案（未知码保留原文透传，诚实化不静默改写） */
export function runControlErrorTextOf(code: string): string {
  return RUN_CONTROL_ERROR_TEXT[code] ?? `控制操作失败（${code}）`;
}

// ── 仓库接口（注入 mock 面；VM 只依赖接口不依赖实现） ─────────────────────

export interface RunControlRepository {
  /** C25 run 控制（level ∈ continue/cooperative_stop/force_cancel；sessionId 必填） */
  runControl(params: RunControlParams): Promise<RunControlResult>;
  /** C26 取消 run（reason ≤ 256 可选；重复 cancel 无副作用，TerminalImmutable 幂等） */
  cancelRun(params: CancelRunParams): Promise<CancelRunResult>;
}

/** 经 WsGateway.invoke 发送 remote.* 并解析响应（注入 gateway，测试可注入假网关） */
export class GatewayRunControlRepository implements RunControlRepository {
  constructor(private readonly gateway: WsGateway) {}

  async runControl(params: RunControlParams): Promise<RunControlResult> {
    const req = buildRunControlRequest(params);
    return invokeCommand(
      this.gateway,
      req,
      'runControl',
      (raw) => parseSessionCommandResult('runControl', raw),
      (code, message, retryable) =>
        new RunControlCommandError(code, message, retryable)
    );
  }

  async cancelRun(params: CancelRunParams): Promise<CancelRunResult> {
    const req = buildCancelRunRequest(params);
    return invokeCommand(
      this.gateway,
      req,
      'cancelRun',
      (raw) => parseSessionCommandResult('cancelRun', raw),
      (code, message, retryable) =>
        new RunControlCommandError(code, message, retryable)
    );
  }
}

// ── 接线上下文（单例；对齐 quickRunWiring.getQuickRunContext） ────────────

export interface RunControlContext {
  /** runControl / cancelRun 发送仓库（生产 = 网关实现；测试注入 mock） */
  repository: RunControlRepository;
}

/** run 控制上下文单例：首次调用从观测接线取网关装配；
 * 接线未启动 → null（VM 投影「未连接」禁用态）。 */
const runControlSingleton = createContextSingleton<RunControlContext>(() => {
  const wiring = getObservationWiring();
  if (!wiring) return null;
  return {
    repository: new GatewayRunControlRepository(wiring.client.gateway),
  };
});

/**
 * run 控制上下文单例读取：首次调用从观测接线取网关装配；
 * 接线未启动 → null（VM 投影「未连接」禁用态）。
 */
export function getRunControlContext(): RunControlContext | null {
  return runControlSingleton.get();
}

/** 测试隔离：清空 run 控制上下文单例（仅测试调用） */
export function resetRunControlContextForTest(): void {
  runControlSingleton.reset();
}
