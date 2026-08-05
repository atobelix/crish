//! B1.5 序列化契约测试：41 事件穷举 roundtrip + 03 §5.1 硬依赖表字段锚定
//!
//! 穷举清单与 [AgentEvent::ALL_TYPE_NAMES]（引擎事件名宏同源生成）动态对照，
//! 新增事件变体在两处登记后本测试自动纳入，不再硬编码事件数。

use conex_types::{
    AgentEndReason, AgentEvent, AgentEventEnvelope, AgentMessage, AgentMessageBlock,
    AgentMessageRole, ApprovalDecision, ContextCompressionRecord,
    ContextCompressionReason, ContextCompressionTrigger, ImpactAssessment,
    MissAttribution, PermissionBehavior, PermissionDecision, PermissionRequest,
    ProviderDiagnostic, ProviderDiagnosticPhase, ProviderErrorKind, RunCacheStats,
    RunTerminalStatus, RuntimeCheckpointKind, RuntimeCheckpointRecord,
    RuntimeCheckpointRestoreRecord, SecurityAuditDecision, SecurityAuditOperation,
    SubagentEndStatus, SubagentEventKind, SubagentEventPayload, ToolArtifactKind,
    ToolBatchCall, ToolBatchResult, ToolCallBlock, ToolCategory, ToolConcurrency,
    ToolMetadata, ToolOutput, ToolProgressUpdate,
};
use serde_json::json;
use std::sync::Arc;

const TS: &str = "2026-07-31T00:00:00.000Z";

// ── 测试构件 ──

fn text_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Text { text: text.into() }
}

fn thought_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Thought {
        text: text.into(),
        redacted: Some(false),
    }
}

fn tool_call_block() -> AgentMessageBlock {
    AgentMessageBlock::ToolCall(ToolCallBlock {
        id: "tc-1".into(),
        tool_name: "read_file".into(),
        input: json!({ "path": "a.txt" }),
    })
}

fn tool_result_block() -> AgentMessageBlock {
    AgentMessageBlock::ToolResult {
        tool_call_id: "tc-1".into(),
        tool_name: "read_file".into(),
        output: ToolOutput::text("文件内容"),
        is_error: false,
    }
}

fn assistant_message() -> AgentMessage {
    AgentMessage {
        id: "m1".into(),
        role: AgentMessageRole::Assistant,
        created_at: TS.into(),
        blocks: vec![text_block("hello"), thought_block("thinking...")],
        metadata: None,
        client_message_id: Some("cm-1".into()),
        content: Some("hello".into()),
    }
}

fn steering_message() -> AgentMessage {
    AgentMessage {
        id: "sm-1".into(),
        role: AgentMessageRole::System,
        created_at: TS.into(),
        blocks: vec![text_block("请调用工具完成目标")],
        metadata: Some(json!({
            "kind": "runtime-steering",
            "reason": "empty-response",
            "steeringCount": 1
        })),
        client_message_id: None,
        content: None,
    }
}

fn batch_call() -> ToolBatchCall {
    ToolBatchCall {
        id: "tc-1".into(),
        tool_name: "read_file".into(),
        summary: "读取文件".into(),
        input: json!({ "path": "a.txt" }),
        category: ToolCategory::Filesystem,
        concurrency: ToolConcurrency::Parallel,
    }
}

fn batch_result() -> ToolBatchResult {
    ToolBatchResult {
        id: "tc-1".into(),
        tool_name: "read_file".into(),
        output: ToolOutput::text("文件内容"),
        is_error: false,
        duration_ms: 12,
    }
}

fn progress_update() -> ToolProgressUpdate {
    ToolProgressUpdate {
        text: Some("正在读取".into()),
        json: None,
        metadata: Some(json!({ "kind": "tool-args-delta", "argumentsText": "{\"path\":" })),
    }
}

fn permission_request() -> PermissionRequest {
    PermissionRequest {
        id: "pr-1".into(),
        session_id: "s1".into(),
        cwd: "/ws".into(),
        tool_call_id: "tc-1".into(),
        tool_name: "write_file".into(),
        parameters: json!({ "path": "a.txt", "content": "x" }),
        summary: "写入文件".into(),
        tool_metadata: ToolMetadata {
            category: Some("filesystem".into()),
            is_read_only: None,
            fatal_on_error: None,
            concurrency: None,
        },
        metadata: None,
        // T-D-14 权限传递层：主 agent 请求缺省 None（向后兼容缺省面）
        requester_run_id: None,
        reason: None,
    }
}

/// T-D-14 载荷扩展的另一种样本：子代理请求携带请求方身份与理由
fn subagent_permission_request() -> PermissionRequest {
    PermissionRequest {
        requester_run_id: Some("run-sub-1".into()),
        reason: Some("需要写入默认范围外的报告目录".into()),
        ..permission_request()
    }
}

fn compression_record() -> ContextCompressionRecord {
    ContextCompressionRecord {
        id: "cc-1".into(),
        trigger: ContextCompressionTrigger::Threshold,
        reason: Some(ContextCompressionReason::Threshold),
        policy: None,
        summary: "压缩摘要".into(),
        first_kept_message_id: Some("m3".into()),
        compressed_message_ids: vec!["m1".into(), "m2".into()],
        kept_message_ids: vec!["m3".into()],
        tokens_before: 100,
        tokens_after: 40,
        threshold_tokens: Some(80),
        created_at: TS.into(),
        handoff: None,
        cache_boundary: None,
        details: None,
    }
}

fn diagnostic() -> ProviderDiagnostic {
    ProviderDiagnostic {
        phase: ProviderDiagnosticPhase::SseFirstByte,
        provider_id: Some("openai".into()),
        endpoint: Some("chat-completions".into()),
        url: Some("https://api.example.com/v1/chat/completions".into()),
        attempt: Some(2),
        max_attempts: Some(3),
        elapsed_ms: Some(1200),
        status: Some(429),
        status_text: Some("Too Many Requests".into()),
        retryable: Some(true),
        reason: Some("rate-limit".into()),
        error_kind: Some(ProviderErrorKind::RateLimit),
        retry_after_ms: Some(5000),
        chunks: None,
        bytes: None,
        headers: None,
        configured_model: None,
        actual_model: None,
        model_mismatch: None,
        stream_requested: Some(true),
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

fn checkpoint() -> RuntimeCheckpointRecord {
    RuntimeCheckpointRecord {
        id: "ck-1".into(),
        kind: RuntimeCheckpointKind::WorkspaceCheckpoint,
        label: "初始检查点".into(),
        tool_call_id: "tc-1".into(),
        tool_name: "checkpoint".into(),
        artifact_uri: None,
        manifest_path: Some("manifest.json".into()),
        snapshot_path: None,
        source_path: None,
        metadata: None,
    }
}

fn restore() -> RuntimeCheckpointRestoreRecord {
    RuntimeCheckpointRestoreRecord {
        checkpoint_id: "ck-1".into(),
        tool_call_id: "tc-1".into(),
        tool_name: "checkpoint".into(),
        restored: vec!["a.txt".into()],
        deleted: vec![],
        skipped: vec!["b.txt".into()],
        metadata: None,
    }
}

/// 缓存统计样本（对齐 events_schema_version.rs §4 的 fixture 形状）
fn run_cache_stats_fixture() -> RunCacheStats {
    RunCacheStats {
        prompt_tokens: 1000,
        completion_tokens: 120,
        total_tokens: 1120,
        cache_read_tokens: 200,
        cache_write_tokens: 0,
        cache_miss_tokens: 800,
        sample_count: 1,
        hit_ratio: Some(0.2),
        write_ratio: Some(0.0),
        missed_tokens: 0,
        warm_until_ms: None,
    }
}

/// 41 种域事件各构造一个实例，顺序与 [AgentEvent::ALL_TYPE_NAMES] 一一对应
/// （03 §1.1-1.6 全清单 + P5 S3 缓存测量域三事件 + I2-S8 安全审计域 +
/// I5-M7 子代理域三事件 + T-AB-17 任务域七事件 + T-CF-04 定时器域两事件 +
/// T-CF-08 cron 域一事件；全量穷举不再按域豁免）
fn all_events() -> Vec<AgentEvent> {
    let s = "s1".to_string();
    vec![
        AgentEvent::AgentStart {
            session_id: s.clone(),
            timestamp: TS.into(),
        },
        AgentEvent::AgentEnd {
            session_id: s.clone(),
            timestamp: TS.into(),
            reason: AgentEndReason::Error,
            error: Some("provider failure".into()),
        },
        AgentEvent::TurnStart {
            session_id: s.clone(),
            turn_index: 1,
            timestamp: TS.into(),
        },
        AgentEvent::TurnEnd {
            session_id: s.clone(),
            turn_index: 1,
            timestamp: TS.into(),
            tool_call_count: 2,
        },
        AgentEvent::MessageStart {
            session_id: s.clone(),
            message: Arc::new(assistant_message()),
        },
        AgentEvent::MessageDelta {
            session_id: s.clone(),
            timestamp: TS.into(),
            message_id: "m1".into(),
            block: text_block("hello"),
        },
        AgentEvent::MessageEnd {
            session_id: s.clone(),
            message: Arc::new(assistant_message()),
        },
        AgentEvent::ToolStart {
            session_id: s.clone(),
            batch_id: "b1".into(),
            call: batch_call(),
            timestamp: TS.into(),
        },
        AgentEvent::ToolUpdate {
            session_id: s.clone(),
            batch_id: "b1".into(),
            tool_call_id: "tc-1".into(),
            update: progress_update(),
            timestamp: TS.into(),
        },
        AgentEvent::ToolEnd {
            session_id: s.clone(),
            batch_id: "b1".into(),
            result: batch_result(),
            timestamp: TS.into(),
        },
        AgentEvent::ToolBatchStart {
            session_id: s.clone(),
            batch_id: "b1".into(),
            timestamp: TS.into(),
            summary: "批量执行".into(),
            calls: vec![batch_call()],
        },
        AgentEvent::ToolBatchEnd {
            session_id: s.clone(),
            batch_id: "b1".into(),
            timestamp: TS.into(),
            calls: vec![batch_result()],
        },
        AgentEvent::ToolInputRepaired {
            session_id: s.clone(),
            timestamp: TS.into(),
            tool_call_id: "tc-1".into(),
            tool_name: "read_file".into(),
            notes: vec!["补全必填入参 path".into()],
        },
        AgentEvent::ContextCompressionStart {
            session_id: s.clone(),
            timestamp: TS.into(),
            reason: "threshold".into(),
            tokens_before: 100,
        },
        AgentEvent::ContextCompressionEnd {
            session_id: s.clone(),
            timestamp: TS.into(),
            result: Some(compression_record()),
            aborted: false,
            error: None,
        },
        AgentEvent::ProviderDiagnostic {
            session_id: s.clone(),
            timestamp: TS.into(),
            diagnostic: diagnostic(),
        },
        AgentEvent::RuntimeError {
            session_id: s.clone(),
            timestamp: TS.into(),
            error: "provider failed".into(),
            retryable: Some(true),
        },
        AgentEvent::RuntimeSteering {
            session_id: s.clone(),
            timestamp: TS.into(),
            reason: "empty-response".into(),
            message: steering_message(),
        },
        AgentEvent::RuntimeInterventionRequired {
            session_id: s.clone(),
            timestamp: TS.into(),
            reason: "no-progress".into(),
            choices: vec!["rollback".into(), "pause".into(), "user-instruction".into()],
            message: "需要人工介入".into(),
        },
        AgentEvent::ApprovalRequested {
            session_id: s.clone(),
            request: permission_request(),
            timestamp: TS.into(),
        },
        AgentEvent::ApprovalResolved {
            session_id: s.clone(),
            tool_call_id: "tc-1".into(),
            request_id: Some("pr-1".into()),
            decision: ApprovalDecision::Approved,
            timestamp: TS.into(),
        },
        AgentEvent::CheckpointCreated {
            session_id: s.clone(),
            timestamp: TS.into(),
            checkpoint: checkpoint(),
        },
        AgentEvent::CheckpointRestored {
            session_id: s.clone(),
            timestamp: TS.into(),
            restore: restore(),
        },
        AgentEvent::RunTerminal {
            session_id: s,
            run_id: "run-1".into(),
            timestamp: TS.into(),
            terminal: RunTerminalStatus::Completed,
            error: None,
        },
        // P5 S3：缓存测量域三事件（仅测量展示，不干预循环）
        AgentEvent::CacheStatsUpdated {
            session_id: "s1".to_string(),
            timestamp: TS.into(),
            stats: run_cache_stats_fixture(),
        },
        AgentEvent::CacheWasteAlert {
            session_id: "s1".to_string(),
            timestamp: TS.into(),
            attribution: MissAttribution::IdleTtlExpired,
            missed_tokens: 21_000,
            idle_ms: 360_000,
            model_changed: false,
            missed_cost_usd: None,
        },
        AgentEvent::ColdCacheWarning {
            session_id: "s1".to_string(),
            timestamp: TS.into(),
            ttl_seconds: 300,
            idle_ms: 360_000,
            resend_estimate_tokens: 1000,
        },
        // I2-S8：安全审计事件（删除接管/重定向/恢复/红线拦截）
        AgentEvent::SecurityAudit {
            session_id: "s1".to_string(),
            timestamp: TS.into(),
            operation: SecurityAuditOperation::Delete,
            targets: vec!["a.txt".into()],
            impact: ImpactAssessment {
                file_count: 1,
                total_size_bytes: 5,
                directory_count: 0,
                cross_directory: false,
                flagged: false,
            },
            decision: SecurityAuditDecision::Redirected,
            permission_mode: Some("full-access".into()),
            tool_call_id: Some("tc-1".into()),
        },
        // I5-M7：子代理域三事件（C8 事件契约；runId 由信封注入 = 父 run）
        AgentEvent::SubagentStarted {
            session_id: "s1".to_string(),
            subagent_id: "sa-1".to_string(),
            subagent_run_id: "sr-1".to_string(),
            role: "researcher".to_string(),
            capability_mode: "readonly".to_string(),
            started_at: TS.into(),
            description: Some("调研子代理".into()),
            mode: Some("research".into()),
            parent_tool_call_id: Some("tc-1".into()),
        },
        AgentEvent::SubagentEvent {
            session_id: "s1".to_string(),
            subagent_id: "sa-1".to_string(),
            subagent_run_id: "sr-1".to_string(),
            event: SubagentEventPayload {
                kind: SubagentEventKind::Progress,
                payload: Some(json!({ "step": "reading" })),
            },
        },
        AgentEvent::SubagentEnded {
            session_id: "s1".to_string(),
            subagent_id: "sa-1".to_string(),
            subagent_run_id: "sr-1".to_string(),
            status: SubagentEndStatus::Completed,
            summary: Some("完成调研".into()),
            ended_at: TS.into(),
        },
        // T-AB-17：任务域七事件（01 方案 §4.5 冻结契约）
        AgentEvent::TaskStarted {
            session_id: "s1".to_string(),
            task_id: "t-1".to_string(),
            command: "cargo build".to_string(),
            cwd: "/ws".to_string(),
            owner_run_id: "run-main".to_string(),
            is_daemon: false,
        },
        AgentEvent::TaskOutput {
            session_id: "s1".to_string(),
            task_id: "t-1".to_string(),
            line: Some("building...".to_string()),
            chunk: None,
            line_count: Some(42),
        },
        AgentEvent::TaskHeartbeat {
            session_id: "s1".to_string(),
            task_id: "t-1".to_string(),
            resource: json!({ "cpuPercent": 12.5, "rssBytes": 1048576 }),
        },
        AgentEvent::TaskSuspicious {
            session_id: "s1".to_string(),
            task_id: "t-1".to_string(),
            silence_ms: 65_000,
            last_output_at_ms: 1_785_456_000_000,
        },
        AgentEvent::TaskCompleted {
            session_id: "s1".to_string(),
            task_id: "t-1".to_string(),
            exit_code: 0,
            duration_ms: 1200,
            line_count: 99,
        },
        AgentEvent::TaskFailed {
            session_id: "s1".to_string(),
            task_id: "t-1".to_string(),
            exit_code: 1,
            tail: vec!["error: mismatched types".to_string()],
            duration_ms: 800,
        },
        AgentEvent::TaskKilled {
            session_id: "s1".to_string(),
            task_id: "t-1".to_string(),
            via_force: true,
            diagnostics: Some("两阶段升级后强制终止".to_string()),
        },
        // T-CF-04：定时器域两事件（唤醒走 steering 面，事件仅数据面）
        AgentEvent::TimerFired {
            session_id: "s1".to_string(),
            timer_id: "timer-1".to_string(),
            prompt: "检查编译结果".to_string(),
            fired_at_ms: 1_785_456_000_000,
        },
        AgentEvent::TimerCancelled {
            session_id: "s1".to_string(),
            timer_id: "timer-1".to_string(),
            reason: "early-exit".to_string(),
            cancelled_at_ms: 1_785_456_000_000,
        },
        // T-CF-08：cron 域一事件（SchedulerRegistry 触发，事件与唤醒解耦）
        AgentEvent::CronFired {
            session_id: "s1".to_string(),
            cron_id: "cron-1".to_string(),
            prompt: "检查编译结果".to_string(),
            expression: "0 * * * *".to_string(),
            iteration: 2,
            fired_at_ms: 1_785_456_000_000,
        },
    ]
}

fn event_type_name(event: &AgentEvent) -> &'static str {
    event.type_name()
}

// ── 1. 全事件穷举 roundtrip（与 ALL_TYPE_NAMES 动态对照）──

#[test]
fn all_events_roundtrip() {
    let events = all_events();
    assert_eq!(
        events.len(),
        AgentEvent::ALL_TYPE_NAMES.len(),
        "穷举清单必须与全量类型名清单一致（当前 {} 种；新增事件变体需在 all_events 登记）",
        AgentEvent::ALL_TYPE_NAMES.len()
    );
    for event in events {
        let json = serde_json::to_string(&event).expect("序列化失败");
        let back: AgentEvent = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(event, back, "roundtrip 不一致：{}", event_type_name(&event));
    }
}

#[test]
fn all_event_types_have_expected_wire_type_name() {
    // 动态对照：穷举清单与 ALL_TYPE_NAMES（引擎事件名宏同源生成）逐项 zip，
    // 顺序必须一一对应——新增事件变体在两处登记后本测试自动纳入
    let events = all_events();
    assert_eq!(events.len(), AgentEvent::ALL_TYPE_NAMES.len());
    for (event, name) in events.iter().zip(AgentEvent::ALL_TYPE_NAMES.iter().copied()) {
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["type"], name, "顶层 type 字段（03 §5.1-1）");
        // 每个事件都携带 sessionId
        assert!(json.get("sessionId").is_some(), "{name} 缺 sessionId");
    }
}

/// type_name 与序列化 tag 一致性：遍历全部变体，断言
/// `AgentEvent::type_name()` 与 serde 顶层 `type` 逐项相同
/// （type_name 从信封 match 抽取后与 tag 同源，防未来变体漂移）
#[test]
fn type_name_matches_serde_tag_for_all_variants() {
    for event in all_events() {
        let json = serde_json::to_value(&event).unwrap();
        let tag = json["type"].as_str().expect("顶层 type 必须存在");
        assert_eq!(
            event.type_name(),
            tag,
            "type_name 与序列化 tag 不一致（变体 {}）",
            tag
        );
    }
}

// ── 2. 03 §5.1 硬依赖表 16 项逐项锚定（AgentEvent 覆盖部分）──

#[test]
fn message_delta_hard_dependency_block_text_and_message_id() {
    // 03 §5.1-4/5：message-delta.block.text + block.type=='thought' + messageId
    let text = AgentEvent::MessageDelta {
        session_id: "s1".into(),
        timestamp: TS.into(),
        message_id: "m1".into(),
        block: text_block("增量正文"),
    };
    let json = serde_json::to_value(&text).unwrap();
    assert_eq!(json["messageId"], "m1");
    assert_eq!(json["block"]["type"], "text");
    assert_eq!(json["block"]["text"], "增量正文");

    let thought = AgentEvent::MessageDelta {
        session_id: "s1".into(),
        timestamp: TS.into(),
        message_id: "m1".into(),
        block: thought_block("思考增量"),
    };
    let json = serde_json::to_value(&thought).unwrap();
    assert_eq!(json["block"]["type"], "thought");
    assert_eq!(json["block"]["text"], "思考增量");
    assert_eq!(json["block"]["redacted"], false);
    // thought 块带 redacted 时序列化仍为 false 而非省略
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    assert_eq!(back, thought);
}

#[test]
fn message_end_hard_dependency_role_content_blocks_client_message_id() {
    // 03 §5.1-6：message-end.message.role/content/blocks[] + clientMessageId 稳定 id
    let event = AgentEvent::MessageEnd {
        session_id: "s1".into(),
        message: Arc::new(assistant_message()),
    };
    let json = serde_json::to_value(&event).unwrap();
    let msg = &json["message"];
    assert_eq!(msg["role"], "assistant");
    assert_eq!(msg["content"], "hello");
    assert_eq!(msg["clientMessageId"], "cm-1");
    assert_eq!(msg["blocks"][0]["type"], "text");
    assert_eq!(msg["blocks"][0]["text"], "hello");
    assert_eq!(msg["blocks"][1]["type"], "thought");
    assert_eq!(msg["id"], "m1");
}

#[test]
fn tool_start_hard_dependency_call_id_and_tool_name() {
    // 03 §5.1-7：tool-start.call.id/toolName + input 参数包
    let event = AgentEvent::ToolStart {
        session_id: "s1".into(),
        batch_id: "b1".into(),
        call: batch_call(),
        timestamp: TS.into(),
    };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["call"]["id"], "tc-1");
    assert_eq!(json["call"]["toolName"], "read_file");
    assert_eq!(json["call"]["input"]["path"], "a.txt");
    assert_eq!(json["call"]["category"], "filesystem");
    assert_eq!(json["call"]["concurrency"], "parallel");
}

#[test]
fn tool_end_hard_dependency_result_fields() {
    // 03 §5.1-8：tool-end.result.id/output/isError + durationMs
    let event = AgentEvent::ToolEnd {
        session_id: "s1".into(),
        batch_id: "b1".into(),
        result: batch_result(),
        timestamp: TS.into(),
    };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["result"]["id"], "tc-1");
    assert_eq!(json["result"]["toolName"], "read_file");
    assert_eq!(json["result"]["output"]["text"], "文件内容");
    assert_eq!(json["result"]["isError"], false);
    assert_eq!(json["result"]["durationMs"], 12);
}

#[test]
fn approval_requested_hard_dependency_request_fields() {
    // 03 §5.1-9：approval-requested.request.toolCallId/toolName/parameters/summary
    let event = AgentEvent::ApprovalRequested {
        session_id: "s1".into(),
        request: permission_request(),
        timestamp: TS.into(),
    };
    let json = serde_json::to_value(&event).unwrap();
    let req = &json["request"];
    assert_eq!(req["toolCallId"], "tc-1");
    assert_eq!(req["toolName"], "write_file");
    assert_eq!(req["parameters"]["path"], "a.txt");
    assert_eq!(req["summary"], "写入文件");
    assert_eq!(req["id"], "pr-1");
}

#[test]
fn approval_resolved_hard_dependency_tool_call_id_and_decision() {
    // 03 §5.1-10：approval-resolved.toolCallId + decision 规范值
    let event = AgentEvent::ApprovalResolved {
        session_id: "s1".into(),
        tool_call_id: "tc-1".into(),
        request_id: Some("pr-1".into()),
        decision: ApprovalDecision::Approved,
        timestamp: TS.into(),
    };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["toolCallId"], "tc-1");
    assert_eq!(json["decision"], "approved");
    assert_eq!(json["requestId"], "pr-1");
    // 仅发规范值（03 §5.3-3）：denied / expired
    let denied = ApprovalDecision::Denied;
    let expired = ApprovalDecision::Expired;
    assert_eq!(serde_json::to_value(denied).unwrap(), "denied");
    assert_eq!(serde_json::to_value(expired).unwrap(), "expired");
}

#[test]
fn run_terminal_hard_dependency_terminal_and_run_id() {
    // 03 §5.1-11/16：run-terminal.terminal + error；runId 必须存在
    let event = AgentEvent::RunTerminal {
        session_id: "s1".into(),
        run_id: "run-1".into(),
        timestamp: TS.into(),
        terminal: RunTerminalStatus::Completed,
        error: None,
    };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["terminal"], "completed");
    assert!(json.get("error").is_none(), "无 error 时省略字段");

    let failed = AgentEvent::RunTerminal {
        session_id: "s1".into(),
        run_id: "run-2".into(),
        timestamp: TS.into(),
        terminal: RunTerminalStatus::Failed,
        error: Some("boom".into()),
    };
    let json = serde_json::to_value(&failed).unwrap();
    assert_eq!(json["terminal"], "failed");
    assert_eq!(json["error"], "boom");

    // terminal 三值穷举（'completed'|'cancelled'|'failed'）
    let cancelled = RunTerminalStatus::Cancelled;
    assert_eq!(serde_json::to_value(cancelled).unwrap(), "cancelled");
}

#[test]
fn agent_end_hard_dependency_reason_and_error() {
    // 03 §5.1-12：agent-end.reason + error
    for (reason, expected) in [
        (AgentEndReason::Stop, "stop"),
        (AgentEndReason::MaxTurns, "max-turns"),
        (AgentEndReason::Aborted, "aborted"),
        (AgentEndReason::Error, "error"),
    ] {
        let event = AgentEvent::AgentEnd {
            session_id: "s1".into(),
            timestamp: TS.into(),
            reason,
            error: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["reason"], expected, "agent-end.reason={expected}");
    }
    // stopped 为 D1 遗留候选值（01 D1）
    assert_eq!(serde_json::to_value(AgentEndReason::Stopped).unwrap(), "stopped");
}

// ── 3. 其余事件字段名 camelCase 锚定 ──

#[test]
fn turn_events_camel_case_fields() {
    let start = serde_json::to_value(AgentEvent::TurnStart {
        session_id: "s1".into(),
        turn_index: 3,
        timestamp: TS.into(),
    })
    .unwrap();
    assert_eq!(start["turnIndex"], 3);

    let end = serde_json::to_value(AgentEvent::TurnEnd {
        session_id: "s1".into(),
        turn_index: 3,
        timestamp: TS.into(),
        tool_call_count: 2,
    })
    .unwrap();
    assert_eq!(end["toolCallCount"], 2);
}

#[test]
fn diagnostic_and_steering_events_camel_case_fields() {
    let diag = serde_json::to_value(AgentEvent::ProviderDiagnostic {
        session_id: "s1".into(),
        timestamp: TS.into(),
        diagnostic: diagnostic(),
    })
    .unwrap();
    assert_eq!(diag["diagnostic"]["phase"], "sse-first-byte");
    assert_eq!(diag["diagnostic"]["errorKind"], "rate-limit");
    assert_eq!(diag["diagnostic"]["retryAfterMs"], 5000);

    let steering = serde_json::to_value(AgentEvent::RuntimeSteering {
        session_id: "s1".into(),
        timestamp: TS.into(),
        reason: "empty-response".into(),
        message: steering_message(),
    })
    .unwrap();
    assert_eq!(steering["reason"], "empty-response");
    assert_eq!(steering["message"]["role"], "system");
    assert_eq!(steering["message"]["metadata"]["kind"], "runtime-steering");

    let intervention = serde_json::to_value(AgentEvent::RuntimeInterventionRequired {
        session_id: "s1".into(),
        timestamp: TS.into(),
        reason: "no-progress".into(),
        choices: vec!["rollback".into()],
        message: "需要人工介入".into(),
    })
    .unwrap();
    assert_eq!(intervention["choices"][0], "rollback");

    let runtime_error = serde_json::to_value(AgentEvent::RuntimeError {
        session_id: "s1".into(),
        timestamp: TS.into(),
        error: "provider failed".into(),
        retryable: Some(true),
    })
    .unwrap();
    assert_eq!(runtime_error["error"], "provider failed");
    assert_eq!(runtime_error["retryable"], true);
}

#[test]
fn tool_batch_and_compression_events_camel_case_fields() {
    let batch_start = serde_json::to_value(AgentEvent::ToolBatchStart {
        session_id: "s1".into(),
        batch_id: "b1".into(),
        timestamp: TS.into(),
        summary: "批量执行".into(),
        calls: vec![batch_call()],
    })
    .unwrap();
    assert_eq!(batch_start["batchId"], "b1");
    assert_eq!(batch_start["calls"][0]["toolName"], "read_file");

    let batch_end = serde_json::to_value(AgentEvent::ToolBatchEnd {
        session_id: "s1".into(),
        batch_id: "b1".into(),
        timestamp: TS.into(),
        calls: vec![batch_result()],
    })
    .unwrap();
    assert_eq!(batch_end["calls"][0]["isError"], false);

    let update = serde_json::to_value(AgentEvent::ToolUpdate {
        session_id: "s1".into(),
        batch_id: "b1".into(),
        tool_call_id: "tc-1".into(),
        update: progress_update(),
        timestamp: TS.into(),
    })
    .unwrap();
    assert_eq!(update["toolCallId"], "tc-1");
    assert_eq!(update["update"]["metadata"]["kind"], "tool-args-delta");

    let repaired = serde_json::to_value(AgentEvent::ToolInputRepaired {
        session_id: "s1".into(),
        timestamp: TS.into(),
        tool_call_id: "tc-1".into(),
        tool_name: "read_file".into(),
        notes: vec!["补全必填入参 path".into()],
    })
    .unwrap();
    assert_eq!(repaired["toolCallId"], "tc-1");
    assert_eq!(repaired["toolName"], "read_file");
    assert_eq!(repaired["notes"][0], "补全必填入参 path");

    let compress_start = serde_json::to_value(AgentEvent::ContextCompressionStart {
        session_id: "s1".into(),
        timestamp: TS.into(),
        reason: "threshold".into(),
        tokens_before: 100,
    })
    .unwrap();
    assert_eq!(compress_start["tokensBefore"], 100);

    let compress_end = serde_json::to_value(AgentEvent::ContextCompressionEnd {
        session_id: "s1".into(),
        timestamp: TS.into(),
        result: Some(compression_record()),
        aborted: false,
        error: None,
    })
    .unwrap();
    assert_eq!(compress_end["aborted"], false);
    assert_eq!(compress_end["result"]["trigger"], "threshold");
    assert_eq!(compress_end["result"]["tokensAfter"], 40);
    assert_eq!(compress_end["result"]["compressedMessageIds"][0], "m1");
}

#[test]
fn checkpoint_events_camel_case_fields() {
    let created = serde_json::to_value(AgentEvent::CheckpointCreated {
        session_id: "s1".into(),
        timestamp: TS.into(),
        checkpoint: checkpoint(),
    })
    .unwrap();
    assert_eq!(created["checkpoint"]["id"], "ck-1");
    assert_eq!(created["checkpoint"]["kind"], "workspace-checkpoint");
    assert_eq!(created["checkpoint"]["toolCallId"], "tc-1");
    assert_eq!(created["checkpoint"]["manifestPath"], "manifest.json");

    let restored = serde_json::to_value(AgentEvent::CheckpointRestored {
        session_id: "s1".into(),
        timestamp: TS.into(),
        restore: restore(),
    })
    .unwrap();
    assert_eq!(restored["restore"]["checkpointId"], "ck-1");
    assert_eq!(restored["restore"]["restored"][0], "a.txt");
    assert_eq!(restored["restore"]["skipped"][0], "b.txt");
}

// ── 4. 事件信封（runId/sequence 注入，03 §5.1-2/3、§3.1）──

#[test]
fn envelope_serializes_flat_with_run_id_and_sequence() {
    let envelope = AgentEventEnvelope::new(
        AgentEvent::RunTerminal {
            session_id: "s1".into(),
            run_id: "run-1".into(),
            timestamp: TS.into(),
            terminal: RunTerminalStatus::Failed,
            error: Some("boom".into()),
        },
        Some("run-1".into()),
        Some(42),
    );
    let json = serde_json::to_value(&envelope).unwrap();
    // 扁平顶层：type/runId/sequence/schemaVersion 与事件字段平级（03 §3.1）
    assert_eq!(json["type"], "run-terminal");
    assert_eq!(json["runId"], "run-1");
    assert_eq!(json["sequence"], 42);
    assert_eq!(json["schemaVersion"], 1, "信封顶层 schemaVersion（PE-03 T03.10）");
    assert_eq!(json["sessionId"], "s1");
    assert_eq!(json["terminal"], "failed");
    assert!(json.get("event").is_none(), "信封不得二次包装 event 键");

    // roundtrip 保留全部字段
    let json_str = serde_json::to_string(&envelope).unwrap();
    let back: AgentEventEnvelope = serde_json::from_str(&json_str).unwrap();
    assert_eq!(envelope, back);
}

#[test]
fn envelope_omits_run_id_and_sequence_when_absent() {
    let envelope = AgentEventEnvelope::new(
        AgentEvent::AgentStart {
            session_id: "s1".into(),
            timestamp: TS.into(),
        },
        None,
        None,
    );
    let json = serde_json::to_value(&envelope).unwrap();
    assert!(json.get("runId").is_none());
    assert!(json.get("sequence").is_none());
    assert_eq!(json["type"], "agent-start");
    assert_eq!(json["schemaVersion"], 1, "runId/sequence 缺省但 schemaVersion 恒注入");
    let back: AgentEventEnvelope = serde_json::from_value(json).unwrap();
    assert_eq!(envelope, back);
}

#[test]
fn envelope_roundtrip_all_events_with_run_id_and_sequence() {
    // 全部事件经信封（注入 runId/sequence）往返一致，
    // 且 run-terminal 的事件体 runId 与信封注入值保持一致
    for event in all_events() {
        let envelope = AgentEventEnvelope::new(event.clone(), Some("run-1".into()), Some(7));
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(json["runId"], "run-1");
        assert_eq!(json["sequence"], 7);
        let back: AgentEventEnvelope = serde_json::from_value(json).unwrap();
        assert_eq!(envelope, back, "信封 roundtrip 不一致：{}", event_type_name(&event));
    }
}

#[test]
fn run_terminal_envelope_run_id_single_key() {
    // run-terminal 事件体自带 runId（events.ts:39），信封注入不得产生重复键
    let envelope = AgentEventEnvelope::new(
        AgentEvent::RunTerminal {
            session_id: "s1".into(),
            run_id: "run-9".into(),
            timestamp: TS.into(),
            terminal: RunTerminalStatus::Completed,
            error: None,
        },
        Some("run-9".into()),
        Some(1),
    );
    let json = serde_json::to_string(&envelope).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["runId"], "run-9");
    assert_eq!(parsed["sequence"], 1);
    assert_eq!(parsed["type"], "run-terminal");
    let back: AgentEventEnvelope = serde_json::from_str(&json).unwrap();
    assert_eq!(envelope, back);
}

#[test]
fn block_roundtrip_all_four_kinds() {
    // message.rs 的四种块各自 roundtrip
    let blocks = vec![
        text_block("hi"),
        thought_block("thinking"),
        tool_call_block(),
        tool_result_block(),
    ];
    for block in blocks {
        let json = serde_json::to_string(&block).unwrap();
        let back: AgentMessageBlock = serde_json::from_str(&json).unwrap();
        assert_eq!(block, back);
    }
}

#[test]
fn block_wire_types_and_camel_case() {
    let thought = serde_json::to_value(thought_block("t")).unwrap();
    assert_eq!(thought["type"], "thought");
    assert_eq!(thought["redacted"], false);

    let call = serde_json::to_value(tool_call_block()).unwrap();
    assert_eq!(call["type"], "tool-call");
    assert_eq!(call["toolName"], "read_file");

    let result = serde_json::to_value(tool_result_block()).unwrap();
    assert_eq!(result["type"], "tool-result");
    assert_eq!(result["toolCallId"], "tc-1");
    assert_eq!(result["isError"], false);
    assert_eq!(result["output"]["text"], "文件内容");
}

#[test]
fn permission_decision_roundtrip() {
    let decision = PermissionDecision {
        behavior: PermissionBehavior::Ask,
        reason: Some("需要确认".into()),
        metadata: None,
    };
    let json = serde_json::to_value(&decision).unwrap();
    assert_eq!(json["behavior"], "ask");
    assert_eq!(json["reason"], "需要确认");
    let back: PermissionDecision = serde_json::from_value(json).unwrap();
    assert_eq!(decision, back);
}

#[test]
fn tool_artifact_kind_roundtrip() {
    // 其余工具域枚举的 wire 值
    assert_eq!(serde_json::to_value(ToolArtifactKind::Diff).unwrap(), "diff");
    assert_eq!(serde_json::to_value(ToolCategory::Mcp).unwrap(), "mcp");
    assert_eq!(
        serde_json::to_value(ToolConcurrency::Sequential).unwrap(),
        "sequential"
    );
    assert_eq!(
        serde_json::to_value(RuntimeCheckpointKind::GitCheckpoint).unwrap(),
        "git-checkpoint"
    );
}

#[test]
fn value_type_helper_smoke() {
    // serde_json::Value 字段（input/parameters/metadata）保持形状
    let json = serde_json::to_value(batch_call()).unwrap();
    assert_eq!(json["input"]["path"], "a.txt");
    let back: ToolBatchCall = serde_json::from_value(json).unwrap();
    assert_eq!(back.input, serde_json::json!({ "path": "a.txt" }));
}

// ── T-D-14 权限传递层：PermissionRequest 载荷扩展兼容 ──

/// 旧解析器可读（缺省字段 + 未知字段容忍）：子代理请求载荷（含
/// requesterRunId/reason）反序列化到「旧字段集合」的解析器不失败——
/// serde 缺省忽略未知字段，旧解析器按已知字段读取。
#[test]
fn extended_payload_readable_by_legacy_field_set_parser() {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyPermissionRequestView {
        id: String,
        session_id: String,
        tool_call_id: String,
        tool_name: String,
    }
    let json = serde_json::to_string(&subagent_permission_request()).unwrap();
    let legacy: LegacyPermissionRequestView = serde_json::from_str(&json)
        .expect("旧字段集解析器必须能读扩展后的载荷（未知字段缺省忽略）");
    assert_eq!(legacy.id, "pr-1");
    assert_eq!(legacy.session_id, "s1");
    assert_eq!(legacy.tool_call_id, "tc-1");
    assert_eq!(legacy.tool_name, "write_file");
}

/// 新解析器读旧载荷：缺省字段 → None（向后兼容）
#[test]
fn legacy_payload_reads_new_optional_fields_as_none() {
    let legacy_json = serde_json::json!({
        "id": "pr-1",
        "sessionId": "s1",
        "cwd": "/ws",
        "toolCallId": "tc-1",
        "toolName": "write_file",
        "parameters": { "path": "a.txt" },
        "summary": "写入文件",
        "toolMetadata": { "category": "filesystem" },
    });
    let parsed: PermissionRequest = serde_json::from_value(legacy_json)
        .expect("旧载荷缺省新字段必须可反序列化");
    assert_eq!(parsed.requester_run_id, None, "缺省 requesterRunId → None");
    assert_eq!(parsed.reason, None, "缺省 reason → None");
    // 主 agent 请求（缺省）序列化不携带新字段（skip_serializing_if）
    let out = serde_json::to_value(&parsed).unwrap();
    assert!(out.get("requesterRunId").is_none(), "None 字段不得序列化");
    assert!(out.get("reason").is_none(), "None 字段不得序列化");
}

/// 子代理请求载荷：wire 字段 camelCase + 往返一致
#[test]
fn subagent_payload_roundtrips_with_camel_case_wire() {
    let json = serde_json::to_value(&subagent_permission_request()).unwrap();
    assert_eq!(json["requesterRunId"], "run-sub-1");
    assert_eq!(json["reason"], "需要写入默认范围外的报告目录");
    let back: PermissionRequest = serde_json::from_value(json).unwrap();
    assert_eq!(subagent_permission_request(), back, "子代理载荷往返一致");
}
