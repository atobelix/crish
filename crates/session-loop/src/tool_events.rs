//! 工具批处理事件与审批门（任务书 B3.5 的 tool_events 部分）
//!
//! - 事件序列：tool-batch-start → (tool-start → approval-requested → tool-end)* → tool-batch-end
//! - 审批防死锁：approval-requested 必须先于挂起等待发出（01 §五.8）
//! - 事件为轻量结构，后续由 orchestrator 转成 AgentEvent（03 §1 清单）
//!
//! 语义来源：01-session-loop-semantics.md §2.8 / §五.8

use agent_tools::permission::PermissionMode;
use conex_types::tool::{ToolCategory, ToolConcurrency};
use serde_json::Value;
use std::time::Duration;

/// 工具批处理事件（执行器产出，供主循环/编排层翻译为 AgentEvent）
///
/// ToolStart 携带完整入参（input/category/concurrency），ToolEnd 携带
/// 完整分类结果（输出/错误码/错误文案）——翻译层不得再硬编码占位，
/// 前端 tool-start/tool-end 卡片的参数与错误详情依赖这些字段。
#[derive(Debug, Clone, PartialEq)]
pub enum ToolEvent {
    /// 批次开始
    BatchStart { batch_id: String, count: usize },
    /// 单工具开始
    ToolStart {
        call_id: String,
        tool_name: String,
        /// 结构化入参（模型原样下发，展示用；cancelled 占位可为 null）
        input: Value,
        category: crate::tool_events::ToolCategory,
        concurrency: crate::tool_events::ToolConcurrency,
        summary: String,
    },
    /// 审批请求（先于等待发出，防死锁）
    ApprovalRequested {
        call_id: String,
        tool_name: String,
        args: Value,
    },
    /// 单工具结束（携带完整分类结果：成功输出 / 错误码+文案）
    ToolEnd {
        call_id: String,
        tool_name: String,
        is_error: bool,
        duration_ms: u64,
        /// 成功时的结构化输出（null 表示无输出）
        output: Value,
        /// 错误码（is_error 时有值，如 tool.execution_failed）
        error_code: Option<String>,
        /// 错误文案（is_error 时有值）
        error_message: Option<String>,
    },
    /// 批次结束
    BatchEnd { batch_id: String },
}

/// 审批决策
#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalDecision {
    /// 通过
    Approved,
    /// 拒绝（用户明确拒绝）
    Denied { reason: String },
    /// 审批超时过期
    Expired,
}

/// 审批门抽象：由编排层（B4/B6）实现真实审批流程
#[async_trait::async_trait]
pub trait ApprovalGate: Send + Sync {
    /// 请求审批并等待决策。实现方须保证先广播 approval-requested 再挂起。
    async fn request_approval(
        &self,
        call_id: &str,
        tool_name: &str,
        args: &Value,
    ) -> ApprovalDecision;
}

/// 工具错误分类（fatalOnError 判定依据，01 §五.8）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolErrorKind {
    /// 未知工具
    NotFound,
    /// 非法入参
    InvalidInput,
    /// 执行失败（真正的致命错误）
    ExecutionFailed,
    /// 超时
    Timeout,
    /// 用户拒绝（审批）
    UserDenied,
    /// 审批过期
    ApprovalExpired,
    /// 需审批（工具返回 tool.requires_approval，R4 T10：产生真实审批请求，
    /// 用户同意后重试执行；不再折叠为 SoftDeny）
    ApprovalRequired,
    /// 软拒绝（审批策略层；R4 T10 后不再作为 requires_approval 的归宿，
    /// 枚举保留兼容既有消费方）
    SoftDeny,
    /// 因 abort / 兄弟失败被取消
    Cancelled,
}

impl ToolErrorKind {
    /// 非 fatal 的审批/控制类错误（softDeny/timedOut/cancelled/
    /// approval_expired/user_denied/approval_required，01 §五.8 排除清单）
    /// ——永不致命。
    pub fn is_never_fatal(self) -> bool {
        matches!(
            self,
            ToolErrorKind::Timeout
                | ToolErrorKind::UserDenied
                | ToolErrorKind::ApprovalExpired
                | ToolErrorKind::ApprovalRequired
                | ToolErrorKind::SoftDeny
                | ToolErrorKind::Cancelled
        )
    }

    /// fatalOnError 判定（01 §五.8）：
    /// - 排除清单（审批/超时/取消）永不致命；
    /// - 其余错误（not_found / invalid_input / execution_failed）是否致命
    ///   由**工具定义**的 fatalOnError 标记决定（对齐 pi：工具错误默认
    ///   作为结果喂回模型，模型调整后继续；仅标记 fatalOnError 的工具
    ///   出错才终止 run）。
    pub fn is_fatal(self, tool_fatal_on_error: bool) -> bool {
        if self.is_never_fatal() {
            return false;
        }
        tool_fatal_on_error
    }

    /// 错误码（对齐 wire 协议 tool.* 域，03 §5.1-7）
    pub fn error_code(self) -> &'static str {
        match self {
            ToolErrorKind::NotFound => "tool.not_found",
            ToolErrorKind::InvalidInput => "tool.invalid_input",
            ToolErrorKind::ExecutionFailed => "tool.execution_failed",
            ToolErrorKind::Timeout => "tool.timeout",
            ToolErrorKind::UserDenied => "tool.user_denied",
            ToolErrorKind::ApprovalExpired => "tool.approval_expired",
            ToolErrorKind::ApprovalRequired => "tool.requires_approval",
            ToolErrorKind::SoftDeny => "tool.soft_deny",
            ToolErrorKind::Cancelled => "tool.cancelled",
        }
    }
}

/// 单工具执行的分类结果（内部结构，映射到 ToolBatchResult 输出）
#[derive(Debug, Clone)]
pub struct ClassifiedToolResult {
    /// 对应 ToolBatchCall.id
    pub id: String,
    /// 工具名
    pub tool_name: String,
    /// 错误分类（成功时为 None）
    pub error_kind: Option<ToolErrorKind>,
    /// 错误文案
    pub error_message: Option<String>,
    /// 成功时的工具输出（JSON）
    pub output: Value,
    /// 执行耗时
    pub duration_ms: u64,
}

impl ClassifiedToolResult {
    /// 是否成功
    pub fn is_ok(&self) -> bool {
        self.error_kind.is_none()
    }

    /// 便捷构造：错误结果
    pub fn error(id: impl Into<String>, tool_name: impl Into<String>, kind: ToolErrorKind, message: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            tool_name: tool_name.into(),
            error_kind: Some(kind),
            error_message: Some(message.into()),
            output: serde_json::Value::Null,
            duration_ms: 0,
        }
    }

    /// 便捷构造：成功结果
    pub fn ok(id: impl Into<String>, tool_name: impl Into<String>, output: Value, duration_ms: u64) -> Self {
        Self {
            id: id.into(),
            tool_name: tool_name.into(),
            error_kind: None,
            error_message: None,
            output,
            duration_ms,
        }
    }
}

/// 批次执行配置
#[derive(Debug, Clone)]
pub struct ToolBatchOptions {
    /// 每工具执行超时（默认 60s）
    pub timeout: Duration,
    /// 失败策略
    pub fail_strategy: FailStrategy,
    /// 是否启用审批（配合 ApprovalGate）
    pub approval_enabled: bool,
    /// 单工具输出预算（字节；None 不截断，默认 None）。
    /// 透传 agent-tools executor 的 summarize 截断语义（T06.4.2 补缺省，
    /// 修复 tool_exec.rs 中硬编码 None 的死配置）
    pub output_budget_bytes: Option<usize>,
    /// 权限模式（R4 T10）：显式设置时按工具 dangerous 标记 + 模式做三态
    /// 判定（ask 问询 / plan 拒绝写类 / full-access 放行）；None = 既有
    /// 语义（approval_enabled 开启 → 全部工具调用走审批）。
    pub permission_mode: Option<PermissionMode>,
}

impl Default for ToolBatchOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(60),
            fail_strategy: FailStrategy::ContinueDrain,
            approval_enabled: false,
            output_budget_bytes: None,
            permission_mode: None,
        }
    }
}

/// 批内失败策略
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailStrategy {
    /// 任一致命失败：同批未执行项标记 cancelled
    CancelSiblings,
    /// 继续执行其余项
    ContinueDrain,
}
