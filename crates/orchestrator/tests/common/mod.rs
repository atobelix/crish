//! orchestrator 集成测试公共构件（tests/common）
//!
//! 各测试文件以 `mod common;` 方式包含本模块，共享：
//! - [setup]：内存 store 句柄 + 共享 trait 对象（InMemoryStore 断言 + 落库路径）；
//! - [TestEngine]：run 引擎替身（L2 协作停止是否支持可配置，记录调用；
//!   对齐 05 §4.5 createMockGateway 的脚本 + 记录模式）；
//! - 事件构件：agent_start / agent_end / message_delta / message_end /
//!   approval_requested / approval_resolved / outcome 等最小字段构造。
//!
//! 注意：本模块不构成独立测试二进制，须由测试文件包含（`mod common;`）。
//! 各测试文件只使用其中一部分构件，未用部分按共享测试模块惯例豁免。

#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use conex_types::events::{
    AgentEvent, AgentEventEnvelope, ApprovalDecision, PermissionRequest, RunTerminalStatus,
};
use conex_types::message::{AgentMessage, AgentMessageBlock};
use conex_types::session::AgentEndReason;
use orchestrator::persist::{InMemoryStore, Store};
use orchestrator::run::RunEngine;
use session_loop::RunOutcome;

/// 固定时间戳（事件体最小构造共用）
pub const TS: &str = "2026-07-31T00:00:00.000Z";

/// 内存 store（具体句柄 + 共享 trait 对象）——断言落库快照用 mem，落库路径用 store
pub fn setup() -> (Arc<InMemoryStore>, Arc<dyn Store>) {
    let mem = Arc::new(InMemoryStore::new());
    let store: Arc<dyn Store> = mem.clone();
    (mem, store)
}

/// run 引擎替身（05 §4.5 脚本 + 记录模式）：
/// - `cooperative_supported = false` 模拟引擎不支持 L2（回落 L3 路径）；
/// - 协作停止 / 强制中断调用分别记录，供断言「不 hard abort」语义。
pub struct TestEngine {
    cooperative_supported: bool,
    cooperative_calls: Arc<Mutex<Vec<String>>>,
    abort_calls: Arc<Mutex<Vec<String>>>,
}

impl TestEngine {
    /// 新建引擎（true = 支持 L2 协作停止）
    pub fn new(cooperative_supported: bool) -> Self {
        Self {
            cooperative_supported,
            cooperative_calls: Arc::new(Mutex::new(Vec::new())),
            abort_calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// 已注入的协作停止原因列表（L2）
    pub fn cooperative_calls(&self) -> Vec<String> {
        self.cooperative_calls.lock().unwrap().clone()
    }

    /// 已执行的强制中断原因列表（L3 hard abort）
    pub fn abort_calls(&self) -> Vec<String> {
        self.abort_calls.lock().unwrap().clone()
    }
}

impl RunEngine for TestEngine {
    fn request_cooperative_stop(&self, reason: &str) -> bool {
        if !self.cooperative_supported {
            return false;
        }
        self.cooperative_calls
            .lock()
            .unwrap()
            .push(reason.to_string());
        true
    }

    fn abort(&self, reason: &str) {
        self.abort_calls.lock().unwrap().push(reason.to_string());
    }
}

/// T-D-09：kill_all / resume 的 L3 强停投递替身（记录投递调用 +
/// 可配置投递结果，模拟引擎「有无该 run 运行实例」）
pub struct RecordingCancelSink {
    calls: Arc<Mutex<Vec<(String, String)>>>,
    /// 是否模拟投递成功（false = 引擎无该 run 的运行实例）
    deliver: bool,
}

impl RecordingCancelSink {
    /// 新建替身（deliver = 投递结果模拟）
    pub fn new(deliver: bool) -> Arc<Self> {
        Arc::new(Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            deliver,
        })
    }

    /// 已投递的 (run_id, reason) 调用序列
    pub fn calls(&self) -> Vec<(String, String)> {
        self.calls.lock().unwrap().clone()
    }
}

impl orchestrator::lifecycle::ForceCancelSink for RecordingCancelSink {
    fn request_force_cancel(&self, subagent_run_id: &str, reason: &str) -> bool {
        self.calls
            .lock()
            .unwrap()
            .push((subagent_run_id.to_string(), reason.to_string()));
        self.deliver
    }
}

// ── 事件构件（字段最小化，供 drive 流程入队）──

/// agent-start 事件（sessionId 显式给定，模拟运行时产出）
pub fn agent_start(session: &str) -> AgentEvent {
    AgentEvent::AgentStart {
        session_id: session.to_string(),
        timestamp: TS.into(),
    }
}

/// agent-end 事件（reason 按收场给定）
pub fn agent_end(session: &str, reason: AgentEndReason) -> AgentEvent {
    AgentEvent::AgentEnd {
        session_id: session.to_string(),
        timestamp: TS.into(),
        reason,
        error: None,
    }
}

/// message-delta 事件（非持久化类别，drive 分流断言用）
pub fn message_delta(session: &str, index: u64) -> AgentEvent {
    AgentEvent::MessageDelta {
        session_id: session.to_string(),
        timestamp: TS.into(),
        message_id: "m1".to_string(),
        block: AgentMessageBlock::Text {
            text: format!("chunk-{index}"),
        },
    }
}

/// message-end 事件（持久化类别）
pub fn message_end(session: &str) -> AgentEvent {
    AgentEvent::MessageEnd {
        session_id: session.to_string(),
        message: std::sync::Arc::new(AgentMessage {
            id: "m1".to_string(),
            role: conex_types::message::AgentMessageRole::Assistant,
            created_at: TS.into(),
            blocks: vec![AgentMessageBlock::Text {
                text: "full".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }),
        turn_index: None,
    }
}

/// approval-requested 事件（持久化类别；审批挂起时 runtime 产出）
pub fn approval_requested(session: &str, tool_call_id: &str) -> AgentEvent {
    AgentEvent::ApprovalRequested {
        session_id: session.to_string(),
        request: PermissionRequest {
            id: format!("pr-{tool_call_id}"),
            session_id: session.to_string(),
            cwd: "/ws".to_string(),
            tool_call_id: tool_call_id.to_string(),
            tool_name: "write_file".to_string(),
            parameters: serde_json::json!({}),
            summary: "写入文件".to_string(),
            tool_metadata: Default::default(),
            metadata: None,
            // T-D-14 权限传递层：主 agent 请求缺省 None（向后兼容）
            requester_run_id: None,
            reason: None,
        },
        timestamp: TS.into(),
    }
}

/// approval-resolved 事件（批准 / 拒绝决策均由本事件表达，03 §5.3-3）
pub fn approval_resolved(
    session: &str,
    tool_call_id: &str,
    decision: ApprovalDecision,
) -> AgentEvent {
    AgentEvent::ApprovalResolved {
        session_id: session.to_string(),
        tool_call_id: tool_call_id.to_string(),
        request_id: None,
        decision,
        timestamp: TS.into(),
    }
}

/// 构造 run 结果（session-loop 收口类型；error 收场时携带文案）
pub fn outcome(reason: AgentEndReason, error: Option<&str>, events: Vec<AgentEvent>) -> RunOutcome {
    RunOutcome {
        reason: reason.into(),
        error: error.map(str::to_string),
        diagnostic: None,
        messages: Vec::new(),
        events,
        turn_index: 1,
        tool_call_count: 0,
        steering_count: 0,
        // T-36：缓存统计字段（本构造点无样本 → None，缺省向后兼容）
        cache_stats: None,
        yield_payload: None,
        // D1：provider 错误摘要（本构造点非 fatal 收场 → None，缺省向后兼容）
        provider_error: None,
    }
}

/// 事件信封（sequence 指定，runId 待归一化注入）
pub fn envelope(event: AgentEvent, sequence: u64) -> AgentEventEnvelope {
    AgentEventEnvelope::new(event, None, Some(sequence))
}

/// 序列化后的扁平 JSON 顶层 `type`（对齐 03 §3.1 扁平信封）
pub fn top_level_type(envelope: &AgentEventEnvelope) -> String {
    serde_json::to_value(envelope)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_default()
}

/// 断言 run-terminal 唯一性与终态字段（终态事件唯一性，03 §5.2-2）
pub fn assert_single_terminal(
    events: &[orchestrator::events::SequencedEvent],
    expected: RunTerminalStatus,
) {
    let terminals: Vec<_> = events
        .iter()
        .filter(|e| matches!(e.event, AgentEvent::RunTerminal { .. }))
        .collect();
    assert_eq!(terminals.len(), 1, "run-terminal 应恰好发出一次");
    match &terminals[0].event {
        AgentEvent::RunTerminal { terminal, .. } => {
            assert_eq!(*terminal, expected, "终态应与收场 reason 一致");
        }
        other => panic!("终态事件类型不符：{other:?}"),
    }
    assert_eq!(
        events.last().map(|e| e.sequence),
        Some(terminals[0].sequence),
        "run-terminal 应为事件流最后一个事件"
    );
}

/// 确定性异步状态轮询器（消除测试中的假等待与固定 sleep）
pub async fn wait_until<T, F, Fut>(
    timeout_dur: std::time::Duration,
    poll_interval: std::time::Duration,
    mut condition: F,
) -> Result<T, &'static str>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let start = std::time::Instant::now();
    while start.elapsed() < timeout_dur {
        if let Some(res) = condition().await {
            return Ok(res);
        }
        tokio::time::sleep(poll_interval).await;
    }
    Err("wait_until 超时：在指定时限内未达成预期状态")
}
