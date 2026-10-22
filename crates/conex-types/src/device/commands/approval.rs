use serde::{Deserialize, Serialize};

use super::enums::{ApprovalChannel, Arbiter, CheckDecision};
use crate::events::ApprovalDecision;

// ── F2 审批域：参数与响应 ──

/// C11 参数（decision 恒 approved；协议面不提供 decision 字段）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveParams {
    /// 工具调用 id（真键）
    pub tool_call_id: String,
    /// run id（校验辅助，缺省按待审批集合反查）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// C12 参数
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DenyParams {
    /// 工具调用 id（真键）
    pub tool_call_id: String,
    /// run id（校验辅助）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// 拒绝原因（≤256 字符；缺省 "user denied"）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// C11/C12 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveResult {
    /// 是否成功
    pub ok: bool,
    /// 工具调用 id
    pub tool_call_id: String,
    /// 决策规范值（approved/denied/expired）
    pub decision: ApprovalDecision,
}

/// C13 参数（待办对账）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPendingApprovalsParams {
    /// 只返回该水位之后新出现的待办（增量对账）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
}

/// 待办条目（C13 响应元素；parameters 全量不下发，仅 paramKeys）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    /// 审批请求 id
    pub request_id: String,
    /// 工具调用 id
    pub tool_call_id: String,
    /// 工具名
    pub tool_name: String,
    /// 摘要
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 工作目录
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// 会话 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// run id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// 请求方 run 归属（None = 主 agent）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester_run_id: Option<String>,
    /// 申请理由
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 仲裁方
    pub arbiter: Arbiter,
    /// 请求时刻（epoch ms）
    pub requested_at: u64,
    /// 过期时刻（epoch ms）
    pub expires_at: u64,
    /// 危险级别（1|2；桌面按 F2 §2.2 表推导）
    pub danger_level: u8,
    /// 参数键名列表（parameters 全量不下发）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub param_keys: Option<Vec<String>>,
}

/// C13 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPendingApprovalsResult {
    /// 待办列表
    pub approvals: Vec<PendingApproval>,
    /// 服务端当前水位
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_sequence: Option<u64>,
}

/// C14 参数（审批历史补拉）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalHistoryParams {
    /// 会话 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 水位游标
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
    /// 条数上限（缺省 100，上限 500）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// 审批历史条目（approval-resolved 事件白名单投影）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalHistoryItem {
    /// 事件序列号
    pub sequence: u64,
    /// 工具调用 id
    pub tool_call_id: String,
    /// 工具名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// 决策
    pub decision: ApprovalDecision,
    /// 原因
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 决策渠道
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<ApprovalChannel>,
    /// 决策时刻（epoch ms）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<u64>,
    /// 会话 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// run id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// C14 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalHistoryResult {
    /// 历史条目
    pub items: Vec<ApprovalHistoryItem>,
    /// 下一游标
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_after_sequence: Option<u64>,
    /// 是否还有更多
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_more: Option<bool>,
}

/// C15 参数（审批前置预览；只读判定，不是安全判定）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckCommandParams {
    /// 命令名（如 shell:write）
    pub command: String,
    /// 参数包
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// C15 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckCommandResult {
    /// 预检决策
    pub decision: CheckDecision,
    /// 原因
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
