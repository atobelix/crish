// F5 会话操作域命令构造与响应解析（G3 数据层纯逻辑）
//
// 对齐依据：
// - 字段真源：crates/conex-device-protocol/contracts/device-protocol.json
//   （C40 renameSession / C41 setSessionPinned / C42 setSessionArchived /
//   C43 deleteSession；commands 段 name/kind/paramsType/resultType +
//   types 段字段表）；
// - 真源口径：四条命令作用于桌面宿主的会话存储（conex-db sessions 表），
//   与桌面侧栏改名/置顶/归档/删除同一存储层、同一语义——改名标题由宿主
//   按桌面规范化口径清洗后落库（清洗为空 = cmd.invalid），删除守卫与
//   桌面孤儿清理豁免同源（活动 run/未决输入 = cmd.session_busy、引擎
//   子代理会话 = cmd.denied）；本文件不引入任何手机本地会话状态，操作
//   结果以宿主 listSessions 回读对账为准；
// - 命令信封：remote.* 消息体 = CommandRequest {command, params, timeoutMs?}，
//   kind 与 body.command 后缀必须一致（生成解析器校验）；
// - 响应解析：四条结果统一 GenericOkResult，复用生成解析器
//   （parseGenericOkResult）——不手写第二套字段校验（M5 §1.3 组合纪律）。

import type {
  RenameSessionParams,
  SetSessionPinnedParams,
  SetSessionArchivedParams,
  DeleteSessionParams,
  GenericOkResult,
  CommandRequest,
} from '@crish/shared-types';
import { parseGenericOkResult as parseWireGenericOkResult } from '@crish/shared-types';
import type { ParseResult } from '@crish/shared-types';

// ── 命令标识（注册表 commands 段 name；kind = remote.<name>）────────────────

/** F5 会话操作域 4 条命令名（C40-C43，G3 增补） */
export type SessionOpsCommandName =
  'renameSession' | 'setSessionPinned' | 'setSessionArchived' | 'deleteSession';

/** F5 会话操作域 4 条命令 kind（协议层消息类别） */
export type SessionOpsCommandKind =
  | 'remote.renameSession'
  | 'remote.setSessionPinned'
  | 'remote.setSessionArchived'
  | 'remote.deleteSession';

/** 命令名 → kind（注册表锁定的双射；kind 前缀固定 remote.） */
export const SESSION_OPS_COMMAND_KIND: Record<
  SessionOpsCommandName,
  SessionOpsCommandKind
> = {
  renameSession: 'remote.renameSession',
  setSessionPinned: 'remote.setSessionPinned',
  setSessionArchived: 'remote.setSessionArchived',
  deleteSession: 'remote.deleteSession',
};

/** 命令请求产物：kind（WsGateway.invoke 第一参）+ CommandRequest 信封体 */
export interface SessionOpsCommandRequest {
  kind: SessionOpsCommandKind;
  body: CommandRequest;
}

// ── 命令构造（纯函数；参数类型 = 生成契约 paramsType）───────────────────────

/** C40 会话改名：原始标题透传（规范化在宿主侧，与桌面改名同口径） */
export function buildRenameSessionRequest(
  params: RenameSessionParams
): SessionOpsCommandRequest {
  return {
    kind: 'remote.renameSession',
    body: { command: 'renameSession', params: { ...params } },
  };
}

/** C41 置顶/取消置顶：is_pinned 定向写（幂等） */
export function buildSetSessionPinnedRequest(
  params: SetSessionPinnedParams
): SessionOpsCommandRequest {
  return {
    kind: 'remote.setSessionPinned',
    body: { command: 'setSessionPinned', params: { ...params } },
  };
}

/** C42 归档/取消归档：is_archived 定向写（幂等） */
export function buildSetSessionArchivedRequest(
  params: SetSessionArchivedParams
): SessionOpsCommandRequest {
  return {
    kind: 'remote.setSessionArchived',
    body: { command: 'setSessionArchived', params: { ...params } },
  };
}

/** C43 删除会话：真删（守卫在宿主侧，见文件头口径） */
export function buildDeleteSessionRequest(
  params: DeleteSessionParams
): SessionOpsCommandRequest {
  return {
    kind: 'remote.deleteSession',
    body: { command: 'deleteSession', params: { ...params } },
  };
}

// ── 响应解析（分发到生成解析器；响应类型 = 生成契约 resultType）─────────────

/** 命令名 → 响应载荷类型映射（四条统一 GenericOkResult） */
export interface SessionOpsCommandResultMap {
  renameSession: GenericOkResult;
  setSessionPinned: GenericOkResult;
  setSessionArchived: GenericOkResult;
  deleteSession: GenericOkResult;
}

/**
 * 按命令名分发响应解析（输入 = CommandResult 信封的 result 载荷；
 * WsGateway.invoke 已解信封，此处校验 result 内容）。
 */
export function parseSessionOpsCommandResult<T extends SessionOpsCommandName>(
  command: T,
  raw: unknown
): ParseResult<SessionOpsCommandResultMap[T]> {
  void command;
  return parseWireGenericOkResult(raw) as ParseResult<
    SessionOpsCommandResultMap[T]
  >;
}
