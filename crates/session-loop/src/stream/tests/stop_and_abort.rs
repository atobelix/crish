use super::*;

/// 文字 + error stop → Message（内容部分保留）；stopReason=error 第一公民变体（BC02-2）。
/// D7 §3.7（T9）：标注含结构化分类 providerErrorKind/providerErrorRetryable
#[test]
fn text_then_error_stop_yields_message() {
    let result = consume(
        vec![
            ProviderStreamEvent::text("你好"),
            ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("上游超时".to_string()),
                error_kind: Some(ProviderErrorKind::Timeout),
                usage: None,
            },
        ],
        false,
    );
    assert_eq!(result.response, ProviderOutput::message("你好", vec![]));
    assert_eq!(
        result.stop_reason(),
        Some(ConsumeStopReason::Error {
            kind: ProviderErrorKind::Timeout,
            message: "上游超时".to_string(),
            retryable: true,
        })
    );
    assert_eq!(result.metadata["stopReason"], "error");
    // providerError 字符串保持 + 结构化字段（kebab-case kind / retryable）
    assert_eq!(result.metadata["providerError"], "上游超时");
    assert_eq!(result.metadata["providerErrorKind"], "timeout");
    assert_eq!(result.metadata["providerErrorRetryable"], true);
}

/// D7 §3.7：不可重试分类（Unknown）→ providerErrorRetryable=false
#[test]
fn error_stop_unknown_kind_marks_not_retryable() {
    let result = consume(
        vec![
            ProviderStreamEvent::text("部分内容"),
            ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("未知错误".to_string()),
                error_kind: Some(ProviderErrorKind::Unknown),
                usage: None,
            },
        ],
        false,
    );
    assert_eq!(
        result.stop_reason(),
        Some(ConsumeStopReason::Error {
            kind: ProviderErrorKind::Unknown,
            message: "未知错误".to_string(),
            retryable: false,
        })
    );
    assert_eq!(result.metadata["stopReason"], "error");
    assert_eq!(result.metadata["providerErrorKind"], "unknown");
    assert_eq!(result.metadata["providerErrorRetryable"], false);
}

/// D7 §3.7 向后兼容：Stop 未携带 error_kind（老注入方）→ 只标
/// providerError，不写 kind/retryable 字段（标注增量、不伪造分类）
#[test]
fn error_stop_without_kind_omits_classification_fields() {
    let result = consume(
        vec![
            ProviderStreamEvent::text("部分内容"),
            ProviderStreamEvent::stop(StopReason::Error),
        ],
        false,
    );
    assert_eq!(
        result.stop_reason(),
        Some(ConsumeStopReason::Error {
            kind: ProviderErrorKind::Unknown,
            message: "provider 流异常终止".to_string(),
            retryable: false,
        })
    );
    assert_eq!(result.metadata["stopReason"], "error");
    assert_eq!(result.metadata["providerError"], "provider 流异常终止");
    assert!(result.metadata.get("providerErrorKind").is_none());
    assert!(result.metadata.get("providerErrorRetryable").is_none());
}

/// 纯 error 无内容 → StreamError（Unknown，不可重试）
#[test]
fn pure_error_stop_yields_stream_error() {
    let result = consume(vec![ProviderStreamEvent::stop(StopReason::Error)], false);
    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("应为 StreamError，得到 {:?}", result.response);
    };
    assert_eq!(classified.kind, ProviderErrorKind::Unknown);
    assert!(!classified.retryable);
}

/// abort 有内容 → 保留部分，stopReason=aborted
#[test]
fn abort_with_content_keeps_partial_message() {
    let result = consume(vec![ProviderStreamEvent::text("已流出的部分")], true);
    assert_eq!(result.response.text(), "已流出的部分");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Aborted));
    assert_eq!(result.metadata["aborted"], true);
}

/// 空流 → Empty
#[test]
fn empty_stream_yields_empty() {
    let result = consume(Vec::<ProviderStreamEvent>::new(), false);
    assert_eq!(result.response, ProviderOutput::Empty);
}

/// stop.reason=length → Message + stopReason=length（length 阶梯输入）
#[test]
fn length_stop_yields_message_with_length() {
    let result = consume(
        vec![
            ProviderStreamEvent::text("长回复"),
            ProviderStreamEvent::stop(StopReason::Length),
        ],
        false,
    );
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Length));
}

/// tool-call 收集与正文共存
#[test]
fn tool_call_collected_at_stream_end() {
    let result = consume(
        vec![
            ProviderStreamEvent::tool_call(
                None,
                "read_file",
                serde_json::json!({"path": "/tmp/a"}),
            ),
            ProviderStreamEvent::text("调用后的话"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        false,
    );
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
    let ProviderOutput::Message { text, tool_calls } = &result.response else {
        panic!("应为 Message");
    };
    assert_eq!(text, "调用后的话");
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0].id, "call_0");
}

/// 空 id → 合成 call_0（既有行为锁定）
#[test]
fn empty_tool_call_id_generates_call_0() {
    let result = consume(
        vec![
            ProviderStreamEvent::tool_call(
                Some("".into()),
                "read_file",
                serde_json::json!({"path": "/tmp/a"}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        false,
    );
    let ProviderOutput::Message { tool_calls, .. } = &result.response else {
        panic!("应为 Message");
    };
    assert_eq!(tool_calls[0].id, "call_0", "空字符串 id 必须合成 call_0");
}

/// 纯空白 id（"   "）→ 合成 call_0（trim 后为空视为空 id）
#[test]
fn whitespace_tool_call_id_generates_call_0() {
    let result = consume(
        vec![
            ProviderStreamEvent::tool_call(
                Some("   \t".into()),
                "read_file",
                serde_json::json!({"path": "/tmp/a"}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        false,
    );
    let ProviderOutput::Message { tool_calls, .. } = &result.response else {
        panic!("应为 Message");
    };
    assert_eq!(tool_calls[0].id, "call_0", "纯空白 id 必须合成 call_0");
}

/// 合成 id 与显式 id 碰撞：显式 call_0 在场时空 id 不得再生成 call_0
///（修复前 format!("call_{}", len) 在 len=1 时生成 call_1 恰好不撞——
/// 真正碰撞场景是空 id 先到生成 call_0、显式 call_0 后到；以及多个空 id
/// 后显式 call_N 插入。本测试锁定「合成跳过已存在 id」语义）
#[test]
fn synthesized_id_skips_existing_explicit_id() {
    // 场景①：显式 call_0 先到（len=0 时不占合成位），空 id 后到
    // 修复前 len=1 → 生成 call_1（不撞）；锁定无碰撞 + id 唯一
    let result = consume(
        vec![
            ProviderStreamEvent::tool_call(Some("call_0".into()), "first", serde_json::json!({})),
            ProviderStreamEvent::tool_call(None, "second", serde_json::json!({})),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        false,
    );
    let ProviderOutput::Message { tool_calls, .. } = &result.response else {
        panic!("应为 Message");
    };
    assert_eq!(tool_calls.len(), 2);
    assert_eq!(tool_calls[0].id, "call_0", "显式 id 保留");
    assert_ne!(
        tool_calls[1].id, "call_0",
        "空 id 合成结果不得与显式 call_0 碰撞"
    );
    assert_ne!(
        tool_calls[0].id, tool_calls[1].id,
        "两条 tool-call id 必须唯一"
    );
}

/// 合成 id 跳过已存在 id（含显式插入后的空洞场景，修复前真实碰撞路径）：
/// 显式 ["call_0","call_2"] 在场时空 id 修复前生成 call_2（len=2）碰撞；
/// 修复后合成须跳到 call_3。多空 id 连续合成亦互不相同。
#[test]
fn synthesized_id_skips_existing_after_explicit_insert() {
    let result = consume(
        vec![
            // 显式 call_0 / call_2 先占位，制造合成候选 call_2 碰撞
            ProviderStreamEvent::tool_call(Some("call_0".into()), "a", serde_json::json!({})),
            ProviderStreamEvent::tool_call(Some("call_2".into()), "b", serde_json::json!({})),
            // 空 id：len=2 → 候选 call_2 已存在 → 跳到 call_3
            ProviderStreamEvent::tool_call(None, "c", serde_json::json!({})),
            ProviderStreamEvent::tool_call(Some("".into()), "d", serde_json::json!({})),
            ProviderStreamEvent::tool_call(Some("  ".into()), "e", serde_json::json!({})),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        false,
    );
    let ProviderOutput::Message { tool_calls, .. } = &result.response else {
        panic!("应为 Message");
    };
    assert_eq!(tool_calls.len(), 5);
    assert_eq!(tool_calls[0].id, "call_0", "显式 id 保留");
    assert_eq!(tool_calls[1].id, "call_2", "显式 id 保留");
    // c：候选 call_2 撞已存在 → call_3
    assert_eq!(
        tool_calls[2].id, "call_3",
        "合成 id 必须跳过已存在的 call_2"
    );
    // d：len=3 → 候选 call_3 已存在 → call_4
    assert_eq!(tool_calls[3].id, "call_4");
    // e：len=4 → 候选 call_4 已存在 → call_5
    assert_eq!(tool_calls[4].id, "call_5");
    // 全部合成 id（c/d/e）与显式 id 互不相同
    let all: std::collections::HashSet<&str> = tool_calls.iter().map(|tc| tc.id.as_str()).collect();
    assert_eq!(all.len(), 5, "五条 tool-call id 必须全部唯一");
}

/// Q33（T09.9）：reannotate_aborted——Message 正常聚合后补 aborted 标注
/// （内容保留，stopReason 改写为 aborted，原有标注不丢失）
#[test]
fn reannotate_message_sets_aborted_stop_reason() {
    let mut consumed = consume(
        vec![
            ProviderStreamEvent::text("已流出的部分"),
            ProviderStreamEvent::stop(StopReason::Length),
        ],
        false,
    );
    assert_eq!(consumed.stop_reason(), Some(ConsumeStopReason::Length));
    consumed = reannotate_aborted(consumed);
    assert_eq!(consumed.response.text(), "已流出的部分", "内容保留");
    assert_eq!(consumed.stop_reason(), Some(ConsumeStopReason::Aborted));
    assert_eq!(consumed.metadata["aborted"], true);
    // 原有标注保留（providerFinishReason 等不因补标注丢失）
    assert_eq!(consumed.metadata["providerFinishReason"], "length");
}

/// Q33（T09.9）：reannotate_aborted——Empty 无内容可抢救 → Aborted 类
/// 流错误（aborted 收场，不误入 Empty/steering 路径）
#[test]
fn reannotate_empty_becomes_aborted_error() {
    let consumed = consume(Vec::<ProviderStreamEvent>::new(), false);
    assert_eq!(consumed.response, ProviderOutput::Empty);
    let reannotated = reannotate_aborted(consumed);
    let ProviderOutput::StreamError { classified } = &reannotated.response else {
        panic!("应为 StreamError，得到 {:?}", reannotated.response);
    };
    assert_eq!(classified.kind, ProviderErrorKind::Aborted);
    assert!(!classified.retryable);
}

/// T09.1：ConsumeBuilder 增量聚合与 consume 全量等价（finish 语义一致）
#[test]
fn consume_builder_matches_consume() {
    let events = vec![
        ProviderStreamEvent::text("你"),
        ProviderStreamEvent::thought("思考", Some(true)),
        ProviderStreamEvent::text("好"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ];
    let full = consume(events.clone(), false);
    let mut builder = ConsumeBuilder::new();
    assert!(builder.is_empty(), "构建器初始为空");
    for event in events {
        builder.push(event);
        assert!(!builder.is_empty(), "push 后非空");
    }
    let incremental = builder.finish(false);
    assert_eq!(incremental, full, "增量聚合与全量聚合等价");
    assert_eq!(incremental.response.text(), "你好");
    assert!(matches!(
        incremental.stop_reason(),
        Some(ConsumeStopReason::Stop)
    ));
}

/// T09.1：ConsumeBuilder 空构建器 is_empty 判定（流中错误归属输入）
#[test]
fn consume_builder_is_empty_before_any_push() {
    let mut builder = ConsumeBuilder::new();
    assert!(builder.is_empty());
    builder.push(ProviderStreamEvent::text("x"));
    assert!(!builder.is_empty());
    let empty = ConsumeBuilder::new().finish(false);
    assert_eq!(empty.response, ProviderOutput::Empty);
}
