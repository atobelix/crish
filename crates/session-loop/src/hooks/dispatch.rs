use super::registry::HookRegistry;
use super::types::{
    HookAction, HookDispatchOutcome, HookError, HookEvent, HookEventKind, HookFailStrategy,
    HookHandler, HookMode, InvokeResult,
};
use conex_types::events::AgentEvent;
use std::sync::Arc;
use std::time::Duration;

impl HookRegistry {
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
