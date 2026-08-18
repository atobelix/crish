// F2 审批域命令构造与响应解析（R2-08 命令批 B2：approve/deny/
// listPendingApprovals/approvalHistory/checkCommand 5 条审批命令）
//
// 对齐依据：
// - 字段真源：crates/conex-types/contracts/device-protocol.json（C11-C15 参数/响应
//   类型 + commands 段 name/kind/paramsType/resultType/tauriCommand；M6 §4.2
//   逐条展开）；Rust 侧同构体 crates/conex-types/src/device/commands.rs
//   （serde camelCase，注册表与 Rust 结构逐字节同构）；
// - 命令信封：remote.* 消息体 = CommandRequest {command, params, timeoutMs?}
//   （M6 §3.1 / 生成解析器 parseCommandRequest），kind 与 body.command 后缀必须
//   一致（生成解析器校验，drift.test.ts:161-175）；
// - 响应解析：复用生成解析器（parseApproveResult / parseListPendingApprovalsResult /
//   parseApprovalHistoryResult / parseCheckCommandResult）——不手写第二套字段校验
//   （M5 §1.3 组合纪律：响应类型从 @crish/shared-types 生成包引用，不手抄字段）；
//   **deny 的 resultType = ApproveResult**（注册表 C12 共用 resultType，生成面
//   无独立 parseDenyResult）→ deny 分发到 parseApproveResult；
// - 只读纪律：本轮只构造命令体不发送（WsGateway.invoke 接线在后续轮次）；
//   approve/deny 是审批域仅有的两条写命令（outbox=true + idempotencyKey =
//   "toolCallId + msgId"，M6 §1.3 五条写命令之二；冲突收敛以 approval-resolved
//   事件为唯一裁决，F2 §11.2 先到者胜）；
// - decision 恒 approved/denied：协议面**不提供 decision 字段**（M6 §4.2.1，
//   跨端消灭「传错决策」的可能性；桌面侧 core_backend.rs:620-624 / 639-643
//   恒装配 Approved / Denied）；
// - 桌面端核对（只读，R2-07 映射表「B2 审批批」节）：
//   approve ↔ POST /v1/approval/{toolCallId}/approve（APPROVAL_APPROVE_PATH:148）、
//   deny ↔ POST /v1/approval/{toolCallId}/deny（APPROVAL_DENY_PATH:150；toolCallId
//   路径真键，body 仅 {runId?, reason?}）、listPendingApprovals ↔
//   GET /v1/approvals/pending（APPROVALS_PENDING_PATH:152；afterSequence 增量水位
//   R1-04 未实现 → 全量对账）、approvalHistory ↔ GET /v1/approvals/history
//   （APPROVALS_HISTORY_PATH:154；limit 缺省 100 上限 500 桌面夹紧）、checkCommand
//   ↔ v1 无 REST 端点（仅引擎命令面 core_check_command registered=true）；
// - 错误码映射：cmd.approval_mismatch ↔ HTTP 409（error.rs:127；重复决策/已被
//   其他设备处理/已过期，I-02 天然幂等不改状态机）、approval.expired /
//   approval.rejected（引擎错误域，error.rs:150-152）、cmd.denied / cmd.not_found /
//   cmd.invalid 通用拒绝面——移动端接线层据此分类「不可重试冲突」与「退避重试」。

import type {
  ApproveParams,
  ApproveResult,
  DenyParams,
  ListPendingApprovalsParams,
  ListPendingApprovalsResult,
  ApprovalHistoryParams,
  ApprovalHistoryResult,
  CheckCommandParams,
  CheckCommandResult,
  CommandRequest,
} from '@crish/shared-types';
import {
  parseApproveResult as parseWireApproveResult,
  parseListPendingApprovalsResult as parseWireListPendingApprovalsResult,
  parseApprovalHistoryResult as parseWireApprovalHistoryResult,
  parseCheckCommandResult as parseWireCheckCommandResult,
} from '@crish/shared-types';
import type { ParseResult } from '@crish/shared-types';

// ── 命令标识（注册表 commands 段 name；kind = remote.<name>）────────────────

/** F2 审批域 5 条命令名（C11-C15，M6 §4.2.0 总表） */
export type ApprovalCommandName =
  | 'approve'
  | 'deny'
  | 'listPendingApprovals'
  | 'approvalHistory'
  | 'checkCommand';

/** F2 审批域 5 条命令 kind（协议层消息类别，M6 §3.1） */
export type ApprovalCommandKind =
  | 'remote.approve'
  | 'remote.deny'
  | 'remote.listPendingApprovals'
  | 'remote.approvalHistory'
  | 'remote.checkCommand';

/** 命令名 → kind（注册表锁定的双射；kind 前缀固定 remote.，M6 §4.0） */
export const APPROVAL_COMMAND_KIND: Record<
  ApprovalCommandName,
  ApprovalCommandKind
> = {
  approve: 'remote.approve',
  deny: 'remote.deny',
  listPendingApprovals: 'remote.listPendingApprovals',
  approvalHistory: 'remote.approvalHistory',
  checkCommand: 'remote.checkCommand',
};

/** 命令请求产物：kind（WsGateway.invoke 第一参）+ CommandRequest 信封体 */
export interface ApprovalCommandRequest {
  kind: ApprovalCommandKind;
  body: CommandRequest;
}

// ── 命令构造（纯函数；参数类型 = 生成契约 paramsType）───────────────────────
// 注：params 以展开字面量 { ...params } 传给 CommandRequest.params（JsonValue）——
// 生成接口类型无隐式索引签名，展开后为对象字面量类型可赋给索引签名面（TS2322 规避）。

/** C11 审批通过：decision 恒 approved——协议面**不提供 decision 字段**
 * （M6 §4.2.1，跨端消灭「传错决策」可能性）；runId 为校验辅助（缺失时桌面按
 * 待审批集合反查，容错）。写命令：outbox + toolCallId+msgId 幂等键（I-02 天然
 * 幂等：重复决策 → cmd.approval_mismatch 409，不改状态机，F2 §11.2 先到者胜） */
export function buildApproveRequest(
  params: ApproveParams
): ApprovalCommandRequest {
  return {
    kind: 'remote.approve',
    body: { command: 'approve', params: { ...params } },
  };
}

/** C12 审批拒绝：reason ≤ 256 字符可选（缺省由桌面补 "user denied"）；
 * runId 校验辅助（与 approve 同反查语义）。写命令：outbox + 幂等键（同上） */
export function buildDenyRequest(params: DenyParams): ApprovalCommandRequest {
  return {
    kind: 'remote.deny',
    body: { command: 'deny', params: { ...params } },
  };
}

/** C13 待审批对账：参数恒空或可选 afterSequence 增量水位（只返回该水位之后
 * 新出现的待办；R1-04 桌面实现为全量对账，latestSequence 恒 None——构造侧照常
 * 透传，语义降级全量）。只读天然幂等；parameters 全量不下发（D6 §7.2 隐私红线） */
export function buildListPendingApprovalsRequest(
  params?: ListPendingApprovalsParams
): ApprovalCommandRequest {
  return {
    kind: 'remote.listPendingApprovals',
    body: { command: 'listPendingApprovals', params: { ...params } },
  };
}

/** C14 审批历史补拉：sessionId/afterSequence/limit 全可选（limit 缺省 100 上限
 * 500，桌面端夹紧 clamp，构造侧透传不重算）；响应 items + nextAfterSequence/
 * hasMore 水位分页。只读天然幂等；approval-resolved 白名单投影（不携带参数全量） */
export function buildApprovalHistoryRequest(
  params?: ApprovalHistoryParams
): ApprovalCommandRequest {
  return {
    kind: 'remote.approvalHistory',
    body: { command: 'approvalHistory', params: { ...params } },
  };
}

/** C15 审批前置预览（只读判定，非安全判定——真实判定永远在引擎 gatekeeper /
 * 审批门，D3 §8.3）：command 必填（引擎命令名），params 可选 JsonValue（如
 * shell:write 的 {script}）；响应 decision ∈ allowed/requires-approval/blocked，
 * 移动端 UI 据此展示「此命令需审批」预提示。cmd.unknown（命令未注册） */
export function buildCheckCommandRequest(
  params: CheckCommandParams
): ApprovalCommandRequest {
  return {
    kind: 'remote.checkCommand',
    body: { command: 'checkCommand', params: { ...params } },
  };
}

// ── 响应解析（分发到生成解析器；响应类型 = 生成契约 resultType）─────────────

/** F2 审批域 5 条命令响应载荷联合（生成 resultType 全集；deny 与 approve
 * 共用 ApproveResult——注册表 C12 resultType=ApproveResult） */
export type ApprovalCommandResultPayload =
  | ApproveResult
  | ListPendingApprovalsResult
  | ApprovalHistoryResult
  | CheckCommandResult;

/** 命令名 → 响应载荷类型映射（生成 resultType，M6 §4.2 总表） */
export interface ApprovalCommandResultMap {
  approve: ApproveResult;
  deny: ApproveResult;
  listPendingApprovals: ListPendingApprovalsResult;
  approvalHistory: ApprovalHistoryResult;
  checkCommand: CheckCommandResult;
}

/**
 * 按命令名分发响应解析（输入 = CommandResult 信封的 result 载荷，M6 §6.1；
 * WsGateway.invoke 已解信封并校验 CommandResult 骨架，此处校验 result 内容；
 * 错误码经信封 error 面送达，不在 result 载荷内）。
 * 解析器全部来自生成面（parser.ts），必填字段缺省/类型错 → 拒绝；
 * 桌面端多余字段（注册表未登记）被宽容忽略（生成解析器仅按注册表字段抽取）。
 */
export function parseApprovalCommandResult<T extends ApprovalCommandName>(
  command: T,
  raw: unknown
): ParseResult<ApprovalCommandResultMap[T]> {
  const result = parseAnyApprovalCommandResult(command, raw);
  return result as ParseResult<ApprovalCommandResultMap[T]>;
}

function parseAnyApprovalCommandResult(
  command: ApprovalCommandName,
  raw: unknown
): ParseResult<ApprovalCommandResultPayload> {
  switch (command) {
    case 'approve':
    case 'deny':
      // C11/C12 共用 ApproveResult（生成面无独立 parseDenyResult）
      return parseWireApproveResult(raw);
    case 'listPendingApprovals':
      return parseWireListPendingApprovalsResult(raw);
    case 'approvalHistory':
      return parseWireApprovalHistoryResult(raw);
    case 'checkCommand':
      return parseWireCheckCommandResult(raw);
  }
}
