//! 插件钩子运行时骨架（对齐 packages/shared-types/src/hooks.ts 事件面）
//!
//! 职责：Rust 侧 hook 注册/分派机制——[HookRegistry] 广播事件给注册的
//! handler，失败策略对齐 plugin-sdk 的 `HookFailStrategy` 类型语义
//! （'swallow' | 'log' | 'propagate'）。本轮实现事件：turn.end /
//! tool.pre / tool.post；后续生态轮扩展事件（session.start /
//! model.beforeRequest 等）直接加 [HookEventKind] 变体即可。
//!
//! 接线决策（详见 docs/multi-agent-repair/06-tool-middleware-hook-接线决策.md）：
//! - turn.end：`loop/handlers/turn_complete.rs` 步骤 4.5（编排层
//!   turn_end_hook 之后、maxTurns 之前），handler 返回 Block = stop 建议；
//! - tool.pre / tool.post：`tool_exec.rs::ToolExecutor::execute_single`
//!   内，与 ToolMiddleware 链共享同一点位（顺序：middleware before 链 →
//!   tool.pre 广播 → 执行 → tool.post 广播 → middleware on_result /
//!   on_error 链）；
//! - RecoveryHook（F6 冻结签名 `decide(&CrishError, state)`）**不并入**
//!   事件分派：它是同步裁决语义（Retry/Skip/Abort）而非观察事件，保持
//!   原接口；后续生态轮可新增 Recovery 观察变体。
//!
//! 失败策略语义（propagate 不中断会话）：
//! - tool.pre 的 propagate 失败 → 该工具调用以执行失败结果收场，批继续；
//! - turn.end 的 propagate 失败 → 记录日志后收场流程继续。

use serde_json::Value;
use std::fmt;
use std::sync::{Arc, RwLock};

/// 事件种类（注册与分派的匹配键）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HookEventKind {
    /// 轮次结束（hooks.ts turn.end）
    TurnEnd,
    /// 工具执行前（hooks.ts tool.pre）
    ToolPre,
    /// 工具执行后（hooks.ts tool.post）
    ToolPost,
}

impl HookEventKind {
    /// 事件名（对齐 hooks.ts 点分命名）
    pub fn as_str(&self) -> &'static str {
        match self {
            HookEventKind::TurnEnd => "turn.end",
            HookEventKind::ToolPre => "tool.pre",
            HookEventKind::ToolPost => "tool.post",
        }
    }
}

impl fmt::Display for HookEventKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 钩子事件载荷（对齐 hooks.ts 对应 payload 最小子集）
#[derive(Debug, Clone)]
pub enum HookEvent {
    /// turn.end：hooks.ts TurnEndPayload（outcome 由调用方按收场推导）
    TurnEnd {
        session_id: String,
        turn_index: u32,
        tool_call_count: u32,
    },
    /// tool.pre：hooks.ts ToolPrePayload
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
}

impl HookEvent {
    /// 事件种类
    pub fn kind(&self) -> HookEventKind {
        match self {
            HookEvent::TurnEnd { .. } => HookEventKind::TurnEnd,
            HookEvent::ToolPre { .. } => HookEventKind::ToolPre,
            HookEvent::ToolPost { .. } => HookEventKind::ToolPost,
        }
    }
}

/// handler 动作
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookAction {
    /// 放行（观察类默认）
    Continue,
    /// 阻止（仅 tool.pre 语义有效：阻止工具执行；其余事件按观察忽略并记录）
    Block { reason: String },
}

/// hook 运行时错误（Propagate 策略下向上传播给调用方）
#[derive(Debug, Clone)]
pub struct HookError {
    /// 错误文案
    pub message: String,
}

impl HookError {
    /// 新建错误
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
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

/// 钩子 handler（同步回调；生态轮转 async 时改 async_trait，调用点仅两处）
pub trait HookHandler: Send + Sync {
    /// handler 名（日志 / 调试）
    fn name(&self) -> &str;

    /// 处理事件
    fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError>;
}

/// 分派结果（供调用方与测试断言）
#[derive(Debug, Clone, Default)]
pub struct HookDispatchOutcome {
    /// 是否被 handler 阻止（仅 tool.pre 产生；reason 为阻止原因）
    pub blocked: Option<String>,
    /// 被 swallow / log 策略吞掉的 handler 失败数
    pub failed_handlers: usize,
}

/// 注册表条目
struct HandlerEntry {
    kind: HookEventKind,
    strategy: HookFailStrategy,
    handler: Arc<dyn HookHandler>,
}

/// 钩子注册表（广播分派；线程安全，可跨 run 复用）
#[derive(Default)]
pub struct HookRegistry {
    entries: RwLock<Vec<HandlerEntry>>,
}

impl HookRegistry {
    /// 新建空注册表
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册 handler（按事件种类 + 失败策略；分派按注册顺序）
    pub fn register(
        &self,
        kind: HookEventKind,
        strategy: HookFailStrategy,
        handler: Arc<dyn HookHandler>,
    ) {
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
                handler,
            });
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
    /// 语义：
    /// - handler 返回 Block 且事件为 tool.pre → 立即停止分派并返回阻止；
    /// - handler 返回 Block 但事件非 tool.pre → 观察语义下忽略并记录；
    /// - handler 返回 Err → 按该 handler 注册的失败策略处置。
    pub fn dispatch(&self, event: &HookEvent) -> Result<HookDispatchOutcome, HookError> {
        // 快照克隆（读锁不跨 handler 调用持有，避免 handler 内注册死锁）
        let snapshot = self
            .entries
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
                    Arc::clone(&entry.handler),
                )
            })
            .collect::<Vec<_>>();

        let mut outcome = HookDispatchOutcome::default();
        for (kind, strategy, handler) in snapshot {
            if kind != event.kind() {
                continue;
            }
            match handler.handle(event) {
                Ok(HookAction::Continue) => {}
                Ok(HookAction::Block { reason }) => {
                    if event.kind() == HookEventKind::ToolPre {
                        outcome.blocked = Some(reason);
                        return Ok(outcome);
                    }
                    // 非 tool.pre 的 Block：观察语义下忽略（仅记录）
                    tracing::warn!(
                        hook = %handler.name(),
                        event = %event.kind(),
                        reason = %reason,
                        "非 tool.pre 事件返回 Block，按观察忽略"
                    );
                }
                Err(e) => match strategy {
                    HookFailStrategy::Swallow => {
                        outcome.failed_handlers += 1;
                    }
                    HookFailStrategy::Log => {
                        tracing::warn!(hook = %handler.name(), event = %event.kind(), error = %e, "hook 失败（log 策略）");
                        outcome.failed_handlers += 1;
                    }
                    HookFailStrategy::Propagate => {
                        return Err(HookError::new(format!(
                            "hook {} 失败（propagate）：{}",
                            handler.name(),
                            e.message
                        )));
                    }
                },
            }
        }
        Ok(outcome)
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
    }

    impl SpyHandler {
        fn new(name: &str, action: Option<HookAction>) -> Self {
            Self {
                name: name.to_string(),
                seen: Arc::new(std::sync::Mutex::new(Vec::new())),
                action,
                err: None,
            }
        }

        fn failing(name: &str, message: &str) -> Self {
            Self {
                name: name.to_string(),
                seen: Arc::new(std::sync::Mutex::new(Vec::new())),
                action: None,
                err: Some(HookError::new(message)),
            }
        }

        fn kinds(&self) -> Vec<HookEventKind> {
            self.seen
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        }
    }

    impl HookHandler for SpyHandler {
        fn name(&self) -> &str {
            &self.name
        }

        fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError> {
            self.seen
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(event.kind());
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
    #[test]
    fn dispatch_routes_to_matching_handlers_in_order() {
        let registry = HookRegistry::new();
        let a = Arc::new(SpyHandler::new("a", None));
        let b = Arc::new(SpyHandler::new("b", None));
        let other = Arc::new(SpyHandler::new("other", None));
        registry.register(HookEventKind::TurnEnd, HookFailStrategy::Swallow, Arc::clone(&a) as Arc<dyn HookHandler>);
        registry.register(HookEventKind::TurnEnd, HookFailStrategy::Swallow, Arc::clone(&b) as Arc<dyn HookHandler>);
        // 不匹配事件种类的 handler 不收到
        registry.register(HookEventKind::ToolPre, HookFailStrategy::Swallow, other as Arc<dyn HookHandler>);

        let outcome = registry.dispatch(&turn_end()).unwrap();
        assert!(outcome.blocked.is_none());
        assert_eq!(outcome.failed_handlers, 0);
        assert_eq!(a.kinds(), vec![HookEventKind::TurnEnd]);
        assert_eq!(b.kinds(), vec![HookEventKind::TurnEnd]);
        assert_eq!(registry.len(), 3);
    }

    /// tool.pre 的 Block 阻止分派并携带原因
    #[test]
    fn tool_pre_block_stops_dispatch() {
        let registry = HookRegistry::new();
        let blocker = Arc::new(SpyHandler::new(
            "blocker",
            Some(HookAction::Block {
                reason: "策略禁止".into(),
            }),
        ));
        let after = Arc::new(SpyHandler::new("after", None));
        registry.register(HookEventKind::ToolPre, HookFailStrategy::Swallow, blocker as Arc<dyn HookHandler>);
        registry.register(HookEventKind::ToolPre, HookFailStrategy::Swallow, Arc::clone(&after) as Arc<dyn HookHandler>);

        let outcome = registry.dispatch(&tool_pre()).unwrap();
        assert_eq!(outcome.blocked.as_deref(), Some("策略禁止"));
        // 后续 handler 未收到（提前停止）
        assert!(after.kinds().is_empty());
    }

    /// 非 tool.pre 事件的 Block 按观察忽略（不停止分派）
    #[test]
    fn block_on_non_tool_pre_is_ignored() {
        let registry = HookRegistry::new();
        let blocker = Arc::new(SpyHandler::new(
            "blocker",
            Some(HookAction::Block {
                reason: "不应生效".into(),
            }),
        ));
        registry.register(HookEventKind::TurnEnd, HookFailStrategy::Swallow, blocker as Arc<dyn HookHandler>);
        let outcome = registry.dispatch(&turn_end()).unwrap();
        assert!(outcome.blocked.is_none());
    }

    /// 失败策略 swallow：handler 失败被吞，继续分派
    #[test]
    fn swallow_ignores_handler_error() {
        let registry = HookRegistry::new();
        let fail = Arc::new(SpyHandler::failing("fail", "boom"));
        let ok = Arc::new(SpyHandler::new("ok", None));
        registry.register(HookEventKind::TurnEnd, HookFailStrategy::Swallow, fail as Arc<dyn HookHandler>);
        registry.register(HookEventKind::TurnEnd, HookFailStrategy::Swallow, Arc::clone(&ok) as Arc<dyn HookHandler>);

        let outcome = registry.dispatch(&turn_end()).unwrap();
        assert_eq!(outcome.failed_handlers, 1);
        assert_eq!(ok.kinds(), vec![HookEventKind::TurnEnd], "swallow 后继续分派");
    }

    /// 失败策略 log：handler 失败记录后继续分派（failed_handlers 计数）
    #[test]
    fn log_records_and_continues() {
        let registry = HookRegistry::new();
        let fail = Arc::new(SpyHandler::failing("fail", "boom"));
        let ok = Arc::new(SpyHandler::new("ok", None));
        registry.register(HookEventKind::ToolPre, HookFailStrategy::Log, fail as Arc<dyn HookHandler>);
        registry.register(HookEventKind::ToolPre, HookFailStrategy::Log, Arc::clone(&ok) as Arc<dyn HookHandler>);

        let outcome = registry.dispatch(&tool_pre()).unwrap();
        assert_eq!(outcome.failed_handlers, 1);
        assert_eq!(ok.kinds(), vec![HookEventKind::ToolPre]);
    }

    /// 失败策略 propagate：停止分派并向上传播
    #[test]
    fn propagate_stops_and_raises() {
        let registry = HookRegistry::new();
        let fail = Arc::new(SpyHandler::failing("fail", "boom"));
        let after = Arc::new(SpyHandler::new("after", None));
        registry.register(HookEventKind::ToolPre, HookFailStrategy::Propagate, fail as Arc<dyn HookHandler>);
        registry.register(HookEventKind::ToolPre, HookFailStrategy::Swallow, Arc::clone(&after) as Arc<dyn HookHandler>);

        let err = registry.dispatch(&tool_pre()).unwrap_err();
        assert!(err.message.contains("boom"));
        assert!(after.kinds().is_empty(), "propagate 后不再分派");
    }

    /// 空注册表 / 无匹配注册：分派无副作用
    #[test]
    fn dispatch_noop_without_matches() {
        let registry = HookRegistry::new();
        let outcome = registry.dispatch(&turn_end()).unwrap();
        assert!(outcome.blocked.is_none());
        assert_eq!(outcome.failed_handlers, 0);

        let other = Arc::new(SpyHandler::new("other", None));
        registry.register(HookEventKind::ToolPost, HookFailStrategy::Swallow, other as Arc<dyn HookHandler>);
        // ToolPost 注册不匹配 TurnEnd 事件
        let outcome = registry.dispatch(&turn_end()).unwrap();
        assert!(outcome.blocked.is_none());
        assert_eq!(outcome.failed_handlers, 0);
    }

    /// tool.post 事件载荷字段透传
    #[test]
    fn tool_post_payload_carries_output_and_flags() {
        let registry = HookRegistry::new();
        let spy = Arc::new(SpyHandler::new("spy", None));
        registry.register(HookEventKind::ToolPost, HookFailStrategy::Swallow, Arc::clone(&spy) as Arc<dyn HookHandler>);
        registry
            .dispatch(&HookEvent::ToolPost {
                session_id: "s1".into(),
                tool_name: "echo".into(),
                output: json!({ "echo": 1 }),
                duration_ms: 5,
                is_error: false,
            })
            .unwrap();
        assert_eq!(spy.kinds(), vec![HookEventKind::ToolPost]);
    }
}
