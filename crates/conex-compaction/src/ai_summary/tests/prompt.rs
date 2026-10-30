use super::*;

use conex_types::ToolCallBlock;

use crate::ai_summary::{build_summarize_prompt, is_acceptable_summary, is_degenerate_summary};
use crate::summary_document::{validate_summary_document, SummaryDocument};

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
    // Schema V1 required 字段点名在场（字段清单由强类型序列化键派生，
    // 与引擎校验单轨一致）
    let sample: SummaryDocument = validate_summary_document(
        r#"{"schemaVersion":1,"blockId":"summary","generation":1,"droppedIds":[],"height":1,"tier":"chunk","goal":"","constraints":[],"progress":[],"decisions":[],"nextSteps":[],"criticalContext":[]}"#,
        4096,
    )
    .expect("基准文档合法");
    for field in serde_json::to_value(&sample)
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
    {
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
