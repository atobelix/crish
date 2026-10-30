//! 会话持久化行模型（对齐 crish-desktop store/types.ts）。

use serde::{Deserialize, Serialize};

/// 新建会话索引条目的默认文件夹名（中文 UI 文案的历史默认值）。
pub const DEFAULT_SESSION_FOLDER: &str = "常规会话";

/// 会话内一条用户或助手消息（对齐 SessionMessage in store/types.ts L344-370）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub id: String,
    /// "user" | "assistant"
    pub sender: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// epoch ms
    pub timestamp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_text_offset: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_time: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_results_json: Option<String>,
    /// 消息级 usage 快照（v5 列 usage_json 的投影，P5 C8）。
    /// 内容为前端写入的 camelCase CacheUsage JSON 原样透传（如
    /// `{"promptTokens":12000,"cacheReadTokens":9000}`），Rust 侧不转换
    /// 不解析，解析/派生在回读面完成；无快照（含全零，C15）→ None 不落库。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<String>,
}

/// 协作子 agent（对齐 SessionAgent in store/types.ts L383-405）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionAgent {
    pub id: String,
    pub subagent_run_id: String,
    pub parent_session_id: String,
    pub parent_run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub mode: String,
    /// running | completed | failed | stopped
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub messages: Vec<SessionMessage>,
    /// epoch ms
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_path_json: Option<String>,
    /// 任务类型（wire kebab-case 六枚举，T-D-07；v6 新列；驱动系统默认
    /// 权限集的落库快照，展示/审计用——权限判定在引擎侧按默认集装配）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
    /// 角色展示标签（2-5 字自由文本，仅展示不影响调度，T-D-05；v6 新列）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_label: Option<String>,
    /// 显式写路径白名单（JSON 字符串数组，硬沙箱消费输入，T-D-07；v6 新列）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_write_paths_json: Option<String>,
    /// 子会话 id（D-02 LK-04 反向导航键：`sub-sess-{depth}-{n}` 命名，
    /// spawner 落库；子会话行经本列反查 session_agents 行——parent_run_id /
    /// parent_tool_call_id 回父会话；v9 新列，旧行空串/未接线 = None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_session_id: Option<String>,
    /// spawn 时声明的能力档（read-only / all；v14 列）。
    /// 展示与恢复建议用；运行期生效值由 `CapabilityCell` 按父链实时钳制。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_mode: Option<String>,
    /// 绑定的模型覆盖（None = 跟随引擎当前配置；v14 列）。
    /// 跨重启保留，恢复时作为子代理 run 的初始模型。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_override: Option<String>,
    /// 可恢复标记（v14 列）：中断对账置 true，正常终态置 false。
    /// 主 agent 可据此决定是否重派/恢复；前端展示「可恢复」徽标。
    #[serde(default)]
    pub resumable: bool,
    /// 最近心跳（epoch ms；v14 列）。运行期周期刷新，用于识别
    /// 长时间无进展的失联子代理；None = 旧行/未采集。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_heartbeat_ms: Option<i64>,
}

/// 会话索引条目（对齐 SessionIndexEntry in sessionPersistenceTypes.ts L20-36）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default = "default_session_folder")]
    pub folder: String,
    #[serde(default)]
    pub is_pinned: bool,
    #[serde(default)]
    pub is_archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_parent_id: Option<String>,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub message_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_message_ids: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_cursor: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_last_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hydrated_from_engine: Option<bool>,
}

fn default_session_folder() -> String {
    DEFAULT_SESSION_FOLDER.to_string()
}

/// 数据迁移统计
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportStats {
    #[serde(default)]
    pub sessions: u64,
    #[serde(default)]
    pub messages: u64,
    #[serde(default)]
    pub agents: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_message_serializes_to_camel_case() {
        let msg = SessionMessage {
            id: "m1".into(),
            sender: "user".into(),
            text: Some("hello".into()),
            thinking: None,
            timestamp: 1700000000,
            status: Some("completed".into()),
            stream_text_offset: None,
            thinking_time: Some(120),
            tool_calls_json: None,
            blocks_json: None,
            tool_call_results_json: None,
            usage: None,
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["id"], "m1");
        assert_eq!(json["sender"], "user");
        assert_eq!(json["text"], "hello");
        assert_eq!(json["timestamp"], 1700000000);
        assert_eq!(json["status"], "completed");
        assert_eq!(json["thinkingTime"], 120);
        // None 字段应被跳过
        assert!(json.get("thinking").is_none());
        assert!(json.get("streamTextOffset").is_none());
        assert!(json.get("toolCallsJson").is_none());
        assert!(json.get("usage").is_none());
    }

    #[test]
    fn session_message_roundtrip() {
        let msg = SessionMessage {
            id: "m1".into(),
            sender: "assistant".into(),
            text: Some("hi".into()),
            thinking: Some("reasoning".into()),
            timestamp: 1700000001,
            status: None,
            stream_text_offset: Some(10),
            thinking_time: None,
            tool_calls_json: Some(r#"[]"#.into()),
            blocks_json: None,
            tool_call_results_json: None,
            usage: Some(r#"{"promptTokens":12000,"cacheReadTokens":9000}"#.into()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let back: SessionMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
        // usage 线上键为 camelCase 原形（透传字符串，Rust 侧不解析）
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(
            value["usage"],
            r#"{"promptTokens":12000,"cacheReadTokens":9000}"#
        );
    }

    #[test]
    fn session_message_accepts_legacy_field_names() {
        // 旧 JS 端写入的 JSON 应能被反序列化
        let raw = r#"{"id":"m1","sender":"user","text":"hi","timestamp":100,"thinkingTime":5}"#;
        let msg: SessionMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(msg.id, "m1");
        assert_eq!(msg.thinking_time, Some(5));
    }

    #[test]
    fn session_message_usage_absent_deserializes_to_none() {
        // 旧数据（无 usage 键）反序列化 → None，不炸
        let raw = r#"{"id":"m1","sender":"user","text":"hi","timestamp":100}"#;
        let msg: SessionMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(msg.usage, None);
        // 携带 usage 键（前端契约形状）→ 原样透传字符串
        let raw2 = r#"{"id":"m2","sender":"assistant","timestamp":101,
                       "usage":"{\"promptTokens\":12000,\"cacheReadTokens\":9000}"}"#;
        let msg2: SessionMessage = serde_json::from_str(raw2).unwrap();
        assert_eq!(
            msg2.usage.as_deref(),
            Some(r#"{"promptTokens":12000,"cacheReadTokens":9000}"#)
        );
    }

    #[test]
    fn session_agent_roundtrip_with_messages() {
        let agent = SessionAgent {
            id: "a1".into(),
            subagent_run_id: "run-1".into(),
            parent_session_id: "s1".into(),
            parent_run_id: "prun-1".into(),
            parent_tool_call_id: Some("tc-1".into()),
            description: "explore".into(),
            mode: "explore".into(),
            status: "completed".into(),
            summary: Some("done".into()),
            messages: vec![SessionMessage {
                id: "am1".into(),
                sender: "assistant".into(),
                text: Some("ok".into()),
                thinking: None,
                timestamp: 100,
                status: None,
                stream_text_offset: None,
                thinking_time: None,
                tool_calls_json: None,
                blocks_json: None,
                tool_call_results_json: None,
                usage: None,
            }],
            started_at: 50,
            ended_at: Some(150),
            depth: Some(0),
            subagent_path_json: Some(r#"["a1"]"#.into()),
            task_type: Some("analysis".into()),
            display_label: Some("Rust 内核分析师".into()),
            allowed_write_paths_json: Some(r#"["docs/notes"]"#.into()),
            sub_session_id: Some("sub-sess-0-1".into()),
            capability_mode: Some("read-only".into()),
            model_override: Some("grok-3".into()),
            resumable: true,
            last_heartbeat_ms: Some(140),
        };
        let json = serde_json::to_string(&agent).unwrap();
        let back: SessionAgent = serde_json::from_str(&json).unwrap();
        assert_eq!(agent, back);
        assert_eq!(back.messages.len(), 1);
        // D-02 LK-04 S5 测钉：wire 键 camelCase 显式断言（subSessionId 键名
        // 契约锚——前端行级反查依赖该键，防 rename 漂移）
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value["subSessionId"], "sub-sess-0-1",
            "SessionAgent wire 键必须为 camelCase subSessionId"
        );
        assert_eq!(value["parentToolCallId"], "tc-1", "既有 camelCase 键不回归");
        assert_eq!(value["capabilityMode"], "read-only", "能力快照 wire 键");
        assert_eq!(value["modelOverride"], "grok-3", "模型覆盖 wire 键");
        assert_eq!(value["resumable"], true, "可恢复标记 wire 键");
        assert_eq!(value["lastHeartbeatMs"], 140, "心跳 wire 键");
        // 缺省兼容：旧载荷无新字段 → 反序列化为 None
        let legacy = r#"{"id":"a1","subagentRunId":"r1","parentSessionId":"s1",
                         "parentRunId":"p1","description":"","mode":"",
                         "status":"completed","messages":[],"startedAt":0}"#;
        let old: SessionAgent = serde_json::from_str(legacy).unwrap();
        assert_eq!(old.task_type, None);
        assert_eq!(old.display_label, None);
        assert_eq!(old.allowed_write_paths_json, None);
        assert_eq!(old.sub_session_id, None, "旧载荷无 subSessionId → None");
        assert_eq!(old.capability_mode, None, "旧载荷能力快照默认 None");
        assert_eq!(old.model_override, None, "旧载荷模型覆盖默认 None");
        assert!(!old.resumable, "旧载荷 resumable 默认 false");
        assert_eq!(old.last_heartbeat_ms, None, "旧载荷心跳默认 None");
    }

    #[test]
    fn session_index_entry_uses_default_folder() {
        let raw = r#"{"id":"s1","title":"t","updatedAt":1,"messageCount":0}"#;
        let entry: SessionIndexEntry = serde_json::from_str(raw).unwrap();
        assert_eq!(entry.folder, DEFAULT_SESSION_FOLDER);
        assert!(!entry.is_pinned);
        assert_eq!(entry.timestamp, "");
    }

    #[test]
    fn session_index_entry_roundtrip() {
        let entry = SessionIndexEntry {
            id: "s1".into(),
            title: "hello".into(),
            folder: "work".into(),
            is_pinned: true,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
            updated_at: 1700000000,
            message_count: 42,
            pinned_message_ids: Some(r#"["m1"]"#.into()),
            engine_cursor: Some(10),
            engine_last_run_id: Some("run-1".into()),
            hydrated_from_engine: Some(true),
        };
        let json = serde_json::to_string(&entry).unwrap();
        let back: SessionIndexEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(entry, back);
    }

    #[test]
    fn import_stats_default_zero() {
        let stats = ImportStats::default();
        assert_eq!(stats.sessions, 0);
        assert_eq!(stats.messages, 0);
        assert_eq!(stats.agents, 0);
    }
}
