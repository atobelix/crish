//! wait_channel 单元测试（自 wait_channel.rs 内联 `mod tests` 原样搬迁，按主题分文件）；
//! 本文件保留共用的测试通道 / 订阅同步 / 事件与状态行构造 helper。

use super::*;
use agent_tools::tools::subagent::SubagentState;
use agent_tools::tools::wait_subagents::{
    dispatch_outputs_value, parse_dispatch_outputs, SubagentOutput, WaitMode,
    DISPATCH_META_KEY_MODE, DISPATCH_META_KEY_OUTPUTS,
};
use conex_db::LocalDb;
use conex_types::events::AgentEvent;
use conex_types::events::SubagentEndStatus;
use session_loop::control::ControlKind;
use std::collections::HashMap;
use std::time::Duration;

mod local_db;
mod persist;
mod wait_inject_snapshot;

/// 测试通道（mock 适配器；返回通道与可断言适配器句柄）
fn test_channel() -> (
    Arc<WaitChannel>,
    Arc<MemoryWaitStore>,
    Arc<MemoryAgentSource>,
    Arc<EventStreamBroadcast>,
) {
    let store = Arc::new(MemoryWaitStore::new());
    let agents = Arc::new(MemoryAgentSource::new());
    let stream = Arc::new(EventStreamBroadcast::new());
    let channel = Arc::new(WaitChannel::new(
        Arc::clone(&store) as Arc<dyn WaitStore>,
        Arc::clone(&agents) as Arc<dyn SubagentStatusSource>,
        Arc::clone(&stream),
        Arc::new(NoopControlBusResolver),
    ));
    (channel, store, agents, stream)
}

/// 等待订阅建立（wait_for_terminal 与 feed 之间的同步点；
/// 避免订阅前 feed 丢事件）
async fn wait_until_subscribed(stream: &EventStreamBroadcast) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        if stream.subscriber_count() > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("订阅未在时限内建立（subscriber_count = 0）");
}

/// 子代理结束事件构造（feed 测试用；ended_at 形状对齐
/// build_subagent_ended subagent_events.rs:153-162）
fn subagent_ended(subagent_id: &str, status: SubagentEndStatus) -> AgentEvent {
    AgentEvent::SubagentEnded {
        session_id: "sess-test".to_string(),
        subagent_id: subagent_id.to_string(),
        subagent_run_id: format!("run-{subagent_id}"),
        status,
        summary: Some(format!("{subagent_id} 完成")),
        ended_at: "2026-08-05T00:00:00.000Z".to_string(),
        subagent_session_id: None,
    }
}

/// 状态行构造（snapshot 测试用；字段对齐 conex-types SessionAgent）
fn agent_row(id: &str, status: &str, started_at_ms: i64) -> SessionAgent {
    SessionAgent {
        id: id.to_string(),
        subagent_run_id: format!("run-{id}"),
        parent_session_id: "sess-test".to_string(),
        parent_run_id: "run-main".to_string(),
        parent_tool_call_id: None,
        description: String::new(),
        mode: "research".to_string(),
        status: status.to_string(),
        summary: None,
        messages: Vec::new(),
        started_at: started_at_ms,
        ended_at: None,
        depth: Some(1),
        subagent_path_json: None,
        task_type: None,
        display_label: None,
        allowed_write_paths_json: None,
        sub_session_id: None,
    }
}
