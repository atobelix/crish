// F5 会话域命令构造与响应解析（R2-10 命令批 B4：runTask/runControl/cancelRun/
// searchSessions 4 条会话命令）
//
// 对齐依据：
// - 字段真源：crates/conex-types/contracts/device-protocol.json（C24-C27 参数/响应
//   类型 + commands 段 name/kind/paramsType/resultType/tauriCommand；M6 §4.4
//   逐条展开）；Rust 侧同构体 crates/conex-types/src/device/commands.rs:1076-1168
//   （serde camelCase，注册表与 Rust 结构逐字节同构）；
// - 命令信封：remote.* 消息体 = CommandRequest {command, params, timeoutMs?}
//   （M6 §3.1 / 生成解析器 parseCommandRequest，parser.ts:422-435），kind 与
//   body.command 后缀必须一致（生成解析器校验，drift.test.ts:161-175）；
// - 响应解析：复用生成解析器（parseRunTaskResult 等，parser.ts:1679-1783）——
//   不手写第二套字段校验（M5 §1.3 组合纪律：响应类型从 @crish/shared-types
//   生成包引用，不手抄字段）；本文件只做「命令名 → 解析器」的分发与类型收口；
// - 只读纪律：本轮只构造命令体不发送（WsGateway.invoke 接线在后续轮次）；
//   写命令 runTask 的 outbox/幂等重发（clientMessageId）语义见未覆盖项；
// - 桌面端核对（只读，R2-07 映射表 B4 会话批）：
//   runTask ↔ POST /v1/runs（router.rs RUNS_PATH:140）、
//   runControl ↔ POST /v1/runs/{id}/control（RUN_CONTROL_PATH:143；路径 runId
//   优先覆盖 body）、cancelRun ↔ POST /v1/runs/{id}/cancel（RUN_CANCEL_PATH:145；
//   body 仅 {reason?}，runId 走路径）、searchSessions ↔ v1 无端点
//   （mobile_search_sessions registered=false，P2 预留 → cmd.unknown）；
//   差异清单与判定见映射表（D-08 ~ D-11），移动端解析器一律以注册表字段为准；
// - permissionMode 降级语义（R1-10 T-08 / D5 §4.6.1）：桌面
//   apply_remote_mode（core_backend.rs:107-112）对 full-access 恒降级 ask
//   （远程不存在 full-access，TH-12 直接缓解），并发射 remote-mode-downgrade
//   审计（core_backend.rs:527-539）。构造层允许全值域（注册表 PermissionMode
//   三值）——若移动端申报 full-access，桌面仍以 ask 执行——故移动端**默认
//   申报 ask**，UI 不得提供 full-access 选项（可提供 ask/plan 选择）。

import type {
  RunTaskParams,
  RunTaskResult,
  RunControlParams,
  RunControlResult,
  CancelRunParams,
  CancelRunResult,
  SearchSessionsParams,
  SearchSessionsResult,
  CommandRequest,
} from '@crish/shared-types';
import {
  parseRunTaskResult as parseWireRunTaskResult,
  parseRunControlResult as parseWireRunControlResult,
  parseCancelRunResult as parseWireCancelRunResult,
  parseSearchSessionsResult as parseWireSearchSessionsResult,
} from '@crish/shared-types';
import type { ParseResult } from '@crish/shared-types';

// ── 命令标识（注册表 commands 段 name；kind = remote.<name>）────────────────

/** F5 会话域 4 条命令名（C24-C27，M6 §4.4.0 总表；C05 listSessions /
 * C03 readSessionEvents 复用见 monitorCommands） */
export type SessionCommandName =
  'runTask' | 'runControl' | 'cancelRun' | 'searchSessions';

/** F5 会话域 4 条命令 kind（协议层消息类别，M6 §3.1） */
export type SessionCommandKind =
  | 'remote.runTask'
  | 'remote.runControl'
  | 'remote.cancelRun'
  | 'remote.searchSessions';

/** 命令名 → kind（注册表锁定的双射；kind 前缀固定 remote.，M6 §4.0） */
export const SESSION_COMMAND_KIND: Record<
  SessionCommandName,
  SessionCommandKind
> = {
  runTask: 'remote.runTask',
  runControl: 'remote.runControl',
  cancelRun: 'remote.cancelRun',
  searchSessions: 'remote.searchSessions',
};

/** 命令请求产物：kind（WsGateway.invoke 第一参）+ CommandRequest 信封体 */
export interface SessionCommandRequest {
  kind: SessionCommandKind;
  body: CommandRequest;
}

// ── 命令构造（纯函数；参数类型 = 生成契约 paramsType）───────────────────────
// 注：params 以展开字面量 { ...params } 传给 CommandRequest.params（JsonValue）——
// 生成接口类型无隐式索引签名，展开后为对象字面量类型可赋给索引签名面（TS2322 规避）。

/** C24 发起 run（P2 能力位 runTask 默认关闭，协议预留；clientMessageId 幂等）：
 * - prompt 必填（1-262144；超 256 KiB 走流上传 promptRef，本轮仅透传不实现上传）；
 * - sessionId 缺省 = 桌面新建会话（commitDraftIfNeeded 语义）；
 * - permissionMode 缺省 ask；构造层允许全值域（ask/plan/full-access），但
 *   full-access 会被桌面恒降级 ask（apply_remote_mode，D5 §4.6.1）——
 *   移动端默认申报 ask 或按 UI 选择（ask/plan），UI 不提供 full-access 选项 */
export function buildRunTaskRequest(
  params: RunTaskParams
): SessionCommandRequest {
  return {
    kind: 'remote.runTask',
    body: { command: 'runTask', params: { ...params } },
  };
}

/** C25 L0-L3 run 控制：level ∈ continue/soft_inject/cooperative_stop/
 * force_cancel（RunControlLevel 枚举）；runId/sessionId 必填（桌面 REST 侧
 * 路径 runId 覆盖 body 值）；reason ≤ 256；payload 仅 soft_inject {text} /
 * continue {message?} 携带 */
export function buildRunControlRequest(
  params: RunControlParams
): SessionCommandRequest {
  return {
    kind: 'remote.runControl',
    body: { command: 'runControl', params: { ...params } },
  };
}

/** C26 取消 run：runId 必填；reason ≤ 256 可选。重复 cancel 无副作用
 * （终态拒绝，TerminalImmutable 幂等语义） */
export function buildCancelRunRequest(
  params: CancelRunParams
): SessionCommandRequest {
  return {
    kind: 'remote.cancelRun',
    body: { command: 'cancelRun', params: { ...params } },
  };
}

/** C27 服务端会话搜索（P2 预留，v1 未注册 → cmd.unknown）：query 必填
 * （1-128）；limit 可选（缺省 50 上限 50，桌面端钳制，构造侧透传）。
 * v1 兜底：移动端本地标题过滤 + 已加载消息内搜索（F5 §2.6） */
export function buildSearchSessionsRequest(
  params: SearchSessionsParams
): SessionCommandRequest {
  return {
    kind: 'remote.searchSessions',
    body: { command: 'searchSessions', params: { ...params } },
  };
}

// ── 响应解析（分发到生成解析器；响应类型 = 生成契约 resultType）─────────────

/** F5 会话域 4 条命令响应载荷联合（生成 resultType 全集） */
export type SessionCommandResultPayload =
  RunTaskResult | RunControlResult | CancelRunResult | SearchSessionsResult;

/** 命令名 → 响应载荷类型映射（生成 resultType，M6 §4.4 总表） */
export interface SessionCommandResultMap {
  runTask: RunTaskResult;
  runControl: RunControlResult;
  cancelRun: CancelRunResult;
  searchSessions: SearchSessionsResult;
}

/**
 * 按命令名分发响应解析（输入 = CommandResult 信封的 result 载荷，M6 §6.1；
 * WsGateway.invoke 已解信封并校验 CommandResult 骨架，此处校验 result 内容；
 * 错误码经信封 error 面送达，不在 result 载荷内）。
 * 解析器全部来自生成面（parser.ts），必填字段缺省/类型错 → 拒绝；
 * 桌面端多余字段（注册表未登记）被宽容忽略（生成解析器仅按注册表字段抽取）。
 */
export function parseSessionCommandResult<T extends SessionCommandName>(
  command: T,
  raw: unknown
): ParseResult<SessionCommandResultMap[T]> {
  const result = parseAnySessionCommandResult(command, raw);
  return result as ParseResult<SessionCommandResultMap[T]>;
}

function parseAnySessionCommandResult(
  command: SessionCommandName,
  raw: unknown
): ParseResult<SessionCommandResultPayload> {
  switch (command) {
    case 'runTask':
      return parseWireRunTaskResult(raw);
    case 'runControl':
      return parseWireRunControlResult(raw);
    case 'cancelRun':
      return parseWireCancelRunResult(raw);
    case 'searchSessions':
      return parseWireSearchSessionsResult(raw);
  }
}
