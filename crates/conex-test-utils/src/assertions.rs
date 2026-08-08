//! 公共断言助手（T11.7.1：05 §6.2 建议一等公民化的落地）
//!
//! 从各 crate 测试提取的重复断言模式，统一收口到测试基础设施域：
//! - [assert_event_sequence]：事件序列类型名断言（T09.2 序列连续性复用）；
//! - [assert_message_delta_concatenation]：message-delta 正文拼接 == 全文
//!   （PE-02 契约 T2 收敛性直用）；
//! - [assert_request_text_contains]：第 n 次请求含指定文本（05 §6.2
//!   `assert_request_text_contains` 对应；泛型提取器避免依赖业务 crate）；
//! - [assert_message_text_contains]：消息列表含指定正文的便捷版；
//! - [assert_contains_subsequence]：泛型子序列断言（任意可比较元素）。
//!
//! 依赖边界（T11.7.1）：只依赖 conex-types（域类型叶子 crate），不依赖
//! session-loop/orchestrator 等业务 crate，杜绝循环依赖。

use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageBlock};

/// 断言事件序列的类型名序列与期望完全一致（01 §五.6 序列契约 / T09.2
/// 序列连续性断言复用）
///
/// 按 [AgentEvent::type_name] 投影为 kebab-case 类型名序列后逐项比对；
/// 失败信息打印实际类型名序列，便于定位首尾/成对契约缺口。
pub fn assert_event_sequence(events: &[AgentEvent], expected_type_names: &[&str]) {
    let actual: Vec<&str> = events.iter().map(|e| e.type_name()).collect();
    assert_eq!(
        actual, expected_type_names,
        "事件类型名序列不匹配（期望 {expected_type_names:?}）"
    );
}

/// 断言 message-delta 事件正文拼接 == 期望全文（PE-02 契约 T2 收敛性）
///
/// 只拼接正文块（text；与 [AgentMessage::text] 的正文口径一致，thought
/// 不入文）；非 delta 事件立即 panic。`final_text` 一般为收口
/// message-end 的全文（message-end 兜底语义，T09.1）。
pub fn assert_message_delta_concatenation(deltas: &[AgentEvent], final_text: &str) {
    let joined: String = deltas
        .iter()
        .map(|event| match event {
            AgentEvent::MessageDelta { block, .. } => block_text(block),
            other => panic!("拼接断言只接受 message-delta 事件，实际 {}", other.type_name()),
        })
        .collect();
    assert_eq!(&joined, final_text, "delta 正文拼接 == 全文（T2 收敛性）");
}

/// 提取块正文（text 块原文；thought/tool 块不入正文，与
/// [AgentMessage::text] 口径一致）
fn block_text(block: &AgentMessageBlock) -> &str {
    match block {
        AgentMessageBlock::Text { text } => text,
        _ => "",
    }
}

/// 断言请求序列第 n 次请求含指定文本（05 §6.2 `assert_request_text_contains`
/// 对应，nudge 文案断言复用）
///
/// `texts_of` 提取器把请求映射为候选文本列表（由调用方类型定义，避免
/// 测试基础设施依赖业务 crate 的请求类型）。n 越界或全部候选文本不含
/// 目标文本时给出明确失败信息。
pub fn assert_request_text_contains<'a, R>(
    requests: &'a [R],
    n: usize,
    contains: &str,
    texts_of: impl Fn(&'a R) -> Vec<String>,
) {
    let request = requests
        .get(n)
        .unwrap_or_else(|| panic!("请求序号 {n} 越界（共 {} 次请求）", requests.len()));
    let texts = texts_of(request);
    assert!(
        texts.iter().any(|text| text.contains(contains)),
        "第 {n} 次请求应含 {contains:?}，实际候选文本：{texts:?}"
    );
}

/// 便捷版：断言消息列表中存在含指定正文的消息（AgentMessage 域）
pub fn assert_message_text_contains(messages: &[AgentMessage], contains: &str) {
    let actual: Vec<String> = messages.iter().map(|m| m.text()).collect();
    assert!(
        actual.iter().any(|text| text.contains(contains)),
        "消息列表应含 {contains:?}，实际正文：{actual:?}"
    );
}

/// 泛型子序列断言：`needle` 必须作为连续块出现在 `haystack` 中
///
/// 空 needle 恒真（数学上任何序列都含空子序列）。元素需可比较（PartialEq）
/// 且可打印（Debug，失败定位用）。
pub fn assert_contains_subsequence<T>(haystack: &[T], needle: &[T])
where
    T: PartialEq + std::fmt::Debug,
{
    let found = needle.is_empty()
        || haystack.windows(needle.len()).any(|window| window == needle);
    assert!(found, "序列应含子序列 {needle:?}，实际：{haystack:?}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::events::AgentEvent;
    use conex_types::message::{AgentMessageBlock, AgentMessageRole};
    use conex_types::session::AgentEndReason;
    use std::sync::Arc;

    /// 构造最小事件（按事件序列断言测试所需字段）
    fn sample_events() -> Vec<AgentEvent> {
        vec![
            AgentEvent::AgentStart {
                session_id: "s1".into(),
                timestamp: "2026-01-01T00:00:00.000Z".into(),
            },
            AgentEvent::MessageDelta {
                session_id: "s1".into(),
                timestamp: "2026-01-01T00:00:00.000Z".into(),
                message_id: "m1".into(),
                block: AgentMessageBlock::Text {
                    text: "你好".into(),
                },
            },
            AgentEvent::AgentEnd {
                session_id: "s1".into(),
                timestamp: "2026-01-01T00:00:00.000Z".into(),
                reason: AgentEndReason::Stop,
                error: None,
            },
        ]
    }

    #[test]
    fn event_sequence_asserts_full_type_name_order() {
        let events = sample_events();
        assert_event_sequence(&events, &["agent-start", "message-delta", "agent-end"]);
    }

    #[test]
    #[should_panic(expected = "事件类型名序列不匹配")]
    fn event_sequence_fails_on_mismatch() {
        let events = sample_events();
        assert_event_sequence(&events, &["agent-start", "agent-end"]);
    }

    #[test]
    fn delta_concatenation_joins_text_blocks_only() {
        // thought 块不入正文（与 AgentMessage::text 口径一致）
        let deltas = vec![
            AgentEvent::MessageDelta {
                session_id: "s1".into(),
                timestamp: "2026-01-01T00:00:00.000Z".into(),
                message_id: "m1".into(),
                block: AgentMessageBlock::Text { text: "你".into() },
            },
            AgentEvent::MessageDelta {
                session_id: "s1".into(),
                timestamp: "2026-01-01T00:00:00.000Z".into(),
                message_id: "m1".into(),
                block: AgentMessageBlock::Thought {
                    text: "思考中".into(),
                    redacted: Some(true),
                },
            },
            AgentEvent::MessageDelta {
                session_id: "s1".into(),
                timestamp: "2026-01-01T00:00:00.000Z".into(),
                message_id: "m1".into(),
                block: AgentMessageBlock::Text { text: "好".into() },
            },
        ];
        assert_message_delta_concatenation(&deltas, "你好");
    }

    #[test]
    #[should_panic(expected = "拼接断言只接受 message-delta 事件")]
    fn delta_concatenation_rejects_non_delta() {
        let events = sample_events();
        assert_message_delta_concatenation(&events, "你好");
    }

    #[test]
    fn request_text_contains_matches_nth_request() {
        // 以消息正文作候选文本（调用方提取器形态）
        let requests = vec![
            vec![String::from("用户问题"), String::from("运行期纠正：请重试")],
            vec![String::from("另一请求")],
        ];
        assert_request_text_contains(&requests, 0, "运行期纠正", |r| r.clone());
        assert_request_text_contains(&requests, 1, "另一请求", |r| r.clone());
    }

    #[test]
    #[should_panic(expected = "请求序号 9 越界")]
    fn request_text_contains_fails_on_out_of_range() {
        let requests: Vec<Vec<String>> = vec![vec![]];
        assert_request_text_contains(&requests, 9, "任意", |r| r.clone());
    }

    #[test]
    fn message_text_contains_matches_agent_messages() {
        let messages = vec![
            AgentMessage {
                id: "m1".into(),
                role: AgentMessageRole::System,
                created_at: "2026-01-01T00:00:00Z".into(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "运行期纠正：当前进度慢".into(),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            },
            AgentMessage {
                id: "m2".into(),
                role: AgentMessageRole::User,
                created_at: "2026-01-01T00:00:00Z".into(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "继续".into(),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            },
        ];
        assert_message_text_contains(&messages, "运行期纠正");
    }

    #[test]
    fn contains_subsequence_matches_contiguous_windows() {
        let haystack = vec![1, 2, 3, 4, 5];
        assert_contains_subsequence(&haystack, &[2, 3, 4]);
        assert_contains_subsequence(&haystack, &[5]);
        // 空 needle 恒真
        assert_contains_subsequence(&haystack, &[]);
    }

    #[test]
    #[should_panic(expected = "序列应含子序列")]
    fn contains_subsequence_fails_when_absent() {
        let haystack = vec![1, 2, 3];
        // 非连续窗口不匹配
        assert_contains_subsequence(&haystack, &[2, 4]);
    }

    /// 事件序列断言可作用于真实事件（带 Arc 载荷的消息事件不 panic）
    #[test]
    fn event_sequence_handles_arc_payload_events() {
        let message = Arc::new(AgentMessage {
            id: "m1".into(),
            role: AgentMessageRole::Assistant,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![],
            metadata: None,
            client_message_id: None,
            content: None,
        });
        let events = vec![
            AgentEvent::MessageStart {
                session_id: "s1".into(),
                message: message.clone(),
            },
            AgentEvent::MessageEnd {
                session_id: "s1".into(),
                message,
                turn_index: None,
            },
        ];
        assert_event_sequence(&events, &["message-start", "message-end"]);
    }
}
