//! 工具批处理事件与审批门（任务书 B3.5 的 tool_events 部分）
//!
//! - 事件序列：tool-batch-start → (tool-start → approval-requested →
//!   approval-resolved? → tool-update* → tool-end)* → tool-batch-end
//!   （S1 起 tool-update* 为流式进度增量，零或多条，恒位于 tool-start 与
//!   tool-end 之间——TOOLS-01 §3.1.5；approval-resolved 仅引擎侧超时路径
//!   记录，approve/deny 由壳层命令路径落事件，见下方 G-9 说明）
//! - 审批防死锁：approval-requested 必须先于挂起等待发出（01 §五.8）
//! - G-9 审批超时权威语义：超时（APPROVAL_TIMEOUT）→ Expired 时引擎把
//!   转移记为 approval-resolved(expired) 事件（复用既有 41 变体协议，
//!   协议不变），随会话事件流持久化/广播/多端同步，手机端过期状态
//!   无需各自本地计时兜底
//! - 事件为轻量结构，后续由 orchestrator 转成 AgentEvent（03 §1 清单）
//!
//! 语义来源：01-session-loop-semantics.md §2.8 / §五.8；TOOLS-01 §3.1.5

use agent_tools::permission::PermissionMode;
use conex_types::tool::{ToolCategory, ToolConcurrency, ToolProgressUpdate};
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
        /// 请求方身份（T-D-14 权限传递层；None = 主 agent run，裁决者 = 用户；
        /// Some = 子代理 run，裁决者默认 = 主 agent）
        requester: Option<ApprovalRequester>,
    },
    /// 审批结果（G-9 引擎侧超时权威语义落库）：恒位于本工具
    /// approval-requested 之后、tool-end 之前。引擎当前仅对**超时 →
    /// Expired** 记录本事件（approve/deny 由壳层命令路径落
    /// approval-resolved，避免双发）；翻译层映射为
    /// AgentEvent::ApprovalResolved（复用既有变体，协议不变）。
    ApprovalResolved {
        call_id: String,
        /// 引擎侧审批决策（当前恒 Expired；保留全量枚举供映射层对齐）
        decision: ApprovalDecision,
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
    /// 工具执行进度增量（S1 流式输出，TOOLS-01 §3.1.5）
    ///
    /// 恒位于本工具的 ToolStart 与 ToolEnd 之间（tool-start →
    /// tool-update* → tool-end）；翻译层映射为 AgentEvent::ToolUpdate——
    /// 展示面事件，不进消息历史（终值仍由 ToolEnd 承载，避免污染
    /// 对话缓存前缀）。
    ToolProgress {
        call_id: String,
        update: ToolProgressUpdate,
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

/// 审批请求方身份（T-D-14 权限传递层，用户定夺「子代理申请 → 主 agent 裁决」）
///
/// - `None` = 主 agent run（现状不变：裁决者 = 用户，UI 审批流程）；
/// - `Some` = 子代理 run（新默认：裁决者 = 主 agent，可转用户兜底）；
/// 子代理身份判定 = 本 run 有父 run 归属（`ToolExecCtx.run_id` + 父 run 关系）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRequester {
    /// 请求方 run id（None = 主 agent run；Some = 子代理 run id，裁决者路由依据）
    pub run_id: String,
    /// 子代理任务类型（task_type 六枚举，spawn 时装配；None = 未知/未接线，
    /// 由 F11 T-D-13 spawner 注入面补齐）
    pub task_type: Option<String>,
    /// 子代理申请理由（提示词协议要求「需要更高权限时说明理由」；执行器
    /// 原样透传，不做语义解析；None = 未附理由）
    pub reason: Option<String>,
}

/// 审批门抽象：由编排层（B4/B6）实现真实审批流程
#[async_trait::async_trait]
pub trait ApprovalGate: Send + Sync {
    /// 请求审批并等待决策。实现方须保证先广播 approval-requested 再挂起。
    ///
    /// `requester`（T-D-14 权限传递层）：None = 主 agent run；Some = 子代理
    /// run（携带 run id / 任务类型 / 申请理由）——实现方按此构造载荷
    /// `requester_run_id` / `reason` 字段并路由裁决者。参数全 Option，
    /// 现有实现与测试 MockGate 签名兼容。
    async fn request_approval(
        &self,
        call_id: &str,
        tool_name: &str,
        args: &Value,
        requester: Option<&ApprovalRequester>,
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
    /// 批级审批等待超时（F1-02 修复）：None = 缺省 120s（与编排层
    /// approval_router 的 APPROVAL_TIMEOUT=120s 超时兜底对齐——审批卡片
    /// 丢失/事件桥断连时内核强制收敛，run 不再无限悬挂）；超时 →
    /// [ApprovalDecision::Expired]（复用既有 Expired 分支，非致命）。
    /// 测试注入短超时验证收敛。
    pub approval_timeout: Option<Duration>,
}

impl Default for ToolBatchOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(60),
            fail_strategy: FailStrategy::ContinueDrain,
            approval_enabled: false,
            output_budget_bytes: None,
            permission_mode: None,
            approval_timeout: None,
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
