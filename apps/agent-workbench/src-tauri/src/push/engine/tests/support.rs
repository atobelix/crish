//! push engine 测试共享基建（engine.rs 拆分）：事件构造器与基准时刻。

use super::super::*;

use conex_types::events::{
    AgentEvent, PermissionRequest, RunTerminalStatus, SubagentEndStatus, ToolMetadata,
};

/// 基准时刻：2026-08-10 12:00:00 UTC（非静默）
pub(super) const T0: u64 = 1_786_276_800_000;

pub(super) fn ctx() -> PushIntentCtx {
    PushIntentCtx::default()
}

pub(super) fn ctx_run(run_id: &str) -> PushIntentCtx {
    PushIntentCtx {
        envelope_run_id: Some(run_id.to_string()),
        sequence: None,
    }
}

pub(super) fn approval(tool_call_id: &str) -> AgentEvent {
    AgentEvent::ApprovalRequested {
        session_id: "s-7".to_string(),
        timestamp: "t".to_string(),
        request: PermissionRequest {
            id: "req-1".to_string(),
            session_id: "s-7".to_string(),
            cwd: "C:\\workspace".to_string(),
            tool_call_id: tool_call_id.to_string(),
            tool_name: "bash".to_string(),
            parameters: serde_json::json!({}),
            summary: "执行部署脚本".to_string(),
            tool_metadata: ToolMetadata::default(),
            metadata: None,
            requester_run_id: None,
            reason: None,
        },
    }
}

pub(super) fn run_terminal(run_id: &str, terminal: RunTerminalStatus) -> AgentEvent {
    AgentEvent::RunTerminal {
        session_id: "s-7".to_string(),
        run_id: run_id.to_string(),
        timestamp: "t".to_string(),
        terminal,
        error: None,
    }
}

pub(super) fn subagent_completed(id: &str) -> AgentEvent {
    AgentEvent::SubagentEnded {
        session_id: "s-7".to_string(),
        subagent_id: id.to_string(),
        subagent_run_id: format!("{id}-run"),
        status: SubagentEndStatus::Completed,
        summary: None,
        ended_at: "t".to_string(),
        subagent_session_id: None,
    }
}

pub(super) fn task_failed(task_id: &str) -> AgentEvent {
    AgentEvent::TaskFailed {
        session_id: "s-7".to_string(),
        task_id: task_id.to_string(),
        exit_code: 1,
        tail: vec![],
        duration_ms: 100,
    }
}

pub(super) fn task_suspicious(task_id: &str) -> AgentEvent {
    AgentEvent::TaskSuspicious {
        session_id: "s-7".to_string(),
        task_id: task_id.to_string(),
        silence_ms: 120_000,
        last_output_at_ms: T0,
    }
}

pub(super) fn runtime_error() -> AgentEvent {
    AgentEvent::RuntimeError {
        session_id: "s-7".to_string(),
        timestamp: "t".to_string(),
        error: "provider 429".to_string(),
        retryable: Some(true),
    }
}

pub(super) fn batch_end() -> AgentEvent {
    AgentEvent::ToolBatchEnd {
        session_id: "s-7".to_string(),
        batch_id: "b-1".to_string(),
        timestamp: "t".to_string(),
        calls: vec![],
    }
}

/// P1 直发场景（timer-fired）：防洪测试的普通意图填充素材
/// （task-suspicious 属 P0，会旁路防洪，不能作防洪丢弃断言素材）
pub(super) fn timer_fired(id: &str) -> AgentEvent {
    AgentEvent::TimerFired {
        session_id: "s-7".to_string(),
        timer_id: id.to_string(),
        prompt: "检查任务进度".to_string(),
        fired_at_ms: T0,
    }
}

pub(super) fn task_started(task_id: &str, owner_run_id: &str) -> AgentEvent {
    AgentEvent::TaskStarted {
        session_id: "s-7".to_string(),
        task_id: task_id.to_string(),
        command: "cargo build".to_string(),
        cwd: "C:\\workspace".to_string(),
        owner_run_id: owner_run_id.to_string(),
        is_daemon: false,
    }
}

pub(super) fn task_killed(task_id: &str, via_force: bool) -> AgentEvent {
    AgentEvent::TaskKilled {
        session_id: "s-7".to_string(),
        task_id: task_id.to_string(),
        via_force,
        diagnostics: None,
    }
}
