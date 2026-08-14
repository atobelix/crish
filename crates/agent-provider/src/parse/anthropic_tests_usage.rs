//! parse/anthropic.rs 测试旁挂 · usage/空流保护/错误帧域（SR-06e · 拆分 · ≠ EL；
//! 经 #[path] 接线，非直接 mod）
//!
//! 原 anthropic.rs `mod tests` 拆分搬入，零删除零合并；测试名与断言形状不变。
//! 正常流/thinking/工具调用/stop_reason 域见 anthropic_tests.rs；共享便捷函数
//! （parse_all / event_frame / stop_of）由 [super::tests] 提供。

use super::tests::{event_frame, parse_all, stop_of};
use super::*;
use serde_json::json;

// ── usage 分片补全（02 §六.6：Anthropic 分片补全）──

#[test]
fn usage_merged_across_message_start_and_message_delta() {
    // message_start 只带 input；message_delta 只带 output → 合并且 total 重算
    let events = parse_all(vec![
        &event_frame(
            "message_start",
            json!({
                "message": { "usage": { "input_tokens": 100, "cache_read_input_tokens": 40, "cache_creation_input_tokens": 10 } },
            }),
        ),
        &event_frame("message_delta", json!({ "usage": { "output_tokens": 60 } })),
        &event_frame("message_stop", json!({})),
    ]);
    match stop_of(&events) {
        ProviderStreamEvent::Stop {
            usage: Some(usage), ..
        } => {
            assert_eq!(usage.prompt_tokens, Some(100));
            assert_eq!(usage.completion_tokens, Some(60));
            assert_eq!(usage.total_tokens, Some(160), "total 由合并后重算");
            assert_eq!(usage.cache_read_tokens, Some(40));
            assert_eq!(usage.cache_write_tokens, Some(10));
        }
        other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
    }
}

#[test]
fn usage_next_zero_does_not_override_prev_input() {
    // 分片合并 max 语义：message_delta 传 0 不覆盖 message_start 的完整 input
    // （P2 §3.3 D；共享函数 merge_usage_shards 已钉死纯函数级用例，此处走真实帧路径再钉一层）
    let events = parse_all(vec![
        &event_frame(
            "message_start",
            json!({
                "message": { "usage": { "input_tokens": 100, "cache_read_input_tokens": 40 } },
            }),
        ),
        &event_frame(
            "message_delta",
            json!({
                "usage": { "input_tokens": 0, "output_tokens": 60 },
            }),
        ),
        &event_frame("message_stop", json!({})),
    ]);
    match stop_of(&events) {
        ProviderStreamEvent::Stop {
            usage: Some(usage), ..
        } => {
            assert_eq!(
                usage.prompt_tokens,
                Some(100),
                "next 传 0 不覆盖 prev 的 100"
            );
            assert_eq!(usage.cache_read_tokens, Some(40), "read 同理防 0 覆盖");
            assert_eq!(usage.completion_tokens, Some(60));
            assert_eq!(usage.total_tokens, Some(160), "total 由合并后重算");
        }
        other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
    }
}

#[test]
fn usage_preserves_explicit_total_when_fields_missing() {
    // prompt/completion 均缺失时保留显式 total（377-378 的 else 分支）
    let base = ProviderUsage {
        total_tokens: Some(50),
        ..ProviderUsage::default()
    };
    let next = ProviderUsage {
        cache_read_tokens: Some(5),
        ..ProviderUsage::default()
    };
    let merged = merge_anthropic_usage(Some(&base), &next);
    assert_eq!(
        merged.total_tokens,
        Some(50),
        "无 prompt/completion 时保留显式 total"
    );
    assert_eq!(merged.cache_read_tokens, Some(5));
}

#[test]
fn usage_next_fields_override_base() {
    let base = ProviderUsage {
        prompt_tokens: Some(10),
        completion_tokens: Some(20),
        total_tokens: Some(30),
        ..ProviderUsage::default()
    };
    let next = ProviderUsage {
        completion_tokens: Some(25),
        ..ProviderUsage::default()
    };
    let merged = merge_anthropic_usage(Some(&base), &next);
    assert_eq!(merged.prompt_tokens, Some(10), "base 字段保留");
    assert_eq!(merged.completion_tokens, Some(25), "next 显式字段优先");
    assert_eq!(merged.total_tokens, Some(35), "total 重算为 10+25");
}

#[test]
fn parse_anthropic_usage_accepts_snake_alternates() {
    let usage = parse_anthropic_usage(Some(&json!({
        "prompt_tokens": 3,
        "completion_tokens": 4,
        "total_tokens": 9,
    })));
    let usage = usage.expect("解析成功");
    assert_eq!(usage.prompt_tokens, Some(3));
    assert_eq!(usage.completion_tokens, Some(4));
    assert_eq!(usage.total_tokens, Some(9), "显式 total 优先于重算");
}

#[test]
fn parse_anthropic_usage_empty_returns_none() {
    assert!(parse_anthropic_usage(None).is_none());
    assert!(parse_anthropic_usage(Some(&Value::Null)).is_none());
    assert!(parse_anthropic_usage(Some(&json!("usage"))).is_none());
    assert!(
        parse_anthropic_usage(Some(&json!({}))).is_none(),
        "全空字段返回 None"
    );
    assert!(parse_anthropic_usage(Some(&json!({ "input_tokens": 1 }))).is_some());
}

// ── 空流保护 / 收尾 ──

#[test]
fn empty_stream_produces_error_stop() {
    // 无 message_start / 内容 / message_stop / usage → error（198-205）
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
                Some("Anthropic streaming response completed without content events")
            );
            assert!(usage.is_none());
        }
        other => panic!("期望 error stop，得到：{other:?}"),
    }
}

#[test]
fn message_stop_alone_prevents_empty_stream_error() {
    // 有 message_stop → 不算空流，正常 stop（198 判定）
    let events = parse_all(vec![&event_frame("message_stop", json!({}))]);
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
fn usage_only_stream_is_not_an_error() {
    // 无内容但有 usage → 不算空流（198 判定）；message_start 即带 usage
    let events = parse_all(vec![&event_frame(
        "message_start",
        json!({
            "message": { "usage": { "input_tokens": 5 } },
        }),
    )]);
    match stop_of(&events) {
        ProviderStreamEvent::Stop {
            reason: StopReason::Stop,
            usage: Some(usage),
            ..
        } => {
            assert_eq!(usage.prompt_tokens, Some(5));
        }
        other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
    }
}

#[test]
fn finish_is_idempotent() {
    let mut parser = AnthropicParser::new();
    let first = parser.finish().expect("首次 finish");
    assert_eq!(first.len(), 1);
    assert!(
        parser.finish().expect("二次 finish").is_empty(),
        "重复 finish 不得再产出 stop"
    );
    assert!(parser.is_terminated());
}

#[test]
fn noise_frames_are_ignored() {
    // 无 type 或未知事件：代理噪声忽略，不炸流（182）
    let events = parse_all(vec![
        r#"{"ping":"keep-alive"}"#,
        &event_frame("unknown_event", json!({ "data": "x" })),
        &event_frame("message_stop", json!({})),
    ]);
    assert_eq!(events.len(), 1, "仅剩 stop");
    assert!(matches!(events[0], ProviderStreamEvent::Stop { .. }));
}

// ── 错误帧 ──

#[test]
fn error_frame_terminates_immediately() {
    let events = parse_all(vec![
        r#"{"type":"error","error":{"type":"overloaded_error","message":"过载"}}"#,
    ]);
    assert_eq!(
        stop_of(&events),
        &ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error: Some("overloaded_error: 过载".into()),
            usage: None,
        }
    );
    assert_eq!(events.len(), 1, "错误帧后不得再产出任何事件");
}

#[test]
fn error_frame_variants() {
    let cases = [
        (r#"{"type":"error","error":"字符串错误"}"#, "字符串错误"),
        (r#"{"type":"error","error":{"message":"仅消息"}}"#, "仅消息"),
        (r#"{"type":"error","error":{"type":"仅类型"}}"#, "仅类型"),
        (r#"{"type":"error","message":"顶层消息"}"#, "顶层消息"),
        (r#"{"type":"error"}"#, "Anthropic streaming error"),
        // 非 error 帧的顶层 message 不视为错误
        (
            r#"{"type":"message_start","message":{"usage":{"input_tokens":1}}}"#,
            "no-error",
        ),
    ];
    for (data, expected) in cases {
        let events = parse_all(vec![data]);
        if expected == "no-error" {
            assert!(
                events.iter().all(|event| !matches!(
                    event,
                    ProviderStreamEvent::Stop {
                        reason: StopReason::Error,
                        ..
                    }
                )),
                "{data} 不应判定为错误帧"
            );
            continue;
        }
        match stop_of(&events) {
            ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(error),
                ..
            } => {
                assert_eq!(error, expected, "{data}");
            }
            other => panic!("{data} 期望错误 stop，得到：{other:?}"),
        }
    }
}

#[test]
fn frames_after_error_are_ignored() {
    let mut parser = AnthropicParser::new();
    parser
        .push_frame(&SseFrame {
            event: None,
            data: Some(r#"{"type":"error","error":"boom"}"#.to_string()),
            id: None,
            retry: None,
        })
        .expect("错误帧处理");
    assert!(parser.is_terminated());
    assert!(
        parser
            .push_frame(&SseFrame {
                event: None,
                data: Some(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}"#.to_string()),
                id: None,
                retry: None,
            })
            .expect("已终结帧处理")
            .is_empty(),
        "错误帧后 push 应空产出"
    );
}
