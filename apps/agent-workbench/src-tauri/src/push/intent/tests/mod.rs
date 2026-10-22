//! push_intent 测试：公共 fixture（ctx / 事件构造器 / 全字段断言 helper）

use super::*;
use conex_types::events::{
    ApprovalDecision, MissAttribution, PermissionRequest, RunCacheStats, RunTerminalStatus,
    SecurityAuditDecision, SecurityAuditOperation, SubagentEndStatus, SubagentEventKind,
    SubagentEventPayload, ToolMetadata,
};
// AgentEndReason 定义于 session 域（events.rs 仅私有导入，外部不可达）
use conex_types::impact::ImpactAssessment;
use conex_types::session::AgentEndReason;

mod approval_run;
mod subagent_task;
mod system;

fn ctx() -> PushIntentCtx {
    PushIntentCtx::default()
}

fn ctx_with_run(run_id: &str) -> PushIntentCtx {
    PushIntentCtx {
        envelope_run_id: Some(run_id.to_string()),
        sequence: None,
    }
}

fn approval_requested(tool_call_id: &str, tool_name: &str, summary: &str) -> AgentEvent {
    AgentEvent::ApprovalRequested {
        session_id: "s-7".to_string(),
        timestamp: "2026-08-13T10:00:00Z".to_string(),
        request: PermissionRequest {
            id: "req-1".to_string(),
            session_id: "s-7".to_string(),
            cwd: "C:\\workspace".to_string(),
            tool_call_id: tool_call_id.to_string(),
            tool_name: tool_name.to_string(),
            parameters: serde_json::json!({}),
            summary: summary.to_string(),
            tool_metadata: ToolMetadata::default(),
            metadata: None,
            requester_run_id: None,
            reason: None,
        },
    }
}

fn run_terminal(run_id: &str, terminal: RunTerminalStatus, error: Option<&str>) -> AgentEvent {
    AgentEvent::RunTerminal {
        session_id: "s-7".to_string(),
        run_id: run_id.to_string(),
        timestamp: "2026-08-13T10:00:00Z".to_string(),
        terminal,
        error: error.map(str::to_string),
    }
}

fn subagent_ended(id: &str, status: SubagentEndStatus) -> AgentEvent {
    AgentEvent::SubagentEnded {
        session_id: "s-7".to_string(),
        subagent_id: id.to_string(),
        subagent_run_id: format!("{id}-run"),
        status,
        summary: Some("已产出缺口分析 5 页".to_string()),
        ended_at: "2026-08-13T10:00:00Z".to_string(),
        subagent_session_id: None,
    }
}

fn security_audit(decision: SecurityAuditDecision, tool_call_id: Option<&str>) -> AgentEvent {
    AgentEvent::SecurityAudit {
        session_id: "s-7".to_string(),
        timestamp: "2026-08-13T10:00:00Z".to_string(),
        operation: SecurityAuditOperation::Delete,
        targets: vec!["C:\\workspace\\src\\main.rs".to_string()],
        impact: ImpactAssessment::default(),
        decision,
        permission_mode: None,
        tool_call_id: tool_call_id.map(str::to_string),
    }
}

// ── 逐臂全字段断言 helper（锁定 match 每个分支的完整产物：
//    payload/collapse/target/approval 全字段与 kill 来源注入面）──

fn payload_digest(biz_key: &str, digest: Option<&str>, detail: Option<&str>) -> PayloadDigest {
    PayloadDigest {
        session_id: "s-7".to_string(),
        biz_key: biz_key.to_string(),
        digest: digest.map(str::to_string),
        detail: detail.map(str::to_string),
    }
}

fn expected_intent(
    scene: SceneId,
    level: PushLevel,
    target: PushTargetScreen,
    dedupe: &str,
    collapse: &str,
    payload: PayloadDigest,
) -> PushIntent {
    PushIntent {
        scene,
        level,
        dedupe_key: dedupe.to_string(),
        collapse_key: collapse.to_string(),
        target,
        payload,
        approval: None,
    }
}

const ALL_KILL_SOURCES: [Option<RunTerminationSource>; 3] = [
    None,
    Some(RunTerminationSource::UserKilled),
    Some(RunTerminationSource::EngineTerminated),
];
