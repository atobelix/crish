//! 工具批处理事件与审批门（任务书 B3.5 的 tool_events 部分）
//!
//! - 事件序列：tool-batch-start → (tool-start → approval-requested →
//!   approval-resolved? → tool-end)* → tool-batch-end
//!   （approval-resolved 仅引擎侧超时路径记录，approve/deny 由壳层命令路径
//!   落事件，见下方 G-9 说明）
//! - 审批防死锁：approval-requested 必须先于挂起等待发出（01 §五.8）
//! - G-9 审批超时权威语义：超时（APPROVAL_TIMEOUT）→ Expired 时引擎把
//!   转移记为 approval-resolved(expired) 事件（复用既有 41 变体协议，
//!   协议不变），随会话事件流持久化/广播/多端同步，手机端过期状态
//!   无需各自本地计时兜底
//! - 事件为轻量结构，后续由 orchestrator 转成 AgentEvent（03 §1 清单）
//!
//! # 批收口语义（EV-09 / D-03 文档化契约）
//!
//! **tool 域事件 = 批收口一次性广播（execute_batch 全部返回后经
//! `emit_tool_events` 翻译为 AgentEvent），非实时轨**——不做逐事件实时
//! 推送（R-16 裁决：不建实时工具轨，加字段不加系统）。观测含义：
//!
//! - `timestamp` 默认取翻译时刻；EV-09 起执行器在**实际发生时刻**打点
//!   `occurred_at_ms`（工具开始/完成毫秒），翻译层优先回填——事件序列
//!   仍为批收口广播，但时间轴反映真实执行时刻（并行组 tool-end 按完成
//!   时刻排序，事件顺序即完成顺序）；
//! - 审批挂起可见性：工具等待审批时事件流处于「本批 tool-start 已发、
//!   tool-end 未发」的中间态，run 状态机为 awaiting-approval 中间态；
//!   实时查询面 = `list_pending_approvals`（壳层命令），不依赖事件轨；
//! - 实时轨登记为后续增强（触发条件：工具执行 >N 秒场景出现或用户明确
//!   要求），当前不实现。
//!
//! 语义来源：01-session-loop-semantics.md §2.8 / §五.8；TOOLS-01 §3.1.5；
//! D-03 详案 EV-10（duration_ms 真实化 / occurred_at 打点 / 批收口语义）
//!
//! > 统一输入流收敛战役 R1（tool-update 事件契约删除）：`ToolEvent::ToolProgress`
//! > 变体随 `AgentEvent` 的 tool-update 变体删除——S1 流式进度无出站事件（前端零消费），
//! > 终值仍由 tool-end 承载；`ToolProgress`（agent-tools 流式协议类型）保留。

use agent_tools::permission::PermissionMode;
use conex_shared::perf_budget::TOOL_OUTPUT_BUDGET_BYTES_DEFAULT;
use conex_types::tool::{ToolCategory, ToolConcurrency};
use serde_json::Value;
use std::sync::Arc;
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
        /// EV-09（D-03）：工具实际开始时刻（ms epoch；执行器打点，
        /// 翻译层回填 timestamp——批收口广播时间轴真实化）
        occurred_at_ms: Option<u64>,
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
    ///
    /// U-OUT-RS / T-D1-D：`output` 为 `Arc<Value>`——执行器出口共享边界，
    /// exec_batch/exec_single 对同一 output 的拷贝为浅 clone（refcount+1），
    /// 消除多份深 clone。IPC 全链 Arc 扩展归 D6/D11（本维不扩）。
    ToolEnd {
        call_id: String,
        tool_name: String,
        is_error: bool,
        duration_ms: u64,
        /// 成功时的结构化输出（null 表示无输出）；Arc 共享，出口浅 clone
        output: Arc<Value>,
        /// 错误码（is_error 时有值，如 tool.execution_failed）
        error_code: Option<String>,
        /// 错误文案（is_error 时有值）
        error_message: Option<String>,
        /// EV-09（D-03）：审批重试 attempt 序号（首 attempt=1，审批重试
        /// =2；非重试路径恒 1）
        attempt: Option<u32>,
        /// EV-09（D-03）：幂等去重命中标记（守卫命中 = 未真正执行）
        deduplicated: Option<bool>,
        /// EV-09（D-03）：中间件改写后的实际执行入参（与
        /// ToolStart.input 展示原始入参对照；未执行路径 None）
        executed_input: Option<Value>,
        /// EV-09（D-03）：执行完成时刻（ms epoch；执行器打点，翻译层
        /// 回填 timestamp）
        occurred_at_ms: Option<u64>,
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
    /// 分发前中止（session-integrity-repair 02 §4.2：SP-1 / 流末尾中断）
    AbortedBeforeDispatch,
    /// 崩溃恢复结果未知（冷启动自愈合成）
    OutcomeUnknown,
}

impl ToolErrorKind {
    /// 非 fatal 的审批/控制类错误（softDeny/timedOut/cancelled/
    /// approval_expired/user_denied/approval_required，01 §五.8 排除清单；
    /// 02 §4.2 追加 AbortedBeforeDispatch / OutcomeUnknown）
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
                | ToolErrorKind::AbortedBeforeDispatch
                | ToolErrorKind::OutcomeUnknown
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

    /// 错误码（对齐 wire 协议 tool.* 域，03 §5.1-7；02 §4.2 对齐 F01 常量）
    pub fn error_code(self) -> &'static str {
        use conex_types::error::codes;
        match self {
            ToolErrorKind::NotFound => codes::TOOL_NOT_FOUND,
            ToolErrorKind::InvalidInput => codes::TOOL_INVALID_INPUT,
            ToolErrorKind::ExecutionFailed => codes::TOOL_EXECUTION_FAILED,
            ToolErrorKind::Timeout => "tool.timeout",
            ToolErrorKind::UserDenied => "tool.user_denied",
            ToolErrorKind::ApprovalExpired => "tool.approval_expired",
            ToolErrorKind::ApprovalRequired => "tool.requires_approval",
            ToolErrorKind::SoftDeny => "tool.soft_deny",
            ToolErrorKind::Cancelled => codes::TOOL_CANCELLED,
            ToolErrorKind::AbortedBeforeDispatch => codes::TOOL_ABORTED_BEFORE_DISPATCH,
            ToolErrorKind::OutcomeUnknown => codes::TOOL_OUTCOME_UNKNOWN,
        }
    }
}

/// 单工具执行的分类结果（内部结构，映射到 ToolBatchResult 输出）
///
/// EV-09（D-03）原子要素：attempt/deduplicated/executed_input/occurred_at_ms
/// 随本结构从执行器（exec_single / exec_batch）透传到翻译层
/// （executing_tools.rs），落 ToolEnd 事件载荷。
///
/// U-OUT-RS / T-D1-D：`output` 为 `Arc<Value>`——执行器出口共享边界，
/// 与 ToolEvent::ToolEnd 共享同一所有权，消除出口层多份深 clone。
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
    /// 成功时的工具输出（JSON）；Arc 共享边界（出口浅 clone）
    pub output: Arc<Value>,
    /// 执行耗时（未执行语义保持 0：abort/denied/expired/blocked/not-found）
    pub duration_ms: u64,
    /// 审批重试 attempt 序号（首 attempt=1；审批重试后终态=2）
    pub attempt: u32,
    /// 幂等去重命中标记（守卫命中 = 未真正执行）
    pub deduplicated: bool,
    /// 中间件改写后的实际执行入参（未执行路径 None）
    pub executed_input: Option<Value>,
    /// 执行完成时刻（ms epoch；None = 未执行/未打点）
    pub occurred_at_ms: Option<u64>,
}

impl ClassifiedToolResult {
    /// 是否成功
    pub fn is_ok(&self) -> bool {
        self.error_kind.is_none()
    }

    /// 便捷构造：错误结果（duration_ms 传实际执行耗时；未执行路径传 0——
    /// EV-09/D-03：失败路径 duration_ms 真实化，禁止硬编码）
    pub fn error(
        id: impl Into<String>,
        tool_name: impl Into<String>,
        kind: ToolErrorKind,
        message: impl Into<String>,
        duration_ms: u64,
    ) -> Self {
        Self {
            id: id.into(),
            tool_name: tool_name.into(),
            error_kind: Some(kind),
            error_message: Some(message.into()),
            output: Arc::new(serde_json::Value::Null),
            duration_ms,
            attempt: 1,
            deduplicated: false,
            executed_input: None,
            occurred_at_ms: None,
        }
    }

    /// 便捷构造：成功结果
    pub fn ok(
        id: impl Into<String>,
        tool_name: impl Into<String>,
        output: Value,
        duration_ms: u64,
    ) -> Self {
        Self {
            id: id.into(),
            tool_name: tool_name.into(),
            error_kind: None,
            error_message: None,
            output: Arc::new(output),
            duration_ms,
            attempt: 1,
            deduplicated: false,
            executed_input: None,
            occurred_at_ms: None,
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
    /// 单工具输出预算（字节；None 不截断）。
    ///
    /// U-OUT-RS / T-D1-D：**默认 Some(TOOL_OUTPUT_BUDGET_BYTES_DEFAULT)**
    /// （D0 常量 64KiB 事件载荷预算）。生产装配点（run_launch）显式
    /// `Some`，禁止仅靠 `..Default::default()` 隐式继承；测试若需无预算
    /// 须**显式**传 `None`。透传 agent-tools executor 的 summarize 截断语义。
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
    /// 并行组最大并发数（B4 并发上限）：None = 默认 4（常量
    /// `DEFAULT_MAX_PARALLEL`）。超出上限的项**排队等待 permit**而非
    /// 立即拒绝；与 abort/超时语义正交（取消仍逐点穿透，permit 随
    /// future drop 自动释放）。
    pub max_parallel: Option<usize>,
}

impl Default for ToolBatchOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(60),
            fail_strategy: FailStrategy::ContinueDrain,
            approval_enabled: false,
            // U-OUT-RS / T-D1-D：默认 Some——防测试/旁路装配漏网无预算
            //（生产 run_launch 仍须显式写 Some，N6 负向断言）
            output_budget_bytes: Some(TOOL_OUTPUT_BUDGET_BYTES_DEFAULT),
            permission_mode: None,
            approval_timeout: None,
            max_parallel: None,
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
