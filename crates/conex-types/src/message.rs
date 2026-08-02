//! 消息域类型（契约注册表 contracts/engine-events.json 的
//! AgentMessage / AgentMessageBlock / ToolCallBlock 载荷）
//!
//! 前端硬依赖（03 §5.1-4/5/6）：`message-delta.block.text` 与
//! `block.type === 'thought'` 是增量正文/思考的唯一文本来源；
//! `message-end.message` 必须携带稳定 id 与 blocks[] 全文。

use serde::{Deserialize, Serialize};

use crate::tool::ToolOutput;

/// 消息角色（对齐 AgentMessage.role，serde lowercase）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMessageRole {
    /// 系统消息（含 steering 注入消息）
    System,
    /// 用户消息
    User,
    /// 助手消息
    Assistant,
    /// 工具结果消息
    Tool,
}

/// 会话消息（对齐 AgentMessage）
///
/// `clientMessageId` 为前端水合 rekey 的稳定幂等键（03 §5.1-6 /
/// §5.3-4）：用户消息 = 本地乐观 id，助手消息 = stream placeholder id。
/// `content` 为前端正文兜底字段（03 §5.1-6：EventRouter 读
/// `message.content` 兜底），非 TS 类型字段，可选。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    /// 消息稳定 id
    pub id: String,
    pub role: AgentMessageRole,
    /// ISO8601 时间戳
    pub created_at: String,
    /// 内容块序列（text/thought/tool-call/tool-result）
    pub blocks: Vec<AgentMessageBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    /// 客户端幂等键（前端 upsert/rekey 优先此字段）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    /// 正文兜底（前端 content 回退，emit 时建议填充 text block 拼接）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

impl AgentMessage {
    /// 拼接全部 text block 的正文
    pub fn text(&self) -> String {
        self.blocks
            .iter()
            .filter_map(|b| match b {
                AgentMessageBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }

    /// 拼接全部 thought block 的思考内容
    pub fn thought(&self) -> String {
        self.blocks
            .iter()
            .filter_map(|b| match b {
                AgentMessageBlock::Thought { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }

    /// 消息携带的工具调用块
    pub fn tool_calls(&self) -> impl Iterator<Item = &ToolCallBlock> {
        self.blocks.iter().filter_map(|b| match b {
            AgentMessageBlock::ToolCall(block) => Some(block),
            _ => None,
        })
    }
}

/// 工具调用块（对齐 ToolCallBlock）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallBlock {
    pub id: String,
    pub tool_name: String,
    /// 结构化入参（JSON 对象）
    pub input: serde_json::Value,
}

/// 消息内容块（对齐 AgentMessageBlock）
///
/// tagged enum：`type` ∈ text / thought / tool-call / tool-result。
/// 前端以 `block.type === 'thought'` 判定思考块（03 §5.1-4）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum AgentMessageBlock {
    /// 正文增量/终态块
    #[serde(rename = "text", rename_all = "camelCase")]
    Text {
        text: String,
    },
    /// 思考块（redacted 透传，02 §1.4：Responses 推理标 redacted=true）
    #[serde(rename = "thought", rename_all = "camelCase")]
    Thought {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    /// 工具调用块
    #[serde(rename = "tool-call", rename_all = "camelCase")]
    ToolCall(ToolCallBlock),
    /// 工具结果块
    #[serde(rename = "tool-result", rename_all = "camelCase")]
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        output: ToolOutput,
        is_error: bool,
    },
}
