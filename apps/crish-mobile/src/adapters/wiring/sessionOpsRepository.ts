// 会话操作域命令仓库（G3 接线层）：WsGateway.invoke → sessionOpsCommands 构造/解析
//
// 职责（对齐 M5 §1.2 repository 组合纪律：仓库 = 命令构造 + 网络发送 + 响应解析）：
// - 命令发送唯一入口：renameSession / setSessionPinned / setSessionArchived /
//   deleteSession 四条（C40-C43）——作用于桌面宿主会话存储，与桌面侧栏同一
//   存储层同一语义；仓库不缓存、不落本地状态：操作成功后由 VM 以宿主回读
//   （listSessions 对账）刷新列表，不做无回滚的乐观更新；
// - 响应解析复用 sessionOpsCommands.parseSessionOpsCommandResult（生成面解析器）；
// - 错误归一化：invokeCommand 统一执行链（gatewayCommand.ts）——GatewayError
//   透传 code/retryable → SessionOpsCommandError；解析失败/未知异常 → internal；
// - 注入模式：网关来源构造注入（GatewaySource）——实例 = 测试 mock / 同代
//   直注；解析函数 = 生产命令域（sessionOpsWiring 传 resolveCommandGateway，
//   每次 invoke 现取当代网关，H1 陈旧捕获根治，见 gatewayCommand 文件头口径）。

import { invokeCommand, type GatewaySource } from './gatewayCommand';
import {
  buildDeleteSessionRequest,
  buildRenameSessionRequest,
  buildSetSessionArchivedRequest,
  buildSetSessionPinnedRequest,
  parseSessionOpsCommandResult,
} from '@/domain/repositories/sessionOpsCommands';
import type {
  SessionOpsCommandName,
  SessionOpsCommandRequest,
  SessionOpsCommandResultMap,
} from '@/domain/repositories/sessionOpsCommands';
import type {
  DeleteSessionParams,
  GenericOkResult,
  RenameSessionParams,
  SetSessionArchivedParams,
  SetSessionPinnedParams,
} from '@crish/shared-types';

// ── 错误类型 ──────────────────────────────────────────────────────────────

/** 会话操作域命令错误（code = 协议错误码 / 本地映射码，UI 层映射文案） */
export class SessionOpsCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'SessionOpsCommandError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 未知错误兜底码（解析失败 / 非 GatewayError 异常） */
export const SESSION_OPS_ERROR_INTERNAL = 'internal';

// ── 仓库接口（注入 mock 面；VM/接线层只依赖接口不依赖实现） ────────────────

export interface SessionOpsRepository {
  /** C40 会话改名（标题规范化在宿主侧；清洗为空 = cmd.invalid、不存在 = cmd.not_found） */
  renameSession(params: RenameSessionParams): Promise<GenericOkResult>;
  /** C41 置顶/取消置顶（幂等；不存在 = cmd.not_found） */
  setSessionPinned(params: SetSessionPinnedParams): Promise<GenericOkResult>;
  /** C42 归档/取消归档（幂等；不存在 = cmd.not_found） */
  setSessionArchived(
    params: SetSessionArchivedParams
  ): Promise<GenericOkResult>;
  /** C43 删除会话（真删；活动 run/未决输入 = cmd.session_busy、引擎子代理会话 = cmd.denied、不存在 = cmd.not_found） */
  deleteSession(params: DeleteSessionParams): Promise<GenericOkResult>;
}

// ── 网关实现 ──────────────────────────────────────────────────────────────

/** 经 WsGateway.invoke 发送 F5 会话操作命令并解析响应（注入网关来源，测试可注入假网关） */
export class GatewaySessionOpsRepository implements SessionOpsRepository {
  constructor(private readonly gatewaySource: GatewaySource) {}

  renameSession(params: RenameSessionParams): Promise<GenericOkResult> {
    return this.invoke('renameSession', buildRenameSessionRequest(params));
  }

  setSessionPinned(params: SetSessionPinnedParams): Promise<GenericOkResult> {
    return this.invoke(
      'setSessionPinned',
      buildSetSessionPinnedRequest(params)
    );
  }

  setSessionArchived(
    params: SetSessionArchivedParams
  ): Promise<GenericOkResult> {
    return this.invoke(
      'setSessionArchived',
      buildSetSessionArchivedRequest(params)
    );
  }

  deleteSession(params: DeleteSessionParams): Promise<GenericOkResult> {
    return this.invoke('deleteSession', buildDeleteSessionRequest(params));
  }

  /** 统一执行链转发（invokeCommand，gatewayCommand.ts；错误归一化为域错误类） */
  private invoke<T extends SessionOpsCommandName>(
    command: T,
    req: SessionOpsCommandRequest
  ): Promise<SessionOpsCommandResultMap[T]> {
    return invokeCommand(
      this.gatewaySource,
      req,
      command,
      (raw) => parseSessionOpsCommandResult(command, raw),
      (code, message, retryable) =>
        new SessionOpsCommandError(code, message, retryable)
    );
  }
}
