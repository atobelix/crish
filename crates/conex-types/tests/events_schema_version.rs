//! 事件 schema 版本化兼容测试（PE-03 T03.10 / PE-12 T12.5/T12.6）
//!
//! 覆盖：
//! - v1 golden fixture（tests/fixtures/events-v1/，24 事件每类 ≥1 条，无
//!   schemaVersion 的 v1 形状）反序列化全部成功，schemaVersion 缺省补 1；
//! - 关键字段抽查（含旧 RuntimeError `error: String` 形态）；
//! - 完整信封帧（runId/sequence）解析；
//! - 新信封序列化恒带 `schemaVersion: 1`；未来版本号透传不丢弃；
//! - 变体数一致性断言：24 == 本清单 == 33-event-schema-changelog.md v1 表登记数
//!   （新增事件类型必须同步登记 changelog + 本清单 + fixtures，T12.6 门禁）。

use conex_types::{AgentEventEnvelope, EVENT_ENVELOPE_SCHEMA_VERSION};
use serde_json::{json, Value};

/// 统一 fixture 访问辅助（T11.3 golden 规范：tests/common/mod.rs 单一实现）
mod common;

/// v1 基线 24 事件类型清单（与 changelog v1 表逐条对应，PE-12 T12.6 门禁）
const V1_EVENT_TYPES: &[&str] = &[
    "agent-start",
    "agent-end",
    "turn-start",
    "turn-end",
    "message-start",
    "message-delta",
    "message-end",
    "tool-start",
    "tool-update",
    "tool-end",
    "tool-batch-start",
    "tool-batch-end",
    "tool-input-repaired",
    "context-compression-start",
    "context-compression-end",
    "provider-diagnostic",
    "runtime-error",
    "runtime-steering",
    "runtime-intervention-required",
    "approval-requested",
    "approval-resolved",
    "checkpoint-created",
    "checkpoint-restored",
    "run-terminal",
];

// ── 1. 变体数一致性：24 清单 ↔ fixtures ↔ changelog ──

#[test]
fn v1_baseline_has_exactly_24_event_types() {
    // changelog v1 表登记数 == 本清单数 == AgentEvent 变体数（24）
    assert_eq!(
        V1_EVENT_TYPES.len(),
        24,
        "v1 基线必须是 24 事件（与 changelog 登记数一致）"
    );
    let unique: std::collections::HashSet<&&str> = V1_EVENT_TYPES.iter().collect();
    assert_eq!(unique.len(), 24, "清单内事件名不得重复");
}

#[test]
fn v1_fixture_files_cover_all_24_event_types() {
    // 每个事件类型必须有对应的 v1 golden fixture（PE-12 T12.6 步骤 1）
    for name in V1_EVENT_TYPES {
        let path = common::v1_fixture_dir().join(format!("event-{name}.json"));
        assert!(path.exists(), "缺 v1 fixture：{}", path.display());
    }
}

// ── 2. v1 旧事件解析：无 schemaVersion 缺省补 1 ──

#[test]
fn v1_fixtures_parse_and_default_schema_version_one() {
    // 全部 24 条 v1 样本（无 schemaVersion 字段）反序列化无错；
    // schemaVersion 缺省视为 1（旧帧向后兼容），type_name 与文件一一对应
    for name in V1_EVENT_TYPES {
        let raw = common::v1_fixture(name);
        let envelope: AgentEventEnvelope =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("解析 v1 样本 {name} 失败：{e}"));
        assert_eq!(
            envelope.schema_version, 1,
            "{name}：无 schemaVersion 的旧帧必须缺省为 1"
        );
        assert_eq!(
            envelope.type_name(),
            *name,
            "{name}：fixture 文件名与事件类型名必须一致"
        );
        // 升级读后重序列化再解析，roundtrip 保真（补位后的 schema_version 恒 1）
        let reserialized = serde_json::to_string(&envelope).unwrap();
        let back: AgentEventEnvelope = serde_json::from_str(&reserialized).unwrap();
        assert_eq!(envelope, back, "{name}：补位 schemaVersion 后 roundtrip 保真");
    }
}

#[test]
fn old_runtime_error_string_form_parses() {
    // 首个 major 变更候选（PE-04 R4/T04.3-3）的 v1 形态：
    // RuntimeError.error 为字符串（String），演进为 CrishError 前必须可解析
    let envelope: AgentEventEnvelope =
        serde_json::from_str(&common::v1_fixture("runtime-error")).unwrap();
    assert_eq!(envelope.type_name(), "runtime-error");
    let event = serde_json::to_value(&envelope.event).unwrap();
    assert_eq!(event["error"], "provider failed", "v1 的 error 是字符串");
    assert!(event["error"].is_string(), "旧形态 error 必须是 String（演进锚点）");
    assert_eq!(event["retryable"], true);
    assert_eq!(event["sessionId"], "s1");
}

#[test]
fn v1_fixture_key_fields_anchored() {
    // 抽查：message-delta 的硬依赖字段（03 §5.1-4/5）
    let delta: AgentEventEnvelope =
        serde_json::from_str(&common::v1_fixture("message-delta")).unwrap();
    let d = serde_json::to_value(&delta.event).unwrap();
    assert_eq!(d["messageId"], "m1");
    assert_eq!(d["block"]["type"], "text");
    assert_eq!(d["block"]["text"], "hello");

    // 抽查：run-terminal 的事件体 runId（03 §5.1-16）
    let terminal: AgentEventEnvelope =
        serde_json::from_str(&common::v1_fixture("run-terminal")).unwrap();
    let t = serde_json::to_value(&terminal.event).unwrap();
    assert_eq!(t["terminal"], "completed");
    assert_eq!(t["runId"], "run-1");
}

// ── 3. 信封帧与 schemaVersion 语义 ──

#[test]
fn complete_frame_with_runid_sequence_parses() {
    // v1 完整信封帧：带 runId/sequence、无 schemaVersion（PE-12 T12.6 步骤 1）
    let envelope: AgentEventEnvelope =
        serde_json::from_str(&common::fixture("events-v1/frame-with-runid-sequence.json")).unwrap();
    assert_eq!(envelope.run_id.as_deref(), Some("run-1"));
    assert_eq!(envelope.sequence, Some(42));
    assert_eq!(envelope.schema_version, 1);
    assert_eq!(envelope.type_name(), "run-terminal");
    let event = serde_json::to_value(&envelope.event).unwrap();
    assert_eq!(event["terminal"], "completed");
    assert_eq!(event["runId"], "run-1", "事件体 runId 与信封注入值一致");
}

#[test]
fn minimal_old_frame_without_envelope_keys_parses() {
    // 极简旧帧：只有 type + 事件字段（连 runId/sequence 都没有）也能解析
    let raw = json!({
        "type": "agent-start",
        "sessionId": "s1",
        "timestamp": "2026-07-31T00:00:00.000Z",
    });
    let envelope: AgentEventEnvelope = serde_json::from_value(raw).unwrap();
    assert_eq!(envelope.run_id, None);
    assert_eq!(envelope.sequence, None);
    assert_eq!(envelope.schema_version, 1, "缺 schemaVersion 必须缺省为 1");
}

#[test]
fn new_envelope_serializes_schema_version_one() {
    // 新信封序列化恒带 schemaVersion: 1（PE-12 T12.5 验收口径）
    assert_eq!(EVENT_ENVELOPE_SCHEMA_VERSION, 1, "当前 wire schema 版本为 1");
    let envelope = AgentEventEnvelope::new(
        serde_json::from_value(json!({
            "type": "agent-end",
            "sessionId": "s1",
            "timestamp": "2026-07-31T00:00:00.000Z",
            "reason": "stop",
        }))
        .unwrap(),
        Some("run-1".into()),
        Some(1),
    );
    let json = serde_json::to_value(&envelope).unwrap();
    assert_eq!(json["schemaVersion"], 1, "信封序列化必须注入 schemaVersion");
    // 与 runId/sequence 同层扁平注入，不二次包装
    assert!(json.get("event").is_none());
    assert_eq!(json["type"], "agent-end");
}

#[test]
fn future_schema_version_passes_through() {
    // 未来 major 帧（schemaVersion=2）解析不报错、版本号不丢弃——
    // 是否支持由消费端按 changelog 决策，本层只保证透传
    let raw = json!({
        "type": "run-terminal",
        "runId": "run-9",
        "sequence": 9,
        "schemaVersion": 2,
        "sessionId": "s1",
        "timestamp": "2026-07-31T00:00:00.000Z",
        "terminal": "completed",
    });
    let envelope: AgentEventEnvelope = serde_json::from_value(raw).unwrap();
    assert_eq!(envelope.schema_version, 2);
}

#[test]
fn upgrade_on_read_reserializes_with_schema_version() {
    // 升级读语义：旧帧解析后（schema_version=1）再序列化会带上
    // schemaVersion: 1 —— wire 形状自然升级，双端 golden 无需迁移
    let envelope: AgentEventEnvelope =
        serde_json::from_str(&common::fixture("events-v1/frame-with-runid-sequence.json")).unwrap();
    let reserialized: Value = serde_json::to_value(&envelope).unwrap();
    assert_eq!(reserialized["schemaVersion"], 1, "旧帧重序列化自动补 schemaVersion");
    assert_eq!(reserialized["runId"], "run-1");
    assert_eq!(reserialized["sequence"], 42);
    assert_eq!(reserialized["terminal"], "completed");
}

/// 变体数与 changelog 一致性的辅助断言入口：消费方（测试/CI）可遍历
/// [V1_EVENT_TYPES] 与 changelog v1 表人工勾稽（T12.8 登记 30 号清单）。
#[allow(dead_code)]
fn v1_event_types() -> &'static [&'static str] {
    V1_EVENT_TYPES
}
