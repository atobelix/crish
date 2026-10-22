//! AgentMessage → Anthropic Messages wire 格式转换（自 build_anthropic.rs 平移）。

use std::borrow::Borrow;

use conex_compaction::clean_output::{clean_output, CleanupOptions};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use serde_json::{json, Map, Value};

use crate::request::messages::{
    sanitize_tool_call_id, stringify_tool_output, user_message_content, ChatContent,
    ChatContentPart, WIRE_CONTINUATION_NOTE,
};
use crate::request::RequestBuildContext;

/// AgentMessage → Anthropic messages 数组（独立映射；从块直接构建 content 块数组）
///
/// 角色映射：
/// - user → content 块数组 `[{type:"text",text}]`
/// - assistant → content 块数组：text/thinking/tool_use 块，且按顺序保留
/// - tool → user 消息携带 `tool_result` 块（Anthropic 官方 tool_result 属 user 角色，
///   与 chat 轨独立 `role:"tool"` 不同）
/// - system → 顶层 `system` 字段（本映射函数不产出独立 system 消息）
///
/// D03-02/INV-07 严格交替约束（Anthropic wire 铁律）：
/// Anthropic Messages API 要求 `messages` 中 user/assistant 严格交替，**连续
/// assistant 消息会触发 HTTP 400**。本函数在**序列化/投影层**保证交替性（不向核心
/// 领域模型注入合成消息，对齐 message.rs 既有 `WIRE_CONTINUATION_NOTE` 投影机制）：
/// - 前一条已产出 assistant，再遇 assistant → 插入一条 user 占位消息
///   `[System Note: The following is a continuation of previous output.]`
///   （复用 [crate::request::messages::WIRE_CONTINUATION_NOTE]）。
/// - 首条为 assistant（无任何 user 前缀）→ 同样前置 user 占位，满足 Anthropic
///   官方「首条必须为 user 或 image」要求。
pub(crate) fn to_anthropic_messages(context: &RequestBuildContext) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    for message_ref in context.messages {
        let message: &AgentMessage = message_ref.borrow();
        match message.role {
            AgentMessageRole::User => {
                let content = user_anthropic_content(message);
                if content.is_empty() {
                    continue;
                }
                push_alternating(&mut result, &json!({ "role": "user", "content": content }));
            }
            AgentMessageRole::Assistant => {
                let content = assistant_anthropic_content(message);
                if !content.is_empty() {
                    push_alternating(
                        &mut result,
                        &json!({ "role": "assistant", "content": content }),
                    );
                }
                // 历史水合兜底：若 assistant 消息同体携带 ToolResult 块（hydrate.rs）
                let tool_results = tool_result_anthropic_content(message);
                if !tool_results.is_empty() {
                    push_alternating(
                        &mut result,
                        &json!({ "role": "user", "content": tool_results }),
                    );
                }
            }
            AgentMessageRole::Tool => {
                let content = tool_result_anthropic_content(message);
                if content.is_empty() {
                    continue;
                }
                push_alternating(&mut result, &json!({ "role": "user", "content": content }));
            }
            // 【核心攻坚修复 BC08-5】：中途注入的运行时转向/系统纠偏绝不丢弃！
            // 投射为带有严格上下文标识的 user 提示，经 push_alternating 严格满足 Anthropic 角色交替铁律
            AgentMessageRole::System => {
                let text = message.text();
                let effective_text = if !text.trim().is_empty() {
                    text
                } else {
                    message.content.clone().unwrap_or_default()
                };
                if !effective_text.trim().is_empty() {
                    let wrapped_steering = json!({
                        "type": "text",
                        "text": format!("[System Directive / Runtime Steering]\n{}", effective_text.trim())
                    });
                    push_alternating(
                        &mut result,
                        &json!({ "role": "user", "content": [wrapped_steering] }),
                    );
                }
            }
        }
    }
    result
}

/// 交替约束投影：向 result 追加一条 wire 消息，仅当该消息为 assistant 且会破坏
/// Anthropic 交替铁律时前置 user 占位——(a) 首条即 assistant（空首条须为 user）；
/// (b) 上一条已是 assistant。
/// 当连续两条均为 user 消息时（如工具响应后紧跟新用户提问或 Steering 纠偏），将其 content 数组合并，
/// 满足 Anthropic wire user/assistant 严格交替铁律。
fn push_alternating(result: &mut Vec<Value>, message: &Value) {
    let next_role = message["role"].as_str().unwrap_or_default();
    if next_role == "user" && result.last().is_some_and(|m| m["role"] == "user") {
        if let Some(last_msg) = result.last_mut() {
            let next_blocks = message.get("content").and_then(|c| c.as_array()).cloned();
            if let Some(next_arr) = next_blocks {
                if let Some(last_arr) = last_msg.get_mut("content").and_then(|c| c.as_array_mut()) {
                    last_arr.extend(next_arr);
                    return;
                } else if let Some(last_str) = last_msg.get("content").and_then(|c| c.as_str()) {
                    let mut new_arr = vec![json!({ "type": "text", "text": last_str })];
                    new_arr.extend(next_arr);
                    last_msg["content"] = Value::Array(new_arr);
                    return;
                }
            }
        }
    }
    let needs_user_prefix = next_role == "assistant"
        && (result.is_empty() || result.last().is_some_and(|m| m["role"] == "assistant"));
    if needs_user_prefix {
        result.push(json!({ "role": "user", "content": WIRE_CONTINUATION_NOTE }));
    }
    result.push(message.clone());
}

/// user 消息 content 块数组（text / image 块；图像来自 metadata.contentParts——
/// plans/04 §4.2：视觉模型图进 Anthropic image source 块，禁止只发 `[图片附件]`
/// 文本备注）
fn user_anthropic_content(message: &AgentMessage) -> Vec<Value> {
    let content = user_message_content(message);
    match content {
        ChatContent::Text(text) => {
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![json!({ "type": "text", "text": text })]
            }
        }
        ChatContent::Parts(parts) => parts.iter().filter_map(anthropic_user_part).collect(),
    }
}

/// ChatContentPart → Anthropic content 块（text → text；image_url → image source）
fn anthropic_user_part(part: &ChatContentPart) -> Option<Value> {
    match part {
        ChatContentPart::Text { text, .. } => {
            if text.trim().is_empty() {
                None
            } else {
                Some(json!({ "type": "text", "text": text }))
            }
        }
        ChatContentPart::ImageUrl { url, .. } => Some(anthropic_image_source(url)),
    }
}

/// image_url → Anthropic image source 块：data URL → base64 source；否则 url source
fn anthropic_image_source(url: &str) -> Value {
    if let Some((mime, data)) = split_data_url(url) {
        json!({
            "type": "image",
            "source": { "type": "base64", "media_type": mime, "data": data },
        })
    } else {
        json!({
            "type": "image",
            "source": { "type": "url", "url": url },
        })
    }
}

/// `data:image/<mime>;base64,<payload>` → (mime, base64 payload)；非 data URL → None
fn split_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(";base64,")?;
    if mime.is_empty() || payload.is_empty() {
        return None;
    }
    Some((mime.to_string(), payload.to_string()))
}

/// tool 消息 → user content 的 `tool_result` 块（Anthropic 官方语义）
fn tool_result_anthropic_content(message: &AgentMessage) -> Vec<Value> {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            AgentMessageBlock::ToolResult {
                tool_call_id,
                output,
                is_error,
                ..
            } => {
                // T-34（R-J）：与 chat 轨 tool 消息同口径清洗（确定性 + 幂等）
                let cleaned =
                    clean_output(&stringify_tool_output(output), &CleanupOptions::default());
                let mut tr = Map::new();
                tr.insert("type".to_string(), json!("tool_result"));
                tr.insert(
                    "tool_use_id".to_string(),
                    json!(sanitize_tool_call_id(tool_call_id)),
                );
                tr.insert(
                    "content".to_string(),
                    json!(if cleaned.cleaned.is_empty() {
                        "(no output)".to_string()
                    } else {
                        cleaned.cleaned
                    }),
                );
                if *is_error {
                    tr.insert("is_error".to_string(), json!(true));
                }
                Some(Value::Object(tr))
            }
            _ => None,
        })
        .collect()
}

/// 从消息元数据中尽最大可能提取对应思考块的签名（signature），保障 Claude 3.7 / Extended Thinking 回放不崩溃
fn extract_signature_for_thought(
    message: &AgentMessage,
    thought_index: usize,
    thought_text: &str,
) -> Option<String> {
    let metadata = message.metadata.as_ref()?;

    // 1. Array of signatures in metadata["signatures"] or metadata["thinkingSignatures"]
    if let Some(arr) = metadata
        .get("signatures")
        .or_else(|| metadata.get("thinkingSignatures"))
        .and_then(Value::as_array)
    {
        if let Some(sig) = arr.get(thought_index).and_then(Value::as_str) {
            if !sig.trim().is_empty() {
                return Some(sig.to_string());
            }
        }
    }

    // 2. Map of text/id to signature in metadata["signatures"] or metadata["thoughtSignatures"]
    if let Some(map) = metadata
        .get("signatures")
        .or_else(|| metadata.get("thoughtSignatures"))
        .and_then(Value::as_object)
    {
        if let Some(sig) = map.get(thought_text).and_then(Value::as_str) {
            if !sig.trim().is_empty() {
                return Some(sig.to_string());
            }
        }
        if let Some(sig) = map.get(&thought_index.to_string()).and_then(Value::as_str) {
            if !sig.trim().is_empty() {
                return Some(sig.to_string());
            }
        }
    }

    // 3. Array of thought blocks in metadata["thinkingBlocks"]
    if let Some(arr) = metadata.get("thinkingBlocks").and_then(Value::as_array) {
        if let Some(obj) = arr.get(thought_index).and_then(Value::as_object) {
            if let Some(sig) = obj.get("signature").and_then(Value::as_str) {
                if !sig.trim().is_empty() {
                    return Some(sig.to_string());
                }
            }
        }
    }

    // 4. Raw blocks fallback in metadata["rawBlocks"] or metadata["blocks"] or metadata["content"]
    if let Some(blocks) = metadata
        .get("rawBlocks")
        .or_else(|| metadata.get("blocks"))
        .or_else(|| metadata.get("content"))
        .and_then(Value::as_array)
    {
        let mut idx = 0;
        for b in blocks {
            if b.get("type").and_then(Value::as_str) == Some("thinking") {
                if idx == thought_index {
                    if let Some(sig) = b.get("signature").and_then(Value::as_str) {
                        if !sig.trim().is_empty() {
                            return Some(sig.to_string());
                        }
                    }
                }
                idx += 1;
            }
        }
    }

    // 5. Single signature in metadata["signature"] or metadata["thinkingSignature"] or metadata["thinking_signature"]
    if let Some(sig) = metadata
        .get("signature")
        .or_else(|| metadata.get("thinkingSignature"))
        .or_else(|| metadata.get("thinking_signature"))
        .or_else(|| metadata.get("thoughtSignature"))
        .and_then(Value::as_str)
    {
        if !sig.trim().is_empty() {
            return Some(sig.to_string());
        }
    }

    None
}

/// assistant 消息 content 块数组：text / thinking / tool_use 块，按原块顺序保留并保全思考签名
fn assistant_anthropic_content(message: &AgentMessage) -> Vec<Value> {
    let mut thought_idx = 0;
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            AgentMessageBlock::Text { text } => Some(json!({ "type": "text", "text": text })),
            AgentMessageBlock::Thought { text, redacted } => {
                let sig = extract_signature_for_thought(message, thought_idx, text);
                thought_idx += 1;
                if *redacted == Some(true) {
                    Some(json!({
                        "type": "redacted_thinking",
                        "data": sig.unwrap_or_else(|| text.clone()),
                    }))
                } else if let Some(sig) = sig {
                    Some(json!({
                        "type": "thinking",
                        "thinking": text,
                        "signature": sig,
                    }))
                } else {
                    Some(json!({ "type": "thinking", "thinking": text }))
                }
            }
            AgentMessageBlock::ToolCall(call) => {
                // tool_use 块：id/name/input（input 为结构化对象，直接透传）
                Some(json!({
                    "type": "tool_use",
                    "id": sanitize_tool_call_id(&call.id),
                    "name": call.tool_name,
                    "input": call.input,
                }))
            }
            AgentMessageBlock::ToolResult { .. } | AgentMessageBlock::Image(_) => None,
        })
        .collect()
}
