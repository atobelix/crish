use regex::Regex;
use serde_json::Value;
use std::fmt;
use std::sync::Arc;

/// 事件种类（注册与分派的匹配键）
///
/// 14 变体与 `packages/shared-types/src/hooks.ts` 的 HOOK_EVENT_NAMES
/// 一一对应（I7-M13 事件映射表冻结；`hook_kind_names_frozen_14` 测试
/// 双向锁定，任一漂移立即失败）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HookEventKind {
    /// 会话开始（hooks.ts session.start）
    SessionStart,
    /// 会话结束（hooks.ts session.end）
    SessionEnd,
    /// 轮次开始（hooks.ts turn.start）
    TurnStart,
    /// 轮次结束（hooks.ts turn.end）
    TurnEnd,
    /// 工具执行前（hooks.ts tool.pre）
    ToolPre,
    /// 工具执行后（hooks.ts tool.post）
    ToolPost,
    /// 工具执行失败（hooks.ts tool.error；tool-end isError 分支追加广播）
    ToolError,
    /// 上下文压缩开始（hooks.ts context.compact.start）
    ContextCompactStart,
    /// 上下文压缩结束（hooks.ts context.compact.end）
    ContextCompactEnd,
    /// 错误发生（hooks.ts error.occurred；插件自身错误也进此事件）
    ErrorOccurred,
    /// 模型请求前（hooks.ts model.beforeRequest；M14 补源，本层只挂钩）
    ModelBeforeRequest,
    /// 模型响应后（hooks.ts model.afterResponse；M14 补源，本层只挂钩）
    ModelAfterResponse,
    /// 子代理开始（hooks.ts subagent.start；M7 发射面，本层只挂钩）
    SubagentStart,
    /// 子代理结束（hooks.ts subagent.end；M7 发射面，本层只挂钩）
    SubagentEnd,
}

/// 全部 14 事件种类（冻结测试与遍历用；顺序与 HOOK_EVENT_NAMES 一致）
pub const ALL_HOOK_EVENT_KINDS: [HookEventKind; 14] = [
    HookEventKind::TurnStart,
    HookEventKind::TurnEnd,
    HookEventKind::ToolPre,
    HookEventKind::ToolPost,
    HookEventKind::ContextCompactStart,
    HookEventKind::ContextCompactEnd,
    HookEventKind::SessionStart,
    HookEventKind::SessionEnd,
    HookEventKind::ModelBeforeRequest,
    HookEventKind::ModelAfterResponse,
    HookEventKind::SubagentStart,
    HookEventKind::SubagentEnd,
    HookEventKind::ErrorOccurred,
    HookEventKind::ToolError,
];

impl HookEventKind {
    /// 事件名（对齐 hooks.ts 点分命名）
    pub fn as_str(&self) -> &'static str {
        match self {
            HookEventKind::SessionStart => "session.start",
            HookEventKind::SessionEnd => "session.end",
            HookEventKind::TurnStart => "turn.start",
            HookEventKind::TurnEnd => "turn.end",
            HookEventKind::ToolPre => "tool.pre",
            HookEventKind::ToolPost => "tool.post",
            HookEventKind::ToolError => "tool.error",
            HookEventKind::ContextCompactStart => "context.compact.start",
            HookEventKind::ContextCompactEnd => "context.compact.end",
            HookEventKind::ErrorOccurred => "error.occurred",
            HookEventKind::ModelBeforeRequest => "model.beforeRequest",
            HookEventKind::ModelAfterResponse => "model.afterResponse",
            HookEventKind::SubagentStart => "subagent.start",
            HookEventKind::SubagentEnd => "subagent.end",
        }
    }
}

impl fmt::Display for HookEventKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 钩子事件载荷（对齐 hooks.ts 对应 payload 最小子集，I7-M13 §2 字段映射）
#[derive(Debug, Clone)]
pub enum HookEvent {
    /// session.start：hooks.ts SessionStartPayload（最小子集 sessionId）
    SessionStart { session_id: String },
    /// session.end：hooks.ts SessionEndPayload（最小子集 sessionId）
    SessionEnd { session_id: String },
    /// turn.start：hooks.ts TurnStartPayload（sessionId/turnIndex）
    TurnStart { session_id: String, turn_index: u32 },
    /// turn.end：hooks.ts TurnEndPayload（outcome 由调用方按收场推导）
    TurnEnd {
        session_id: String,
        turn_index: u32,
        tool_call_count: u32,
    },
    /// tool.pre：hooks.ts ToolPrePayload
    ///
    /// P1 权限归一（A1）：tool.pre 为「扩展观察/策略插入通道」——不构成
    /// 平行 allow/deny 审批第二权威；「命令是否需审批」由引擎
    /// `call_verdict` 单一决策链裁定（本事件运行于审批通过之后，handler
    /// Block 仅为插件策略性拒绝，无放行/自动批准路径）。
    ToolPre {
        session_id: String,
        tool_name: String,
        input: Value,
    },
    /// tool.post：hooks.ts ToolPostPayload（is_error 对应 isError）
    ToolPost {
        session_id: String,
        tool_name: String,
        output: Value,
        duration_ms: u64,
        is_error: bool,
    },
    /// tool.error：hooks.ts ToolErrorPayload（tool-end isError 分支追加广播；
    /// error 承载错误文案）
    ToolError {
        session_id: String,
        tool_name: String,
        error: String,
    },
    /// context.compact.start：hooks.ts ContextCompactStartPayload
    /// （trigger ← reason、tokens_before ← tokensBefore）
    ContextCompactStart {
        session_id: String,
        trigger: String,
        tokens_before: u64,
    },
    /// context.compact.end：hooks.ts ContextCompactEndPayload 诊断子集
    /// （aborted / keptMessageCount / compactionId）
    ContextCompactEnd {
        session_id: String,
        aborted: bool,
        kept_message_count: u32,
        compaction_id: String,
    },
    /// error.occurred：hooks.ts ErrorOccurredPayload（插件自身错误也进此事件）
    ErrorOccurred {
        session_id: String,
        error: String,
        retryable: bool,
    },
    /// model.beforeRequest：hooks.ts ModelBeforeRequestPayload（最小子集）
    ModelBeforeRequest {
        session_id: String,
        provider_id: Option<String>,
        model: Option<String>,
    },
    /// model.afterResponse：hooks.ts ModelAfterResponsePayload（最小子集）
    ModelAfterResponse {
        session_id: String,
        provider_id: Option<String>,
        model: Option<String>,
        ok: bool,
    },
    /// subagent.start：hooks.ts SubagentStartPayload（父/子会话区分）
    SubagentStart {
        parent_session_id: String,
        subagent_session_id: String,
        role: Option<String>,
    },
    /// subagent.end：hooks.ts SubagentEndPayload（reason ← status）
    SubagentEnd {
        parent_session_id: String,
        subagent_session_id: String,
        reason: Option<String>,
    },
}

impl HookEvent {
    /// 事件种类
    pub fn kind(&self) -> HookEventKind {
        match self {
            HookEvent::SessionStart { .. } => HookEventKind::SessionStart,
            HookEvent::SessionEnd { .. } => HookEventKind::SessionEnd,
            HookEvent::TurnStart { .. } => HookEventKind::TurnStart,
            HookEvent::TurnEnd { .. } => HookEventKind::TurnEnd,
            HookEvent::ToolPre { .. } => HookEventKind::ToolPre,
            HookEvent::ToolPost { .. } => HookEventKind::ToolPost,
            HookEvent::ToolError { .. } => HookEventKind::ToolError,
            HookEvent::ContextCompactStart { .. } => HookEventKind::ContextCompactStart,
            HookEvent::ContextCompactEnd { .. } => HookEventKind::ContextCompactEnd,
            HookEvent::ErrorOccurred { .. } => HookEventKind::ErrorOccurred,
            HookEvent::ModelBeforeRequest { .. } => HookEventKind::ModelBeforeRequest,
            HookEvent::ModelAfterResponse { .. } => HookEventKind::ModelAfterResponse,
            HookEvent::SubagentStart { .. } => HookEventKind::SubagentStart,
            HookEvent::SubagentEnd { .. } => HookEventKind::SubagentEnd,
        }
    }

    /// 事件归属会话 id（subagent 域取父会话；错误事件化用）
    pub fn session_id(&self) -> &str {
        match self {
            HookEvent::SessionStart { session_id }
            | HookEvent::SessionEnd { session_id }
            | HookEvent::TurnStart { session_id, .. }
            | HookEvent::TurnEnd { session_id, .. }
            | HookEvent::ToolPre { session_id, .. }
            | HookEvent::ToolPost { session_id, .. }
            | HookEvent::ToolError { session_id, .. }
            | HookEvent::ContextCompactStart { session_id, .. }
            | HookEvent::ContextCompactEnd { session_id, .. }
            | HookEvent::ErrorOccurred { session_id, .. }
            | HookEvent::ModelBeforeRequest { session_id, .. }
            | HookEvent::ModelAfterResponse { session_id, .. } => session_id,
            HookEvent::SubagentStart {
                parent_session_id, ..
            }
            | HookEvent::SubagentEnd {
                parent_session_id, ..
            } => parent_session_id,
        }
    }

    /// tool.* 事件的工具名（matcher 过滤用；其余事件返回 None）
    pub(super) fn tool_name(&self) -> Option<&str> {
        match self {
            HookEvent::ToolPre { tool_name, .. }
            | HookEvent::ToolPost { tool_name, .. }
            | HookEvent::ToolError { tool_name, .. } => Some(tool_name),
            _ => None,
        }
    }
}

/// handler 动作
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookAction {
    /// 放行（观察类默认）
    Continue,
    /// 阻止（仅 tool.pre on 模式语义有效：阻止工具执行；其余按观察忽略）
    Block { reason: String },
}

/// 钩子模式（对齐 shared-types `HookMode`：'observe' | 'on'）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HookMode {
    /// observe：广播观察；Block 忽略、失败按 failStrategy 处置
    #[default]
    Observe,
    /// on：串行 + 控制信号（Block 在 tool.pre/turn.end 生效）
    On,
}

impl HookMode {
    /// 模式名（对齐 shared-types 字面量）
    pub fn as_str(&self) -> &'static str {
        match self {
            HookMode::Observe => "observe",
            HookMode::On => "on",
        }
    }
}

/// 注册扩展选项（mode / matcher / timeout）
#[derive(Debug, Clone, Default)]
pub struct HookRegisterOptions {
    /// 分派模式（默认 Observe——03 §2.4 表默认 mode 全为 observe）
    pub mode: HookMode,
    /// matcher：工具名正则（仅 tool.* 事件生效；非法正则注册即拒）
    pub matcher: Option<String>,
    /// handler 超时窗口（毫秒；None = 不包裹超时）
    pub timeout_ms: Option<u64>,
}

/// hook 运行时错误（Propagate 策略下向上传播给调用方）
#[derive(Debug, Clone)]
pub struct HookError {
    /// 错误文案
    pub message: String,
    /// 触发失败的 handler 名（D-03 EV-05：hook-outcome(failed) 载荷用；
    /// 常规 [HookError::new] 构造为 None，propagate 失败携带）
    pub handler_name: Option<String>,
}

impl HookError {
    /// 新建错误
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            handler_name: None,
        }
    }
}

impl fmt::Display for HookError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "hook 失败：{}", self.message)
    }
}

impl std::error::Error for HookError {}

/// 钩子失败策略（对齐 plugin-sdk `HookFailStrategy`：'swallow' | 'log' |
/// 'propagate'；TS 端字段 `failStrategy` 语义一致）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookFailStrategy {
    /// swallow：忽略 handler 失败，继续分派
    Swallow,
    /// log：记录日志后继续分派
    Log,
    /// propagate：停止分派并把错误向上传播（调用方降级承接，不中断会话）
    Propagate,
}

/// 钩子 handler（异步；分派内按注册 timeout_ms 包裹竞速窗口）
#[async_trait::async_trait]
pub trait HookHandler: Send + Sync {
    /// handler 名（日志 / 调试）
    fn name(&self) -> &str;

    /// 处理事件
    async fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError>;
}

/// 分派结果（供调用方与测试断言）
#[derive(Debug, Clone, Default)]
pub struct HookDispatchOutcome {
    /// 是否被 handler 阻止（仅 tool.pre on 模式产生；reason 为阻止原因）
    pub blocked: Option<String>,
    /// 触发阻止的 handler 名（D-03 EV-05 观测字段：hook-outcome(blocked)
    /// 载荷用；未阻止为 None）
    pub blocked_handler: Option<String>,
    /// 被 swallow / log 策略吞掉的 handler 失败数
    pub failed_handlers: usize,
    /// 首个失败/超时 handler 名（D-03 EV-05 观测字段：hook-outcome
    /// (failed/timeout) 载荷用；无失败为 None）
    pub first_failed_handler: Option<String>,
    /// 超时（虚拟失败）handler 数
    pub timeouts: usize,
    /// 因 handler 失败统一广播的 error.occurred 诊断事件数
    pub error_events: usize,
}

/// 快照条目别名（kind/strategy/mode/matcher/timeout/handler）
pub(super) type SnapshotEntry = (
    HookEventKind,
    HookFailStrategy,
    HookMode,
    Option<Regex>,
    Option<u64>,
    Arc<dyn HookHandler>,
);

/// 带超时竞速的调用结果
pub(super) enum InvokeResult {
    Completed(Result<HookAction, HookError>),
    TimedOut(u64),
}

/// 注册表条目
pub(super) struct HandlerEntry {
    pub(super) kind: HookEventKind,
    pub(super) strategy: HookFailStrategy,
    pub(super) mode: HookMode,
    pub(super) matcher: Option<Regex>,
    pub(super) timeout_ms: Option<u64>,
    pub(super) handler: Arc<dyn HookHandler>,
}
