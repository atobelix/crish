//! messages 测试 · 多模态 contentParts / strip data url / cache_control 载体字段

use super::*;

// ── 多模态 contentParts ──

#[test]
fn user_content_parts_used_when_image_present() {
    let mut msg = user_msg(vec![text_block("正文文本")]);
    msg.metadata = Some(json!({
        "contentParts": [
            { "type": "text", "text": "看图说话" },
            { "type": "image_url", "image_url": { "url": "https://example.com/a.png", "detail": "high" } },
        ]
    }));
    let messages = to_chat_messages(
        None,
        &[msg],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(
        messages[0].content,
        Some(ChatContent::Parts(vec![
            ChatContentPart::Text {
                text: "看图说话".to_string(),
                cache_control: None
            },
            ChatContentPart::ImageUrl {
                url: "https://example.com/a.png".to_string(),
                detail: Some("high".to_string()),
            },
        ]))
    );
    let value = messages[0].to_value();
    assert_eq!(value["content"][0]["type"], "text");
    assert_eq!(
        value["content"][1]["image_url"]["url"],
        "https://example.com/a.png"
    );
}

#[test]
fn user_content_parts_text_only_degrades_to_plain_text() {
    let mut msg = user_msg(vec![text_block("正文")]);
    msg.metadata = Some(json!({
        "contentParts": [{ "type": "text", "text": "只有文本" }]
    }));
    let messages = to_chat_messages(
        None,
        &[msg],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    // 无图片 → 退回 blocks 纯文本（对齐 TS hasImage 判定）
    assert_text_content(&messages, 0, "user", "正文");
}

#[test]
fn user_content_parts_image_url_flat_variant() {
    let mut msg = user_msg(vec![]);
    msg.metadata = Some(json!({
        "contentParts": [{ "type": "image_url", "url": "https://example.com/b.png" }]
    }));
    let messages = to_chat_messages(
        None,
        &[msg],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    match &messages[0].content {
        Some(ChatContent::Parts(parts)) => {
            assert_eq!(parts.len(), 1);
            match &parts[0] {
                ChatContentPart::ImageUrl { url, detail } => {
                    assert_eq!(url, "https://example.com/b.png");
                    assert_eq!(*detail, None);
                }
                other => panic!("期望 image part，得到：{other:?}"),
            }
        }
        other => panic!("期望 parts 内容，得到：{other:?}"),
    }
}

#[test]
fn strip_inline_data_urls_removes_base64_payloads() {
    let text = "看图 data:image/png;base64,iVBORw0KGgo= 之后";
    assert_eq!(strip_inline_data_urls(text), "看图 [image] 之后");
    // markdown 图片语法
    let text = "![alt](data:image/jpeg;base64,AAAA) 结尾";
    assert_eq!(strip_inline_data_urls(text), "![alt]([image]) 结尾");
}

#[test]
fn strip_inline_data_urls_keeps_plain_text() {
    assert_eq!(strip_inline_data_urls(""), "");
    assert_eq!(strip_inline_data_urls("没有图片"), "没有图片");
    // 非 base64 的 data url 原样保留
    assert_eq!(
        strip_inline_data_urls("data:text/plain;charset=utf-8,hi"),
        "data:text/plain;charset=utf-8,hi"
    );
}

/// 大量「形似但非法」的 data:image/ 前缀必须原样保留且线性完成（旧实现
/// 每次只前进 1 字符，逐个前缀重扫导致 O(n²)）。
#[test]
fn strip_inline_data_urls_handles_repeated_invalid_prefixes_linearly() {
    let text = "data:image/not-base64;utf8,abc ".repeat(2_000);
    let stripped = strip_inline_data_urls(&text);
    assert_eq!(stripped, text, "非法 data url 必须原样保留");
    // 幂等：再次剥离结果不变
    assert_eq!(strip_inline_data_urls(&stripped), stripped);
}

#[test]
fn wire_value_shape() {
    let messages = to_chat_messages(
        None,
        &[assistant_msg(vec![text_block("回复")])],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    let value = messages[0].to_value();
    assert_eq!(value["role"], "assistant");
    assert_eq!(value["content"], "回复");
    assert!(value.get("tool_call_id").is_none());
    assert!(value.get("reasoning_content").is_none());
    assert!(value.get("tool_calls").is_none());
}

// ── P2：cache_control 载体字段与序列化（T-14）──

/// 便捷构造 user wire 消息（cache_control 恒 None，构造点补齐语义）
fn wire_user(content: &str) -> ChatMessage {
    ChatMessage {
        role: "user".to_string(),
        content: Some(ChatContent::Text(content.to_string())),
        tool_call_id: None,
        reasoning_content: None,
        tool_calls: Vec::new(),
        cache_control: None,
    }
}

#[test]
fn text_part_cache_control_omitted_when_none() {
    // None → 序列化省略 cache_control 键（与 P2 前 wire 字节一致）
    let part = ChatContentPart::Text {
        text: "hi".to_string(),
        cache_control: None,
    };
    assert_eq!(part.to_value(), json!({ "type": "text", "text": "hi" }));
}

#[test]
fn text_part_cache_control_serialized_when_some() {
    // Some → 输出块级断点键（Anthropic 系 wire 值）
    let part = ChatContentPart::Text {
        text: "hi".to_string(),
        cache_control: Some(CacheControl::Ephemeral),
    };
    assert_eq!(
        part.to_value(),
        json!({ "type": "text", "text": "hi", "cache_control": { "type": "ephemeral" } })
    );
    // Ephemeral1h → 带 ttl 键
    let part = ChatContentPart::Text {
        text: "hi".to_string(),
        cache_control: Some(CacheControl::Ephemeral1h),
    };
    assert_eq!(
        part.to_value()["cache_control"],
        json!({ "type": "ephemeral", "ttl": "1h" })
    );
}

#[test]
fn message_cache_control_omitted_when_none() {
    // 消息级 None → 不输出 cache_control 键
    let value = wire_user("hi").to_value();
    assert!(
        value.get("cache_control").is_none(),
        "None 不得输出 cache_control 键"
    );
}

#[test]
fn message_cache_control_serialized_when_some() {
    // 消息级 Some → 输出 `"cache_control":{"type":"ephemeral"}`（原生端点顶层载体）
    let message = wire_user("hi").with_cache_control(CacheControl::Ephemeral);
    let value = message.to_value();
    assert_eq!(value["cache_control"], json!({ "type": "ephemeral" }));
    assert_eq!(value["content"], "hi", "消息级断点不改写内容");
}

#[test]
fn with_cache_control_helpers() {
    // part 级：文本 part 挂断点；非文本 part 原样返回自身
    let part = ChatContentPart::Text {
        text: "hi".to_string(),
        cache_control: None,
    }
    .with_cache_control(CacheControl::Ephemeral);
    assert_eq!(
        part,
        ChatContentPart::Text {
            text: "hi".to_string(),
            cache_control: Some(CacheControl::Ephemeral),
        }
    );
    let image = ChatContentPart::ImageUrl {
        url: "https://example.com/a.png".to_string(),
        detail: None,
    };
    assert_eq!(
        image.clone().with_cache_control(CacheControl::Ephemeral),
        image,
        "非文本 part 原样返回"
    );
    // 消息级：设置 cache_control 字段
    let message = wire_user("hi").with_cache_control(CacheControl::Ephemeral1h);
    assert_eq!(message.cache_control, Some(CacheControl::Ephemeral1h));
}
