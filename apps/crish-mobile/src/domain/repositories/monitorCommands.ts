// F1 监控域命令构造与响应解析（R2-07 命令批 B1：10 条只读监控命令）
//
// 对齐依据：
// - 字段真源：crates/conex-types/contracts/device-protocol.json（C01-C10 参数/响应
//   类型 + commands 段 name/kind/paramsType/resultType/tauriCommand；M6 §4.1
//   逐条展开）；
// - 命令信封：remote.* 消息体 = CommandRequest {command, params, timeoutMs?}
//   （M6 §3.1 / 生成解析器 parseCommandRequest，parser.ts:422-435），kind 与
//   body.command 后缀必须一致（生成解析器校验，drift.test.ts:161-175）；
// - 响应解析：复用生成解析器（parseStatusResult 等，parser.ts:989-1245）——
//   不手写第二套字段校验（M5 §1.3 组合纪律：响应类型从 @crish/shared-types
//   生成包引用，不手抄字段）；本文件只做「命令名 → 解析器」的分发与类型收口；
// - 只读纪律：本轮只构造命令体不发送（WsGateway.invoke 接线在后续轮次）；
// - 桌面端核对（只读，R2-07 映射表 docs/multi-device/R2-07-command-mapping.md）：
//   10 条命令 ↔ router.rs 只读端点（/v1/status 等）↔ core_backend.rs 响应面，
//   差异清单与判定见映射表；移动端解析器一律以注册表字段为准，桌面端多余
//   字段（如 SessionIndexEntry.branchParentId）被生成解析器宽容忽略；
// - 夹紧语义归属：maxEvents 默认 200 上限 1000 / maxLines 默认 200 上限 1000 /
//   afterLine 默认 0 —— 均以桌面端为准（router.rs:618 normalize_max_events 与
//   core_run_commands 钳制），移动端构造侧原样透传不重算（M6 §2.4 原则 1）。

import type {
  StatusQuery,
  StatusResult,
  RunSnapshotParams,
  RunSnapshotResult,
  EventPageParams,
  EventPageResult,
  RunEventsParams,
  ListSessionsParams,
  ListSessionsResult,
  ListTasksResult,
  TaskOutputParams,
  TaskOutputResult,
  FlowSnapshotParams,
  FlowSnapshotResult,
  ListCommandsResult,
  SearchIndexResult,
  CommandRequest,
} from '../../../../../packages/shared-types/src/generated/device/types';
import {
  parseStatusResult as parseWireStatusResult,
  parseRunSnapshotResult as parseWireRunSnapshotResult,
  parseEventPageResult as parseWireEventPageResult,
  parseListSessionsResult as parseWireListSessionsResult,
  parseListTasksResult as parseWireListTasksResult,
  parseTaskOutputResult as parseWireTaskOutputResult,
  parseFlowSnapshotResult as parseWireFlowSnapshotResult,
  parseListCommandsResult as parseWireListCommandsResult,
  parseSearchIndexResult as parseWireSearchIndexResult,
} from '../../../../../packages/shared-types/src/generated/device/parser';
import type { ParseResult } from '../../../../../packages/shared-types/src/generated/device/parser';

// ── 命令标识（注册表 commands 段 name；kind = remote.<name>）────────────────

/** F1 监控域 10 条命令名（C01-C10，M6 §4.1.0 总表；注册表 domain 以
 * device-protocol.json commands 段为准——C05 listSessions 登记于 sessions 域） */
export type MonitorCommandName =
  | 'getStatus'
  | 'getRunSnapshot'
  | 'readSessionEvents'
  | 'readRunEvents'
  | 'listSessions'
  | 'listBackgroundTasks'
  | 'getTaskOutput'
  | 'getFlowSnapshot'
  | 'listCommands'
  | 'getSearchIndex';

/** F1 监控域 10 条命令 kind（协议层消息类别，M6 §3.1） */
export type MonitorCommandKind =
  | 'remote.getStatus'
  | 'remote.getRunSnapshot'
  | 'remote.readSessionEvents'
  | 'remote.readRunEvents'
  | 'remote.listSessions'
  | 'remote.listBackgroundTasks'
  | 'remote.getTaskOutput'
  | 'remote.getFlowSnapshot'
  | 'remote.listCommands'
  | 'remote.getSearchIndex';

/** 命令名 → kind（注册表锁定的双射；kind 前缀固定 remote.，M6 §4.0） */
export const MONITOR_COMMAND_KIND: Record<
  MonitorCommandName,
  MonitorCommandKind
> = {
  getStatus: 'remote.getStatus',
  getRunSnapshot: 'remote.getRunSnapshot',
  readSessionEvents: 'remote.readSessionEvents',
  readRunEvents: 'remote.readRunEvents',
  listSessions: 'remote.listSessions',
  listBackgroundTasks: 'remote.listBackgroundTasks',
  getTaskOutput: 'remote.getTaskOutput',
  getFlowSnapshot: 'remote.getFlowSnapshot',
  listCommands: 'remote.listCommands',
  getSearchIndex: 'remote.getSearchIndex',
};

/** 命令请求产物：kind（WsGateway.invoke 第一参）+ CommandRequest 信封体 */
export interface MonitorCommandRequest {
  kind: MonitorCommandKind;
  body: CommandRequest;
}

// ── 命令构造（纯函数；参数类型 = 生成契约 paramsType）───────────────────────
// 注：params 以展开字面量 { ...params } 传给 CommandRequest.params（JsonValue）——
// 生成接口类型无隐式索引签名，展开后为对象字面量类型可赋给索引签名面（TS2322 规避）。

/** C01 状态查询：include 白名单可选（coreStatus/activeRuns/pendingApprovals/
 * bgTaskSummary）；响应为 CoreStatus 裁剪子集（logDir 裁剪面见映射表差异 D-01） */
export function buildGetStatusRequest(
  params?: StatusQuery
): MonitorCommandRequest {
  return {
    kind: 'remote.getStatus',
    body: { command: 'getStatus', params: { ...params } },
  };
}

/** C02 run 快照：runId 必填；sessionId 可选（校验辅助） */
export function buildGetRunSnapshotRequest(
  params: RunSnapshotParams
): MonitorCommandRequest {
  return {
    kind: 'remote.getRunSnapshot',
    body: { command: 'getRunSnapshot', params: { ...params } },
  };
}

/** C03 会话事件分页（同步面主查询）：afterSequence 开区间 ≥0 缺省 0；
 * maxEvents 默认 200 上限 1000（桌面端夹紧，构造侧透传）；
 * direction 可选（backward 仅 UI 历史浏览，桌面端 v1 未实现，见映射表 D-04） */
export function buildReadSessionEventsRequest(
  params: EventPageParams
): MonitorCommandRequest {
  return {
    kind: 'remote.readSessionEvents',
    body: { command: 'readSessionEvents', params: { ...params } },
  };
}

/** C04 run 事件分页（EventPage 同构）：runId 必填；sessionId/afterSequence/
 * maxEvents 可选 */
export function buildReadRunEventsRequest(
  params: RunEventsParams
): MonitorCommandRequest {
  return {
    kind: 'remote.readRunEvents',
    body: { command: 'readRunEvents', params: { ...params } },
  };
}

/** C05 会话列表：includeLastMessage 可选（≤80 字符预览；桌面端 v1 接受但
 * 不生效，见映射表 D-05） */
export function buildListSessionsRequest(
  params?: ListSessionsParams
): MonitorCommandRequest {
  return {
    kind: 'remote.listSessions',
    body: { command: 'listSessions', params: { ...params } },
  };
}

/** C06 后台任务列表：参数恒空对象（摘要，不携带输出内容） */
export function buildListBackgroundTasksRequest(): MonitorCommandRequest {
  return {
    kind: 'remote.listBackgroundTasks',
    body: { command: 'listBackgroundTasks', params: {} },
  };
}

/** C07 任务输出补取：taskId 必填；maxLines 默认 200 上限 1000、afterLine
 * 默认 0（桌面端钳制；断线兜底分页语义） */
export function buildGetTaskOutputRequest(
  params: TaskOutputParams
): MonitorCommandRequest {
  return {
    kind: 'remote.getTaskOutput',
    body: { command: 'getTaskOutput', params: { ...params } },
  };
}

/** C08 子代理 DAG 概览：sessionId 必填（任务书 {runId} 为笔误，注册表
 * FlowSnapshotParams 唯一必填字段为 sessionId，M6 §4.1.8） */
export function buildGetFlowSnapshotRequest(
  params: FlowSnapshotParams
): MonitorCommandRequest {
  return {
    kind: 'remote.getFlowSnapshot',
    body: { command: 'getFlowSnapshot', params: { ...params } },
  };
}

/** C09 命令清单（能力发现）：参数恒空对象（manifest 原样透传） */
export function buildListCommandsRequest(): MonitorCommandRequest {
  return {
    kind: 'remote.listCommands',
    body: { command: 'listCommands', params: {} },
  };
}

/** C10 搜索索引就绪状态：参数恒空对象（ready/state 子集；全文搜索不暴露） */
export function buildGetSearchIndexRequest(): MonitorCommandRequest {
  return {
    kind: 'remote.getSearchIndex',
    body: { command: 'getSearchIndex', params: {} },
  };
}

// ── 响应解析（分发到生成解析器；响应类型 = 生成契约 resultType）─────────────

/** F1 监控域 10 条命令响应载荷联合（生成 resultType 全集） */
export type MonitorCommandResultPayload =
  | StatusResult
  | RunSnapshotResult
  | EventPageResult
  | ListSessionsResult
  | ListTasksResult
  | TaskOutputResult
  | FlowSnapshotResult
  | ListCommandsResult
  | SearchIndexResult;

/** 命令名 → 响应载荷类型映射（生成 resultType，M6 §4.1 总表；
 * readSessionEvents/readRunEvents 共用 EventPageResult） */
export interface MonitorCommandResultMap {
  getStatus: StatusResult;
  getRunSnapshot: RunSnapshotResult;
  readSessionEvents: EventPageResult;
  readRunEvents: EventPageResult;
  listSessions: ListSessionsResult;
  listBackgroundTasks: ListTasksResult;
  getTaskOutput: TaskOutputResult;
  getFlowSnapshot: FlowSnapshotResult;
  listCommands: ListCommandsResult;
  getSearchIndex: SearchIndexResult;
}

/**
 * 按命令名分发响应解析（输入 = CommandResult 信封的 result 载荷，M6 §6.1；
 * WsGateway.invoke 已解信封并校验 CommandResult 骨架，此处校验 result 内容）。
 * 解析器全部来自生成面（parser.ts），必填字段缺省/类型错 → 拒绝；
 * 桌面端多余字段（注册表未登记）被宽容忽略（生成解析器仅按注册表字段抽取）。
 */
export function parseMonitorCommandResult<T extends MonitorCommandName>(
  command: T,
  raw: unknown
): ParseResult<MonitorCommandResultMap[T]> {
  const result = parseAnyMonitorCommandResult(command, raw);
  return result as ParseResult<MonitorCommandResultMap[T]>;
}

function parseAnyMonitorCommandResult(
  command: MonitorCommandName,
  raw: unknown
): ParseResult<MonitorCommandResultPayload> {
  switch (command) {
    case 'getStatus':
      return parseWireStatusResult(raw);
    case 'getRunSnapshot':
      return parseWireRunSnapshotResult(raw);
    case 'readSessionEvents':
      return parseWireEventPageResult(raw);
    case 'readRunEvents':
      return parseWireEventPageResult(raw);
    case 'listSessions':
      return parseWireListSessionsResult(raw);
    case 'listBackgroundTasks':
      return parseWireListTasksResult(raw);
    case 'getTaskOutput':
      return parseWireTaskOutputResult(raw);
    case 'getFlowSnapshot':
      return parseWireFlowSnapshotResult(raw);
    case 'listCommands':
      return parseWireListCommandsResult(raw);
    case 'getSearchIndex':
      return parseWireSearchIndexResult(raw);
  }
}
