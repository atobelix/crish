//! request/build.rs 缓存注入测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 build.rs `mod tests` 的 P2 缓存参数注入与亲和头测试整段搬入（T-15 三字段 /
//! 断点施加 / Auto 零参数回归护栏），零删除零合并；测试名与断言形状不变。
//! 公共构造（cache_policy / baseline_context 等）复用 build_tests_common.rs。

use super::*;
use super::test_common::*;

use conex_types::message::AgentMessage;
use crate::request::cache::{
    BreakpointPlan, CacheMechanism, CacheRetention, PromptCacheMode, PromptCacheOptions, TtlBucket,
};
use crate::request::schema::canonical_json_string;
use serde_json::json;
use std::sync::Arc;

// ── P2 步骤 3（T-15）：缓存参数注入 ──

#[test]
fn cache_none_keeps_baseline_bytes() {
    // 无缓存配置（cache: None）：请求字节与 P2 前逐字节一致（关键回归护栏，
    // P2 §5.3：无缓存配置请求字节与 P2 前一致；compactObject 兜底）
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let context = baseline_context(&messages);
    let body = build_chat_completions_request_body(&base_opts(), &context);
    assert_eq!(
        body,
        json!({
            "model": "gpt-4o",
            "messages": [
                { "content": "系统提示", "role": "system" },
                { "content": "你好", "role": "user" },
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "工具 read_file",
                    "parameters": { "type": "object" },
                },
            }],
            "tool_choice": "auto",
            "stream_options": { "include_usage": true },
        })
    );
    // 字节级钉死（canonical 序列化 = 键码点序；BTreeMap 字典序同构）
    assert_eq!(
        canonical_json_string(&body),
        r#"{"messages":[{"content":"系统提示","role":"system"},{"content":"你好","role":"user"}],"model":"gpt-4o","stream_options":{"include_usage":true},"tool_choice":"auto","tools":[{"function":{"description":"工具 read_file","name":"read_file","parameters":{"type":"object"}},"type":"function"}]}"#
    );
}

#[test]
fn cache_injects_prompt_cache_key_and_retention() {
    // Key 机制（OpenAI/Grok）：prompt_cache_key + prompt_cache_retention 顶层注入
    let opts = ChatCompletionsRequestOptions {
        cache: Some(cache_policy(
            CacheMechanism::Key,
            Some("ses-abc"),
            CacheRetention::Short,
            TtlBucket::FiveMinutes,
            None,
        )),
        ..base_opts()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(body["prompt_cache_key"], "ses-abc");
    assert_eq!(body["prompt_cache_retention"], "in_memory");
    assert!(body.get("prompt_cache_options").is_none(), "默认不发 options");

    // retention=Long → wire 值 "24h"
    let opts = ChatCompletionsRequestOptions {
        cache: Some(cache_policy(
            CacheMechanism::Key,
            Some("ses-abc"),
            CacheRetention::Long,
            TtlBucket::OneHour,
            None,
        )),
        ..base_opts()
    };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(body["prompt_cache_retention"], "24h");
    assert_eq!(body["prompt_cache_key"], "ses-abc");
}

#[test]
fn cache_injects_prompt_cache_options() {
    // GPT-5.6+ none 档：prompt_cache_options={"mode":"explicit"}（"none 也须被
    // 尊重"，pi openai-responses.ts:278-285）；无键、无 retention
    let mut policy = cache_policy(
        CacheMechanism::Key,
        None,
        CacheRetention::None,
        TtlBucket::FiveMinutes,
        None,
    );
    policy.prompt_cache_options =
        Some(PromptCacheOptions { mode: PromptCacheMode::Explicit });
    let opts = ChatCompletionsRequestOptions { cache: Some(policy), ..base_opts() };
    let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
    assert_eq!(body["prompt_cache_options"], json!({ "mode": "explicit" }));
    assert!(body.get("prompt_cache_key").is_none());
    assert!(body.get("prompt_cache_retention").is_none(), "none 档不发 retention");
}

#[test]
fn cache_none_omits_all_cache_keys() {
    // DeepSeek 语义（build_cache_policy → None）与显式 None 同：请求体不含
    // 任何 cache 键——顶层三字段、消息断点、工具断点全部省略
    // （P2 §5.1 DeepSeek 省略；对齐 deepseek-reasonix-cache-analysis.md:111-112）
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let context = baseline_context(&messages);
    let opts = ChatCompletionsRequestOptions { cache: None, ..base_opts() };
    let body = build_chat_completions_request_body(&opts, &context);
    for key in ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"] {
        assert!(body.get(key).is_none(), "cache=None 不得注入 {key}");
    }
    let wire_messages = body["messages"].as_array().expect("messages 数组");
    for message in wire_messages {
        assert!(message.get("cache_control").is_none(), "消息不得携带断点");
    }
    assert_eq!(wire_messages[1]["content"], "你好", "无断点 → content 保持 string 形态");
    let tools = body["tools"].as_array().expect("tools 数组");
    for tool in tools {
        assert!(tool.get("cache_control").is_none(), "工具不得附加断点");
    }
}

#[test]
fn cache_auto_zero_params_keeps_bytes_identical() {
    // Auto 机制（Kimi/Gemini 隐式）产出零参数 policy：无键/断点/options，
    // retention 恒 Short 为内部档位不发 wire——请求字节与 cache=None 完全
    // 一致（P2 §5.1：plan 全 false → 请求字节与未施加时完全一致）
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let context = baseline_context(&messages);
    let opts_without = base_opts();
    let opts_with = ChatCompletionsRequestOptions {
        cache: Some(cache_policy(
            CacheMechanism::Auto,
            None,
            CacheRetention::Short,
            TtlBucket::FiveMinutes,
            None,
        )),
        ..base_opts()
    };
    let body_without = build_chat_completions_request_body(&opts_without, &context);
    let body_with = build_chat_completions_request_body(&opts_with, &context);
    assert_eq!(
        serde_json::to_string(&body_with).expect("序列化"),
        serde_json::to_string(&body_without).expect("序列化"),
        "Auto 零参数 policy 不得改变请求字节"
    );
}

#[test]
fn explicit_breakpoints_placed_on_wire_messages_and_last_tool() {
    // Explicit 机制（MiniMax M2.x / Anthropic 语义）：policy.breakpoints=Some
    // （启用位）→ post-pass 在首条 system 消息与最后 user 消息末块落 part 级
    // 断点（锚点落在 wire 消息上）；plan.tools → 最后一个工具附加
    // cache_control，其余工具不附加
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
    let mut context = baseline_context(&messages);
    context.tools = vec![tool("read_file"), tool("search")];
    let opts = ChatCompletionsRequestOptions {
        cache: Some(cache_policy(
            CacheMechanism::Explicit,
            None,
            CacheRetention::Short,
            TtlBucket::FiveMinutes,
            Some(BreakpointPlan::default()),
        )),
        ..base_opts()
    };
    let body = build_chat_completions_request_body(&opts, &context);
    // system 锚点：首条 system 消息改写为 parts 形态挂断点
    let wire_messages = body["messages"].as_array().expect("messages 数组");
    assert_eq!(wire_messages[0]["role"], "system");
    assert_eq!(
        wire_messages[0]["content"][0]["cache_control"],
        json!({ "type": "ephemeral" })
    );
    // messages 锚点：最后 user 消息改写为 parts 形态挂断点
    assert_eq!(wire_messages[1]["role"], "user");
    assert_eq!(
        wire_messages[1]["content"][0]["cache_control"],
        json!({ "type": "ephemeral" })
    );
    // Explicit 机制不发顶层键
    for key in ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"] {
        assert!(body.get(key).is_none(), "Explicit 机制不得注入 {key}");
    }
    // tools 级：仅最后一个工具附加（tools 层级锚点）
    let tools = body["tools"].as_array().expect("tools 数组");
    assert_eq!(tools.len(), 2);
    assert!(tools[0].get("cache_control").is_none(), "非最后工具不附加");
    assert_eq!(tools[1]["cache_control"], json!({ "type": "ephemeral" }));
    assert_eq!(tools[1]["function"]["name"], "search");
}

#[test]
fn affinity_http_headers_consumes_policy_header() {
    // G2 消费点：policy.affinity_header → HTTP 头列表（发送层基础头 + 亲和头
    // 合并用）；无亲和头 / None policy → 空 Vec（不新增任何头）
    let mut policy = cache_policy(
        CacheMechanism::Key,
        Some("ses-grok"),
        CacheRetention::Short,
        TtlBucket::FiveMinutes,
        None,
    );
    policy.affinity_header = Some(("x-grok-conv-id", "ses-grok".to_string()));
    assert_eq!(
        affinity_http_headers(Some(&policy)),
        vec![("x-grok-conv-id", "ses-grok".to_string())]
    );
    let plain = cache_policy(
        CacheMechanism::Key,
        Some("ses-1"),
        CacheRetention::Short,
        TtlBucket::FiveMinutes,
        None,
    );
    assert_eq!(affinity_http_headers(Some(&plain)), Vec::new());
    assert_eq!(affinity_http_headers(None), Vec::new());
    // 亲和头不影响请求体字节（HTTP 头不在 body 内，回归护栏）
    let body = build_chat_completions_request_body(
        &ChatCompletionsRequestOptions { cache: Some(policy), ..base_opts() },
        &RequestBuildContext::default(),
    );
    assert!(body.get("x-grok-conv-id").is_none(), "请求体不得携带 HTTP 头");
}
