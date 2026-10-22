//! ai_summary 单元测试：公共 fixture / mock 摘要器（从 ai_summary.rs 纯搬迁）

use std::sync::Arc;

use conex_types::{AgentMessage, AgentMessageBlock, AgentMessageRole};

use crate::compaction::Summarizer;

mod details;
mod guard;
mod prompt;

pub(super) fn text_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Text {
        text: text.to_string(),
    }
}

pub(super) fn amsg(
    id: &str,
    role: AgentMessageRole,
    created_at: &str,
    blocks: Vec<AgentMessageBlock>,
) -> Arc<AgentMessage> {
    Arc::new(AgentMessage {
        id: id.to_string(),
        role,
        created_at: created_at.to_string(),
        blocks,
        metadata: None,
        client_message_id: None,
        content: None,
    })
}

/// 足够长的摘要样本（≥ min_chars 阈值，用于通过退化检测的"成功"路径）
pub(super) fn long_summary() -> String {
    "这是一段足够长的压缩摘要样本，用于通过退化检测的字符下限阈值。".repeat(20)
}

/// 可编程摘要器（mock provider 通道：按脚本依次返回成功/退化/失败；
/// 脚本耗尽后按最后一项重复）
pub(super) struct ScriptedSummarizer {
    state: std::sync::Mutex<ScriptState>,
}

/// 脚本状态：剩余队列 + 最近弹出项（耗尽后重复最近项）
struct ScriptState {
    queue: std::collections::VecDeque<Result<String, String>>,
    last: Option<Result<String, String>>,
}

impl ScriptedSummarizer {
    pub(super) fn new(script: Vec<Result<String, String>>) -> Self {
        Self {
            state: std::sync::Mutex::new(ScriptState {
                queue: script.into(),
                last: None,
            }),
        }
    }
}

impl Summarizer for ScriptedSummarizer {
    fn summarize(
        &self,
        _dropped: &[AgentMessage],
        _existing: Option<&str>,
    ) -> Result<String, String> {
        let mut state = self.state.lock().unwrap();
        if let Some(item) = state.queue.pop_front() {
            let clone = item.clone();
            state.last = Some(clone);
            item
        } else {
            state.last.clone().expect("脚本必须至少有一项且已被消费")
        }
    }
}

pub(super) fn empty_wait() -> Box<dyn FnMut(std::time::Duration) + Send> {
    Box::new(|_| {})
}

/// Arc 列表 → 值列表（摘要边界以 [AgentMessage] 传值形态为准）
pub(super) fn flat(messages: &[Arc<AgentMessage>]) -> Vec<AgentMessage> {
    messages.iter().map(|m| (**m).clone()).collect()
}

/// Schema V1 合法摘要文档（Summarizer 成功路径返回；T-13 R-G 场景 A）。
/// 正文 > 500 字符以通过护栏退化判定（grok MIN_SUMMARY_SEED_CHARS）
pub(super) fn summary_doc_json(goal: &str) -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "blockId": "unused",
        "generation": 1,
        "droppedIds": [],
        "height": 1,
        "tier": "chunk",
        "goal": goal,
        "constraints": [],
        "progress": [],
        "decisions": [],
        "nextSteps": [],
        "criticalContext": "折叠链冻结 + 中性 stub（R-C）+ Schema V1 文档 md 渲染投影（R-G）：链消息逐字节稳定，可追溯可恢复；同步单次尝试（R-F）；摘要就绪以块表为准，对话 stub 永不改写。".repeat(5),
    })
    .to_string()
}
