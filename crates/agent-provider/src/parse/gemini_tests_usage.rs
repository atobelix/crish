//! parse/gemini.rs 测试旁挂 · usage/阻断/空流/错误帧域（SR-06e · 拆分 · ≠ EL；
//! 经 #[path] 接线，非直接 mod）
//!
//! 原 gemini.rs `mod tests` 拆分搬入，零删除零合并；测试名与断言形状不变。
//! 正常流/工具调用/finishReason 域见 gemini_tests.rs；共享便捷函数
//! （parse_all / stop_of）由 [super::tests] 提供。

use super::tests::{parse_all, stop_of};
use super::*;
use serde_json::json;

// ── usage 逐帧合并（02 §六.6：Gemini 逐帧合并）──

#[test]
fn usage_merged_across_frames() {
    // usageMetadata 为累计值：帧 2 携带完整计数，帧 1 的部分字段回退保留（456-479）
    let frame1 = serde_json::to_string(&json!({
        "candidates": [{ "content": { "parts": [{ "text": "a" }] }, "finishReason": "STOP" }],
        "usageMetadata": { "promptTokenCount": 10, "cachedContentTokenCount": 4, "thoughtsTokenCount": 3 },
    })).expect("序列化");
    let frame2 = serde_json::to_string(&json!({
        "candidates": [{ "content": { "parts": [{ "text": "b" }] }, "finishReason": "STOP" }],
        "usageMetadata": { "promptTokenCount": 10, "candidatesTokenCount": 20 },
    }))
    .expect("序列化");
    let events = parse_all(vec![&frame1, &frame2]);
    match stop_of(&events) {
        ProviderStreamEvent::Stop {
            usage: Some(usage), ..
        } => {
            assert_eq!(usage.prompt_tokens, Some(10));
            assert_eq!(usage.completion_tokens, Some(20));
            assert_eq!(
                usage.total_tokens,
                Some(30),
                "next 显式 total（累计值）优先"
            );
            assert_eq!(usage.cache_read_tokens, Some(4), "帧 1 字段回退保留");
            assert_eq!(usage.reasoning_tokens, Some(3), "帧 1 字段回退保留");
        }
        other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
    }
}

#[test]
fn usage_total_prefers_next_explicit_value() {
    // 收敛后（P2 §3.3 D max 语义）：total 恒由合并结果重算（10+20=30，
    // 与 next 显式 total 同值——保持既有断言成立）
    let base = ProviderUsage {
        prompt_tokens: Some(10),
        completion_tokens: Some(5),
        total_tokens: Some(15),
        ..ProviderUsage::default()
    };
    let next = ProviderUsage {
        prompt_tokens: Some(10),
        completion_tokens: Some(20),
        total_tokens: Some(30),
        ..ProviderUsage::default()
    };
    let merged = merge_gemini_usage(Some(&base), &next);
    assert_eq!(merged.total_tokens, Some(30), "total 重算为 10+20");
    assert_eq!(merged.prompt_tokens, Some(10));
    assert_eq!(merged.completion_tokens, Some(20));
}

#[test]
fn usage_total_recomputed_when_next_missing() {
    let base = ProviderUsage {
        prompt_tokens: Some(10),
        completion_tokens: Some(5),
        total_tokens: Some(15),
        ..ProviderUsage::default()
    };
    let next = ProviderUsage {
        completion_tokens: Some(20),
        ..ProviderUsage::default()
    };
    let merged = merge_gemini_usage(Some(&base), &next);
    assert_eq!(merged.prompt_tokens, Some(10), "base 字段保留");
    assert_eq!(merged.completion_tokens, Some(20), "next 显式字段优先");
    assert_eq!(merged.total_tokens, Some(30), "next 无 total → 重算 10+20");
}

#[test]
fn usage_merge_max_semantics_next_zero_keeps_prev() {
    // 收敛后（P2 §3.3 D 分片 max 语义）：next 传 0 不覆盖 prev 的完整 input
    let base = ProviderUsage {
        prompt_tokens: Some(100),
        cache_read_tokens: Some(40),
        ..ProviderUsage::default()
    };
    let next = ProviderUsage {
        prompt_tokens: Some(0),
        completion_tokens: Some(5),
        ..ProviderUsage::default()
    };
    let merged = merge_gemini_usage(Some(&base), &next);
    assert_eq!(merged.prompt_tokens, Some(100), "next 0 不覆盖 prev 100");
    assert_eq!(merged.cache_read_tokens, Some(40), "prev 字段保留");
    assert_eq!(merged.completion_tokens, Some(5), "completion 后到优先");
    assert_eq!(merged.total_tokens, Some(105), "total 重算为 100+5");
}

#[test]
fn parse_gemini_usage_accepts_snake_alternates() {
    let usage = parse_gemini_usage(Some(&json!({
        "prompt_token_count": 3,
        "candidates_token_count": 4,
        "total_token_count": 9,
        "cached_content_token_count": 1,
        "thoughts_token_count": 2,
    })));
    let usage = usage.expect("解析成功");
    assert_eq!(usage.prompt_tokens, Some(3));
    assert_eq!(usage.completion_tokens, Some(4));
    assert_eq!(usage.total_tokens, Some(9), "显式 total 优先于重算");
    assert_eq!(usage.cache_read_tokens, Some(1));
    assert_eq!(usage.reasoning_tokens, Some(2));
}

#[test]
fn parse_gemini_usage_accepts_total_cached_tokens_alias() {
    // total_cached_tokens 别名（camel/snake 双形，P2 步骤 1b）：回退于
    // cachedContentTokenCount 之后（00-catalog 第 8.2 节隐式缓存计量字段）
    let usage = parse_gemini_usage(Some(&json!({
        "promptTokenCount": 10,
        "candidatesTokenCount": 20,
        "totalCachedTokens": 4,
    })))
    .expect("解析成功");
    assert_eq!(
        usage.cache_read_tokens,
        Some(4),
        "camel 形 totalCachedTokens"
    );

    let usage = parse_gemini_usage(Some(&json!({
        "promptTokenCount": 10,
        "total_cached_tokens": 3,
    })))
    .expect("解析成功");
    assert_eq!(
        usage.cache_read_tokens,
        Some(3),
        "snake 形 total_cached_tokens"
    );

    let usage = parse_gemini_usage(Some(&json!({
        "promptTokenCount": 10,
        "cachedContentTokenCount": 6,
        "total_cached_tokens": 3,
    })))
    .expect("解析成功");
    assert_eq!(
        usage.cache_read_tokens,
        Some(6),
        "cachedContentTokenCount 优先于别名"
    );
}

#[test]
fn parse_gemini_usage_empty_returns_none() {
    assert!(parse_gemini_usage(None).is_none());
    assert!(parse_gemini_usage(Some(&Value::Null)).is_none());
    assert!(parse_gemini_usage(Some(&json!("usage"))).is_none());
    assert!(
        parse_gemini_usage(Some(&json!({}))).is_none(),
        "全空字段返回 None"
    );
    assert!(parse_gemini_usage(Some(&json!({ "promptTokenCount": 1 }))).is_some());
}

// ── 阻断 / 空流保护 / 收尾 ──

#[test]
fn block_reason_without_candidates_errors() {
    // promptFeedback.blockReason 且无 candidates → stop{error}（60-71）
    let data = r#"{"promptFeedback":{"blockReason":"SAFETY","blockReasonMessage":"含违禁内容"}}"#;
    let events = parse_all(vec![data]);
    assert_eq!(
        stop_of(&events),
        &ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error: Some("Gemini prompt blocked (SAFETY): 含违禁内容".into()),
            usage: None,
        }
    );
}

#[test]
fn block_reason_without_message_uses_reason_only() {
    let data = r#"{"promptFeedback":{"block_reason":"OTHER"}}"#;
    let events = parse_all(vec![data]);
    match stop_of(&events) {
        ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error: Some(error),
            ..
        } => {
            assert_eq!(error, "Gemini prompt blocked: OTHER");
        }
        other => panic!("期望阻断 error stop，得到：{other:?}"),
    }
}

#[test]
fn block_reason_with_candidates_is_not_an_error() {
    // 有 candidates 时 blockReason 不触发阻断分支（62 判定）
    let data = serde_json::to_string(&json!({
        "candidates": [{ "content": { "parts": [{ "text": "x" }] }, "finishReason": "STOP" }],
        "promptFeedback": { "blockReason": "SAFETY" },
    }))
    .expect("序列化");
    let events = parse_all(vec![&data]);
    assert_eq!(
        stop_of(&events),
        &ProviderStreamEvent::Stop {
            reason: StopReason::Stop,
            error: None,
            usage: None,
        }
    );
}

#[test]
fn unspecified_block_reason_is_ignored() {
    let cases = [
        r#"{"promptFeedback":{"blockReason":"BLOCK_REASON_UNSPECIFIED"}}"#,
        r#"{"promptFeedback":{"blockReason":""}}"#,
        r#"{"promptFeedback":{}}"#,
        r#"{}"#,
    ];
    for data in cases {
        let events = parse_all(vec![data]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("Gemini streaming response completed without content events".into()),
                usage: None,
            },
            "{data} 应走空流保护而非阻断"
        );
    }
}

#[test]
fn empty_stream_produces_error_stop() {
    // 无 candidates / usage / 终态 → error（162-169）
    let events = parse_all(vec![]);
    assert_eq!(events.len(), 1);
    match stop_of(&events) {
        ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error,
            usage,
        } => {
            assert_eq!(
                error.as_deref(),
                Some("Gemini streaming response completed without content events")
            );
            assert!(usage.is_none());
        }
        other => panic!("期望 error stop，得到：{other:?}"),
    }
}

#[test]
fn usage_only_stream_is_not_an_error() {
    // 无内容但有 usage → 不算空流（162 判定）
    let data = r#"{"usageMetadata":{"promptTokenCount":5}}"#;
    let events = parse_all(vec![data]);
    assert_eq!(
        stop_of(&events),
        &ProviderStreamEvent::Stop {
            reason: StopReason::Stop,
            error: None,
            usage: Some(ProviderUsage {
                prompt_tokens: Some(5),
                total_tokens: Some(5),
                ..ProviderUsage::default()
            }),
        }
    );
}

#[test]
fn finish_is_idempotent() {
    let mut parser = GeminiParser::new();
    let first = parser.finish().expect("首次 finish");
    assert_eq!(first.len(), 1);
    assert!(
        parser.finish().expect("二次 finish").is_empty(),
        "重复 finish 不得再产出 stop"
    );
    assert!(parser.is_terminated());
}

#[test]
fn non_object_parts_and_candidates_are_skipped() {
    let data = serde_json::to_string(&json!({
        "candidates": [
            "not-an-object",
            { "content": { "parts": [42, { "text": "正文" }] }, "finishReason": "STOP" },
        ],
    }))
    .expect("序列化");
    let events = parse_all(vec![&data]);
    assert!(events.iter().any(|event| matches!(
        event,
        ProviderStreamEvent::TextDelta { text } if text == "正文"
    )));
    assert_eq!(
        stop_of(&events),
        &ProviderStreamEvent::Stop {
            reason: StopReason::Stop,
            error: None,
            usage: None,
        }
    );
}

// ── 错误帧 ──

#[test]
fn error_frame_terminates_immediately() {
    let cases = [
        (
            r#"{"error":{"status":"INVALID_ARGUMENT","message":"参数错"}}"#,
            "INVALID_ARGUMENT: 参数错",
        ),
        (
            r#"{"error":{"code":403,"message":"无权限"}}"#,
            "403: 无权限",
        ),
        (r#"{"error":{"message":"仅消息"}}"#, "仅消息"),
        (r#"{"error":{"status":"UNAVAILABLE"}}"#, "UNAVAILABLE"),
        (r#"{"error":"字符串错误"}"#, "字符串错误"),
    ];
    for (data, expected) in cases {
        let events = parse_all(vec![data]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(expected.into()),
                usage: None,
            },
            "{data}"
        );
    }
}

#[test]
fn frames_after_error_are_ignored() {
    let mut parser = GeminiParser::new();
    parser
        .push_frame(&SseFrame {
            event: None,
            data: Some(r#"{"error":{"message":"boom"}}"#.to_string()),
            id: None,
            retry: None,
        })
        .expect("错误帧处理");
    assert!(parser.is_terminated());
    assert!(
        parser
            .push_frame(&SseFrame {
                event: None,
                data: Some(r#"{"candidates":[{"content":{"parts":[{"text":"x"}]},"finishReason":"STOP"}]}"#.to_string()),
                id: None,
                retry: None,
            })
            .expect("已终结帧处理")
            .is_empty(),
        "错误帧后 push 应空产出"
    );
}
