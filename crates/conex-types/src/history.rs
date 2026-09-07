//! 历史回流水合类型域（P4 §3.7 HistoryMessage / §3.2.3 store 水合判定规则）
//!
//! 前端 store 消息的 LLM 上下文候选，与 `SessionMessage` 1:1；
//! 供前端水合（`core_run_task.history` 参数载荷，T-29/T-31）与
//! 引擎侧 SessionHistoryCache 冷启动兜底（T-30）共用；
//! T-28（session-loop hydrate.rs）据此映射为 `Vec<AgentMessage>`。

use serde::{Deserialize, Serialize};

/// 历史回流最小消息形态（对齐 P4 §3.7 HistoryMessage）
///
/// 与 `SessionMessage`（lib.rs:136-158）字段一一对应；
/// `id`/`sender`/`timestamp` 为必需，其余载荷字段全可选
/// （`#[serde(default, skip_serializing_if = "Option::is_none")]`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    /// 消息稳定 id
    pub id: String,
    /// "user" | "assistant"（UI 模型只有两种 sender）
    pub sender: String,
    /// 正文文本（无 blocks_json 时的合成兜底源）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 思考块文本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// 完整 `AgentMessageBlock` 序列 JSON（块保真优先，message.rs:100-126）
    #[serde(default, alias = "blocks_json", skip_serializing_if = "Option::is_none")]
    pub blocks_json: Option<String>,
    /// 工具调用 JSON（老数据兜底）
    #[serde(default, alias = "tool_calls_json", skip_serializing_if = "Option::is_none")]
    pub tool_calls_json: Option<String>,
    /// 工具结果 JSON（老数据兜底）
    #[serde(default, alias = "tool_call_results_json", skip_serializing_if = "Option::is_none")]
    pub tool_call_results_json: Option<String>,
    /// 完成态判定（completed 或历史无 status 字段才进 LLM 上下文，§3.2.3）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// epoch ms（顺序判定用）
    pub timestamp: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_message_serializes_to_camel_case() {
        let msg = HistoryMessage {
            id: "m1".into(),
            sender: "user".into(),
            text: Some("hello".into()),
            thinking: None,
            blocks_json: Some(r#"[{"type":"text","text":"hello"}]"#.into()),
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".into()),
            timestamp: 1_700_000_000_000,
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["id"], "m1");
        assert_eq!(json["sender"], "user");
        assert_eq!(json["text"], "hello");
        assert_eq!(json["blocksJson"], r#"[{"type":"text","text":"hello"}]"#);
        assert_eq!(json["timestamp"], 1_700_000_000_000i64);
        // Option::None 字段应被跳过
        assert!(json.get("thinking").is_none());
        assert!(json.get("toolCallsJson").is_none());
        assert!(json.get("toolCallResultsJson").is_none());
    }

    #[test]
    fn history_message_roundtrip() {
        let msg = HistoryMessage {
            id: "m2".into(),
            sender: "assistant".into(),
            text: Some("hi".into()),
            thinking: Some("reasoning".into()),
            blocks_json: None,
            tool_calls_json: Some(r#"[{"id":"c1","name":"read_file","arguments":"{}"}]"#.into()),
            tool_call_results_json: Some(r#"[{"callId":"c1","content":"ok"}]"#.into()),
            status: None,
            timestamp: 1_700_000_000_001,
        };
        let json = serde_json::to_string(&msg).unwrap();
        let back: HistoryMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn history_message_accepts_missing_optionals() {
        // 旧数据 / 最小载荷：可选字段全部缺失时应可反序列化
        let raw = r#"{"id":"m3","sender":"user","timestamp":100}"#;
        let msg: HistoryMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(msg.id, "m3");
        assert_eq!(msg.sender, "user");
        assert_eq!(msg.timestamp, 100);
        assert_eq!(msg.text, None);
        assert_eq!(msg.thinking, None);
        assert_eq!(msg.blocks_json, None);
        assert_eq!(msg.tool_calls_json, None);
        assert_eq!(msg.tool_call_results_json, None);
        assert_eq!(msg.status, None);
    }

    #[test]
    fn history_message_accepts_status_absent_legacy() {
        // 历史无 status 字段 = 视为完成态（§3.2.3 兼容旧数据）
        let raw = r#"{"id":"m4","sender":"assistant","text":"done","timestamp":200}"#;
        let msg: HistoryMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(msg.status, None);
    }
}
