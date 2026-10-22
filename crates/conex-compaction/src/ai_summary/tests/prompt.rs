use super::*;

use conex_types::ToolCallBlock;

use crate::ai_summary::{
    build_summarize_prompt, is_acceptable_summary, is_degenerate_summary, push_critical_context,
};

// ── 摘要提示词 ──

/// COMPACTION-01 P1-C：提示词已对齐 Schema V1 JSON 契约——12 个
/// required 字段点名在场（引擎校验单轨 JSON，忠实输出不再被拒）；
/// 丢弃消息上下文 + 迭代合并 + thought 不入提示保持原语义
#[test]
fn summarize_prompt_contains_schema_json_instruction_and_dropped_context() {
    let dropped = vec![
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-04T10:00:00.000Z",
            vec![text_block("实现压缩模块")],
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:01.000Z",
            vec![
                text_block("已完成"),
                AgentMessageBlock::ToolCall(ToolCallBlock {
                    id: "t1".to_string(),
                    tool_name: "read_file".to_string(),
                    input: serde_json::json!({"path": "src/lib.rs"}),
                }),
            ],
        ),
    ];
    let prompt = build_summarize_prompt(&flat(&dropped), Some("OLD SUMMARY"));
    // Schema V1 12 required 字段点名在场（与引擎校验单轨一致）
    for field in crate::summary_document::SUMMARY_REQUIRED_FIELDS {
        assert!(prompt.contains(field), "提示词须点名 required 字段 {field}");
    }
    // 丢弃消息上下文 + 迭代合并
    assert!(prompt.contains("实现压缩模块"));
    assert!(prompt.contains("read_file"));
    assert!(prompt.contains("OLD SUMMARY"));
    assert!(prompt.contains("既有摘要"));
    // thought 块不入提示
    let thought = amsg(
        "a2",
        AgentMessageRole::Assistant,
        "2026-08-04T10:00:02.000Z",
        vec![AgentMessageBlock::Thought {
            text: "内部思考过程".to_string(),
            redacted: None,
        }],
    );
    let prompt = build_summarize_prompt(&[(*thought).clone()], None);
    assert!(!prompt.contains("内部思考过程"));
}

// ── 退化判定 ──

#[test]
fn degenerate_summary_detection_threshold() {
    assert!(is_degenerate_summary("", 500));
    assert!(is_degenerate_summary("   ", 500));
    assert!(is_degenerate_summary(&"短".repeat(499), 500));
    assert!(!is_degenerate_summary(&"长".repeat(500), 500));
    // 可配下限
    assert!(is_degenerate_summary("abc", 10));
    assert!(!is_degenerate_summary("abc", 2));
}

/// 可接受性：字符达标的任意文本可用；合法 Schema V1 JSON 文档
/// 同样可用（COMPACTION-01 P1-C：引擎契约单轨 JSON 后不得被字符
/// 下限误杀）
#[test]
fn acceptable_summary_accepts_valid_template_and_schema_json() {
    // Schema V1 JSON：短而完整（12 required 字段）不得被字符下限拒绝
    let json = serde_json::json!({
        "schemaVersion": 1,
        "blockId": "summary",
        "generation": 1,
        "droppedIds": [],
        "height": 1,
        "tier": "chunk",
        "goal": "短会话",
        "constraints": [],
        "progress": [],
        "decisions": [],
        "nextSteps": [],
        "criticalContext": [],
    })
    .to_string();
    assert!(
        is_degenerate_summary(&json, 500),
        "极短 JSON 文档应被判退化（字符口径）"
    );
    assert!(
        is_acceptable_summary(&json, 500),
        "合法 Schema V1 JSON 文档必须可接受"
    );
    assert!(!is_acceptable_summary("", 500));
    assert!(!is_acceptable_summary("退化", 500));
    assert!(is_acceptable_summary(&"长".repeat(500), 500));
}

#[test]
fn test_push_critical_context_array_strings() {
    let doc = serde_json::json!({
        "criticalContext": [
            "crates/conex-compaction/src/tokens.rs",
            "enforce_tool_batch_closure",
            "ERR_CONTEXT_OVERFLOW"
        ]
    });
    let mut out = String::new();
    push_critical_context(&mut out, &doc);
    assert_eq!(
        out,
        "- crates/conex-compaction/src/tokens.rs\n- enforce_tool_batch_closure\n- ERR_CONTEXT_OVERFLOW\n"
    );
}

#[test]
fn test_push_critical_context_array_objects() {
    let doc = serde_json::json!({
        "criticalContext": [
            { "path": "src/main.rs", "error": "timeout" },
            { "command": "cargo test", "exitCode": "1" }
        ]
    });
    let mut out = String::new();
    push_critical_context(&mut out, &doc);
    assert!(
        out.contains("- path: src/main.rs, error: timeout\n")
            || out.contains("- error: timeout, path: src/main.rs\n")
    );
    assert!(out.contains("command: cargo test"));
}

#[test]
fn test_push_critical_context_top_level_object() {
    let doc = serde_json::json!({
        "criticalContext": {
            "failedPath": "src/lib.rs:42",
            "status": "failed"
        }
    });
    let mut out = String::new();
    push_critical_context(&mut out, &doc);
    assert!(out.contains("- failedPath: src/lib.rs:42\n"));
    assert!(out.contains("- status: failed\n"));
}

#[test]
fn test_push_critical_context_multiline_string() {
    let doc = serde_json::json!({
        "criticalContext": "src/lib.rs:100\n- error: already formatted\nsymbol: tokenize"
    });
    let mut out = String::new();
    push_critical_context(&mut out, &doc);
    assert_eq!(
        out,
        "- src/lib.rs:100\n- error: already formatted\n- symbol: tokenize\n"
    );
}

#[test]
fn test_push_critical_context_empty_and_missing() {
    let mut out = String::new();
    push_critical_context(&mut out, &serde_json::json!({}));
    assert!(out.is_empty());

    let mut out = String::new();
    push_critical_context(&mut out, &serde_json::json!({ "criticalContext": [] }));
    assert!(out.is_empty());

    let mut out = String::new();
    push_critical_context(&mut out, &serde_json::json!({ "criticalContext": "" }));
    assert!(out.is_empty());
}
