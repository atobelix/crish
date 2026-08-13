// 快速操作接线（R2-05 部分 5：仪表盘发起 run 快捷入口的发送面）
//
// - 仓库：GatewayRunTaskRepository（WsGateway.invoke remote.runTask → 生成面解析，
//   对齐 filesRepository 同构；命令构造复用 R2-10 已交付的 buildRunTaskRequest）；
// - 错误归一化：GatewayError（transport.closed / cmd.timeout / 服务端 error 帧）
//   → RunTaskCommandError{code, message, retryable}，UI 层按 RUN_TASK_ERROR_TEXT
//   映射人话文案（M6 §11.3 错误码表）；
// - 注入模式：gateway 实例构造注入（测试 mock；生产 = observationWiring 单例网关，
//   对齐 filesWiring.getFilesContext 先例）；未装配 → getQuickRunContext() null，
//   VM 投影「未连接」禁用态（任务书：未连接显示未连接禁用）。
//
// 纪律：本文件为新增文件，不改动 src/domain、src/network、src/adapters/wiring。

import { WsGateway, GatewayError } from '@/network/WsGateway';
import { getObservationWiring } from '@/adapters/wiring/observationWiring';
import {
  buildRunTaskRequest,
  parseSessionCommandResult,
} from '@/domain/repositories/sessionCommands';
import type {
  RunTaskParams,
  RunTaskResult,
} from '../../../../packages/shared-types/src/generated/device/types';

// ── 错误类型与文案映射 ────────────────────────────────────────────────────

/** 快速操作命令错误（code = 协议错误码 / 本地映射码；retryable 供重试提示） */
export class RunTaskCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'RunTaskCommandError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 未知错误兜底码（解析失败 / 非 GatewayError 异常） */
export const RUN_TASK_ERROR_INTERNAL = 'internal';

/**
 * 错误码 → 人话文案（M6 §11.3 错误码表 + GatewayError 本地码）：
 * - transport.closed：未连接（M6 §6.2.1，重连兜底）；
 * - cmd.timeout：本地超时（M6 §6.2.2，幂等重发可）；
 * - cmd.session_busy：桌面会话串行守卫命中（core_run_commands.rs:3082-3090，
 *   桌面正在处理该会话，M6 §11.3 提示口径）；
 * - cmd.invalid / cmd.denied / cmd.not_found：参数/授权/目标缺失；
 * - RUN_TASK_ERROR_INTERNAL：解析失败等本地兜底。
 */
export const RUN_TASK_ERROR_TEXT: Record<string, string> = {
  'transport.closed': '未连接，请检查连接后重试',
  'cmd.timeout': '请求超时，请重试',
  'cmd.session_busy': '桌面正在处理该会话，请稍后再试',
  'cmd.invalid': '任务参数无效',
  'cmd.denied': '发起任务未获授权',
  'cmd.not_found': '会话不存在',
  [RUN_TASK_ERROR_INTERNAL]: '发起失败，请重试',
};

/** 错误码 → 人话文案（未知码保留原文透传，诚实化不静默改写） */
export function runTaskErrorTextOf(code: string): string {
  return RUN_TASK_ERROR_TEXT[code] ?? `发起失败（${code}）`;
}

// ── 仓库接口（注入 mock 面；VM 只依赖接口不依赖实现） ─────────────────────

export interface RunTaskRepository {
  /** C24 发起 run（prompt 必填；sessionId 缺省 = 桌面新建会话） */
  runTask(params: RunTaskParams): Promise<RunTaskResult>;
}

/** 经 WsGateway.invoke 发送 remote.runTask 并解析响应（注入 gateway，测试可注入假网关） */
export class GatewayRunTaskRepository implements RunTaskRepository {
  constructor(private readonly gateway: WsGateway) {}

  async runTask(params: RunTaskParams): Promise<RunTaskResult> {
    try {
      const raw: unknown = await this.gateway.invoke(
        'remote.runTask',
        buildRunTaskRequest(params).body
      );
      const parsed = parseSessionCommandResult('runTask', raw);
      if (!parsed.ok) {
        throw new RunTaskCommandError(
          RUN_TASK_ERROR_INTERNAL,
          `响应解析失败（runTask）：${parsed.error}`,
          false
        );
      }
      return parsed.data;
    } catch (e) {
      if (e instanceof RunTaskCommandError) throw e;
      if (e instanceof GatewayError) {
        throw new RunTaskCommandError(e.code, e.message, e.retryable);
      }
      throw new RunTaskCommandError(
        RUN_TASK_ERROR_INTERNAL,
        e instanceof Error ? e.message : '未知错误',
        false
      );
    }
  }
}

// ── 接线上下文（单例；对齐 filesWiring.getFilesContext） ──────────────────

export interface QuickRunContext {
  /** runTask 发送仓库（生产 = 网关实现；测试注入 mock） */
  repository: RunTaskRepository;
}

let singleton: QuickRunContext | null = null;

/**
 * 快速操作上下文单例读取：首次调用从观测接线取网关装配；
 * 接线未启动 → null（VM 投影「未连接」禁用态）。
 */
export function getQuickRunContext(): QuickRunContext | null {
  if (singleton) return singleton;
  const wiring = getObservationWiring();
  if (!wiring) return null;
  singleton = {
    repository: new GatewayRunTaskRepository(wiring.client.gateway),
  };
  return singleton;
}

/** 测试隔离：清空快速操作上下文单例（仅测试调用） */
export function resetQuickRunContextForTest(): void {
  singleton = null;
}
