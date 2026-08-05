//! 事件归一化（B4.4，对齐 03 §5.2-2 / §5.3-2 / 00 D1）
//!
//! 本模块是 orchestrator 所有 emit 出口的**统一归一化点**：
//! - **runId/sessionId 注入**（03 §5.3-2）：emit 前经
//!   [normalize_envelope] 统一处理——信封注入 runId（已有不覆盖），
//!   事件体内 `sessionId` / `run-terminal.runId` 缺失（空串）时补齐，
//!   保证 `messageBelongsToRun` 过滤与 streamRecovery 键控可用
//!   （03 §5.1-16：终态事件 runId 必须存在）；
//! - **终态收敛**（03 §5.2-2）：run-terminal 为**唯一**终态事件，
//!   原 `is_terminal_run_event` 依赖 run-completed/run-failed/
//!   run-cancelled/run-ended 别名，别名已删除，判据收敛为
//!   [is_terminal_event]；
//! - **cooperative stop**（00 D1）：agent-end reason 与 run 终态一致
//!   （[terminal_status_for_end_reason]，委托 run.rs 单一权威映射，T08.9）；
//!   stopped 终态**不触发自动续轮**
//!   （[allows_auto_continue]，配合 goal 模式轮次策略）。

use conex_types::events::{AgentEvent, AgentEventEnvelope, RunTerminalStatus};
use conex_types::session::AgentEndReason;

/// 事件体 `sessionId` 字段的可变引用（全部 27 种事件均携带该字段）
fn event_session_id_mut(event: &mut AgentEvent) -> &mut String {
    match event {
        AgentEvent::AgentStart { session_id, .. } => session_id,
        AgentEvent::AgentEnd { session_id, .. } => session_id,
        AgentEvent::TurnStart { session_id, .. } => session_id,
        AgentEvent::TurnEnd { session_id, .. } => session_id,
        AgentEvent::MessageStart { session_id, .. } => session_id,
        AgentEvent::MessageDelta { session_id, .. } => session_id,
        AgentEvent::MessageEnd { session_id, .. } => session_id,
        AgentEvent::ToolStart { session_id, .. } => session_id,
        AgentEvent::ToolUpdate { session_id, .. } => session_id,
        AgentEvent::ToolEnd { session_id, .. } => session_id,
        AgentEvent::ToolBatchStart { session_id, .. } => session_id,
        AgentEvent::ToolBatchEnd { session_id, .. } => session_id,
        AgentEvent::ToolInputRepaired { session_id, .. } => session_id,
        AgentEvent::ContextCompressionStart { session_id, .. } => session_id,
        AgentEvent::ContextCompressionEnd { session_id, .. } => session_id,
        AgentEvent::ProviderDiagnostic { session_id, .. } => session_id,
        AgentEvent::RuntimeError { session_id, .. } => session_id,
        AgentEvent::RuntimeSteering { session_id, .. } => session_id,
        AgentEvent::RuntimeInterventionRequired { session_id, .. } => session_id,
        AgentEvent::ApprovalRequested { session_id, .. } => session_id,
        AgentEvent::ApprovalResolved { session_id, .. } => session_id,
        AgentEvent::CheckpointCreated { session_id, .. } => session_id,
        AgentEvent::CheckpointRestored { session_id, .. } => session_id,
        AgentEvent::RunTerminal { session_id, .. } => session_id,
        AgentEvent::CacheStatsUpdated { session_id, .. } => session_id,
        AgentEvent::CacheWasteAlert { session_id, .. } => session_id,
        AgentEvent::ColdCacheWarning { session_id, .. } => session_id,
        AgentEvent::SecurityAudit { session_id, .. } => session_id,
        // I5-M7 事件契约新增三事件（subagent-started/event/ended，均携带
        // sessionId；M6 域补齐归一化位，emit 出口统一注入语义不变）
        AgentEvent::SubagentStarted { session_id, .. } => session_id,
        AgentEvent::SubagentEvent { session_id, .. } => session_id,
        AgentEvent::SubagentEnded { session_id, .. } => session_id,
        // T-AB-17 任务域七事件（均携带 sessionId；M6 域补齐归一化位，
        // emit 出口统一注入语义不变——C1 验证补丁由 C2 正式落位）
        AgentEvent::TaskStarted { session_id, .. } => session_id,
        AgentEvent::TaskOutput { session_id, .. } => session_id,
        AgentEvent::TaskHeartbeat { session_id, .. } => session_id,
        AgentEvent::TaskSuspicious { session_id, .. } => session_id,
        AgentEvent::TaskCompleted { session_id, .. } => session_id,
        AgentEvent::TaskFailed { session_id, .. } => session_id,
        AgentEvent::TaskKilled { session_id, .. } => session_id,
        // T-CF-04 定时器域两事件（均携带 sessionId；M6 域补齐归一化位，
        // 定时器事件无 run 归属时 sessionId 可空串，由本归一化补会话）
        AgentEvent::TimerFired { session_id, .. } => session_id,
        AgentEvent::TimerCancelled { session_id, .. } => session_id,
        // T-CF-08 cron 域事件（均携带 sessionId；M6 域补齐归一化位，
        // cron 事件无 run 归属时 sessionId 可空串，由本归一化补会话）
        AgentEvent::CronFired { session_id, .. } => session_id,
    }
}

/// emit 前统一归一化（03 §5.3-2）。
///
/// - 信封 `runId`：已有（非空）不覆盖，缺失时用 `run_id` 补；
/// - 事件体 `sessionId`：缺失（空串）时用 `session_id` 补，已有不覆盖；
/// - `run-terminal` 事件体 `runId`：缺失时用信封/入参 runId 补
///   （03 §5.1-16 终态事件 runId 必须存在）。
///
/// 返回注入后的信封，可直接交给 emit 层序列化（扁平顶层 JSON：
/// `{type, runId, sequence, sessionId, ...事件字段}`，03 §3.1）。
pub fn normalize_envelope(
    mut envelope: AgentEventEnvelope,
    run_id: Option<&str>,
    session_id: &str,
) -> AgentEventEnvelope {
    // 信封 runId：已有（非空）不覆盖
    if envelope.run_id.as_deref().is_none_or(str::is_empty) {
        envelope.run_id = run_id.map(str::to_string);
    }
    let effective_run_id = envelope
        .run_id
        .clone()
        .or_else(|| run_id.map(str::to_string));

    // 事件体 sessionId：缺失（空串）时补，已有不覆盖
    if event_session_id_mut(&mut envelope.event).is_empty() {
        *event_session_id_mut(&mut envelope.event) = session_id.to_string();
    }

    // run-terminal 事件体 runId：缺失时补（与信封注入值一致）
    if let AgentEvent::RunTerminal { run_id: rid, .. } = &mut envelope.event {
        if rid.is_empty() {
            if let Some(id) = &effective_run_id {
                *rid = id.clone();
            }
        }
    }

    envelope
}

/// 终态事件**唯一**判据（03 §5.2-2）。
///
/// 原 `is_terminal_run_event` 依赖 run-completed/run-failed/run-cancelled/
/// run-ended 别名，别名已删除（B4.2），判据收敛为「仅 run-terminal」。
pub fn is_terminal_event(event: &AgentEvent) -> bool {
    matches!(event, AgentEvent::RunTerminal { .. })
}

/// 信封视角的终态判据（[is_terminal_event] 的便捷封装）
pub fn is_terminal_envelope(envelope: &AgentEventEnvelope) -> bool {
    is_terminal_event(&envelope.event)
}

/// agent-end reason → run 终态（cooperative stop 的 agent-end reason 与
/// run 终态一致，00 D1）：
/// - stop / stopped → completed（stopped 是协作停止，**不是**取消也不是
///   错误，01 §四 D1）；
/// - max-turns → **failed**（T08.9 裁决 D1：预算耗尽属阻断而非自然完成，
///   与 [allows_auto_continue] 不续轮语义一致）；
/// - aborted → cancelled（用户取消 / L3 force_cancel）；
/// - error → failed。
///
/// **单一权威映射在 run.rs**（[crate::run::map_agent_end_to_terminal]，run
/// 生命周期与终态落库的权威方）；本函数为薄委托（保留包装防破坏既有
/// import），两处映射永不分叉（T08.9 互引测试锚定）。
pub fn terminal_status_for_end_reason(reason: AgentEndReason) -> RunTerminalStatus {
    crate::run::map_agent_end_to_terminal(reason)
}

/// run 终态 → agent-end reason（[terminal_status_for_end_reason] 的逆映射，
/// 供事件重放 / 投影恢复用）
pub fn end_reason_for_terminal(terminal: RunTerminalStatus) -> AgentEndReason {
    match terminal {
        RunTerminalStatus::Completed => AgentEndReason::Stop,
        RunTerminalStatus::Cancelled => AgentEndReason::Aborted,
        RunTerminalStatus::Failed => AgentEndReason::Error,
    }
}

/// 终态 reason 判据：该 reason 是否表示 agent 循环已终结。
///
/// 五种 reason 均为 run 终结状态（agent-end 事件本身即 run 结束标志）；
/// 「是否自动续轮」由 [allows_auto_continue] 另行裁决（00 D1）。
pub fn is_terminal_reason(reason: AgentEndReason) -> bool {
    matches!(
        reason,
        AgentEndReason::Stop
            | AgentEndReason::MaxTurns
            | AgentEndReason::Aborted
            | AgentEndReason::Error
            | AgentEndReason::Stopped
    )
}

/// 该 reason 是否允许 orchestrator 自动续轮（goal 模式轮次策略，00 D1）。
///
/// - stop：自然完成，goal 未达成时可评估续轮；
/// - max-turns：预算用尽属阻断（对齐 B4.5「max-rounds blocked」语义），
///   不续轮；
/// - stopped：cooperative stop——用户协作停止**不触发自动续轮**（00 D1）；
/// - aborted / error：取消 / 失败，不续轮。
pub fn allows_auto_continue(reason: AgentEndReason) -> bool {
    matches!(reason, AgentEndReason::Stop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TS: &str = "2026-07-31T00:00:00.000Z";

    fn agent_start() -> AgentEvent {
        AgentEvent::AgentStart {
            session_id: String::new(),
            timestamp: TS.into(),
        }
    }

    fn agent_end(reason: AgentEndReason) -> AgentEvent {
        AgentEvent::AgentEnd {
            session_id: "sess-1".into(),
            timestamp: TS.into(),
            reason,
            error: None,
        }
    }

    fn run_terminal() -> AgentEvent {
        AgentEvent::RunTerminal {
            session_id: String::new(),
            run_id: String::new(),
            timestamp: TS.into(),
            terminal: RunTerminalStatus::Completed,
            error: None,
        }
    }

    /// 03 §5.3-2：信封 runId 缺失时补齐
    #[test]
    fn run_id_injected_when_envelope_missing() {
        let envelope = AgentEventEnvelope::new(agent_start(), None, Some(1));
        let normalized = normalize_envelope(envelope, Some("run-1"), "sess-1");
        assert_eq!(normalized.run_id.as_deref(), Some("run-1"));
    }

    /// 已有 runId 不覆盖（测试要求：已有不覆盖）
    #[test]
    fn run_id_not_overwritten_when_present() {
        let envelope = AgentEventEnvelope::new(agent_start(), Some("run-0".into()), None);
        let normalized = normalize_envelope(envelope, Some("run-1"), "sess-1");
        assert_eq!(normalized.run_id.as_deref(), Some("run-0"), "已有 runId 不被覆盖");
    }

    /// 事件体 sessionId 缺失（空串）时补齐
    #[test]
    fn session_id_filled_when_missing() {
        let envelope = AgentEventEnvelope::new(agent_start(), None, None);
        let normalized = normalize_envelope(envelope, None, "sess-1");
        match &normalized.event {
            AgentEvent::AgentStart { session_id, .. } => {
                assert_eq!(session_id, "sess-1", "事件体 sessionId 补齐")
            }
            other => panic!("事件类型不符：{other:?}"),
        }
    }

    /// 事件体 sessionId 已有（非空）不覆盖
    #[test]
    fn session_id_not_overwritten_when_present() {
        let event = AgentEvent::AgentEnd {
            session_id: "sess-0".into(),
            timestamp: TS.into(),
            reason: AgentEndReason::Stop,
            error: None,
        };
        let envelope = AgentEventEnvelope::new(event, None, None);
        let normalized = normalize_envelope(envelope, None, "sess-1");
        match &normalized.event {
            AgentEvent::AgentEnd { session_id, .. } => {
                assert_eq!(session_id, "sess-0", "已有 sessionId 不被覆盖")
            }
            other => panic!("事件类型不符：{other:?}"),
        }
    }

    /// 03 §5.1-16：run-terminal 事件体 runId 缺失时补齐（与信封一致）
    #[test]
    fn run_terminal_body_run_id_filled_when_missing() {
        // 信封缺失、入参提供
        let envelope = AgentEventEnvelope::new(run_terminal(), None, None);
        let normalized = normalize_envelope(envelope, Some("run-1"), "sess-1");
        match &normalized.event {
            AgentEvent::RunTerminal { run_id, .. } => {
                assert_eq!(run_id, "run-1", "终态事件 runId 补齐");
            }
            other => panic!("事件类型不符：{other:?}"),
        }
        assert_eq!(normalized.run_id.as_deref(), Some("run-1"), "信封同步注入");

        // 信封已有、事件体缺失：取信封值
        let envelope = AgentEventEnvelope::new(run_terminal(), Some("run-9".into()), None);
        let normalized = normalize_envelope(envelope, Some("run-1"), "sess-1");
        match &normalized.event {
            AgentEvent::RunTerminal { run_id, .. } => {
                assert_eq!(run_id, "run-9", "事件体取信封已有 runId");
            }
            other => panic!("事件类型不符：{other:?}"),
        }
    }

    /// run-terminal 事件体 runId 已有（非空）不覆盖
    #[test]
    fn run_terminal_body_run_id_not_overwritten() {
        let mut event = run_terminal();
        if let AgentEvent::RunTerminal { run_id, .. } = &mut event {
            run_id.push_str("run-9");
        }
        let envelope = AgentEventEnvelope::new(event, Some("run-9".into()), None);
        let normalized = normalize_envelope(envelope, Some("run-1"), "sess-1");
        match &normalized.event {
            AgentEvent::RunTerminal { run_id, .. } => {
                assert_eq!(run_id, "run-9", "已有 runId 不被覆盖")
            }
            other => panic!("事件类型不符：{other:?}"),
        }
    }

    /// 归一化后信封序列化为扁平顶层 JSON：runId/sessionId 齐备（03 §3.1）
    #[test]
    fn normalized_envelope_serializes_flat_with_run_id() {
        let envelope = AgentEventEnvelope::new(run_terminal(), None, Some(7));
        let normalized = normalize_envelope(envelope, Some("run-1"), "sess-1");
        let value = serde_json::to_value(&normalized).unwrap();
        assert_eq!(value["type"], "run-terminal");
        assert_eq!(value["runId"], "run-1", "顶层 runId");
        assert_eq!(value["sessionId"], "sess-1", "顶层 sessionId");
        assert_eq!(value["sequence"], 7);
        assert!(value.get("event").is_none(), "不得二次包装 event 键");
    }

    /// 03 §5.2-2：终态唯一判据——仅 run-terminal 为终态事件。
    ///
    /// run-completed/run-failed/run-cancelled/run-ended 别名已删除
    /// （B4.2 事件收敛），判据不再依赖别名。
    #[test]
    fn is_terminal_event_only_run_terminal() {
        assert!(is_terminal_event(&run_terminal()));

        let non_terminal = [
            agent_start(),
            agent_end(AgentEndReason::Stop),
            agent_end(AgentEndReason::Error),
            AgentEvent::TurnStart {
                session_id: "s".into(),
                turn_index: 0,
                timestamp: TS.into(),
            },
            AgentEvent::TurnEnd {
                session_id: "s".into(),
                turn_index: 0,
                timestamp: TS.into(),
                tool_call_count: 0,
            },
            AgentEvent::MessageStart {
                session_id: "s".into(),
                message: std::sync::Arc::new(message()),
            },
            AgentEvent::MessageDelta {
                session_id: "s".into(),
                timestamp: TS.into(),
                message_id: "m".into(),
                block: block(),
            },
            AgentEvent::MessageEnd {
                session_id: "s".into(),
                message: std::sync::Arc::new(message()),
            },
            AgentEvent::ToolStart {
                session_id: "s".into(),
                batch_id: "b".into(),
                call: batch_call(),
                timestamp: TS.into(),
            },
            AgentEvent::ToolUpdate {
                session_id: "s".into(),
                batch_id: "b".into(),
                tool_call_id: "tc".into(),
                update: progress_update(),
                timestamp: TS.into(),
            },
            AgentEvent::ToolEnd {
                session_id: "s".into(),
                batch_id: "b".into(),
                result: batch_result(),
                timestamp: TS.into(),
            },
            AgentEvent::ToolBatchStart {
                session_id: "s".into(),
                batch_id: "b".into(),
                timestamp: TS.into(),
                summary: "批量".into(),
                calls: vec![batch_call()],
            },
            AgentEvent::ToolBatchEnd {
                session_id: "s".into(),
                batch_id: "b".into(),
                timestamp: TS.into(),
                calls: vec![batch_result()],
            },
            AgentEvent::ToolInputRepaired {
                session_id: "s".into(),
                timestamp: TS.into(),
                tool_call_id: "tc".into(),
                tool_name: "read_file".into(),
                notes: vec![],
            },
            AgentEvent::ContextCompressionStart {
                session_id: "s".into(),
                timestamp: TS.into(),
                reason: "threshold".into(),
                tokens_before: 100,
            },
            AgentEvent::ContextCompressionEnd {
                session_id: "s".into(),
                timestamp: TS.into(),
                result: None,
                aborted: false,
                error: None,
            },
            AgentEvent::ProviderDiagnostic {
                session_id: "s".into(),
                timestamp: TS.into(),
                diagnostic: diagnostic(),
            },
            AgentEvent::RuntimeError {
                session_id: "s".into(),
                timestamp: TS.into(),
                error: "boom".into(),
                retryable: Some(true),
            },
            AgentEvent::RuntimeSteering {
                session_id: "s".into(),
                timestamp: TS.into(),
                reason: "empty-response".into(),
                message: message(),
            },
            AgentEvent::RuntimeInterventionRequired {
                session_id: "s".into(),
                timestamp: TS.into(),
                reason: "no-progress".into(),
                choices: vec![],
                message: "介入".into(),
            },
            AgentEvent::ApprovalRequested {
                session_id: "s".into(),
                request: permission_request(),
                timestamp: TS.into(),
            },
            AgentEvent::ApprovalResolved {
                session_id: "s".into(),
                tool_call_id: "tc".into(),
                request_id: None,
                decision: conex_types::ApprovalDecision::Approved,
                timestamp: TS.into(),
            },
            AgentEvent::CheckpointCreated {
                session_id: "s".into(),
                timestamp: TS.into(),
                checkpoint: checkpoint(),
            },
            AgentEvent::CheckpointRestored {
                session_id: "s".into(),
                timestamp: TS.into(),
                restore: restore(),
            },
        ];
        for event in non_terminal {
            assert!(
                !is_terminal_event(&event),
                "{} 不是终态事件",
                event.type_name()
            );
        }
    }

    /// 信封视角终态判据
    #[test]
    fn is_terminal_envelope_wraps_event_criterion() {
        assert!(is_terminal_envelope(&AgentEventEnvelope::new(run_terminal(), None, None)));
        assert!(!is_terminal_envelope(&AgentEventEnvelope::new(
            agent_end(AgentEndReason::Stop),
            None,
            None
        )));
    }

    /// agent-end reason 与 run 终态一致（00 D1 / T08.9 D1 裁决）：
    /// stopped → completed（既不是 cancelled 也不是 failed）；
    /// max-turns → failed（预算耗尽属阻断而非自然完成）
    #[test]
    fn terminal_status_for_end_reason_mapping() {
        assert_eq!(
            terminal_status_for_end_reason(AgentEndReason::Stop),
            RunTerminalStatus::Completed
        );
        assert_eq!(
            terminal_status_for_end_reason(AgentEndReason::MaxTurns),
            RunTerminalStatus::Failed,
            "max-turns → failed（T08.9 D1 裁决：run.rs 为权威，本处委托）"
        );
        assert_eq!(
            terminal_status_for_end_reason(AgentEndReason::Stopped),
            RunTerminalStatus::Completed,
            "cooperative stop 非取消非错误"
        );
        assert_eq!(
            terminal_status_for_end_reason(AgentEndReason::Aborted),
            RunTerminalStatus::Cancelled
        );
        assert_eq!(
            terminal_status_for_end_reason(AgentEndReason::Error),
            RunTerminalStatus::Failed
        );
    }

    /// 终态 reason 判据：五种 reason 均为 run 终结状态
    #[test]
    fn is_terminal_reason_all_end_reasons() {
        for reason in [
            AgentEndReason::Stop,
            AgentEndReason::MaxTurns,
            AgentEndReason::Aborted,
            AgentEndReason::Error,
            AgentEndReason::Stopped,
        ] {
            assert!(is_terminal_reason(reason), "{reason:?} 应为终态 reason");
        }
    }

    /// 00 D1：cooperative stop（stopped）不触发自动续轮；
    /// 仅自然完成（stop）允许 goal 模式评估续轮
    #[test]
    fn cooperative_stop_does_not_auto_continue() {
        assert!(allows_auto_continue(AgentEndReason::Stop), "自然完成可评估续轮");
        assert!(!allows_auto_continue(AgentEndReason::Stopped), "stopped 不续轮（D1）");
        assert!(!allows_auto_continue(AgentEndReason::MaxTurns), "预算耗尽阻断不续轮");
        assert!(!allows_auto_continue(AgentEndReason::Aborted), "取消不续轮");
        assert!(!allows_auto_continue(AgentEndReason::Error), "失败不续轮");
    }

    /// 终态 → reason 逆映射（事件重放用）
    #[test]
    fn end_reason_for_terminal_mapping() {
        assert_eq!(end_reason_for_terminal(RunTerminalStatus::Completed), AgentEndReason::Stop);
        assert_eq!(end_reason_for_terminal(RunTerminalStatus::Cancelled), AgentEndReason::Aborted);
        assert_eq!(end_reason_for_terminal(RunTerminalStatus::Failed), AgentEndReason::Error);
    }

    // ── 测试构件（最小字段构造）──

    fn message() -> conex_types::AgentMessage {
        conex_types::AgentMessage {
            id: "m1".into(),
            role: conex_types::AgentMessageRole::User,
            created_at: TS.into(),
            blocks: vec![block()],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    fn block() -> conex_types::AgentMessageBlock {
        conex_types::AgentMessageBlock::Text { text: "hi".into() }
    }

    fn batch_call() -> conex_types::ToolBatchCall {
        conex_types::ToolBatchCall {
            id: "tc-1".into(),
            tool_name: "read_file".into(),
            summary: "读取".into(),
            input: json!({ "path": "a.txt" }),
            category: conex_types::ToolCategory::Filesystem,
            concurrency: conex_types::ToolConcurrency::Parallel,
        }
    }

    fn batch_result() -> conex_types::ToolBatchResult {
        conex_types::ToolBatchResult {
            id: "tc-1".into(),
            tool_name: "read_file".into(),
            output: conex_types::ToolOutput::text("内容"),
            is_error: false,
            duration_ms: 1,
        }
    }

    fn progress_update() -> conex_types::ToolProgressUpdate {
        conex_types::ToolProgressUpdate {
            text: Some("进行中".into()),
            json: None,
            metadata: None,
        }
    }

    fn permission_request() -> conex_types::PermissionRequest {
        conex_types::PermissionRequest {
            id: "pr-1".into(),
            session_id: "s".into(),
            cwd: "/ws".into(),
            tool_call_id: "tc-1".into(),
            tool_name: "write_file".into(),
            parameters: json!({}),
            summary: "写入".into(),
            tool_metadata: Default::default(),
            metadata: None,
            // T-D-14 权限传递层：主 agent 请求缺省 None（向后兼容）
            requester_run_id: None,
            reason: None,
        }
    }

    fn diagnostic() -> conex_types::ProviderDiagnostic {
        conex_types::ProviderDiagnostic {
            phase: conex_types::ProviderDiagnosticPhase::RequestStart,
            provider_id: None,
            endpoint: None,
            url: None,
            attempt: None,
            max_attempts: None,
            elapsed_ms: None,
            status: None,
            status_text: None,
            retryable: None,
            reason: None,
            error_kind: None,
            retry_after_ms: None,
            chunks: None,
            bytes: None,
            headers: None,
            configured_model: None,
            actual_model: None,
            model_mismatch: None,
            stream_requested: None,
            system_prompt_wire_mode: None,
            has_system_role: None,
            system_prompt_present: None,
            system_message_count: None,
            rewritten_system_message_count: None,
            message_count: None,
            tool_count: None,
            message_role_counts: None,
            partial: None,
        }
    }

    fn checkpoint() -> conex_types::RuntimeCheckpointRecord {
        conex_types::RuntimeCheckpointRecord {
            id: "ck-1".into(),
            kind: conex_types::RuntimeCheckpointKind::WorkspaceCheckpoint,
            label: "检查点".into(),
            tool_call_id: "tc-1".into(),
            tool_name: "checkpoint".into(),
            artifact_uri: None,
            manifest_path: None,
            snapshot_path: None,
            source_path: None,
            metadata: None,
        }
    }

    fn restore() -> conex_types::RuntimeCheckpointRestoreRecord {
        conex_types::RuntimeCheckpointRestoreRecord {
            checkpoint_id: "ck-1".into(),
            tool_call_id: "tc-1".into(),
            tool_name: "checkpoint".into(),
            restored: vec![],
            deleted: vec![],
            skipped: vec![],
            metadata: None,
        }
    }
}
