//! 消息域类型（契约注册表 contracts/engine-events.json 的
//! AgentMessage / AgentMessageBlock / ToolCallBlock 载荷）
//!
//! 前端硬依赖（03 §5.1-4/5/6）：`message-delta.block.text` 与
//! `block.type === 'thought'` 是增量正文/思考的唯一文本来源；
//! `message-end.message` 必须携带稳定 id 与 blocks[] 全文。

use serde::{Deserialize, Serialize};

use crate::tool::ToolOutput;

/// 消息来源/类型标记（对齐 `AgentMessage.metadata.kind`，与 [AgentMessageRole]
/// 正交的另一维度——role 是 LLM wire 对话角色，kind 是注入/状态等「来源标记」）。
///
/// 统一输入流收敛战役 T1a（详案-T1-事件模型扩展 §1.2 b/c）：把 02 审计问题⑥
/// 的魔法字符串常量化（`steering`/`nudge`/`diagnostic`/`steering`，
/// 历史出站 `runtime-steering` 经 I1-α④ 统一为 `Steering` canonical wire）。
/// T1 只定义枚举位（wire 映射经 serde kebab-case 派生，as_str 消费归 I1）。
/// wire kebab-case，serde 反序列化接受下列规范值。
///
/// serde 不可实例化冲突规避：枚举是「来源标记名称」集合，`AgentMessage.metadata`
/// 依旧为 `JsonValue`（详案 §1.3：不改 metadata 字段类型），枚举位经生成常量
/// `AGENT_MESSAGE_METADATA_KIND_VALUES` 暴露给前端。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentMessageMetadataKind {
    /// 运行时 steering 注入（canonical wire `steering`；历史 `runtime-steering`
    /// 出站值已随 I1-α④ 统一收编）
    Steering,
    /// 轻量 nudge 提示（`nudge`；决策 9 后无生产者，枚举位保留供事件面）
    Nudge,
    /// 诊断说明消息（`diagnostic`）
    Diagnostic,
    /// 上下文状态切换告知（I1 注入；role=User，正文走 text 块）
    ContextState,
    /// 静态注入文本（D2 文本化；走请求组装层，不进时间线）
    Injection,
    /// tool-promise 自愈注入（二进制恒值 `tool-promise-recovery`；
    /// I1-α④ 补位，消费方 streaming.rs / no_tool_calls.rs）
    ToolPromiseRecovery,
    /// goal 续轮注入（跨 run 边界 `goal-continue`；I1-α④ 补位，
    /// 消费方 run_idle.rs）
    GoalContinue,
}

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

/// 图片多模态内容块（一等公民支持）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageContentBlock {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(alias = "mime_type")]
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
}

/// 消息内容块（对齐 AgentMessageBlock）
///
/// tagged enum：`type` ∈ text / thought / tool-call / tool-result / image。
/// 前端以 `block.type === 'thought'` 判定思考块（03 §5.1-4）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum AgentMessageBlock {
    /// 正文增量/终态块
    #[serde(rename = "text", alias = "Text", rename_all = "camelCase")]
    Text { text: String },
    /// 思考块（redacted 透传，02 §1.4：Responses 推理标 redacted=true）
    #[serde(
        rename = "thought",
        alias = "Thought",
        alias = "thought_log",
        rename_all = "camelCase"
    )]
    Thought {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    /// 工具调用块
    #[serde(
        rename = "tool-call",
        alias = "tool_call",
        alias = "ToolCall",
        rename_all = "camelCase"
    )]
    ToolCall(ToolCallBlock),
    /// 工具结果块
    #[serde(
        rename = "tool-result",
        alias = "tool_result",
        alias = "ToolResult",
        rename_all = "camelCase"
    )]
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        output: ToolOutput,
        is_error: bool,
    },
    /// 图片多模态内容块
    #[serde(rename = "image", alias = "Image", rename_all = "camelCase")]
    Image(ImageContentBlock),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_image_content_block_roundtrip() {
        let block = AgentMessageBlock::Image(ImageContentBlock {
            url: Some("https://example.com/photo.png".into()),
            data: None,
            mime_type: "image/png".into(),
            alt: Some("测试图片".into()),
        });
        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains(r#""type":"image""#));
        assert!(json.contains(r#""mimeType":"image/png""#));
        assert!(json.contains(r#""url":"https://example.com/photo.png""#));

        let back: AgentMessageBlock = serde_json::from_str(&json).unwrap();
        assert_eq!(block, back);
    }

    #[test]
    fn test_image_content_block_snake_case_alias() {
        let raw = r#"{
            "type": "Image",
            "mime_type": "image/jpeg",
            "data": "base64data=="
        }"#;
        let parsed: AgentMessageBlock = serde_json::from_str(raw).unwrap();
        match parsed {
            AgentMessageBlock::Image(img) => {
                assert_eq!(img.mime_type, "image/jpeg");
                assert_eq!(img.data.as_deref(), Some("base64data=="));
                assert!(img.url.is_none());
            }
            _ => panic!("Expected Image block"),
        }
    }

    #[test]
    fn test_tool_call_and_result_aliases() {
        let call_raw = r#"{
            "type": "tool_call",
            "id": "c1",
            "toolName": "bash",
            "input": {"cmd": "pwd"}
        }"#;
        let call_block: AgentMessageBlock = serde_json::from_str(call_raw).unwrap();
        match call_block {
            AgentMessageBlock::ToolCall(c) => {
                assert_eq!(c.id, "c1");
                assert_eq!(c.tool_name, "bash");
            }
            _ => panic!("Expected ToolCall"),
        }

        let res_raw = r#"{
            "type": "tool_result",
            "toolCallId": "c1",
            "toolName": "bash",
            "output": {"text": "/root"},
            "isError": false
        }"#;
        let res_block: AgentMessageBlock = serde_json::from_str(res_raw).unwrap();
        match res_block {
            AgentMessageBlock::ToolResult {
                tool_call_id,
                output,
                is_error,
                ..
            } => {
                assert_eq!(tool_call_id, "c1");
                assert_eq!(output.text.as_deref(), Some("/root"));
                assert!(!is_error);
            }
            _ => panic!("Expected ToolResult"),
        }
    }
}
