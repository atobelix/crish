//! 事件 schema 版本化兼容测试（PE-03 T03.10 / PE-12 T12.5/T12.6）
//!
//! 覆盖：
//! - v1 golden fixture（tests/fixtures/events-v1/，58 事件每类 ≥1 条，无
//!   schemaVersion 的 v1 形状）反序列化全部成功，schemaVersion 缺省补 1；
//! - 关键字段抽查（含旧 RuntimeError `error: String` 形态）；
//! - 完整信封帧（runId/sequence）解析；
//! - 新信封序列化恒带 `schemaVersion: 1`；未来版本号透传不丢弃；
//! - 变体数一致性断言：58 == 本清单 == 33-event-schema-changelog.md v1 表登记数
//!   （新增事件类型必须同步登记 changelog + 本清单 + fixtures，T12.6 门禁；
//!   2026-08-03 P5 S3 兼容新增 cache-* 三事件，24 → 27；I2-S8 新增
//!   security-audit，27 → 28；I5-M7 新增 subagent 域三事件，28 → 31；
//!   2026-08-04 T-AB-17 任务域兼容新增七事件，31 → 38；
//!   2026-08-05 T-CF-04 定时器域兼容新增两事件，38 → 40；
//!   同日 T-CF-08 cron 域兼容新增 cron-fired，40 → 41；
//!   2026-08-11 D8 恢复域 + goal 域兼容新增 8 事件，41 → 49；
//!   2026-08-14 D-03 契约窗口：tool-input-repaired 核销删除 + 9 新观测事件，
//!   49 → 57；2026-08-16 T1a 统一输入流收敛战役协议硬约束新增 timeline-truncate，
//!   57 → 58）；
//! - 缓存测量域三变体（P5 S3 §3.1.3）serde roundtrip / camelCase / 缺省字段；
//! - 任务域七变体（T-AB-17，01 方案 §4.5 冻结契约）serde roundtrip /
//!   camelCase / 缺省字段 / 信封 schemaVersion。

use conex_types::{
    AgentEvent, AgentEventEnvelope, MissAttribution, RunCacheStats, EVENT_ENVELOPE_SCHEMA_VERSION,
};
use serde_json::{json, Value};

/// 统一 fixture 访问辅助（T11.3 golden 规范：tests/common/mod.rs 单一实现）
mod common;

/// v1 基线 58 事件类型清单（与 changelog v1 表逐条对应，PE-12 T12.6 门禁；
/// 2026-08-04 T-AB-17 任务域兼容新增七事件，31 → 38，登记于 changelog §四
/// 1.4 行；2026-08-05 T-CF-04 定时器域兼容新增两事件，38 → 40，登记于
/// changelog §四 1.5 行；同日 T-CF-08 cron 域兼容新增 cron-fired，40 → 41，
/// 登记于 changelog §四 1.6 行；2026-08-11 D8 恢复域 + goal 域兼容新增
/// 8 事件，41 → 49，登记于 changelog §四 1.9 行；2026-08-14 D-03 契约窗口
/// tool-input-repaired 核销删除 + 9 新观测事件，49 → 57，登记于 changelog
/// §四 1.10 行；2026-08-16 T1a 统一输入流收敛战役新增 timeline-truncate，
/// 57 → 58，登记于 changelog §四 1.11 行；原 `v1_baseline_has_exactly_31_event_types` /
/// `v1_baseline_has_exactly_38_event_types` / `v1_baseline_has_exactly_40_event_types` /
/// `v1_baseline_has_exactly_41_event_types` / `v1_baseline_has_exactly_57_event_types`
/// 断言随基线演进改名并同步更新——旧名即留痕，见测试体注释）
const V1_EVENT_TYPES: &[&str] = &[
    "agent-start",
    "agent-end",
    "turn-start",
    "turn-end",
    "message-start",
    "message-delta",
    "message-end",
    "tool-start",
    "tool-end",
    "tool-batch-start",
    "tool-batch-end",
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
    // 缓存测量域（P5 S3 §3.1.3 兼容新增，2026-08-03；登记于 changelog §四 1.1 行）
    "cache-stats-updated",
    "cache-waste-alert",
    "cold-cache-warning",
    // 安全审计域（I2-S8 兼容新增，2026-08-03；登记于 changelog §四 1.2 行）
    "security-audit",
    // 子代理域（I5-M7 C8 事件契约兼容新增，2026-08-03；登记于 changelog §四 1.3 行）
    "subagent-started",
    "subagent-event",
    "subagent-ended",
    // 任务域（T-AB-17 兼容新增，2026-08-04；登记于 changelog §四 1.4 行）
    "task-started",
    "task-output",
    "task-heartbeat",
    "task-suspicious",
    "task-completed",
    "task-failed",
    "task-killed",
    // 定时器域（T-CF-04 兼容新增，2026-08-05；登记于 changelog §四 1.5 行）
    "timer-fired",
    "timer-cancelled",
    // cron 域（T-CF-08 兼容新增，2026-08-05；登记于 changelog §四 1.6 行）
    "cron-fired",
    // 恢复域（D8 事件登记兼容新增，2026-08-11；登记于 changelog §四 1.9 行）
    "recovery-escalated",
    "recovery-steering",
    "recovery-fork",
    "recovery-report",
    "recovery-budget-denied",
    // goal 域（D8 事件登记兼容新增，2026-08-11；登记于 changelog §四 1.9 行）
    "goal-round-started",
    "goal-round-completed",
    "goal-continuation-decided",
    // D-03 观测补全域（契约窗口兼容新增，2026-08-14；登记于 changelog §四
    // 1.10 行；tool-input-repaired 核销删除已同步移除）
    "steering-evaluated",
    "control-intent",
    "hook-outcome",
    "summary-background",
    "stage-summary-milestone",
    "nudge-enqueued",
    "recovery-acknowledged",
    "recovery-retry-attempted",
    "provider-request-anchored",
    // 撤回域（T1a 统一输入流收敛战役兼容新增，2026-08-16；登记于 changelog
    // §四 1.11 行）
    "timeline-truncate",
];

// ── 1. 变体数一致性：49 清单 ↔ fixtures ↔ changelog ──

/// v1 基线必须为 57 事件（T1a 统一输入流收敛战役 timeline-truncate 后为 58；
/// R1 tool-update 死契约删除后 58 → 57）。
///
/// 原断言名 `v1_baseline_has_exactly_31_event_types`（2026-08-03 冻结 31
/// 事件基线）、`v1_baseline_has_exactly_38_event_types`（2026-08-04 任务域
/// 演进）、`v1_baseline_has_exactly_40_event_types`（2026-08-05 定时器域
/// 演进）与 `v1_baseline_has_exactly_41_event_types`（2026-08-05 cron 域
/// 演进）与 `v1_baseline_has_exactly_57_event_types`（2026-08-14 D-03 契约
/// 窗口净增）与 `v1_baseline_has_exactly_58_event_types`（2026-08-16 T1a
/// 新增 timeline-truncate）随基线演进改名升级——基线演进留痕：28 → 31 → 38
/// → 40 → 41 → 49 → 57 → 58（T1a 协议硬约束新增 1）→ 57（R1 tool-update
/// 死契约删除：前端零消费 + 落库语义错位，决策 1）。
#[test]
fn v1_baseline_has_exactly_57_event_types() {
    // changelog v1 表登记数 == 本清单数 == AgentEvent 变体数（57）
    assert_eq!(
        V1_EVENT_TYPES.len(),
        57,
        "v1 基线必须是 57 事件（R1 tool-update 死契约删除后）"
    );
    let unique: std::collections::HashSet<&&str> = V1_EVENT_TYPES.iter().collect();
    assert_eq!(unique.len(), 57, "清单内事件名不得重复");
}

#[test]
fn v1_fixture_files_cover_all_event_types() {
    // 每个事件类型必须有对应的 v1 golden fixture（PE-12 T12.6 步骤 1）
    for name in V1_EVENT_TYPES {
        let path = common::v1_fixture_dir().join(format!("event-{name}.json"));
        assert!(path.exists(), "缺 v1 fixture：{}", path.display());
    }
}

#[test]
fn v1_event_types_cover_all_agent_event_variants() {
    // V1_EVENT_TYPES 与 AgentEvent 全量变体逐项一致（T12.6 门禁：
    // 新增变体漏登记本清单 / 本清单超前于变体都立即失败）
    assert_eq!(
        V1_EVENT_TYPES,
        AgentEvent::ALL_TYPE_NAMES,
        "V1_EVENT_TYPES 清单必须与 AgentEvent 全部变体（声明序）一一对应"
    );
}

// ── 2. v1 旧事件解析：无 schemaVersion 缺省补 1 ──

#[test]
fn v1_fixtures_parse_and_default_schema_version_one() {
    // 全部 38 条 v1 样本（无 schemaVersion 字段）反序列化无错；
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
        assert_eq!(
            envelope, back,
            "{name}：补位 schemaVersion 后 roundtrip 保真"
        );
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
    assert!(
        event["error"].is_string(),
        "旧形态 error 必须是 String（演进锚点）"
    );
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
    assert_eq!(
        EVENT_ENVELOPE_SCHEMA_VERSION, 1,
        "当前 wire schema 版本为 1"
    );
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
    assert_eq!(
        reserialized["schemaVersion"], 1,
        "旧帧重序列化自动补 schemaVersion"
    );
    assert_eq!(reserialized["runId"], "run-1");
    assert_eq!(reserialized["sequence"], 42);
    assert_eq!(reserialized["terminal"], "completed");
}

// ── 4. 缓存测量域（P5 S3 §3.1.3）：三变体 serde 契约 ──

const TS: &str = "2026-07-31T00:00:00.000Z";

fn run_cache_stats_fixture() -> RunCacheStats {
    RunCacheStats {
        prompt_tokens: 1000,
        completion_tokens: 120,
        total_tokens: 1120,
        cache_read_tokens: 200,
        cache_write_tokens: 0,
        cache_miss_tokens: 800,
        sample_count: 1,
        hit_ratio: Some(0.2),
        write_ratio: Some(0.0),
        missed_tokens: 0,
        warm_until_ms: None,
    }
}

#[test]
fn cache_stats_updated_roundtrip_and_camel_case() {
    // cache-stats-updated：RunCacheStats 载荷 camelCase + roundtrip 保真
    let event = AgentEvent::CacheStatsUpdated {
        session_id: "s1".into(),
        timestamp: TS.into(),
        stats: run_cache_stats_fixture(),
    };
    assert_eq!(event.type_name(), "cache-stats-updated");
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["type"], "cache-stats-updated");
    let stats = &json["stats"];
    assert_eq!(stats["promptTokens"], 1000);
    assert_eq!(stats["cacheReadTokens"], 200);
    assert_eq!(stats["cacheMissTokens"], 800);
    assert_eq!(stats["sampleCount"], 1);
    assert_eq!(stats["hitRatio"], 0.2);
    assert_eq!(stats["writeRatio"], 0.0);
    // 可选字段 None 时必须省略（skip_serializing_if 纪律）
    assert!(stats.get("warmUntilMs").is_none(), "None 可选字段必须省略");
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    assert_eq!(back, event, "cache-stats-updated roundtrip 保真");
}

#[test]
fn cache_waste_alert_roundtrip_and_missed_cost_omitted_when_none() {
    // cache-waste-alert：attribution kebab-case + missedCostUsd None 省略
    let event = AgentEvent::CacheWasteAlert {
        session_id: "s1".into(),
        timestamp: TS.into(),
        attribution: MissAttribution::IdleTtlExpired,
        missed_tokens: 21_000,
        idle_ms: 360_000,
        model_changed: false,
        missed_cost_usd: None,
    };
    assert_eq!(event.type_name(), "cache-waste-alert");
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["attribution"], "idle-ttl-expired");
    assert_eq!(json["missedTokens"], 21_000);
    assert_eq!(json["idleMs"], 360_000);
    assert_eq!(json["modelChanged"], false);
    assert!(json.get("missedCostUsd").is_none(), "None 可选字段必须省略");
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    assert_eq!(back, event, "cache-waste-alert roundtrip 保真");
}

#[test]
fn cache_waste_alert_missing_cost_field_defaults_to_none() {
    // 缺省字段兼容：瘦帧无 missedCostUsd 也能解析（serde default 补 None）
    let raw = json!({
        "type": "cache-waste-alert",
        "sessionId": "s1",
        "timestamp": TS,
        "attribution": "cold",
        "missedTokens": 500,
        "idleMs": 0,
        "modelChanged": false,
    });
    let event: AgentEvent = serde_json::from_value(raw).unwrap();
    match event {
        AgentEvent::CacheWasteAlert {
            missed_cost_usd, ..
        } => {
            assert_eq!(missed_cost_usd, None, "缺省字段必须补 None");
        }
        other => panic!("type 判别错误：{}", other.type_name()),
    }
}

#[test]
fn cold_cache_warning_roundtrip_and_camel_case() {
    // cold-cache-warning：ttlSeconds/idleMs/resendEstimateTokens camelCase
    let event = AgentEvent::ColdCacheWarning {
        session_id: "s1".into(),
        timestamp: TS.into(),
        ttl_seconds: 300,
        idle_ms: 360_000,
        resend_estimate_tokens: 1000,
    };
    assert_eq!(event.type_name(), "cold-cache-warning");
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["ttlSeconds"], 300);
    assert_eq!(json["idleMs"], 360_000);
    assert_eq!(json["resendEstimateTokens"], 1000);
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    assert_eq!(back, event, "cold-cache-warning roundtrip 保真");
}

/// 变体数与 changelog 一致性的辅助断言入口：消费方（测试/CI）可遍历
/// [V1_EVENT_TYPES] 与 changelog v1 表人工勾稽（T12.8 登记 30 号清单）。
// 测试专用构造：契约勾稽辅助入口（消费方为人工/CI 遍历，测试自身不调用），
// 变体数随 changelog 演进——dead_code 静音。
#[allow(dead_code)]
fn v1_event_types() -> &'static [&'static str] {
    V1_EVENT_TYPES
}

// ── 5. 安全审计域（I2-S8）：security-audit serde 契约 ──

use conex_types::{ImpactAssessment, SecurityAuditDecision, SecurityAuditOperation};

#[test]
fn security_audit_roundtrip_and_camel_case() {
    // security-audit：operation/decision lowercase、impact 载荷 camelCase、
    // 可选字段 None 省略、runId 不占事件体（emit 层信封注入）
    let event = AgentEvent::SecurityAudit {
        session_id: "s1".into(),
        timestamp: TS.into(),
        operation: SecurityAuditOperation::Delete,
        targets: vec!["sub/a.txt".into(), "sub/b.txt".into()],
        impact: ImpactAssessment {
            file_count: 2,
            total_size_bytes: 8,
            directory_count: 1,
            cross_directory: true,
            flagged: false,
        },
        decision: SecurityAuditDecision::Redirected,
        permission_mode: None,
        tool_call_id: Some("tc-1".into()),
    };
    assert_eq!(event.type_name(), "security-audit");
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["type"], "security-audit");
    assert_eq!(json["operation"], "delete");
    assert_eq!(json["targets"][0], "sub/a.txt");
    assert_eq!(json["impact"]["fileCount"], 2);
    assert_eq!(json["impact"]["totalSizeBytes"], 8);
    assert_eq!(json["impact"]["crossDirectory"], true);
    assert_eq!(json["decision"], "redirected");
    assert_eq!(json["toolCallId"], "tc-1");
    // 可选字段 None 时必须省略（skip_serializing_if 纪律）
    assert!(
        json.get("permissionMode").is_none(),
        "None 可选字段必须省略"
    );
    // runId 属信封注入（03 §5.3-2），事件体不得携带
    assert!(json.get("runId").is_none(), "runId 不得出现在事件体");
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    assert_eq!(back, event, "security-audit roundtrip 保真");
}

#[test]
fn security_audit_decision_wire_values() {
    // 决策枚举 wire lowercase 全量锚定（blocked/approved/denied/redirected/
    // restored/purged——覆盖删除接管、审批与恢复动作三组语义）
    for (value, decision) in [
        ("blocked", SecurityAuditDecision::Blocked),
        ("approved", SecurityAuditDecision::Approved),
        ("denied", SecurityAuditDecision::Denied),
        ("redirected", SecurityAuditDecision::Redirected),
        ("restored", SecurityAuditDecision::Restored),
        ("purged", SecurityAuditDecision::Purged),
    ] {
        let parsed: SecurityAuditDecision =
            serde_json::from_value(serde_json::json!(value)).unwrap();
        assert_eq!(parsed, decision, "决策值 {value}");
        assert_eq!(
            serde_json::to_value(parsed).unwrap(),
            serde_json::json!(value),
            "决策值 {value} 回写"
        );
    }
    for (value, operation) in [
        ("delete", SecurityAuditOperation::Delete),
        ("trash-restore", SecurityAuditOperation::TrashRestore),
        ("trash-purge", SecurityAuditOperation::TrashPurge),
        ("git-revert", SecurityAuditOperation::GitRevert),
        ("command-exec", SecurityAuditOperation::CommandExec),
        (
            "remote-source-attempt",
            SecurityAuditOperation::RemoteSourceAttempt,
        ),
        (
            "remote-mode-downgrade",
            SecurityAuditOperation::RemoteModeDowngrade,
        ),
        ("remote-only", SecurityAuditOperation::RemoteOnly),
    ] {
        let parsed: SecurityAuditOperation =
            serde_json::from_value(serde_json::json!(value)).unwrap();
        assert_eq!(parsed, operation, "操作值 {value}");
        assert_eq!(
            serde_json::to_value(parsed).unwrap(),
            serde_json::json!(value),
            "操作值 {value} 回写"
        );
    }
}

#[test]
fn security_audit_missing_optional_fields_default_to_none() {
    // 缺省字段兼容：瘦帧无 permissionMode/toolCallId 也能解析
    let raw = json!({
        "type": "security-audit",
        "sessionId": "s1",
        "timestamp": TS,
        "operation": "command-exec",
        "targets": [],
        "impact": {
            "fileCount": 0,
            "totalSizeBytes": 0,
            "directoryCount": 0,
            "crossDirectory": false,
            "flagged": false,
        },
        "decision": "blocked",
    });
    let event: AgentEvent = serde_json::from_value(raw).unwrap();
    match event {
        AgentEvent::SecurityAudit {
            permission_mode,
            tool_call_id,
            ..
        } => {
            assert_eq!(permission_mode, None, "缺省 permissionMode 必须补 None");
            assert_eq!(tool_call_id, None, "缺省 toolCallId 必须补 None");
        }
        other => panic!("type 判别错误：{}", other.type_name()),
    }
}

// ── 6. 子代理域（I5-M7：C8 事件契约）serde 契约 ──

use conex_types::{SubagentEndStatus, SubagentEventKind, SubagentEventPayload};

fn subagent_started_event() -> AgentEvent {
    AgentEvent::SubagentStarted {
        session_id: "s1".into(),
        subagent_id: "sa-1".into(),
        subagent_run_id: "sr-1".into(),
        role: "researcher".into(),
        capability_mode: "readonly".into(),
        started_at: TS.into(),
        description: Some("调研子代理".into()),
        mode: Some("research".into()),
        parent_tool_call_id: Some("tc-1".into()),
        // D-02 LK-04：跨会话导航键（新帧携带）
        subagent_session_id: Some("sub-sess-1".into()),
    }
}

#[test]
fn subagent_started_roundtrip_and_camel_case() {
    // subagent-started：subagentId/subagentRunId/role/capabilityMode/startedAt
    // camelCase；description/mode/parentToolCallId 可选 None 省略；
    // runId 不占事件体（信封注入 = 父 run，ParentID 语义 01 B1-2）
    let event = subagent_started_event();
    assert_eq!(event.type_name(), "subagent-started");
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["type"], "subagent-started");
    assert_eq!(json["subagentId"], "sa-1");
    assert_eq!(json["subagentRunId"], "sr-1");
    assert_eq!(json["role"], "researcher");
    assert_eq!(json["capabilityMode"], "readonly");
    assert_eq!(json["startedAt"], TS);
    assert_eq!(json["description"], "调研子代理");
    assert_eq!(json["mode"], "research");
    assert_eq!(json["parentToolCallId"], "tc-1");
    // runId 属信封注入（03 §5.3-2），事件体不得携带
    assert!(json.get("runId").is_none(), "runId 不得出现在事件体");
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    assert_eq!(back, event, "subagent-started roundtrip 保真");

    // 可选字段 None 时必须省略（skip_serializing_if 纪律）
    let slim = serde_json::to_value(AgentEvent::SubagentStarted {
        session_id: "s1".into(),
        subagent_id: "sa-1".into(),
        subagent_run_id: "sr-1".into(),
        role: "researcher".into(),
        capability_mode: "readonly".into(),
        started_at: TS.into(),
        description: None,
        mode: None,
        parent_tool_call_id: None,
        subagent_session_id: None,
    })
    .unwrap();
    assert!(slim.get("description").is_none(), "None 可选字段必须省略");
    assert!(slim.get("mode").is_none(), "None 可选字段必须省略");
    assert!(
        slim.get("parentToolCallId").is_none(),
        "None 可选字段必须省略"
    );
    assert!(
        slim.get("subagentSessionId").is_none(),
        "None 可选字段必须省略"
    );
}

#[test]
fn subagent_event_roundtrip_and_kind_wire_values() {
    // subagent-event：event 为结构化负载（kind kebab-case + payload JsonValue）；
    // 前端 subagentHandlers.ts:38-42 把 event 对象整体透传
    for (wire, kind) in [
        ("progress", SubagentEventKind::Progress),
        ("message", SubagentEventKind::Message),
        ("tool", SubagentEventKind::Tool),
    ] {
        let parsed: SubagentEventKind = serde_json::from_value(serde_json::json!(wire)).unwrap();
        assert_eq!(parsed, kind, "kind 值 {wire}");
        assert_eq!(
            serde_json::to_value(parsed).unwrap(),
            serde_json::json!(wire),
            "kind 值 {wire} 回写"
        );
    }
    let event = AgentEvent::SubagentEvent {
        session_id: "s1".into(),
        subagent_id: "sa-1".into(),
        subagent_run_id: "sr-1".into(),
        event: SubagentEventPayload {
            kind: SubagentEventKind::Progress,
            payload: Some(json!({ "step": "reading", "percent": 40 })),
        },
    };
    assert_eq!(event.type_name(), "subagent-event");
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["subagentId"], "sa-1");
    assert_eq!(json["event"]["kind"], "progress");
    assert_eq!(json["event"]["payload"]["step"], "reading");
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    assert_eq!(back, event, "subagent-event roundtrip 保真");

    // payload 缺省兼容：瘦帧无 payload 也能解析（补 None）
    let slim = json!({
        "type": "subagent-event",
        "sessionId": "s1",
        "subagentId": "sa-1",
        "subagentRunId": "sr-1",
        "event": { "kind": "tool" },
    });
    let slim_event: AgentEvent = serde_json::from_value(slim).unwrap();
    match slim_event {
        AgentEvent::SubagentEvent { event, .. } => {
            assert_eq!(event.kind, SubagentEventKind::Tool, "kind 判别");
            assert_eq!(event.payload, None, "缺省 payload 必须补 None");
        }
        other => panic!("type 判别错误：{}", other.type_name()),
    }
}

#[test]
fn subagent_ended_roundtrip_and_status_wire_values() {
    // subagent-ended.status wire 全量锚定（completed/failed/cancelled——
    // 前端正则 /cancel|stopp?ed|abort/ 把 cancelled 映射为 stopped 展示）
    for (value, status) in [
        ("completed", SubagentEndStatus::Completed),
        ("failed", SubagentEndStatus::Failed),
        ("cancelled", SubagentEndStatus::Cancelled),
    ] {
        let parsed: SubagentEndStatus = serde_json::from_value(serde_json::json!(value)).unwrap();
        assert_eq!(parsed, status, "status 值 {value}");
        assert_eq!(
            serde_json::to_value(parsed).unwrap(),
            serde_json::json!(value),
            "status 值 {value} 回写"
        );
    }
    let event = AgentEvent::SubagentEnded {
        session_id: "s1".into(),
        subagent_id: "sa-1".into(),
        subagent_run_id: "sr-1".into(),
        status: SubagentEndStatus::Cancelled,
        summary: Some("被用户终止".into()),
        ended_at: TS.into(),
        // D-02 LK-04：跨会话导航键（新帧携带）
        subagent_session_id: Some("sub-sess-1".into()),
    };
    assert_eq!(event.type_name(), "subagent-ended");
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["status"], "cancelled");
    assert_eq!(json["summary"], "被用户终止");
    assert_eq!(json["endedAt"], TS);
    let back: AgentEvent = serde_json::from_value(json).unwrap();
    assert_eq!(back, event, "subagent-ended roundtrip 保真");

    // summary 缺省兼容：瘦帧无 summary 也能解析（补 None）
    let slim = json!({
        "type": "subagent-ended",
        "sessionId": "s1",
        "subagentId": "sa-1",
        "subagentRunId": "sr-1",
        "status": "completed",
        "endedAt": TS,
    });
    let slim_event: AgentEvent = serde_json::from_value(slim).unwrap();
    match slim_event {
        AgentEvent::SubagentEnded {
            status, summary, ..
        } => {
            assert_eq!(status, SubagentEndStatus::Completed, "status 判别");
            assert_eq!(summary, None, "缺省 summary 必须补 None");
        }
        other => panic!("type 判别错误：{}", other.type_name()),
    }
}

// ── 7. 任务域（T-AB-17：01 方案 §4.5 七事件冻结契约）serde 契约 ──

/// 任务域七事件各构造一个信封（schemaVersion=1），逐一断言：
/// 顶层 type kebab-case、payload 字段 camelCase、信封扁平注入
/// runId/schemaVersion、roundtrip 保真。
#[test]
fn task_events_envelopes_camel_case_and_schema_version_one() {
    let cases: Vec<(AgentEvent, &str, Vec<&str>)> = vec![
        (
            AgentEvent::TaskStarted {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                command: "cargo build".into(),
                cwd: "/ws".into(),
                owner_run_id: "run-main".into(),
                is_daemon: false,
            },
            "task-started",
            vec!["taskId", "command", "cwd", "ownerRunId", "isDaemon"],
        ),
        (
            AgentEvent::TaskOutput {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                line: Some("building...".into()),
                chunk: None,
                line_count: Some(42),
            },
            "task-output",
            vec!["taskId"],
        ),
        (
            AgentEvent::TaskHeartbeat {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                resource: json!({ "cpuPercent": 12.5, "rssBytes": 1024 }),
            },
            "task-heartbeat",
            vec!["taskId", "resource"],
        ),
        (
            AgentEvent::TaskSuspicious {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                silence_ms: 65_000,
                last_output_at_ms: 1_785_456_000_000,
            },
            "task-suspicious",
            vec!["taskId", "silenceMs", "lastOutputAtMs"],
        ),
        (
            AgentEvent::TaskCompleted {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                exit_code: 0,
                duration_ms: 1200,
                line_count: 99,
            },
            "task-completed",
            vec!["taskId", "exitCode", "durationMs", "lineCount"],
        ),
        (
            AgentEvent::TaskFailed {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                exit_code: 1,
                tail: vec!["最后一行".into()],
                duration_ms: 800,
            },
            "task-failed",
            vec!["taskId", "exitCode", "tail", "durationMs"],
        ),
        (
            AgentEvent::TaskKilled {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                via_force: true,
                diagnostics: Some("5s 宽限后强制终止".into()),
            },
            "task-killed",
            vec!["taskId", "viaForce", "diagnostics"],
        ),
    ];
    for (event, type_name, camel_fields) in cases {
        assert_eq!(event.type_name(), type_name, "type_name 必须为 {type_name}");
        // 信封扁平注入：runId + schemaVersion 恒 1（T-AB-17 契约：信封
        // schemaVersion 不变，恒 1；旧解析器对未知 type 静默忽略）
        let envelope = AgentEventEnvelope::new(event, Some("run-main".into()), Some(1));
        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(json["type"], type_name, "顶层 type 必须为 {type_name}");
        assert_eq!(json["runId"], "run-main", "信封 runId 扁平注入");
        assert_eq!(json["schemaVersion"], 1, "信封 schemaVersion 必须为 1");
        assert!(json.get("event").is_none(), "不得二次包装 event 键");
        for field in camel_fields {
            assert!(
                json.get(field).is_some(),
                "{type_name} 缺 camelCase 字段 {field}"
            );
        }
        // runId 属信封注入（03 §5.3-2），事件体由信封承载不占 payload 键
        // roundtrip 保真
        let back: AgentEventEnvelope = serde_json::from_value(json).unwrap();
        assert_eq!(back.type_name(), type_name, "{type_name} roundtrip 保真");
    }
}

/// task-output 的 line/chunk 二选一语义（T-AB-17 §4.5）：可选字段 None
/// 时必须省略（skip_serializing_if 纪律）；瘦帧缺省解析补 None
/// （serde default 补位，minor 兼容）。
#[test]
fn task_output_optional_fields_omitted_and_default_to_none() {
    let slim = AgentEvent::TaskOutput {
        session_id: "s1".into(),
        task_id: "t-1".into(),
        line: None,
        chunk: None,
        line_count: None,
    };
    let json = serde_json::to_value(&slim).unwrap();
    assert_eq!(json["type"], "task-output");
    assert!(json.get("line").is_none(), "None 可选字段必须省略");
    assert!(json.get("chunk").is_none(), "None 可选字段必须省略");
    assert!(json.get("lineCount").is_none(), "None 可选字段必须省略");

    let full = json!({
        "type": "task-output",
        "sessionId": "s1",
        "taskId": "t-1",
        "chunk": "二进制块",
        "lineCount": 7,
    });
    let parsed: AgentEvent = serde_json::from_value(full).unwrap();
    match parsed {
        AgentEvent::TaskOutput {
            task_id,
            line,
            chunk,
            line_count,
            ..
        } => {
            assert_eq!(task_id, "t-1");
            assert_eq!(line, None, "缺省 line 必须补 None");
            assert_eq!(chunk.as_deref(), Some("二进制块"));
            assert_eq!(line_count, Some(7));
        }
        other => panic!("type 判别错误：{}", other.type_name()),
    }
}

/// task-killed 的 diagnostics 可选：None 省略、瘦帧补 None。
#[test]
fn task_killed_diagnostics_omitted_when_none() {
    let event = AgentEvent::TaskKilled {
        session_id: "s1".into(),
        task_id: "t-1".into(),
        via_force: false,
        diagnostics: None,
    };
    let json = serde_json::to_value(&event).unwrap();
    assert!(json.get("diagnostics").is_none(), "None 可选字段必须省略");
    assert_eq!(json["viaForce"], false);

    let slim = json!({
        "type": "task-killed",
        "sessionId": "s1",
        "taskId": "t-1",
        "viaForce": true,
    });
    let parsed: AgentEvent = serde_json::from_value(slim).unwrap();
    match parsed {
        AgentEvent::TaskKilled { diagnostics, .. } => {
            assert_eq!(diagnostics, None, "缺省 diagnostics 必须补 None");
        }
        other => panic!("type 判别错误：{}", other.type_name()),
    }
}

/// 任务域七事件背压分级（T-AB-17 §4.5 表）：output/heartbeat=Delta 可丢、
/// suspicious=Soft 尽力、started/completed/failed/killed=Critical 必达——
/// 与事件注册表 backpressure 字段及 `event_backpressure` 静态判定一致
/// （registry_drift 双向锁定，本测试锚定静态判定的分级结果）。
#[test]
fn task_events_backpressure_levels() {
    use conex_types::events::event_backpressure;
    use conex_types::BackpressureLevel;
    fn started(task_id: &str) -> AgentEvent {
        AgentEvent::TaskStarted {
            session_id: "s1".into(),
            task_id: task_id.into(),
            command: "cargo build".into(),
            cwd: "/ws".into(),
            owner_run_id: "run-main".into(),
            is_daemon: false,
        }
    }
    let cases: Vec<(AgentEvent, BackpressureLevel)> = vec![
        (
            AgentEvent::TaskOutput {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                line: Some("x".into()),
                chunk: None,
                line_count: None,
            },
            BackpressureLevel::Delta,
        ),
        (
            AgentEvent::TaskHeartbeat {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                resource: json!({}),
            },
            BackpressureLevel::Delta,
        ),
        (
            AgentEvent::TaskSuspicious {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                silence_ms: 60_000,
                last_output_at_ms: 0,
            },
            BackpressureLevel::Soft,
        ),
        (started("t-1"), BackpressureLevel::Critical),
        (
            AgentEvent::TaskCompleted {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                exit_code: 0,
                duration_ms: 100,
                line_count: 1,
            },
            BackpressureLevel::Critical,
        ),
        (
            AgentEvent::TaskFailed {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                exit_code: 1,
                tail: vec![],
                duration_ms: 100,
            },
            BackpressureLevel::Critical,
        ),
        (
            AgentEvent::TaskKilled {
                session_id: "s1".into(),
                task_id: "t-1".into(),
                via_force: false,
                diagnostics: None,
            },
            BackpressureLevel::Critical,
        ),
    ];
    for (event, expected) in cases {
        assert_eq!(
            event_backpressure(&event),
            expected,
            "{} 背压分级不符",
            event.type_name()
        );
    }
}
