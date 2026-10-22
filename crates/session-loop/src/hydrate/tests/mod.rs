mod basic;
mod regressions;
mod tool_blocks;

use std::sync::Arc;

use conex_types::history::HistoryMessage;
use conex_types::message::AgentMessage;

/// 便捷构造（缺省无 thinking/无 JSON 载荷字段）
pub(super) fn msg(
    id: &str,
    sender: &str,
    text: Option<&str>,
    status: Option<&str>,
) -> HistoryMessage {
    HistoryMessage {
        id: id.into(),
        sender: sender.into(),
        text: text.map(String::from),
        thinking: None,
        blocks_json: None,
        tool_calls_json: None,
        tool_call_results_json: None,
        status: status.map(String::from),
        timestamp: 1_700_000_000_000,
    }
}

pub(super) fn ids(hydrated: &[Arc<AgentMessage>]) -> Vec<&str> {
    hydrated.iter().map(|m| m.id.as_str()).collect()
}
