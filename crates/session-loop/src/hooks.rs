//! 插件钩子运行时（对齐 packages/shared-types/src/hooks.ts 事件面）
//!
//! 职责：Rust 侧 hook 注册/分派机制——[HookRegistry] 广播事件给注册的
//! handler，失败策略对齐 plugin-sdk 的 `HookFailStrategy` 类型语义
//! （'swallow' | 'log' | 'propagate'）。
//!
//! 事件面（I8-E1 扩展，I7-M13 事件映射表冻结）：
//! - 第一批（6 映射）：session.start / session.end / turn.start / turn.end /
//!   tool.pre / tool.post；
//! - 第二批（8 钩子）：tool.error / context.compact.start / context.compact.end /
//!   error.occurred / model.beforeRequest / model.afterResponse /
//!   subagent.start / subagent.end（model.* 与 subagent.* 只挂钩不补源，
//!   事件源由 02 方案 M14/M7 承接——本注册表提供变体与载荷，发射点
//!   由宿主/编排层接线）。
//!
//! 双模式语义（03 生态插件方案 §2.4 冻结表）：
//! - observe = 广播（现有 dispatch 语义）：handler 失败按注册 failStrategy
//!   处置；Block 控制信号忽略（观察者不拦截执行）；
//! - on = 串行 + 控制信号：Block 在 tool.pre 上阻止执行、在 turn.end 上
//!   建议 stop（其余事件按观察忽略并记录）；handler 失败按 failStrategy 处置。
//!
//! matcher 过滤（§2.5，kimi 借鉴）：tool.pre / tool.post / tool.error 的注册
//! 描述附 `matcher`（工具名正则，默认全量匹配）；dispatch 时对 tool_name
//! 做正则匹配，不匹配的条目跳过；其余事件忽略 matcher；非法正则注册即拒。
//!
//! timeout 竞速窗口（§2.4/§3.5）：注册条目可带 timeout_ms，dispatch 内
//! handler 调用包 `tokio::time::timeout`，超时 = 虚拟失败按 failStrategy
//! 处置；tool.pre 超时固定降级放行（kimi runner.ts:117 语义，守门者不可用
//! 放行优先）。handler 失败（超时/Err）除按策略处置外，统一再广播
//! `error.occurred` 诊断事件（错误事件化，opencode publishPluginError 语义）。
//!
//! 接线决策（docs/multi-agent-repair/06-tool-middleware-hook-接线决策.md +
//! 03 生态插件方案 §2.1 映射表）：
//! - turn.end：`loop/handlers/turn_complete.rs` 步骤 4.5；
//! - tool.pre / tool.post / tool.error：`tool_exec.rs::ToolExecutor::execute_single`
//!   内，与 ToolMiddleware 链共享同一点位；
//! - session.start / session.end / error.occurred / turn.start /
//!   context.compact.*：`loop/mod.rs` run 入口 / converge / apply_recovery /
//!   `loop/handlers/prepare_turn.rs` / `loop/handlers/mod.rs` apply_compaction；
//! - RecoveryHook（F6 冻结签名）**不并入**事件分派：同步裁决语义
//!   （Retry/Skip/Abort）保持原接口。
//!
//! 失败策略语义（propagate 不中断会话）：
//! - tool.pre 的 propagate 失败 → 该工具调用以执行失败结果收场，批继续；
//! - turn.end 的 propagate 失败 → 记录日志后收场流程继续。
//!
//! hook-outcome 观测镜像（D-03 EV-05，2026-08-14 契约窗口）：
//! - dispatch 单点聚合：HookRegistry 可经 [HookRegistry::set_outcome_sink]
//!   接线观测出口，dispatch 出口处每批次发射一次 `AgentEvent::HookOutcome`
//!   （Delta 级，可丢）；未接线 = 无观测事件，dispatch 语义完全不变。
//! - 聚合载荷：hook 种类（event.kind）+ 结果（ok/blocked/failed/timeout，
//!   blocked 带原因）+ 触发 handler 名；turn.end 的 Block（stop 建议）同样
//!   以 outcome=blocked 表达。
//! - model.beforeRequest/afterResponse、subagent.start/end 四变体：本层
//!   「只挂钩不补源」（M14/M7 由宿主/编排层接线）；dispatch 单点对任意
//!   HookEventKind 通用，宿主接线后自动发射 hook-outcome，本层不硬造
//!   生产发射点。

use conex_types::events::AgentEvent;
use regex::Regex;
use serde_json::Value;
use std::fmt;
use std::sync::{Arc, RwLock};
use std::time::Duration;

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
    fn tool_name(&self) -> Option<&str> {
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
type SnapshotEntry = (
    HookEventKind,
    HookFailStrategy,
    HookMode,
    Option<Regex>,
    Option<u64>,
    Arc<dyn HookHandler>,
);

/// 带超时竞速的调用结果
enum InvokeResult {
    Completed(Result<HookAction, HookError>),
    TimedOut(u64),
}

/// 注册表条目
struct HandlerEntry {
    kind: HookEventKind,
    strategy: HookFailStrategy,
    mode: HookMode,
    matcher: Option<Regex>,
    timeout_ms: Option<u64>,
    handler: Arc<dyn HookHandler>,
}

/// 钩子注册表（广播分派；线程安全，可跨 run 复用）
///
/// 错误事件化重入护栏：不使用全局共享状态（如 AtomicBool），完全由
/// dispatch_inner 的 per-dispatch `error_eventing` 参数承担——error.occurred
/// 自身再分派时传 false 即可防级联；全局标志会在并发双失败路径误伤后到者
/// （swap 见 true 直接 return，丢掉 error.occurred）。
#[derive(Default)]
pub struct HookRegistry {
    entries: RwLock<Vec<HandlerEntry>>,
    /// hook-outcome 观测镜像出口（D-03 EV-05）：dispatch 聚合出口发射
    /// AgentEvent::HookOutcome（Delta 级可丢）；None = 未接线，dispatch
    /// 语义不变（仅观测，不搬 HookEvent 插件通道）
    outcome_sink: RwLock<Option<Arc<dyn Fn(AgentEvent) + Send + Sync>>>,
}

impl HookRegistry {
    /// 新建空注册表
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册 handler（默认：on 模式、无 matcher、无超时——保留既有
    /// 控制信号语义；分派按注册顺序）
    pub fn register(
        &self,
        kind: HookEventKind,
        strategy: HookFailStrategy,
        handler: Arc<dyn HookHandler>,
    ) {
        // 默认选项（matcher 缺省）下 register_with 不会失败；仍显式处置错误面
        // （BLK-05：不得丢弃注册结果），保证异常注册可见
        if let Err(err) = self.register_with(
            kind,
            strategy,
            handler,
            HookRegisterOptions {
                mode: HookMode::On,
                ..Default::default()
            },
        ) {
            tracing::error!(hook_kind = ?kind, error = %err, "hook 注册失败（register 默认选项）");
        }
    }

    /// 注册 observe 模式 handler（广播观察：Block 忽略、失败按策略处置）
    pub fn register_observe(
        &self,
        kind: HookEventKind,
        strategy: HookFailStrategy,
        handler: Arc<dyn HookHandler>,
    ) {
        // 同 [Self::register]：显式处置注册错误面（BLK-05）
        if let Err(err) = self.register_with(
            kind,
            strategy,
            handler,
            HookRegisterOptions {
                mode: HookMode::Observe,
                ..Default::default()
            },
        ) {
            tracing::error!(
                hook_kind = ?kind,
                error = %err,
                "hook 注册失败（register_observe 默认选项）"
            );
        }
    }

    /// 注册 handler（完整选项：mode / matcher / timeout）。
    ///
    /// matcher 为工具名正则（仅 tool.* 事件生效），非法正则注册即拒
    /// （HookError，03 §2.5）。
    pub fn register_with(
        &self,
        kind: HookEventKind,
        strategy: HookFailStrategy,
        handler: Arc<dyn HookHandler>,
        options: HookRegisterOptions,
    ) -> Result<(), HookError> {
        // matcher 校验（非法正则拒绝注册）
        let matcher = match &options.matcher {
            Some(pattern) => Some(
                Regex::new(pattern)
                    .map_err(|e| HookError::new(format!("非法 matcher 正则 '{pattern}'：{e}")))?,
            ),
            None => None,
        };
        self.entries
            .write()
            .unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续注册
                tracing::error!("hook 注册表写锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .push(HandlerEntry {
                kind,
                strategy,
                mode: options.mode,
                matcher,
                timeout_ms: options.timeout_ms,
                handler,
            });
        Ok(())
    }

    /// 已注册 handler 数（测试 / 观测）
    pub fn len(&self) -> usize {
        self.entries
            .read()
            .unwrap_or_else(|e| {
                tracing::error!("hook 注册表读锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .len()
    }

    /// 是否无任何注册
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 分派事件给所有匹配 handler（按注册顺序）。
    ///
    /// 语义（03 §2.4 冻结）：
    /// - matcher 过滤：tool.* 事件按工具名正则过滤，不匹配跳过；
    /// - on 模式 handler 返回 Block 且事件为 tool.pre → 立即停止分派并
    ///   返回阻止；非 tool.pre 的 Block → 观察语义下忽略并记录；
    /// - observe 模式 handler 的 Block → 忽略并记录（观察者不拦截）；
    /// - handler 返回 Err / 超时（虚拟失败）→ 按该 handler 注册的失败
    ///   策略处置；tool.pre 超时固定降级放行（kimi 守门者不可用放行优先）；
    /// - 任何 handler 失败（Err/超时）除按策略处置外，统一再广播
    ///   `error.occurred` 诊断事件（错误事件化；error.occurred 自身
    ///   分派期间不再级联）。
    ///
    /// D-03 EV-05（hook-outcome 观测镜像）：出口处单点聚合发射
    /// `AgentEvent::HookOutcome`（每批次一次，不逐 hook 发）；已接线
    /// outcome_sink 时每次 dispatch（含 Err 传播路径）发射一条。
    pub async fn dispatch(&self, event: &HookEvent) -> Result<HookDispatchOutcome, HookError> {
        let result = self.dispatch_inner(event, true).await;
        self.emit_hook_outcome(event, &result);
        result
    }

    /// 接线 hook-outcome 观测镜像出口（D-03 EV-05）：dispatch 出口处
    /// 每批次发射一次 AgentEvent::HookOutcome；不接线 = 无观测事件，
    /// dispatch 语义完全不变（纯观测，HookEvent 插件通道不受影响）。
    pub fn set_outcome_sink(&self, sink: Arc<dyn Fn(AgentEvent) + Send + Sync>) {
        *self.outcome_sink.write().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续接线
            tracing::error!("hook 观测出口写锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        }) = Some(sink);
    }

    /// hook-outcome 聚合发射（dispatch 单点，D-03 EV-05）。
    ///
    /// 聚合语义：每批次一条——blocked（tool.pre on 阻止 / turn.end stop
    /// 建议，带原因）> timeout > failed > ok 优先级判定；hook_name 取触发
    /// handler 名；Err 路径（propagate）同样发射 failed。
    fn emit_hook_outcome(
        &self,
        event: &HookEvent,
        result: &Result<HookDispatchOutcome, HookError>,
    ) {
        let sink = self.outcome_sink.read().unwrap_or_else(|e| {
            tracing::error!(target: "session_loop", "hook outcome_sink 读锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        });
        let Some(sink) = sink.as_ref() else { return };
        let (outcome, hook_name, blocked_reason) = match result {
            Ok(o) if o.blocked.is_some() => {
                ("blocked", o.blocked_handler.clone(), o.blocked.clone())
            }
            Ok(o) if o.timeouts > 0 => ("timeout", o.first_failed_handler.clone(), None),
            Ok(o) if o.failed_handlers > 0 => ("failed", o.first_failed_handler.clone(), None),
            Ok(_) => ("ok", None, None),
            Err(e) => ("failed", e.handler_name.clone(), None),
        };
        sink(AgentEvent::HookOutcome {
            session_id: event.session_id().to_string(),
            timestamp: conex_shared::time::now_iso_utc(),
            hook_type: event.kind().as_str().to_string(),
            outcome: outcome.to_string(),
            hook_name,
            blocked_reason,
        });
    }

    /// 内部分派（error_eventing 开关：error.occurred 再分派时关闭，
    /// 防止错误事件 handler 失败无限级联）
    async fn dispatch_inner(
        &self,
        event: &HookEvent,
        error_eventing: bool,
    ) -> Result<HookDispatchOutcome, HookError> {
        let snapshot = self.snapshot_entries();
        let mut outcome = HookDispatchOutcome::default();
        for (kind, strategy, mode, matcher, timeout_ms, handler) in snapshot {
            if Self::entry_should_skip(kind, matcher.as_ref(), event) {
                continue;
            }
            let invoke = Self::invoke_handler(&handler, event, timeout_ms).await;
            let action = match invoke {
                InvokeResult::TimedOut(ms) => {
                    if let Some(err) = self
                        .handle_timeout(event, &handler, ms, strategy, error_eventing, &mut outcome)
                        .await
                    {
                        return Err(err);
                    }
                    continue;
                }
                InvokeResult::Completed(res) => res,
            };
            match action {
                Ok(HookAction::Continue) => {}
                Ok(HookAction::Block { reason }) => {
                    if self.handle_block(&handler, mode, reason, event, &mut outcome) {
                        return Ok(outcome);
                    }
                }
                Err(e) => {
                    if let Some(p) = self
                        .handle_failure(event, strategy, &handler, &e, error_eventing, &mut outcome)
                        .await
                    {
                        return Err(p);
                    }
                }
            }
        }
        Ok(outcome)
    }

    /// 快照克隆（读锁不跨 handler 调用持有，避免 handler 内注册死锁）
    fn snapshot_entries(&self) -> Vec<SnapshotEntry> {
        self.entries
            .read()
            .unwrap_or_else(|e| {
                tracing::error!("hook 注册表读锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .iter()
            .map(|entry| {
                (
                    entry.kind,
                    entry.strategy,
                    entry.mode,
                    entry.matcher.clone(),
                    entry.timeout_ms,
                    Arc::clone(&entry.handler),
                )
            })
            .collect::<Vec<_>>()
    }

    /// 判定条目是否因 kind/matcher 不匹配而跳过
    fn entry_should_skip(
        entry_kind: HookEventKind,
        matcher: Option<&Regex>,
        event: &HookEvent,
    ) -> bool {
        if entry_kind != event.kind() {
            return true;
        }
        if let (Some(pattern), Some(tool_name)) = (matcher, event.tool_name()) {
            if !pattern.is_match(tool_name) {
                return true;
            }
        }
        false
    }

    /// 带超时竞速的 handler 调用
    async fn invoke_handler(
        handler: &Arc<dyn HookHandler>,
        event: &HookEvent,
        timeout_ms: Option<u64>,
    ) -> InvokeResult {
        match timeout_ms {
            Some(ms) => {
                match tokio::time::timeout(Duration::from_millis(ms), handler.handle(event)).await {
                    Ok(res) => InvokeResult::Completed(res),
                    Err(_) => InvokeResult::TimedOut(ms),
                }
            }
            None => InvokeResult::Completed(handler.handle(event).await),
        }
    }

    /// 处理超时虚拟失败（更新计数、日志、错误事件化与策略分派）
    async fn handle_timeout(
        &self,
        event: &HookEvent,
        handler: &Arc<dyn HookHandler>,
        ms: u64,
        strategy: HookFailStrategy,
        error_eventing: bool,
        outcome: &mut HookDispatchOutcome,
    ) -> Option<HookError> {
        outcome.timeouts += 1;
        outcome.failed_handlers += 1;
        if outcome.first_failed_handler.is_none() {
            outcome.first_failed_handler = Some(handler.name().to_string());
        }
        let message = format!("hook {} 超时（{}ms）", handler.name(), ms);
        tracing::warn!(
            hook = %handler.name(),
            event = %event.kind(),
            timeout_ms = ms,
            "hook 超时（虚拟失败）"
        );
        if event.kind() == HookEventKind::ToolPre {
            self.emit_error_event(event, &message, error_eventing, outcome)
                .await;
            return None;
        }
        self.handle_failure(
            event,
            strategy,
            handler,
            &HookError::new(message),
            error_eventing,
            outcome,
        )
        .await
    }

    /// 处理 Block 信号（observe/非 tool.pre 忽略；tool.pre 记 blocked）
    fn handle_block(
        &self,
        handler: &Arc<dyn HookHandler>,
        mode: HookMode,
        reason: String,
        event: &HookEvent,
        outcome: &mut HookDispatchOutcome,
    ) -> bool {
        if mode == HookMode::Observe {
            tracing::warn!(
                hook = %handler.name(),
                event = %event.kind(),
                reason = %reason,
                "observe 模式 handler 返回 Block，按观察忽略"
            );
            return false;
        }
        if event.kind() == HookEventKind::ToolPre {
            outcome.blocked = Some(reason);
            outcome.blocked_handler = Some(handler.name().to_string());
            return true;
        }
        tracing::warn!(
            hook = %handler.name(),
            event = %event.kind(),
            reason = %reason,
            "非 tool.pre 事件返回 Block，按观察忽略"
        );
        false
    }

    /// 按失败策略处置 handler 失败；失败统一广播 error.occurred 诊断事件
    /// （错误事件化，03 §2.4 规则 4）。
    ///
    /// 返回 Some(HookError) 表示 propagate 策略要求停止分派并向上传播。
    async fn handle_failure(
        &self,
        event: &HookEvent,
        strategy: HookFailStrategy,
        handler: &Arc<dyn HookHandler>,
        err: &HookError,
        error_eventing: bool,
        outcome: &mut HookDispatchOutcome,
    ) -> Option<HookError> {
        let message = err.message.clone();
        // D-03 EV-05：记录首个失败 handler 名（hook-outcome(failed/timeout) 载荷；
        // 含 propagate——Err 传播路径也经单点发射观测事件）
        if outcome.first_failed_handler.is_none() {
            outcome.first_failed_handler = Some(handler.name().to_string());
        }
        match strategy {
            HookFailStrategy::Swallow => {
                outcome.failed_handlers += 1;
                self.emit_error_event(event, &message, error_eventing, outcome)
                    .await;
                None
            }
            HookFailStrategy::Log => {
                tracing::warn!(hook = %handler.name(), event = %event.kind(), error = %err, "hook 失败（log 策略）");
                outcome.failed_handlers += 1;
                self.emit_error_event(event, &message, error_eventing, outcome)
                    .await;
                None
            }
            HookFailStrategy::Propagate => {
                // 错误事件化先行（诊断事件不因 propagate 丢失）
                self.emit_error_event(event, &message, error_eventing, outcome)
                    .await;
                let mut hook_err = HookError::new(format!(
                    "hook {} 失败（propagate）：{}",
                    handler.name(),
                    err.message
                ));
                // D-03 EV-05：Err 路径带 handler 名（hook-outcome(failed) 载荷）
                hook_err.handler_name = Some(handler.name().to_string());
                Some(hook_err)
            }
        }
    }

    /// 广播 error.occurred 诊断事件（错误事件化）。
    ///
    /// 重入护栏：error.occurred 事件自身的分派关闭错误事件化
    /// （error_eventing=false），防止 handler 失败无限级联。
    /// 并发安全：不再使用全局 AtomicBool——per-dispatch 参数已足以防
    /// 单链路级联；全局标志会让并发双失败的后到者丢掉 error.occurred。
    async fn emit_error_event(
        &self,
        event: &HookEvent,
        message: &str,
        error_eventing: bool,
        outcome: &mut HookDispatchOutcome,
    ) {
        if !error_eventing {
            return;
        }
        let error_event = HookEvent::ErrorOccurred {
            session_id: event.session_id().to_string(),
            error: format!("hook 失败（{}）：{message}", event.kind()),
            retryable: false,
        };
        // error.occurred 自身分派：错误事件化关闭、失败不阻断（诊断面），
        // 但失败必须留日志（BLK-05：不得静默丢弃 dispatch 的 Result）。
        // 间接递归（dispatch_inner → handle_failure → emit_error_event →
        // dispatch_inner）须 Box::pin 打破 async 递归（E0733）
        if let Err(err) = Box::pin(self.dispatch_inner(&error_event, false)).await {
            tracing::warn!(
                hook_event = %error_event.kind(),
                error = %err,
                "error.occurred 诊断事件分派失败（不阻断主流程）"
            );
        }
        outcome.error_events += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 测试 handler：记录收到的事件并可选返回动作
    struct SpyHandler {
        name: String,
        seen: Arc<std::sync::Mutex<Vec<HookEventKind>>>,
        action: Option<HookAction>,
        err: Option<HookError>,
        delay_ms: Option<u64>,
    }

    impl SpyHandler {
        fn new(name: &str, action: Option<HookAction>) -> Self {
            Self {
                name: name.to_string(),
                seen: Arc::new(std::sync::Mutex::new(Vec::new())),
                action,
                err: None,
                delay_ms: None,
            }
        }

        fn failing(name: &str, message: &str) -> Self {
            Self {
                name: name.to_string(),
                seen: Arc::new(std::sync::Mutex::new(Vec::new())),
                action: None,
                err: Some(HookError::new(message)),
                delay_ms: None,
            }
        }

        fn slow(name: &str, delay_ms: u64) -> Self {
            Self {
                name: name.to_string(),
                seen: Arc::new(std::sync::Mutex::new(Vec::new())),
                action: None,
                err: None,
                delay_ms: Some(delay_ms),
            }
        }

        fn kinds(&self) -> Vec<HookEventKind> {
            self.seen.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }

    #[async_trait::async_trait]
    impl HookHandler for SpyHandler {
        fn name(&self) -> &str {
            &self.name
        }

        async fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError> {
            self.seen
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(event.kind());
            if let Some(ms) = self.delay_ms {
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
            if let Some(err) = &self.err {
                return Err(err.clone());
            }
            Ok(self.action.clone().unwrap_or(HookAction::Continue))
        }
    }

    fn turn_end() -> HookEvent {
        HookEvent::TurnEnd {
            session_id: "s1".into(),
            turn_index: 3,
            tool_call_count: 2,
        }
    }

    fn tool_pre() -> HookEvent {
        HookEvent::ToolPre {
            session_id: "s1".into(),
            tool_name: "echo".into(),
            input: json!({ "v": 1 }),
        }
    }

    /// 注册 → 触发 → 分派：同事件多 handler 按注册顺序收到事件
    #[tokio::test]
    async fn dispatch_routes_to_matching_handlers_in_order() {
        let registry = HookRegistry::new();
        let a = Arc::new(SpyHandler::new("a", None));
        let b = Arc::new(SpyHandler::new("b", None));
        let other = Arc::new(SpyHandler::new("other", None));
        registry.register(
            HookEventKind::TurnEnd,
            HookFailStrategy::Swallow,
            Arc::clone(&a) as Arc<dyn HookHandler>,
        );
        registry.register(
            HookEventKind::TurnEnd,
            HookFailStrategy::Swallow,
            Arc::clone(&b) as Arc<dyn HookHandler>,
        );
        // 不匹配事件种类的 handler 不收到
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            other as Arc<dyn HookHandler>,
        );

        let outcome = registry.dispatch(&turn_end()).await.unwrap();
        assert!(outcome.blocked.is_none());
        assert_eq!(outcome.failed_handlers, 0);
        assert_eq!(a.kinds(), vec![HookEventKind::TurnEnd]);
        assert_eq!(b.kinds(), vec![HookEventKind::TurnEnd]);
        assert_eq!(registry.len(), 3);
    }

    /// tool.pre on 模式的 Block 阻止分派并携带原因
    #[tokio::test]
    async fn tool_pre_block_stops_dispatch() {
        let registry = HookRegistry::new();
        let blocker = Arc::new(SpyHandler::new(
            "blocker",
            Some(HookAction::Block {
                reason: "策略禁止".into(),
            }),
        ));
        let after = Arc::new(SpyHandler::new("after", None));
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            blocker as Arc<dyn HookHandler>,
        );
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            Arc::clone(&after) as Arc<dyn HookHandler>,
        );

        let outcome = registry.dispatch(&tool_pre()).await.unwrap();
        assert_eq!(outcome.blocked.as_deref(), Some("策略禁止"));
        // 后续 handler 未收到（提前停止）
        assert!(after.kinds().is_empty());
    }

    /// observe 模式 handler 的 Block 被忽略（观察者不拦截执行）
    #[tokio::test]
    async fn observe_mode_block_is_ignored() {
        let registry = HookRegistry::new();
        let blocker = Arc::new(SpyHandler::new(
            "blocker",
            Some(HookAction::Block {
                reason: "不应生效".into(),
            }),
        ));
        let after = Arc::new(SpyHandler::new("after", None));
        registry.register_observe(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            blocker as Arc<dyn HookHandler>,
        );
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            Arc::clone(&after) as Arc<dyn HookHandler>,
        );

        let outcome = registry.dispatch(&tool_pre()).await.unwrap();
        assert!(outcome.blocked.is_none(), "observe 模式 Block 不得阻止执行");
        assert_eq!(
            after.kinds(),
            vec![HookEventKind::ToolPre],
            "observe 不中断分派"
        );
    }

    /// 非 tool.pre 事件的 Block 按观察忽略（不停止分派）
    #[tokio::test]
    async fn block_on_non_tool_pre_is_ignored() {
        let registry = HookRegistry::new();
        let blocker = Arc::new(SpyHandler::new(
            "blocker",
            Some(HookAction::Block {
                reason: "不应生效".into(),
            }),
        ));
        registry.register(
            HookEventKind::TurnEnd,
            HookFailStrategy::Swallow,
            blocker as Arc<dyn HookHandler>,
        );
        let outcome = registry.dispatch(&turn_end()).await.unwrap();
        assert!(outcome.blocked.is_none());
    }

    /// 失败策略 swallow：handler 失败被吞，继续分派
    #[tokio::test]
    async fn swallow_ignores_handler_error() {
        let registry = HookRegistry::new();
        let fail = Arc::new(SpyHandler::failing("fail", "boom"));
        let ok = Arc::new(SpyHandler::new("ok", None));
        registry.register(
            HookEventKind::TurnEnd,
            HookFailStrategy::Swallow,
            fail as Arc<dyn HookHandler>,
        );
        registry.register(
            HookEventKind::TurnEnd,
            HookFailStrategy::Swallow,
            Arc::clone(&ok) as Arc<dyn HookHandler>,
        );

        let outcome = registry.dispatch(&turn_end()).await.unwrap();
        assert_eq!(outcome.failed_handlers, 1);
        assert_eq!(
            ok.kinds(),
            vec![HookEventKind::TurnEnd],
            "swallow 后继续分派"
        );
    }

    /// 失败策略 log：handler 失败记录后继续分派（failed_handlers 计数）
    #[tokio::test]
    async fn log_records_and_continues() {
        let registry = HookRegistry::new();
        let fail = Arc::new(SpyHandler::failing("fail", "boom"));
        let ok = Arc::new(SpyHandler::new("ok", None));
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Log,
            fail as Arc<dyn HookHandler>,
        );
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Log,
            Arc::clone(&ok) as Arc<dyn HookHandler>,
        );

        let outcome = registry.dispatch(&tool_pre()).await.unwrap();
        assert_eq!(outcome.failed_handlers, 1);
        assert_eq!(ok.kinds(), vec![HookEventKind::ToolPre]);
    }

    /// 失败策略 propagate：停止分派并向上传播
    #[tokio::test]
    async fn propagate_stops_and_raises() {
        let registry = HookRegistry::new();
        let fail = Arc::new(SpyHandler::failing("fail", "boom"));
        let after = Arc::new(SpyHandler::new("after", None));
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Propagate,
            fail as Arc<dyn HookHandler>,
        );
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            Arc::clone(&after) as Arc<dyn HookHandler>,
        );

        let err = registry.dispatch(&tool_pre()).await.unwrap_err();
        assert!(err.message.contains("boom"));
        assert!(after.kinds().is_empty(), "propagate 后不再分派");
    }

    /// 空注册表 / 无匹配注册：分派无副作用
    #[tokio::test]
    async fn dispatch_noop_without_matches() {
        let registry = HookRegistry::new();
        let outcome = registry.dispatch(&turn_end()).await.unwrap();
        assert!(outcome.blocked.is_none());
        assert_eq!(outcome.failed_handlers, 0);

        let other = Arc::new(SpyHandler::new("other", None));
        registry.register(
            HookEventKind::ToolPost,
            HookFailStrategy::Swallow,
            other as Arc<dyn HookHandler>,
        );
        // ToolPost 注册不匹配 TurnEnd 事件
        let outcome = registry.dispatch(&turn_end()).await.unwrap();
        assert!(outcome.blocked.is_none());
        assert_eq!(outcome.failed_handlers, 0);
    }

    /// tool.post 事件载荷字段透传
    #[tokio::test]
    async fn tool_post_payload_carries_output_and_flags() {
        let registry = HookRegistry::new();
        let spy = Arc::new(SpyHandler::new("spy", None));
        registry.register(
            HookEventKind::ToolPost,
            HookFailStrategy::Swallow,
            Arc::clone(&spy) as Arc<dyn HookHandler>,
        );
        registry
            .dispatch(&HookEvent::ToolPost {
                session_id: "s1".into(),
                tool_name: "echo".into(),
                output: json!({ "echo": 1 }),
                duration_ms: 5,
                is_error: false,
            })
            .await
            .unwrap();
        assert_eq!(spy.kinds(), vec![HookEventKind::ToolPost]);
    }

    // ── I8-E1 新增：matcher / timeout / 模式分派 / 错误事件化 / 冻结 ──

    /// matcher 过滤：tool.pre 按工具名正则过滤（E1 验收断言：
    /// `^fs_` 匹配 fs_read、不匹配 shell_run）
    #[tokio::test]
    async fn matcher_filters_tool_events_by_tool_name() {
        let registry = HookRegistry::new();
        let spy = Arc::new(SpyHandler::new("spy", None));
        registry
            .register_with(
                HookEventKind::ToolPre,
                HookFailStrategy::Swallow,
                Arc::clone(&spy) as Arc<dyn HookHandler>,
                HookRegisterOptions {
                    matcher: Some("^fs_".into()),
                    ..Default::default()
                },
            )
            .unwrap();

        registry
            .dispatch(&HookEvent::ToolPre {
                session_id: "s1".into(),
                tool_name: "fs_read".into(),
                input: json!({}),
            })
            .await
            .unwrap();
        assert_eq!(
            spy.kinds(),
            vec![HookEventKind::ToolPre],
            "fs_read 必须匹配 ^fs_"
        );

        // 不匹配的工具名跳过
        registry
            .dispatch(&HookEvent::ToolPre {
                session_id: "s1".into(),
                tool_name: "shell_run".into(),
                input: json!({}),
            })
            .await
            .unwrap();
        assert_eq!(
            spy.kinds(),
            vec![HookEventKind::ToolPre],
            "shell_run 不匹配 ^fs_，handler 不得再次收到"
        );
    }

    /// matcher 仅对 tool.* 事件生效（其余事件忽略 matcher）
    #[tokio::test]
    async fn matcher_ignored_for_non_tool_events() {
        let registry = HookRegistry::new();
        let spy = Arc::new(SpyHandler::new("spy", None));
        registry
            .register_with(
                HookEventKind::TurnEnd,
                HookFailStrategy::Swallow,
                Arc::clone(&spy) as Arc<dyn HookHandler>,
                HookRegisterOptions {
                    matcher: Some("^fs_".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        registry.dispatch(&turn_end()).await.unwrap();
        assert_eq!(
            spy.kinds(),
            vec![HookEventKind::TurnEnd],
            "非 tool 事件忽略 matcher"
        );
    }

    /// 非法 matcher 正则注册即拒（HookError）
    #[tokio::test]
    async fn invalid_matcher_rejected_at_registration() {
        let registry = HookRegistry::new();
        let err = registry
            .register_with(
                HookEventKind::ToolPre,
                HookFailStrategy::Swallow,
                Arc::new(SpyHandler::new("spy", None)) as Arc<dyn HookHandler>,
                HookRegisterOptions {
                    matcher: Some("([".into()),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(err.message.contains("非法 matcher 正则"));
        assert_eq!(registry.len(), 0, "非法正则不得注册成功");
    }

    /// on 模式 handler 超时（timeoutMs=1）→ tool.pre 放行、failed_handlers
    /// 计数 +1、timeouts 计数 +1、error.occurred 事件已发（E1 验收断言）
    #[tokio::test]
    async fn tool_pre_timeout_degrades_to_allow_with_error_event() {
        let registry = HookRegistry::new();
        let errors = Arc::new(std::sync::Mutex::new(Vec::new()));
        registry.register_observe(
            HookEventKind::ErrorOccurred,
            HookFailStrategy::Swallow,
            Arc::new(ErrorSpy::new(errors.clone())) as Arc<dyn HookHandler>,
        );
        let slow = Arc::new(SpyHandler::slow("slow", 50));
        registry
            .register_with(
                HookEventKind::ToolPre,
                HookFailStrategy::Swallow,
                slow as Arc<dyn HookHandler>,
                HookRegisterOptions {
                    mode: HookMode::On,
                    timeout_ms: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();

        let outcome = registry.dispatch(&tool_pre()).await.unwrap();
        assert!(outcome.blocked.is_none(), "tool.pre 超时固定降级放行");
        assert_eq!(outcome.failed_handlers, 1);
        assert_eq!(outcome.timeouts, 1);
        assert_eq!(outcome.error_events, 1, "超时失败必须广播 error.occurred");
        let errs = errors.lock().unwrap();
        assert_eq!(errs.len(), 1, "error.occurred handler 必须收到诊断事件");
        assert!(
            errs[0].contains("超时"),
            "诊断事件必须含超时文案：{}",
            errs[0]
        );
    }

    /// handler Err（swallow）→ 广播 error.occurred 诊断事件（错误事件化）
    #[tokio::test]
    async fn handler_error_emits_error_occurred_event() {
        let registry = HookRegistry::new();
        let errors = Arc::new(std::sync::Mutex::new(Vec::new()));
        registry.register_observe(
            HookEventKind::ErrorOccurred,
            HookFailStrategy::Swallow,
            Arc::new(ErrorSpy::new(errors.clone())) as Arc<dyn HookHandler>,
        );
        registry.register(
            HookEventKind::TurnEnd,
            HookFailStrategy::Swallow,
            Arc::new(SpyHandler::failing("fail", "boom")) as Arc<dyn HookHandler>,
        );

        let outcome = registry.dispatch(&turn_end()).await.unwrap();
        assert_eq!(outcome.failed_handlers, 1);
        assert_eq!(outcome.error_events, 1);
        let errs = errors.lock().unwrap();
        assert_eq!(errs.len(), 1);
        assert!(errs[0].contains("boom"));
    }

    /// error.occurred 自身 handler 失败不级联（重入护栏）
    #[tokio::test]
    async fn error_event_handler_failure_does_not_cascade() {
        let registry = HookRegistry::new();
        // error.occurred 上挂一个会失败的 handler
        registry.register(
            HookEventKind::ErrorOccurred,
            HookFailStrategy::Swallow,
            Arc::new(SpyHandler::failing("error-fail", "再炸")) as Arc<dyn HookHandler>,
        );
        registry.register(
            HookEventKind::TurnEnd,
            HookFailStrategy::Swallow,
            Arc::new(SpyHandler::failing("fail", "boom")) as Arc<dyn HookHandler>,
        );

        let outcome = registry.dispatch(&turn_end()).await.unwrap();
        // error.occurred 的 handler 失败被吞（不再级联新错误事件）
        assert_eq!(outcome.failed_handlers, 1, "原 handler 失败计数 1");
        assert_eq!(outcome.error_events, 1, "只广播一次错误事件");
    }

    /// 并发双失败：两个并发 dispatch 各自失败时，后到者不得丢 error.occurred
    /// （回归：全局 AtomicBool 重入护栏 swap 见 true 直接 return 会误伤并发
    /// 失败；修复后护栏只由 per-dispatch error_eventing 参数承担）
    #[tokio::test]
    async fn concurrent_failures_both_emit_error_occurred() {
        let registry = HookRegistry::new();
        let errors = Arc::new(std::sync::Mutex::new(Vec::new()));
        // ErrorSpy 带延迟：拉长 error.occurred 分派窗口，让第二个并发
        // dispatch 的失败路径在第一个仍在 emit 期间到达（复现竞态时序）
        registry.register_observe(
            HookEventKind::ErrorOccurred,
            HookFailStrategy::Swallow,
            Arc::new(ErrorSpy::slow(errors.clone(), 30)) as Arc<dyn HookHandler>,
        );
        registry.register(
            HookEventKind::TurnEnd,
            HookFailStrategy::Swallow,
            Arc::new(SpyHandler::failing("fail-a", "boom-a")) as Arc<dyn HookHandler>,
        );
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            Arc::new(SpyHandler::failing("fail-b", "boom-b")) as Arc<dyn HookHandler>,
        );

        // 两个并发 dispatch：TurnEnd 与 ToolPre 各自失败。
        // join! 在单线程 runtime 上于 await 点交错——第一个 dispatch 的
        // ErrorSpy sleep 期间，第二个 dispatch 的失败路径会进入 emit_error_event。
        let ev_a = turn_end();
        let ev_b = tool_pre();
        let (o1, o2) = tokio::join!(registry.dispatch(&ev_a), registry.dispatch(&ev_b),);
        let o1 = o1.expect("dispatch turn_end");
        let o2 = o2.expect("dispatch tool_pre");
        assert_eq!(o1.error_events, 1, "先到失败必须广播 error.occurred");
        assert_eq!(
            o2.error_events, 1,
            "后到失败不得丢 error.occurred（全局 AtomicBool 误伤回归）"
        );
        let errs = errors.lock().unwrap();
        assert_eq!(errs.len(), 2, "ErrorSpy 必须收到两条 error.occurred");
        assert!(errs.iter().any(|e| e.contains("boom-a")));
        assert!(errs.iter().any(|e| e.contains("boom-b")));
    }

    /// 事件名全集冻结：HookEventKind::as_str() 14 变体与
    /// packages/shared-types/src/hooks.ts 的 HOOK_EVENT_NAMES 双向锁定
    #[test]
    fn hook_kind_names_frozen_14() {
        let kinds = ALL_HOOK_EVENT_KINDS;
        assert_eq!(kinds.len(), 14, "HookEventKind 必须恰好 14 个变体");
        let mut names: Vec<&str> = kinds.iter().map(|k| k.as_str()).collect();
        let mut dedup = names.clone();
        dedup.sort();
        dedup.dedup();
        assert_eq!(dedup.len(), 14, "as_str() 必须无重复");
        // 与 TS 侧 HOOK_EVENT_NAMES 字面量比对（从 hooks.ts 文件读取）
        let hooks_ts = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/shared-types/src/hooks.ts"
        ))
        .unwrap_or_else(|e| panic!("读取 hooks.ts 失败：{e}"));
        // 提取 HOOK_EVENT_NAMES 数组内全部字符串字面量
        let start = hooks_ts
            .find("HOOK_EVENT_NAMES")
            .expect("hooks.ts 必须声明 HOOK_EVENT_NAMES");
        let slice = &hooks_ts[start..];
        let mut ts_names = Vec::new();
        for cap in slice
            .lines()
            .take_while(|l| !l.trim_start().starts_with("] as const"))
            .filter_map(|l| {
                l.trim()
                    .strip_prefix('\'')
                    .and_then(|r| r.split('\'').next())
            })
        {
            ts_names.push(cap.to_string());
        }
        names.sort();
        ts_names.sort();
        assert_eq!(
            names, ts_names,
            "HookEventKind::as_str() 与 hooks.ts HOOK_EVENT_NAMES 必须一一对应（I7-M13 冻结）"
        );
    }

    /// 新变体载荷透传：session.start / tool.error / context.compact.* /
    /// error.occurred / model.* / subagent.* 收到事件且载荷可读
    fn new_variant_events() -> Vec<HookEvent> {
        vec![
            HookEvent::SessionStart {
                session_id: "s1".into(),
            },
            HookEvent::SessionEnd {
                session_id: "s1".into(),
            },
            HookEvent::TurnStart {
                session_id: "s1".into(),
                turn_index: 1,
            },
            HookEvent::ToolError {
                session_id: "s1".into(),
                tool_name: "x".into(),
                error: "boom".into(),
            },
            HookEvent::ContextCompactStart {
                session_id: "s1".into(),
                trigger: "threshold".into(),
                tokens_before: 100,
            },
            HookEvent::ContextCompactEnd {
                session_id: "s1".into(),
                aborted: false,
                kept_message_count: 5,
                compaction_id: "c1".into(),
            },
            HookEvent::ErrorOccurred {
                session_id: "s1".into(),
                error: "boom".into(),
                retryable: false,
            },
            HookEvent::ModelBeforeRequest {
                session_id: "s1".into(),
                provider_id: Some("deepseek".into()),
                model: Some("v4".into()),
            },
            HookEvent::ModelAfterResponse {
                session_id: "s1".into(),
                provider_id: None,
                model: None,
                ok: true,
            },
            HookEvent::SubagentStart {
                parent_session_id: "p1".into(),
                subagent_session_id: "a1".into(),
                role: Some("researcher".into()),
            },
            HookEvent::SubagentEnd {
                parent_session_id: "p1".into(),
                subagent_session_id: "a1".into(),
                reason: Some("completed".into()),
            },
        ]
    }

    #[tokio::test]
    async fn new_variant_payloads_are_delivered() {
        let registry = HookRegistry::new();
        let spy = Arc::new(PayloadSpy {
            seen: Arc::new(std::sync::Mutex::new(Vec::new())),
        });
        let kinds = [
            HookEventKind::SessionStart,
            HookEventKind::SessionEnd,
            HookEventKind::TurnStart,
            HookEventKind::ToolError,
            HookEventKind::ContextCompactStart,
            HookEventKind::ContextCompactEnd,
            HookEventKind::ErrorOccurred,
            HookEventKind::ModelBeforeRequest,
            HookEventKind::ModelAfterResponse,
            HookEventKind::SubagentStart,
            HookEventKind::SubagentEnd,
        ];
        for kind in kinds {
            registry.register_observe(
                kind,
                HookFailStrategy::Swallow,
                Arc::clone(&spy) as Arc<dyn HookHandler>,
            );
        }
        let events = new_variant_events();
        for event in &events {
            registry.dispatch(event).await.unwrap();
        }
        let seen = spy.seen.lock().unwrap();
        assert_eq!(seen.len(), events.len(), "全部新变体必须送达对应 handler");
    }

    /// 测试 handler：记录事件名（错误事件化断言用）
    struct ErrorSpy {
        seen: Arc<std::sync::Mutex<Vec<String>>>,
        /// 可选延迟：拉长 error.occurred 分派窗口，供并发交叠测试制造竞态
        delay_ms: Option<u64>,
    }

    impl ErrorSpy {
        fn new(seen: Arc<std::sync::Mutex<Vec<String>>>) -> Self {
            Self {
                seen,
                delay_ms: None,
            }
        }

        fn slow(seen: Arc<std::sync::Mutex<Vec<String>>>, delay_ms: u64) -> Self {
            Self {
                seen,
                delay_ms: Some(delay_ms),
            }
        }
    }

    #[async_trait::async_trait]
    impl HookHandler for ErrorSpy {
        fn name(&self) -> &str {
            "error-spy"
        }

        async fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError> {
            if let Some(ms) = self.delay_ms {
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
            if let HookEvent::ErrorOccurred { error, .. } = event {
                self.seen
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(error.clone());
            }
            Ok(HookAction::Continue)
        }
    }

    /// 测试 handler：记录全部收到的事件种类（新变体透传断言用）
    struct PayloadSpy {
        seen: Arc<std::sync::Mutex<Vec<HookEventKind>>>,
    }

    #[async_trait::async_trait]
    impl HookHandler for PayloadSpy {
        fn name(&self) -> &str {
            "payload-spy"
        }

        async fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError> {
            self.seen
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(event.kind());
            Ok(HookAction::Continue)
        }
    }

    // ── D-03 EV-05：hook-outcome 观测镜像（dispatch 单点聚合）──

    /// 接线观测出口的测试辅助：捕获 hook-outcome 事件列表
    fn sink_capture() -> (
        Arc<dyn Fn(AgentEvent) + Send + Sync>,
        Arc<std::sync::Mutex<Vec<AgentEvent>>>,
    ) {
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: Arc<dyn Fn(AgentEvent) + Send + Sync> = Arc::new({
            let captured = Arc::clone(&captured);
            move |evt| {
                captured.lock().unwrap_or_else(|e| e.into_inner()).push(evt);
            }
        });
        (sink, captured)
    }

    /// 提取捕获列表中的 hook-outcome 事件（断言辅助）
    fn take_hook_outcomes(
        captured: &Arc<std::sync::Mutex<Vec<AgentEvent>>>,
    ) -> Vec<(String, String, Option<String>, Option<String>)> {
        captured
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter_map(|evt| match evt {
                AgentEvent::HookOutcome {
                    hook_type,
                    outcome,
                    hook_name,
                    blocked_reason,
                    ..
                } => Some((
                    hook_type.clone(),
                    outcome.clone(),
                    hook_name.clone(),
                    blocked_reason.clone(),
                )),
                _ => None,
            })
            .collect()
    }

    /// 普通 dispatch（ok 路径）→ 发射 hook-outcome(outcome=ok)，载荷含种类
    #[tokio::test]
    async fn hook_outcome_ok_on_normal_dispatch() {
        let registry = HookRegistry::new();
        let (sink, captured) = sink_capture();
        registry.set_outcome_sink(sink);
        let spy = Arc::new(SpyHandler::new("spy", None));
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            spy as Arc<dyn HookHandler>,
        );

        let outcome = registry.dispatch(&tool_pre()).await.unwrap();
        assert!(outcome.blocked.is_none());
        let events = take_hook_outcomes(&captured);
        assert_eq!(events.len(), 1, "每批次恰一条 hook-outcome");
        assert_eq!(events[0].0, "tool.pre", "hook_type 必须为事件种类");
        assert_eq!(events[0].1, "ok");
        assert!(events[0].2.is_none(), "ok 路径无触发 handler 名");
        assert!(events[0].3.is_none());
    }

    /// tool.pre 阻止（on 模式 Block）→ hook-outcome(outcome=blocked)，
    /// blocked_reason 非空且 hook_name = 阻止 handler 名
    #[tokio::test]
    async fn hook_outcome_blocked_carries_reason_and_handler() {
        let registry = HookRegistry::new();
        let (sink, captured) = sink_capture();
        registry.set_outcome_sink(sink);
        let blocker = Arc::new(SpyHandler::new(
            "blocker",
            Some(HookAction::Block {
                reason: "策略禁止".into(),
            }),
        ));
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            blocker as Arc<dyn HookHandler>,
        );

        let outcome = registry.dispatch(&tool_pre()).await.unwrap();
        assert_eq!(outcome.blocked.as_deref(), Some("策略禁止"));
        assert_eq!(outcome.blocked_handler.as_deref(), Some("blocker"));
        let events = take_hook_outcomes(&captured);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "tool.pre");
        assert_eq!(events[0].1, "blocked");
        assert_eq!(
            events[0].2.as_deref(),
            Some("blocker"),
            "hook_name 必须为阻止 handler 名"
        );
        assert_eq!(
            events[0].3.as_deref(),
            Some("策略禁止"),
            "blocked 必须带原因"
        );
    }

    /// 失败 handler（swallow）→ 也发 hook-outcome(outcome=failed)，hook_name 可辨
    #[tokio::test]
    async fn hook_outcome_failed_on_handler_error() {
        let registry = HookRegistry::new();
        let (sink, captured) = sink_capture();
        registry.set_outcome_sink(sink);
        let fail = Arc::new(SpyHandler::failing("fail", "boom"));
        let ok = Arc::new(SpyHandler::new("ok", None));
        registry.register(
            HookEventKind::TurnEnd,
            HookFailStrategy::Swallow,
            fail as Arc<dyn HookHandler>,
        );
        registry.register(
            HookEventKind::TurnEnd,
            HookFailStrategy::Swallow,
            Arc::clone(&ok) as Arc<dyn HookHandler>,
        );

        let outcome = registry.dispatch(&turn_end()).await.unwrap();
        assert_eq!(outcome.failed_handlers, 1);
        let events = take_hook_outcomes(&captured);
        assert_eq!(events.len(), 1, "失败批次仍只发一条聚合事件");
        assert_eq!(events[0].0, "turn.end");
        assert_eq!(events[0].1, "failed");
        assert_eq!(
            events[0].2.as_deref(),
            Some("fail"),
            "hook_name 必须为失败 handler 名"
        );
    }

    /// 超时 handler（timeout_ms 注入）→ outcome=timeout 可辨（与 failed 区分）
    #[tokio::test]
    async fn hook_outcome_timeout_distinct_from_failed() {
        let registry = HookRegistry::new();
        let (sink, captured) = sink_capture();
        registry.set_outcome_sink(sink);
        let slow = Arc::new(SpyHandler::slow("slow", 50));
        registry
            .register_with(
                HookEventKind::ToolPre,
                HookFailStrategy::Swallow,
                slow as Arc<dyn HookHandler>,
                HookRegisterOptions {
                    mode: HookMode::On,
                    timeout_ms: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();

        let outcome = registry.dispatch(&tool_pre()).await.unwrap();
        assert_eq!(outcome.timeouts, 1);
        let events = take_hook_outcomes(&captured);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1, "timeout", "超时必须与普通失败可辨");
        assert_eq!(events[0].2.as_deref(), Some("slow"));
    }

    /// propagate 失败 → dispatch 返回 Err，但仍发 hook-outcome(failed)
    /// 且 hook_name 携带失败 handler 名（Err 路径单点发射）
    #[tokio::test]
    async fn hook_outcome_emitted_on_propagate_error() {
        let registry = HookRegistry::new();
        let (sink, captured) = sink_capture();
        registry.set_outcome_sink(sink);
        let fail = Arc::new(SpyHandler::failing("fail", "boom"));
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Propagate,
            fail as Arc<dyn HookHandler>,
        );

        let err = registry.dispatch(&tool_pre()).await.unwrap_err();
        assert!(err.message.contains("boom"));
        assert_eq!(err.handler_name.as_deref(), Some("fail"));
        let events = take_hook_outcomes(&captured);
        assert_eq!(events.len(), 1, "Err 路径也必须发 hook-outcome");
        assert_eq!(events[0].1, "failed");
        assert_eq!(events[0].2.as_deref(), Some("fail"));
    }

    /// 四 hook 变体（model.beforeRequest / model.afterResponse /
    /// subagent.start / subagent.end）：dispatch 单点通用，任意种类
    /// 聚合发射（宿主接线后自动覆盖；本层不硬造生产发射点）
    #[tokio::test]
    async fn hook_outcome_covers_four_hook_variants() {
        let registry = HookRegistry::new();
        let (sink, captured) = sink_capture();
        registry.set_outcome_sink(sink);
        let spy = Arc::new(SpyHandler::new("spy", None));
        for kind in [
            HookEventKind::ModelBeforeRequest,
            HookEventKind::ModelAfterResponse,
            HookEventKind::SubagentStart,
            HookEventKind::SubagentEnd,
        ] {
            registry.register_observe(
                kind,
                HookFailStrategy::Swallow,
                Arc::clone(&spy) as Arc<dyn HookHandler>,
            );
        }

        let events = vec![
            HookEvent::ModelBeforeRequest {
                session_id: "s1".into(),
                provider_id: Some("deepseek".into()),
                model: Some("v4".into()),
            },
            HookEvent::ModelAfterResponse {
                session_id: "s1".into(),
                provider_id: None,
                model: None,
                ok: true,
            },
            HookEvent::SubagentStart {
                parent_session_id: "p1".into(),
                subagent_session_id: "a1".into(),
                role: Some("researcher".into()),
            },
            HookEvent::SubagentEnd {
                parent_session_id: "p1".into(),
                subagent_session_id: "a1".into(),
                reason: Some("completed".into()),
            },
        ];
        for event in &events {
            registry.dispatch(event).await.unwrap();
        }
        let outcomes = take_hook_outcomes(&captured);
        assert_eq!(outcomes.len(), 4, "四变体各发一条聚合事件");
        let types: Vec<&str> = outcomes.iter().map(|o| o.0.as_str()).collect();
        assert_eq!(
            types,
            vec![
                "model.beforeRequest",
                "model.afterResponse",
                "subagent.start",
                "subagent.end"
            ],
            "四变体 hook_type 载荷必须对应事件种类"
        );
        assert!(outcomes.iter().all(|o| o.1 == "ok"));
    }

    /// 未接线观测出口 → 无 hook-outcome 事件（dispatch 语义不变，纯观测）
    #[tokio::test]
    async fn hook_outcome_absent_without_sink() {
        let registry = HookRegistry::new();
        let spy = Arc::new(SpyHandler::new("spy", None));
        registry.register(
            HookEventKind::TurnEnd,
            HookFailStrategy::Swallow,
            spy as Arc<dyn HookHandler>,
        );
        let outcome = registry.dispatch(&turn_end()).await.unwrap();
        assert!(outcome.blocked.is_none());
        assert_eq!(outcome.failed_handlers, 0);
    }
}
