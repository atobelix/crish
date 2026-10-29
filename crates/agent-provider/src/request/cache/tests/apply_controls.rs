//! cache 测试 · apply_cache_controls / text_to_parts_with_cc

use super::*;

// ── apply_cache_controls / text_to_parts_with_cc（T-14 接线后真实实现）──

/// 便捷构造 wire 消息（cache_control 恒 None）
fn wire_message(role: &str, text: &str) -> ChatMessage {
    ChatMessage {
        role: role.to_string(),
        content: Some(ChatContent::Text(text.to_string())),
        tool_call_id: None,
        reasoning_content: None,
        tool_calls: Vec::new(),
        cache_control: None,
    }
}

/// 断言文本消息内容被改写为携带断点的 parts 形态
fn assert_text_part_with_cc(message: &ChatMessage, expected_text: &str, expected_cc: CacheControl) {
    match &message.content {
        Some(ChatContent::Parts(parts)) => {
            assert_eq!(parts.len(), 1, "改写为单文本块 parts 形态");
            match &parts[0] {
                ChatContentPart::Text {
                    text,
                    cache_control,
                } => {
                    assert_eq!(text, expected_text);
                    assert_eq!(*cache_control, Some(expected_cc));
                }
                other => panic!("期望文本块，得到：{other:?}"),
            }
        }
        other => panic!("期望 parts 内容，得到：{other:?}"),
    }
}

#[test]
fn cache_control_for_ttl_mapping() {
    // TTL 桶 → 块级断点值（Anthropic 系 wire 值映射）
    assert_eq!(
        cache_control_for_ttl(TtlBucket::FiveMinutes),
        CacheControl::Ephemeral
    );
    assert_eq!(
        cache_control_for_ttl(TtlBucket::OneHour),
        CacheControl::Ephemeral1h
    );
}

#[test]
fn text_to_parts_with_cc_builds_part_with_cc() {
    // Text → parts 数组形态并携带块级断点（string content 无法携带
    // cache_control，pi-cache-analysis.md:139）
    let content = text_to_parts_with_cc("hello", CacheControl::Ephemeral);
    assert_eq!(
        content,
        ChatContent::Parts(vec![ChatContentPart::Text {
            text: "hello".to_string(),
            cache_control: Some(CacheControl::Ephemeral),
        }])
    );
    // wire 形状：type/text/cache_control 三键（T-14 单测要求）
    if let ChatContent::Parts(parts) = &content {
        assert_eq!(
            parts[0].to_value(),
            json!({ "type": "text", "text": "hello", "cache_control": { "type": "ephemeral" } })
        );
    } else {
        panic!("期望 parts 形态");
    }
    // Ephemeral1h 形状
    let content = text_to_parts_with_cc("hi", CacheControl::Ephemeral1h);
    if let ChatContent::Parts(parts) = &content {
        assert_eq!(
            parts[0].to_value()["cache_control"],
            json!({ "type": "ephemeral", "ttl": "1h" })
        );
    } else {
        panic!("期望 parts 形态");
    }
}

#[test]
fn apply_cache_controls_plan_all_false_leaves_bytes_unchanged() {
    // plan 全 false → 零报告、无任何改写（请求字节与未施加时完全一致）
    let mut messages = vec![
        wire_message("system", "系统指令"),
        wire_message("user", "你好"),
    ];
    let before = messages
        .iter()
        .map(ChatMessage::to_value)
        .collect::<Vec<_>>();
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan::default(),
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(report, BreakpointReport::default());
    let after = messages
        .iter()
        .map(ChatMessage::to_value)
        .collect::<Vec<_>>();
    assert_eq!(before, after, "plan 全 false 不得改动任何消息字节");
}

#[test]
fn apply_cache_controls_system_anchor_rewrites_first_system_message() {
    // system 锚点：首条 role=system 消息改写为 parts 形态并挂断点；
    // 其余消息不受影响（改写只发生在被打断点处）
    let mut messages = vec![
        wire_message("system", "系统指令"),
        wire_message("user", "你好"),
    ];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan {
            system: true,
            ..Default::default()
        },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(
        report,
        BreakpointReport {
            placed: 1,
            dropped: 0
        }
    );
    assert_text_part_with_cc(&messages[0], "系统指令", CacheControl::Ephemeral);
    assert_eq!(
        messages[1].content,
        Some(ChatContent::Text("你好".to_string()))
    );
    // wire 形状：content[0].cache_control = {"type":"ephemeral"}
    let value = messages[0].to_value();
    assert_eq!(
        value["content"][0]["cache_control"],
        json!({ "type": "ephemeral" })
    );
}

#[test]
fn apply_cache_controls_system_anchor_falls_back_to_first_user_message() {
    // user-prefix 模式：无 system 角色消息，system 锚点回退首条 user 消息
    let mut messages = vec![
        wire_message("user", "System instructions for this run:\n\n全局提示"),
        wire_message("user", "你好"),
    ];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan {
            system: true,
            ..Default::default()
        },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(
        report,
        BreakpointReport {
            placed: 1,
            dropped: 0
        }
    );
    assert_text_part_with_cc(
        &messages[0],
        "System instructions for this run:\n\n全局提示",
        CacheControl::Ephemeral,
    );
    assert_eq!(
        messages[1].content,
        Some(ChatContent::Text("你好".to_string()))
    );
}

#[test]
fn apply_cache_controls_messages_anchor_part_level_on_last_user() {
    // supports_message_cache_control=false（部分兼容端点只认 part 级）：
    // 最后一条 user 消息改写为 parts 形态挂断点，历史消息不动
    let mut messages = vec![
        wire_message("user", "第一问"),
        wire_message("assistant", "回复"),
        wire_message("user", "第二问"),
    ];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan {
            messages: true,
            ..Default::default()
        },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(
        report,
        BreakpointReport {
            placed: 1,
            dropped: 0
        }
    );
    assert_eq!(
        messages[0].content,
        Some(ChatContent::Text("第一问".to_string()))
    );
    assert_eq!(
        messages[1].content,
        Some(ChatContent::Text("回复".to_string()))
    );
    assert_text_part_with_cc(&messages[2], "第二问", CacheControl::Ephemeral);
}

#[test]
fn apply_cache_controls_messages_anchor_prefers_last_tool_message() {
    // 工具循环：最后一条 role=tool 消息承载历史缓存（OpenAI 兼容线路上
    // tool 结果落在 role=tool 消息）
    let mut messages = vec![wire_message("user", "查一下"), wire_message("tool", "结果")];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan {
            messages: true,
            ..Default::default()
        },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(
        report,
        BreakpointReport {
            placed: 1,
            dropped: 0
        }
    );
    assert_text_part_with_cc(&messages[1], "结果", CacheControl::Ephemeral);
}

#[test]
fn apply_cache_controls_message_level_used_when_supported() {
    // supports_message_cache_control=true（Anthropic 原生端点顶层自动模式）：
    // 挂消息级 cache_control，不改写内容
    let mut messages = vec![wire_message("user", "你好")];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan {
            messages: true,
            ..Default::default()
        },
        TtlBucket::FiveMinutes,
        true,
    );
    assert_eq!(
        report,
        BreakpointReport {
            placed: 1,
            dropped: 0
        }
    );
    assert_eq!(messages[0].cache_control, Some(CacheControl::Ephemeral));
    assert_eq!(
        messages[0].content,
        Some(ChatContent::Text("你好".to_string()))
    );
    let value = messages[0].to_value();
    assert_eq!(value["cache_control"], json!({ "type": "ephemeral" }));
    assert_eq!(value["content"], "你好");
}

#[test]
fn apply_cache_controls_ttl_one_hour_maps_to_ephemeral1h() {
    // TTL 桶 → 断点值：OneHour 桶挂 {"type":"ephemeral","ttl":"1h"}
    let mut messages = vec![wire_message("user", "你好")];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan {
            messages: true,
            ..Default::default()
        },
        TtlBucket::OneHour,
        false,
    );
    assert_eq!(
        report,
        BreakpointReport {
            placed: 1,
            dropped: 0
        }
    );
    assert_text_part_with_cc(&messages[0], "你好", CacheControl::Ephemeral1h);
    let value = messages[0].to_value();
    assert_eq!(
        value["content"][0]["cache_control"],
        json!({ "type": "ephemeral", "ttl": "1h" })
    );
}

#[test]
fn apply_cache_controls_parts_content_marks_last_text_block() {
    // Parts 内容：断点挂到最后一个文本块（白名单），图片块原样保留
    let mut messages = vec![ChatMessage {
        role: "user".to_string(),
        content: Some(ChatContent::Parts(vec![
            ChatContentPart::ImageUrl {
                url: "https://example.com/a.png".to_string(),
                detail: None,
            },
            ChatContentPart::Text {
                text: "看图说话".to_string(),
                cache_control: None,
            },
        ])),
        tool_call_id: None,
        reasoning_content: None,
        tool_calls: Vec::new(),
        cache_control: None,
    }];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan {
            messages: true,
            ..Default::default()
        },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(
        report,
        BreakpointReport {
            placed: 1,
            dropped: 0
        }
    );
    match &messages[0].content {
        Some(ChatContent::Parts(parts)) => {
            assert!(
                matches!(parts[0], ChatContentPart::ImageUrl { .. }),
                "图片块原样保留"
            );
            match &parts[1] {
                ChatContentPart::Text {
                    text,
                    cache_control,
                } => {
                    assert_eq!(text, "看图说话");
                    assert_eq!(*cache_control, Some(CacheControl::Ephemeral));
                }
                other => panic!("期望文本块：{other:?}"),
            }
        }
        other => panic!("期望 parts 内容：{other:?}"),
    }
}

#[test]
fn apply_cache_controls_unplaceable_anchor_counts_dropped() {
    // 锚点不存在（无 system/user 也无 user/tool 消息）→ 请求的断点无法
    // 放置 → dropped 记账（不报错，P5 归因消费）
    let mut messages = vec![wire_message("assistant", "回复")];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan {
            system: true,
            messages: true,
            ..Default::default()
        },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(
        report,
        BreakpointReport {
            placed: 0,
            dropped: 2
        }
    );
    // 消息未被改动
    assert_eq!(
        messages[0].content,
        Some(ChatContent::Text("回复".to_string()))
    );
}

#[test]
fn apply_cache_controls_content_none_counts_dropped() {
    // 目标消息无 content → 无法挂 part 级断点 → dropped
    let mut messages = vec![ChatMessage {
        role: "user".to_string(),
        content: None,
        tool_call_id: None,
        reasoning_content: None,
        tool_calls: Vec::new(),
        cache_control: None,
    }];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan {
            messages: true,
            ..Default::default()
        },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(
        report,
        BreakpointReport {
            placed: 0,
            dropped: 1
        }
    );
}

#[test]
fn apply_cache_controls_same_anchor_not_double_placed() {
    // system 回退锚点与 messages 锚点重合（单条 user 消息 + 双计划）→
    // 只放置一次，不重复记账
    let mut messages = vec![wire_message("user", "你好")];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan {
            system: true,
            messages: true,
            ..Default::default()
        },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(
        report,
        BreakpointReport {
            placed: 1,
            dropped: 0
        }
    );
}

#[test]
fn apply_cache_controls_three_anchors_all_placed() {
    // 三锚点齐备（system + user + 工具循环）：全量放置
    let mut messages = vec![
        wire_message("system", "系统指令"),
        wire_message("user", "查一下"),
        wire_message("tool", "结果"),
    ];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan {
            system: true,
            messages: true,
            ..Default::default()
        },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(
        report,
        BreakpointReport {
            placed: 2,
            dropped: 0
        }
    );
    assert_text_part_with_cc(&messages[0], "系统指令", CacheControl::Ephemeral);
    assert_eq!(
        messages[1].content,
        Some(ChatContent::Text("查一下".to_string()))
    );
    assert_text_part_with_cc(&messages[2], "结果", CacheControl::Ephemeral);
}
