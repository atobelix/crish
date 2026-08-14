//! 消息内容构造域（SR-06e · 拆分 · ≠ EL）
//!
//! 从 request/messages.rs 拆出的实现域：wire 消息 content 构造与纯函数转换。
//! - 内容载体转换（[super::normalize_content_parts] / [super::user_message_content]）
//! - 文本清洗与工具输出 stringify（[super::strip_inline_data_urls] /
//!   [super::stringify_tool_output] / [super::sanitize_tool_call_id]）
//! - 思考内容提取与 system 前缀（[super::thought_content] /
//!   [super::system_prompt_as_user_prefix]）
//! - Responses 轨 content 形状（[super::responses_input_content] /
//!   [super::responses_input_part]）
//!
//! 门面（request/messages.rs）re-export 公开符号，对外路径不变。

use conex_types::message::AgentMessage;
use conex_types::tool::ToolOutput;
use serde_json::{json, Map, Value};

use super::{ChatContent, ChatContentPart};

/// systemPromptAsUserPrefix（对齐 `model:openai-request-build.ts:71-73`）
pub fn system_prompt_as_user_prefix(system_prompt: &str) -> String {
    format!(
        "System instructions for this run:\n\n{}",
        system_prompt.trim()
    )
}

/// 思考内容（thought blocks 拼接，缺省回退 metadata.thought；thoughtContent）
pub fn thought_content(message: &AgentMessage) -> String {
    let from_blocks = message.thought();
    if !from_blocks.is_empty() {
        return from_blocks;
    }
    message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("thought"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// stringifyToolOutput（对齐 `model:openai-request-build.ts:83-88`）：
/// text → json → artifacts JSON 字符串 → 空串
pub fn stringify_tool_output(output: &ToolOutput) -> String {
    if let Some(text) = &output.text {
        return text.clone();
    }
    if let Some(json) = &output.json {
        return serde_json::to_string(json).unwrap_or_default();
    }
    if let Some(artifacts) = &output.artifacts {
        if !artifacts.is_empty() {
            return serde_json::to_string(artifacts).unwrap_or_default();
        }
    }
    String::new()
}

/// 剥掉内联 `data:image/...;base64,...` 载荷（对齐 stripInlineDataUrls，
/// 避免与结构化 parts 重复载荷；不支持正则依赖，用扫描实现）
pub fn strip_inline_data_urls(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        match next_data_url(rest) {
            None => {
                out.push_str(rest);
                break;
            }
            // 形似但非 base64 的 data url：原样保留并前进一个字符（按字符边界），避免死循环
            Some((start, end)) if start == end => {
                let char_len = rest.chars().next().map(char::len_utf8).unwrap_or(1);
                out.push_str(&rest[..char_len]);
                rest = &rest[char_len..];
            }
            Some((start, end)) => {
                out.push_str(&rest[..start]);
                out.push_str("[image]");
                rest = &rest[end..];
            }
        }
    }
    out
}

/// 定位 `data:image/<mime>;base64,<payload>`；形似但非法时返回 `(start, start)` 哨兵
fn next_data_url(rest: &str) -> Option<(usize, usize)> {
    let start = rest.find("data:image/")?;
    let after_prefix = &rest[start + "data:image/".len()..];
    let semi = after_prefix.find(';')?;
    let mime = &after_prefix[..semi];
    let mime_ok = mime
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '+' || c == '-');
    if !mime_ok {
        return Some((start, start));
    }
    let after_semi = &after_prefix[semi..];
    if !after_semi.starts_with(";base64,") {
        return Some((start, start));
    }
    let payload = &after_semi[";base64,".len()..];
    let payload_len = payload
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || "+/=\r\n".contains(*c))
        .count();
    Some((
        start,
        start + "data:image/".len() + semi + ";base64,".len() + payload_len,
    ))
}

/// normalizeContentParts（对齐 `model:openai-request-build.ts:347-377`）：
/// 仅保留合法 text / image_url part；image_url 支持 `image_url.url` 与平铺 `url` 变体
pub fn normalize_content_parts(value: &Value) -> Vec<ChatContentPart> {
    let Some(parts) = value.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for raw in parts {
        let Some(part) = raw.as_object() else {
            continue;
        };
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    out.push(ChatContentPart::Text {
                        text: text.to_string(),
                        cache_control: None,
                    });
                }
            }
            Some("image_url") => {
                let nested = part.get("image_url").and_then(Value::as_object);
                if let Some(image_url) = nested {
                    let url = image_url
                        .get("url")
                        .and_then(Value::as_str)
                        .filter(|url| !url.trim().is_empty());
                    if let Some(url) = url {
                        let detail = image_url
                            .get("detail")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        out.push(ChatContentPart::ImageUrl {
                            url: url.to_string(),
                            detail,
                        });
                    }
                } else if let Some(url) = part
                    .get("url")
                    .and_then(Value::as_str)
                    .filter(|url| !url.trim().is_empty())
                {
                    out.push(ChatContentPart::ImageUrl {
                        url: url.to_string(),
                        detail: None,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

/// userMessageContent（对齐 `model:openai-request-build.ts:383-409`）：
/// metadata.contentParts 含 image_url 时 → 多模态 parts（剥内联 base64、无文本时正文兜底）；
/// 否则 → blocks 纯文本
pub fn user_message_content(message: &AgentMessage) -> ChatContent {
    let parts_value = message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("contentParts"))
        .unwrap_or(&Value::Null);
    let parts = normalize_content_parts(parts_value);
    let has_image = parts
        .iter()
        .any(|part| matches!(part, ChatContentPart::ImageUrl { .. }));
    if !has_image {
        return ChatContent::Text(message.text());
    }
    let mut out: Vec<ChatContentPart> = Vec::new();
    let mut saw_text = false;
    for part in parts {
        match part {
            ChatContentPart::Text { text, .. } => {
                let cleaned = strip_inline_data_urls(&text).trim().to_string();
                if !cleaned.is_empty() {
                    out.push(ChatContentPart::Text {
                        text: cleaned,
                        cache_control: None,
                    });
                    saw_text = true;
                }
            }
            image @ ChatContentPart::ImageUrl { .. } => out.push(image),
        }
    }
    if !saw_text {
        let fallback = strip_inline_data_urls(&message.text()).trim().to_string();
        if !fallback.is_empty() {
            out.insert(
                0,
                ChatContentPart::Text {
                    text: fallback,
                    cache_control: None,
                },
            );
        }
    }
    if out.is_empty() {
        ChatContent::Text(message.text())
    } else {
        ChatContent::Parts(out)
    }
}

/// P1：tool_call id 规整为 [a-zA-Z0-9_-]（对齐 opencode scrub，
/// transform.ts:201-228）——部分 provider 回传非法 id 字符时，回放
/// 请求 400 且前缀漂移；幂等（已合法字符不变，历史字节不回改）。
pub fn sanitize_tool_call_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// ChatContent → Responses input item content（单文本 → 字符串；多模态 → parts 数组）
pub(crate) fn responses_input_content(content: &ChatContent) -> Value {
    match content {
        ChatContent::Text(text) => json!(text),
        ChatContent::Parts(parts) => {
            json!(parts.iter().map(responses_input_part).collect::<Vec<_>>())
        }
    }
}

/// ChatContentPart → Responses content part（text → input_text；image → input_image）
pub(crate) fn responses_input_part(part: &ChatContentPart) -> Value {
    match part {
        ChatContentPart::Text { text, .. } => {
            json!({ "type": "input_text", "text": text })
        }
        ChatContentPart::ImageUrl { url, detail } => {
            let mut part = Map::new();
            part.insert("type".to_string(), json!("input_image"));
            part.insert("image_url".to_string(), json!(url));
            if let Some(detail) = detail {
                part.insert("detail".to_string(), json!(detail));
            }
            Value::Object(part)
        }
    }
}
