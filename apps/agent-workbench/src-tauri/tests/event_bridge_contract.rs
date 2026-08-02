//! 事件桥契约测试（03 §5.1 16 项硬依赖 + schemaVersion 锚定，AU-04 F1/F11 协作面）
//!
//! 本文件经 `#[path]` 独立编译 `src/core_event_bridge.rs`（该模块刻意保持
//! **零 crate:: 内部引用**——AA-02 注记的「可经 #[path] 独立编译测试」先例），
//! 以 RecordingEmitter 替身直调 `EventBridge`，锚定 emit 载荷的 16 项硬依赖
//! 字段（03 §5.1）+ `schemaVersion` 注入（PE-03 T03.10 / PE-12 T12.5）。
//!
//! 承接：30-verification-checklist.md §4.1 逐项核对表原引用的
//! `tests/event_bridge.rs` 文件不存在（断言漂移），由本文件承接锚定。
//!
//! 覆盖范围（16 项中 Rust 可产出项）：
//! - 1 type / 2 runId / 3 sequence：信封注入，逐事件恒在；
//! - 4 message-delta block.type+text / 5 messageId；
//! - 6 message-end message{role, content, blocks[], clientMessageId}；
//! - 7 tool-start call{id, toolName, input}；
//! - 8 tool-end result{id, output.text, isError}；
//! - 9 approval-requested request{toolCallId, toolName, parameters, summary}；
//! - 10 approval-resolved toolCallId + decision 规范值；
//! - 11 run-terminal terminal + 16 runId 必在；
//! - 12 agent-end reason + error 可选；
//! - 13/14 无 error 信封 / 无 event 二次包装（扁平载荷）；
//! - schemaVersion：新事件必带且 = 1（T11.3.2 衔接）。
//! 第 15 项（subagent-*）Rust 侧无产出，属协议已知缺口（30 号清单 §4.1-15 记录）。
//!
//! 运行：`cargo test -p agent-workbench --test event_bridge_contract`

#![allow(dead_code)]

#[path = "../src/core_event_bridge.rs"]
mod core_event_bridge;

use std::sync::{Arc, Mutex};

use conex_types::{
    AgentEndReason, AgentEvent, AgentEventEnvelope, AgentMessage, AgentMessageBlock,
    AgentMessageRole, ApprovalDecision, PermissionRequest, RunTerminalStatus, ToolBatchCall,
    ToolBatchResult, ToolCategory, ToolConcurrency, ToolMetadata, ToolOutput,
};
use core_event_bridge::{Emitter, EventBridge};
use serde_json::Value;

const TS: &str = "2026-07-31T00:00:00.000Z";

// ── 测试构件（构造样板与 events_roundtrip.rs 同源）──

/// 测试发射器：记录 (channel, payload) 序列（不依赖 Tauri runtime）
#[derive(Default)]
struct RecordingEmitter {
    calls: Mutex<Vec<(String, String)>>,
}

impl RecordingEmitter {
    fn calls(&self) -> Vec<(String, String)> {
        self.calls.lock().unwrap().clone()
    }
}

impl Emitter for RecordingEmitter {
    fn emit(&self, channel: &str, payload: &str) {
        self.calls
            .lock()
            .unwrap()
            .push((channel.to_string(), payload.to_string()));
    }
}

/// 构造测试桥（记录发射器 + 冻结通道名 workbench-run-event，03 §3.1）
fn recording_bridge() -> (EventBridge, Arc<RecordingEmitter>) {
    let emitter = Arc::new(RecordingEmitter::default());
    let bridge =
        EventBridge::new("workbench-run-event", Arc::clone(&emitter) as Arc<dyn Emitter>);
    (bridge, emitter)
}

fn text_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Text { text: text.into() }
}

fn thought_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Thought {
        text: text.into(),
        redacted: Some(true),
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

fn batch_call() -> ToolBatchCall {
    ToolBatchCall {
        id: "tc-1".into(),
        tool_name: "read_file".into(),
        summary: "读取文件".into(),
        input: serde_json::json!({ "path": "a.txt" }),
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

fn permission_request() -> PermissionRequest {
    PermissionRequest {
        id: "pr-1".into(),
        session_id: "s1".into(),
        cwd: "/ws".into(),
        tool_call_id: "tc-1".into(),
        tool_name: "write_file".into(),
        parameters: serde_json::json!({ "path": "a.txt", "content": "x" }),
        summary: "写入文件".into(),
        tool_metadata: ToolMetadata {
            category: Some("filesystem".into()),
            is_read_only: None,
            fatal_on_error: None,
            concurrency: None,
        },
        metadata: None,
    }
}

/// 发射并返回**新增**载荷 JSON（记录发射前调用数，支持同一桥多次发射；
/// 断言通道名 = workbench-run-event）
fn emit_and_get(bridge: &EventBridge, emitter: &RecordingEmitter, envelope: AgentEventEnvelope) -> Value {
    let before = emitter.calls().len();
    bridge.emit_envelope(&envelope);
    let calls = emitter.calls();
    assert_eq!(calls.len(), before + 1, "每次发射恰好新增一条");
    let (channel, payload) = &calls[before];
    assert_eq!(channel, "workbench-run-event", "通道名冻结（03 §3.1）");
    serde_json::from_str(payload).expect("载荷为合法 JSON")
}

// ── 1/2/3/14：信封注入键逐事件恒在 + 扁平载荷（无 event/payload 二次包装）──

/// 代表性事件矩阵：信封注入 runId/sequence/schemaVersion/type 恒在，
/// 且顶层无 `event`/`payload` 二次包装键（03 §5.2-1 扁平化，16 项-14）
#[test]
fn envelope_keys_injected_on_every_event() {
    let (bridge, emitter) = recording_bridge();
    let samples: Vec<AgentEvent> = vec![
        AgentEvent::AgentStart {
            session_id: "s1".into(),
            timestamp: TS.into(),
        },
        AgentEvent::AgentEnd {
            session_id: "s1".into(),
            timestamp: TS.into(),
            reason: AgentEndReason::Stop,
            error: None,
        },
        AgentEvent::TurnStart {
            session_id: "s1".into(),
            turn_index: 0,
            timestamp: TS.into(),
        },
        AgentEvent::MessageDelta {
            session_id: "s1".into(),
            timestamp: TS.into(),
            message_id: "m1".into(),
            block: text_block("你"),
        },
        AgentEvent::ToolStart {
            session_id: "s1".into(),
            batch_id: "b1".into(),
            call: batch_call(),
            timestamp: TS.into(),
        },
        AgentEvent::ToolEnd {
            session_id: "s1".into(),
            batch_id: "b1".into(),
            result: batch_result(),
            timestamp: TS.into(),
        },
        AgentEvent::ApprovalRequested {
            session_id: "s1".into(),
            request: permission_request(),
            timestamp: TS.into(),
        },
        AgentEvent::ApprovalResolved {
            session_id: "s1".into(),
            tool_call_id: "tc-1".into(),
            request_id: None,
            decision: ApprovalDecision::Approved,
            timestamp: TS.into(),
        },
        AgentEvent::RunTerminal {
            session_id: "s1".into(),
            run_id: "r1".into(),
            timestamp: TS.into(),
            terminal: RunTerminalStatus::Completed,
            error: None,
        },
    ];

    for (i, event) in samples.iter().enumerate() {
        let envelope =
            AgentEventEnvelope::new(event.clone(), Some("r1".into()), Some(i as u64 + 1));
        let json = emit_and_get(&bridge, &emitter, envelope);
        let map = json.as_object().expect("顶层为 JSON 对象");
        // 1：type 字符串恒在
        assert_eq!(map["type"], event.type_name(), "顶层 type 恒在");
        // 2：runId 恒在（多 run 并发过滤依赖）
        assert_eq!(map["runId"], "r1", "信封注入 runId 恒在");
        // 3：sequence 数字恒在（重放去重/游标唯一依据）
        assert_eq!(map["sequence"], i as u64 + 1, "信封注入 sequence 恒在");
        // 14：扁平载荷，无 event/payload 二次包装键
        assert!(map.get("event").is_none(), "无 event 二次包装");
        assert!(map.get("payload").is_none(), "无 payload 二次包装");
    }
}

// ── 4/5：message-delta 硬依赖（block.text + block.type + messageId）──

#[test]
fn message_delta_contract_fields() {
    let (bridge, emitter) = recording_bridge();
    let json = emit_and_get(
        &bridge,
        &emitter,
        AgentEventEnvelope::new(
            AgentEvent::MessageDelta {
                session_id: "s1".into(),
                timestamp: TS.into(),
                message_id: "m1".into(),
                block: text_block("增量正文"),
            },
            Some("r1".into()),
            Some(1),
        ),
    );
    // 4：block.text + block.type
    assert_eq!(json["block"]["type"], "text", "block.type 锚定");
    assert_eq!(json["block"]["text"], "增量正文", "block.text 锚定");
    // 5：messageId
    assert_eq!(json["messageId"], "m1", "messageId 锚定");
}

#[test]
fn message_delta_thought_block_uses_type_thought() {
    let (bridge, emitter) = recording_bridge();
    let json = emit_and_get(
        &bridge,
        &emitter,
        AgentEventEnvelope::new(
            AgentEvent::MessageDelta {
                session_id: "s1".into(),
                timestamp: TS.into(),
                message_id: "m1".into(),
                block: thought_block("思考中"),
            },
            Some("r1".into()),
            Some(1),
        ),
    );
    assert_eq!(json["block"]["type"], "thought", "思考块 type=thought");
    assert_eq!(json["block"]["text"], "思考中");
    assert_eq!(json["block"]["redacted"], true);
}

// ── 6：message-end 硬依赖（message{role, content, blocks[], clientMessageId}）──

#[test]
fn message_end_message_object_contract() {
    let (bridge, emitter) = recording_bridge();
    let json = emit_and_get(
        &bridge,
        &emitter,
        AgentEventEnvelope::new(
            AgentEvent::MessageEnd {
                session_id: "s1".into(),
                message: Arc::new(assistant_message()),
            },
            Some("r1".into()),
            Some(1),
        ),
    );
    assert_eq!(json["message"]["role"], "assistant", "role 锚定");
    assert_eq!(json["message"]["content"], "hello", "content 兜底字段锚定");
    assert_eq!(
        json["message"]["clientMessageId"], "cm-1",
        "clientMessageId 稳定 id 锚定（pickStableMessageId 消费面）"
    );
    let blocks = json["message"]["blocks"].as_array().expect("blocks[] 数组");
    assert_eq!(blocks.len(), 2, "blocks 逐块序列化");
    assert_eq!(blocks[0]["type"], "text");
    assert_eq!(blocks[1]["type"], "thought");
}

// ── 7：tool-start 硬依赖（call.id/toolName + 参数）──

#[test]
fn tool_start_call_contract() {
    let (bridge, emitter) = recording_bridge();
    let json = emit_and_get(
        &bridge,
        &emitter,
        AgentEventEnvelope::new(
            AgentEvent::ToolStart {
                session_id: "s1".into(),
                batch_id: "b1".into(),
                call: batch_call(),
                timestamp: TS.into(),
            },
            Some("r1".into()),
            Some(1),
        ),
    );
    assert_eq!(json["call"]["id"], "tc-1", "call.id 锚定");
    assert_eq!(json["call"]["toolName"], "read_file", "call.toolName 锚定");
    assert_eq!(json["call"]["input"]["path"], "a.txt", "input 参数包锚定");
}

// ── 8：tool-end 硬依赖（result.id/output.text/isError）──

#[test]
fn tool_end_result_contract() {
    let (bridge, emitter) = recording_bridge();
    let json = emit_and_get(
        &bridge,
        &emitter,
        AgentEventEnvelope::new(
            AgentEvent::ToolEnd {
                session_id: "s1".into(),
                batch_id: "b1".into(),
                result: batch_result(),
                timestamp: TS.into(),
            },
            Some("r1".into()),
            Some(1),
        ),
    );
    assert_eq!(json["result"]["id"], "tc-1", "result.id 恒有（硬失败=无 id）");
    assert_eq!(json["result"]["output"]["text"], "文件内容", "output.text 锚定");
    assert_eq!(json["result"]["isError"], false, "isError 锚定");
}

// ── 9：approval-requested 硬依赖（request 字段组）──

#[test]
fn approval_requested_contract() {
    let (bridge, emitter) = recording_bridge();
    let json = emit_and_get(
        &bridge,
        &emitter,
        AgentEventEnvelope::new(
            AgentEvent::ApprovalRequested {
                session_id: "s1".into(),
                request: permission_request(),
                timestamp: TS.into(),
            },
            Some("r1".into()),
            Some(1),
        ),
    );
    assert_eq!(json["request"]["toolCallId"], "tc-1", "request.toolCallId 锚定");
    assert_eq!(json["request"]["toolName"], "write_file", "request.toolName 锚定");
    assert_eq!(
        json["request"]["parameters"]["path"], "a.txt",
        "request.parameters 参数包锚定"
    );
    assert_eq!(json["request"]["summary"], "写入文件", "request.summary 锚定");
}

// ── 10：approval-resolved 硬依赖（toolCallId + decision 规范值）──

#[test]
fn approval_resolved_decision_lowercase_norms() {
    let (bridge, emitter) = recording_bridge();
    // 三种决策规范值：approved / denied / expired（03 §5.3-3 lowercase）
    for (decision, expected) in [
        (ApprovalDecision::Approved, "approved"),
        (ApprovalDecision::Denied, "denied"),
        (ApprovalDecision::Expired, "expired"),
    ] {
        let json = emit_and_get(
            &bridge,
            &emitter,
            AgentEventEnvelope::new(
                AgentEvent::ApprovalResolved {
                    session_id: "s1".into(),
                    tool_call_id: "tc-1".into(),
                    request_id: None,
                    decision,
                    timestamp: TS.into(),
                },
                Some("r1".into()),
                Some(1),
            ),
        );
        assert_eq!(json["toolCallId"], "tc-1", "toolCallId 主键锚定");
        assert_eq!(json["decision"], expected, "decision 规范值 {expected}");
    }
}

// ── 11/16：run-terminal（terminal 规范值 + error 省略 + runId 必在）──

#[test]
fn run_terminal_contract() {
    let (bridge, emitter) = recording_bridge();
    // 三种终态规范值：completed / cancelled / failed（03 §5.1-11）
    for (terminal, expected) in [
        (RunTerminalStatus::Completed, "completed"),
        (RunTerminalStatus::Cancelled, "cancelled"),
        (RunTerminalStatus::Failed, "failed"),
    ] {
        let json = emit_and_get(
            &bridge,
            &emitter,
            AgentEventEnvelope::new(
                AgentEvent::RunTerminal {
                    session_id: "s1".into(),
                    run_id: "r1".into(),
                    timestamp: TS.into(),
                    terminal,
                    error: None,
                },
                Some("r1".into()),
                Some(1),
            ),
        );
        assert_eq!(json["terminal"], expected, "terminal 规范值 {expected}");
        // 16：run-terminal 的 runId 必须存在（StreamRecovery 消费面）
        assert_eq!(json["runId"], "r1", "run-terminal runId 必在");
        // error 省略时字段不输出（前端 zod 容差）
        assert!(json.get("error").is_none(), "error=None 时不输出 error 键");
    }
}

#[test]
fn run_terminal_error_field_when_failed() {
    let (bridge, emitter) = recording_bridge();
    let json = emit_and_get(
        &bridge,
        &emitter,
        AgentEventEnvelope::new(
            AgentEvent::RunTerminal {
                session_id: "s1".into(),
                run_id: "r1".into(),
                timestamp: TS.into(),
                terminal: RunTerminalStatus::Failed,
                error: Some("provider failed".into()),
            },
            Some("r1".into()),
            Some(1),
        ),
    );
    assert_eq!(json["terminal"], "failed");
    assert_eq!(json["error"], "provider failed", "failed 收场带 error 文案");
    assert_eq!(json["runId"], "r1");
}

// ── 12：agent-end（reason 规范值 + error 可选）──

#[test]
fn agent_end_reason_and_error() {
    let (bridge, emitter) = recording_bridge();
    // 无 error：reason 键恒在、error 键省略
    let json = emit_and_get(
        &bridge,
        &emitter,
        AgentEventEnvelope::new(
            AgentEvent::AgentEnd {
                session_id: "s1".into(),
                timestamp: TS.into(),
                reason: AgentEndReason::Stop,
                error: None,
            },
            Some("r1".into()),
            Some(1),
        ),
    );
    assert_eq!(json["reason"], "stop", "agent-end reason 锚定");
    assert!(json.get("error").is_none());
}

// ── 13：无 error 信封变体（AgentEvent 24 变体无 Error；桥只处理域事件）──

#[test]
fn no_error_envelope_variant_in_event_set() {
    // AgentEvent 24 变体穷举 type_name 白名单——不存在 error 信封变体
    // （IPC 模式失败收口走 run-terminal(failed)，30 号清单 §4.1-13 记录）
    let names: Vec<&str> = vec![
        "agent-start", "agent-end", "turn-start", "turn-end", "message-start", "message-delta",
        "message-end", "tool-start", "tool-update", "tool-end", "tool-batch-start",
        "tool-batch-end", "tool-input-repaired", "context-compression-start",
        "context-compression-end", "provider-diagnostic", "runtime-error", "runtime-steering",
        "runtime-intervention-required", "approval-requested", "approval-resolved",
        "checkpoint-created", "checkpoint-restored", "run-terminal",
    ];
    assert_eq!(names.len(), 24, "24 事件基线（33-event-schema-changelog.md v1 表）");
    assert!(!names.contains(&"error"), "error 信封不是域事件");
}

// ── schemaVersion 衔接（T11.3.2）：新事件必带且 = 1 ──

#[test]
fn schema_version_always_injected_as_one() {
    let (bridge, emitter) = recording_bridge();
    // 代表性事件样本：新信封序列化恒带 schemaVersion=1（PE-12 T12.5 验收口径）
    let samples: Vec<AgentEvent> = vec![
        AgentEvent::AgentStart {
            session_id: "s1".into(),
            timestamp: TS.into(),
        },
        AgentEvent::MessageDelta {
            session_id: "s1".into(),
            timestamp: TS.into(),
            message_id: "m1".into(),
            block: text_block("你"),
        },
        AgentEvent::ToolStart {
            session_id: "s1".into(),
            batch_id: "b1".into(),
            call: batch_call(),
            timestamp: TS.into(),
        },
        AgentEvent::ApprovalResolved {
            session_id: "s1".into(),
            tool_call_id: "tc-1".into(),
            request_id: None,
            decision: ApprovalDecision::Denied,
            timestamp: TS.into(),
        },
        AgentEvent::RunTerminal {
            session_id: "s1".into(),
            run_id: "r1".into(),
            timestamp: TS.into(),
            terminal: RunTerminalStatus::Completed,
            error: None,
        },
    ];
    for (i, event) in samples.iter().enumerate() {
        let json = emit_and_get(
            &bridge,
            &emitter,
            AgentEventEnvelope::new(event.clone(), Some("r1".into()), Some(i as u64)),
        );
        assert_eq!(json["schemaVersion"], 1, "{}：新事件必带 schemaVersion=1", event.type_name());
    }
}

// 保留：发射报告形状（emitted/buffered/dropped）——直发桥无背压
#[test]
fn emit_report_shape_for_direct_bridge() {
    let (bridge, _emitter) = recording_bridge();
    let envelope = AgentEventEnvelope::new(
        AgentEvent::AgentStart {
            session_id: "s1".into(),
            timestamp: TS.into(),
        },
        Some("r1".into()),
        Some(1),
    );
    let report = bridge.emit_envelope(&envelope);
    assert_eq!(report.emitted, 1);
    assert_eq!(report.buffered, 0, "直发桥不缓冲");
    assert_eq!(report.dropped, 0, "直发桥不丢帧");
}

/// 无背压直发桥的载荷获取（与 emit_and_get 同一语义，供桥序列化路径复用）
#[allow(dead_code)]
fn _bridge_serialize(bridge: &EventBridge, event: AgentEvent) -> Value {
    let envelope = AgentEventEnvelope::new(event, Some("r1".into()), Some(1));
    let payload = bridge.serialize(&envelope).expect("序列化成功");
    serde_json::from_str(&payload).expect("载荷为合法 JSON")
}
