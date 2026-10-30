//! request/build.rs 测试公共构造（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 build.rs `mod tests` 的便捷构造（text_block / user_message / tool / base_opts /
//! cache_policy）整段搬入并标为 pub，供 chat / responses 两份旁挂测试经
//! `use super::test_common::*` 复用（避免重复定义；测试名与断言形状不变）。

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use serde_json::json;

use super::ChatCompletionsRequestOptions;
use crate::request::cache::{
    BreakpointPlan, CacheKey, CacheMechanism, CachePolicy, CacheRetention, TtlBucket,
};
use crate::request::tools::ToolDefinition;

pub fn text_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Text {
        text: text.to_string(),
    }
}

pub fn user_message(text: &str) -> AgentMessage {
    AgentMessage {
        id: "m1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![text_block(text)],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

pub fn tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: format!("工具 {name}"),
        input_schema: json!({ "type": "object" }),
    }
}

pub fn base_opts() -> ChatCompletionsRequestOptions {
    ChatCompletionsRequestOptions {
        model: Some("gpt-4o".to_string()),
        ..ChatCompletionsRequestOptions::default()
    }
}

/// 便捷构造缓存策略（prompt_cache_options 恒 None，需要时单独构造）
pub fn cache_policy(
    mechanism: CacheMechanism,
    cache_key: Option<&str>,
    retention: CacheRetention,
    ttl: TtlBucket,
    breakpoints: Option<BreakpointPlan>,
) -> CachePolicy {
    CachePolicy {
        mechanism,
        retention,
        ttl,
        breakpoints,
        cache_key: cache_key.map(|k| CacheKey(k.to_string())),
        prompt_cache_options: None,
        affinity_header: None,
    }
}
