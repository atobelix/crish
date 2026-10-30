//! 实时流式思考标签解析状态机极限单元测试（B2.5 / Markdown Stream Refactor）

use super::*;
use crate::events::ProviderStreamEvent;
use crate::sse::frame::SseFrame;

fn extract_all(extractor: &mut StreamingTagExtractor, chunks: &[&str]) -> Vec<ProviderStreamEvent> {
    let mut events = Vec::new();
    for chunk in chunks {
        events.extend(extractor.push_text(chunk));
    }
    events.extend(extractor.finish());
    events
}

fn extract_pieces_all(
    extractor: &mut StreamingTagExtractor,
    chunks: &[&str],
) -> Vec<ExtractedPiece> {
    let mut pieces = Vec::new();
    for chunk in chunks {
        pieces.extend(extractor.push_chunk(chunk));
    }
    pieces.extend(extractor.finish_pieces());
    pieces
}

// Case 1: 标准单 Chunk 提取
#[test]
fn test_standard_single_chunk() {
    let mut extractor = StreamingTagExtractor::default();
    let events = extract_all(&mut extractor, &["<think>Hello thinking</think>World text"]);
    assert_eq!(
        events,
        vec![
            ProviderStreamEvent::ThoughtDelta {
                text: "Hello thinking".into(),
                redacted: None,
            },
            ProviderStreamEvent::TextDelta {
                text: "World text".into(),
            },
        ]
    );
}

// Case 2: 极限跨 Chunk 单字符分割（开标签与闭标签全切碎）
#[test]
fn test_extreme_token_fragmentation() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &[
        "<", "t", "h", "i", "n", "k", ">", "P", "l", "a", "n", " ", "A", "<", "/", "t", "h", "i",
        "n", "k", ">", "A", "n", "s", "w", "e", "r",
    ];
    let events = extract_all(&mut extractor, chunks);

    let thoughts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    let texts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(thoughts, "Plan A");
    assert_eq!(texts, "Answer");
}

// Case 3: 虚假标签回滚（Rollback in Text State）
#[test]
fn test_false_open_tag_rollback() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["3 < thin", "g is not tag"];
    let events = extract_all(&mut extractor, chunks);

    let texts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(texts, "3 < thing is not tag");
    assert!(events
        .iter()
        .all(|e| matches!(e, ProviderStreamEvent::TextDelta { .. })));
}

// Case 4: 思考态内的虚假闭标签回滚（Rollback in Thinking State）
#[test]
fn test_false_close_tag_rollback_in_thinking() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &[
        "<think>Check 1: a </",
        "div> tag inside thought</think>Final Text",
    ];
    let events = extract_all(&mut extractor, chunks);

    let thoughts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    let texts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(thoughts, "Check 1: a </div> tag inside thought");
    assert_eq!(texts, "Final Text");
}

// Case 5: 流在开标签匹配中途异常终止（EOF in MatchingOpen）
#[test]
fn test_eof_in_matching_open() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["Text before <thi"];
    let events = extract_all(&mut extractor, chunks);

    let texts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(texts, "Text before <thi");
}

// Case 6: 流在闭标签匹配中途异常终止（EOF in MatchingClose）
#[test]
fn test_eof_in_matching_close() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["<think>Thinking text </th"];
    let events = extract_all(&mut extractor, chunks);

    let thoughts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(thoughts, "Thinking text </th");
    assert!(events
        .iter()
        .all(|e| matches!(e, ProviderStreamEvent::ThoughtDelta { .. })));
}

// Case 7: 多重思考块支持与不同标签交替
#[test]
fn test_multiple_thinking_blocks() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &[
        "<think>Plan 1</think>Text 1",
        "<thought>Plan 2</thought>Text 2",
    ];
    let events = extract_all(&mut extractor, chunks);

    assert_eq!(
        events,
        vec![
            ProviderStreamEvent::ThoughtDelta {
                text: "Plan 1".into(),
                redacted: None,
            },
            ProviderStreamEvent::TextDelta {
                text: "Text 1".into(),
            },
            ProviderStreamEvent::ThoughtDelta {
                text: "Plan 2".into(),
                redacted: None,
            },
            ProviderStreamEvent::TextDelta {
                text: "Text 2".into(),
            },
        ]
    );
}

// Case 8: 标签后紧随换行符消除（LF）
#[test]
fn test_strip_leading_newline_after_open_and_close() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["<think>\nLine 1\nLine 2\n</think>\nResult line"];
    let events = extract_all(&mut extractor, chunks);

    assert_eq!(
        events,
        vec![
            ProviderStreamEvent::ThoughtDelta {
                text: "Line 1\nLine 2\n".into(),
                redacted: None,
            },
            ProviderStreamEvent::TextDelta {
                text: "Result line".into(),
            },
        ]
    );
}

// Case 9: 标签后紧随 CRLF 换行符消除
#[test]
fn test_strip_leading_crlf_after_tags() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["<think>\r\nLine 1\r\n</think>\r\nResult line"];
    let events = extract_all(&mut extractor, chunks);

    assert_eq!(
        events,
        vec![
            ProviderStreamEvent::ThoughtDelta {
                text: "Line 1\r\n".into(),
                redacted: None,
            },
            ProviderStreamEvent::TextDelta {
                text: "Result line".into(),
            },
        ]
    );
}

// Case 10: 无思考标签的普通正文
#[test]
fn test_no_think_tags_plain_text() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["Hello ", "world, ", "this is a normal stream!"];
    let events = extract_all(&mut extractor, chunks);

    let full_text: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(full_text, "Hello world, this is a normal stream!");
    assert!(events
        .iter()
        .all(|e| matches!(e, ProviderStreamEvent::TextDelta { .. })));
}

// Case 11: 数学小于号表达式
#[test]
fn test_math_less_than_expressions() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["1 < 2 and 3 > 2 and 5 < 10 and a < b"];
    let events = extract_all(&mut extractor, chunks);

    let full_text: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(full_text, "1 < 2 and 3 > 2 and 5 < 10 and a < b");
    assert!(events
        .iter()
        .all(|e| matches!(e, ProviderStreamEvent::TextDelta { .. })));
}

// Case 12: 连续小于号与嵌套标签前缀
#[test]
fn test_consecutive_opening_angle_brackets() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["<<think>inner</think>"];
    let events = extract_all(&mut extractor, chunks);

    assert_eq!(
        events,
        vec![
            ProviderStreamEvent::TextDelta { text: "<".into() },
            ProviderStreamEvent::ThoughtDelta {
                text: "inner".into(),
                redacted: None,
            },
        ]
    );
}

// Case 13: 空 Chunk 与空流处理
#[test]
fn test_empty_chunks_and_empty_stream() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["", "", ""];
    let events = extract_all(&mut extractor, chunks);
    assert!(events.is_empty());
}

// Case 14: 空思考块
#[test]
fn test_empty_think_block() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["<think></think>After thought"];
    let events = extract_all(&mut extractor, chunks);

    assert_eq!(
        events,
        vec![ProviderStreamEvent::TextDelta {
            text: "After thought".into(),
        }]
    );
}

// Case 15: 详案断言 1：跨 Chunk 切割精准剥离
#[test]
fn test_assertion_1_from_spec() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["<thi", "nk>hello</th", "ink>world"];
    let events = extract_all(&mut extractor, chunks);

    assert_eq!(
        events,
        vec![
            ProviderStreamEvent::ThoughtDelta {
                text: "hello".into(),
                redacted: None,
            },
            ProviderStreamEvent::TextDelta {
                text: "world".into(),
            },
        ]
    );
}

// Case 16: 详案断言 2：纯数学符号与零丢字
#[test]
fn test_assertion_2_from_spec() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["1 < 2 and 3 > 2"];
    let events = extract_all(&mut extractor, chunks);

    assert_eq!(
        events,
        vec![ProviderStreamEvent::TextDelta {
            text: "1 < 2 and 3 > 2".into(),
        }]
    );
}

// Case 17: thinking 标签与跨 Chunk 混合
#[test]
fn test_thinking_tag_variant() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["<thinking>Detailed analysis...</thinking>Answer"];
    let events = extract_all(&mut extractor, chunks);

    assert_eq!(
        events,
        vec![
            ProviderStreamEvent::ThoughtDelta {
                text: "Detailed analysis...".into(),
                redacted: None,
            },
            ProviderStreamEvent::TextDelta {
                text: "Answer".into(),
            },
        ]
    );
}

// Case 18: push_chunk (ExtractedPiece) 与 push_text (ProviderStreamEvent) 等价性
#[test]
fn test_push_chunk_and_push_text_parity() {
    let mut ext1 = StreamingTagExtractor::default();
    let mut ext2 = StreamingTagExtractor::default();
    let chunks = &["<think>T", "est</think>Te", "xt"];

    let pieces = extract_pieces_all(&mut ext1, chunks);
    let events = extract_all(&mut ext2, chunks);

    let mapped_events: Vec<ProviderStreamEvent> = pieces
        .into_iter()
        .map(ExtractedPiece::into_stream_event)
        .collect();
    assert_eq!(mapped_events, events);
}

// Case 19: is_thinking 状态探测
#[test]
fn test_is_thinking_state_reporting() {
    let mut extractor = StreamingTagExtractor::default();
    assert!(!extractor.is_thinking());

    extractor.push_chunk("<think>");
    assert!(extractor.is_thinking());

    extractor.push_chunk("thinking now...");
    assert!(extractor.is_thinking());

    extractor.push_chunk("</think>");
    assert!(!extractor.is_thinking());
}

// Case 20: reset 功能测试
#[test]
fn test_reset_functionality() {
    let mut extractor = StreamingTagExtractor::default();
    extractor.push_chunk("<think>unfinished");
    assert!(extractor.is_thinking());

    extractor.reset();
    assert!(!extractor.is_thinking());
    assert_eq!(extractor.state(), TagState::Text);

    let events = extract_all(&mut extractor, &["clean slate"]);
    assert_eq!(
        events,
        vec![ProviderStreamEvent::TextDelta {
            text: "clean slate".into(),
        }]
    );
}

// Case 21: ChatCompletionsParser 流式集成：content 内嵌 <think> 跨帧剥离
#[test]
fn test_chat_parser_streaming_think_tag_extraction() {
    use crate::parse::ChatCompletionsParser;

    let mut parser = ChatCompletionsParser::new();
    let mut events = Vec::new();

    let frames = vec![
        serde_json::json!({
            "choices": [{ "index": 0, "delta": { "content": "<thi" } }]
        }),
        serde_json::json!({
            "choices": [{ "index": 0, "delta": { "content": "nk>deep reasoning here</th" } }]
        }),
        serde_json::json!({
            "choices": [{ "index": 0, "delta": { "content": "ink>Final answer" }, "finish_reason": "stop" }]
        }),
    ];

    for payload in frames {
        let frame = SseFrame {
            event: None,
            data: Some(serde_json::to_string(&payload).unwrap()),
            id: None,
            retry: None,
        };
        events.extend(parser.push_frame(&frame).expect("push_frame 成功"));
    }
    events.extend(parser.finish().expect("finish 成功"));

    let thoughts: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    let texts: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(thoughts, vec!["deep reasoning here"]);
    assert_eq!(texts, vec!["Final answer"]);
}

// Case 22: GeminiParser 流式集成：part.text 内嵌 <thought> 跨帧剥离
#[test]
fn test_gemini_parser_streaming_thought_tag_extraction() {
    use crate::parse::GeminiParser;

    let mut parser = GeminiParser::new();
    let mut events = Vec::new();

    let frames = vec![serde_json::json!({
        "candidates": [{
            "content": {
                "parts": [{ "text": "<thought>Analyzing step by step</thought>Gemini solution" }]
            },
            "finishReason": "STOP"
        }]
    })];

    for payload in frames {
        let frame = SseFrame {
            event: None,
            data: Some(serde_json::to_string(&payload).unwrap()),
            id: None,
            retry: None,
        };
        events.extend(parser.push_frame(&frame).expect("push_frame 成功"));
    }
    events.extend(parser.finish().expect("finish 成功"));

    let thoughts: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    let texts: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(thoughts, vec!["Analyzing step by step"]);
    assert_eq!(texts, vec!["Gemini solution"]);
}

// Case 23: 异名闭标签不会提前劫持思考流
#[test]
fn test_mismatched_close_tag_not_hijacking_thinking() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["<think>Thinking with </thought> and </thinking> embedded</think>Final Answer"];
    let events = extract_all(&mut extractor, chunks);

    let thoughts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    let texts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(
        thoughts,
        "Thinking with </thought> and </thinking> embedded"
    );
    assert_eq!(texts, "Final Answer");
}

// Case 24: <thought> 标签下异名闭标签 </think> 与 </thinking> 不会提前闭合
#[test]
fn test_thought_tag_with_mismatched_close_tags() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["<thought>Reasoning with </think> and </thinking> inside</thought>Real Output"];
    let events = extract_all(&mut extractor, chunks);

    let thoughts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    let texts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(thoughts, "Reasoning with </think> and </thinking> inside");
    assert_eq!(texts, "Real Output");
}

// Case 25: <thinking> 标签下异名闭标签 </think> 与 </thought> 不会提前闭合
#[test]
fn test_thinking_tag_with_mismatched_close_tags() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["<thinking>Deep dive with </think> and </thought> inside</thinking>Result"];
    let events = extract_all(&mut extractor, chunks);

    let thoughts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    let texts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(thoughts, "Deep dive with </think> and </thought> inside");
    assert_eq!(texts, "Result");
}

// Case 26: 多字节 UTF-8 字符跨 Chunk 边界与 Emoji
#[test]
fn test_multibyte_utf8_across_chunks() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &[
        "<thi",
        "nk>思考：",
        "Rust 🦀 深度",
        "推理 ∑(x_i)</th",
        "ink>正文：",
        "完成！🎯",
    ];
    let events = extract_all(&mut extractor, chunks);

    let thoughts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    let texts: String = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(thoughts, "思考：Rust 🦀 深度推理 ∑(x_i)");
    assert_eq!(texts, "正文：完成！🎯");
}

// Case 27: ThinkTagStateMachine 别名与状态流转
#[test]
fn test_think_tag_state_machine_alias_and_states() {
    let mut sm = ThinkTagStateMachine::default();
    assert_eq!(sm.state(), ThinkTagState::Text);
    assert!(!sm.is_thinking());

    sm.push_chunk("<think>step 1");
    assert_eq!(sm.state(), ThinkTagState::Thinking);
    assert!(sm.is_thinking());

    sm.push_chunk("</think>");
    assert_eq!(sm.state(), ThinkTagState::Text);
    assert!(!sm.is_thinking());
}

// Case 28: 纯思考流（无后续正文输出）
#[test]
fn test_pure_thought_stream_without_text() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["<think>Only thinking, no answer</think>"];
    let events = extract_all(&mut extractor, chunks);

    assert_eq!(
        events,
        vec![ProviderStreamEvent::ThoughtDelta {
            text: "Only thinking, no answer".into(),
            redacted: None,
        }]
    );
}

// Case 29: 未闭合的思考流在流结束时正确收口为思考内容
#[test]
fn test_unclosed_thinking_stream_at_eof() {
    let mut extractor = StreamingTagExtractor::default();
    let chunks = &["<think>Still thinking when stream stopped"];
    let events = extract_all(&mut extractor, chunks);

    assert_eq!(
        events,
        vec![ProviderStreamEvent::ThoughtDelta {
            text: "Still thinking when stream stopped".into(),
            redacted: None,
        }]
    );
}
