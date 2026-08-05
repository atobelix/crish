//! I7-M13 事件映射表冻结护栏（38 引擎事件 → 14 钩子面）
//!
//! 契约真源：docs/multi-agent-repair/improvement/reports/I7-M13-事件映射表.md
//! （I8 生态轮 E1 的 hookPayloadMap 落地的依据）。
//!
//! 本测试把映射表与两侧代码双向锁定，任何一侧不同步立即失败：
//!
//! - 映射的引擎事件必须存在于 [AgentEvent::ALL_TYPE_NAMES]（enum 变体断言）；
//! - 无对应清单 + 映射清单必须恰好划分全部引擎事件（31 = 11 + 20，无遗漏无重复）；
//! - 14 钩子名清单唯一且与 `packages/shared-types/src/hooks.ts` 的字面量一致
//!   （TS 侧 hooks.test.ts 再与 HOOK_EVENT_NAMES 类型层双向锁定）；
//! - 映射事件的背压级别（映射表「背压级别」列）与
//!   [conex_types::events::event_backpressure] 静态判定一致。
//!
//! 与 tests/registry_drift.rs 的关系：注册表护栏锁「事件 enum ↔ 注册表 JSON」，
//! 本护栏锁「事件 enum ↔ 钩子映射表」；两侧独立、互补。

use conex_types::events::event_backpressure;
use conex_types::{AgentEvent, BackpressureLevel};
use serde_json::json;
use std::collections::BTreeSet;

/// 引擎事件 → 钩子事件映射行（与 I7-M13 报告 §2 表逐行一致）
///
/// tool-end 一源双钩（tool.post / tool.error isError 分支），是本表唯一
/// 同源多钩子特例（测试 `only_tool_end_has_two_hooks` 锁定）。
const HOOK_MAPPINGS: &[(&str, &str)] = &[
    // ── 第一批接（6 个引擎事件 → 6 个钩子）──
    ("agent-start", "session.start"),
    ("run-terminal", "session.end"),
    ("turn-start", "turn.start"),
    ("turn-end", "turn.end"),
    ("tool-start", "tool.pre"),
    ("tool-end", "tool.post"),
    // ── 第二批接 ──
    ("tool-end", "tool.error"),
    ("context-compression-start", "context.compact.start"),
    ("context-compression-end", "context.compact.end"),
    ("runtime-error", "error.occurred"),
    ("subagent-started", "subagent.start"),
    ("subagent-ended", "subagent.end"),
];

/// 无对应钩子的引擎事件（事件总线消费，不进插件面；与 I7-M13 报告 §3 一致）
///
/// 分类：收场复用（agent-end）、流式消息（message-*）、工具进度与批语义、
/// 修复审计、厂商诊断、编排干预（steering）、审批（approval-*）、检查点、
/// 缓存测量（cache-*）、安全审计、子代理过程事件（subagent-event）、
/// 任务域过程事件（task-*，2026-08-04 T-AB-17 兼容新增）。
const UNMAPPED_EVENTS: &[&str] = &[
    "agent-end",
    "message-start",
    "message-delta",
    "message-end",
    "tool-update",
    "tool-batch-start",
    "tool-batch-end",
    "tool-input-repaired",
    "provider-diagnostic",
    "runtime-steering",
    "runtime-intervention-required",
    "approval-requested",
    "approval-resolved",
    "checkpoint-created",
    "checkpoint-restored",
    "cache-stats-updated",
    "cache-waste-alert",
    "cold-cache-warning",
    "security-audit",
    "subagent-event",
    // 任务域七事件（T-AB-17）：任务启停/终态/过程事件走事件总线消费，
    // 不进插件钩子面（唤醒/审计/C7 衔接在 orchestrator 域，非 E1 钩子域）
    "task-started",
    "task-output",
    "task-heartbeat",
    "task-suspicious",
    "task-completed",
    "task-failed",
    "task-killed",
];

/// 14 钩子名全集（与 packages/shared-types/src/hooks.ts 的 HOOK_EVENT_NAMES 一致；
/// 顺序冻结，改动须同步两侧与 I7-M13 报告）
const HOOK_NAMES: &[&str] = &[
    "turn.start",
    "turn.end",
    "tool.pre",
    "tool.post",
    "context.compact.start",
    "context.compact.end",
    "session.start",
    "session.end",
    "model.beforeRequest",
    "model.afterResponse",
    "subagent.start",
    "subagent.end",
    "error.occurred",
    "tool.error",
];

/// 无引擎事件源的钩子（02 方案 M14 补事件源，E1 只挂钩不补源）
const SOURCE_PENDING_HOOKS: &[&str] = &["model.beforeRequest", "model.afterResponse"];

const HOOKS_TS_PATH: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/shared-types/src/hooks.ts");

/// 映射行引用的引擎事件名（去重，保序）
fn mapped_engine_events() -> Vec<&'static str> {
    let mut seen = BTreeSet::new();
    HOOK_MAPPINGS
        .iter()
        .map(|(e, _)| *e)
        .filter(|e| seen.insert(*e))
        .collect()
}

// ── 1. 引擎事件存在性（enum 变体断言）──

#[test]
fn mapped_engine_events_exist_in_enum() {
    let registry: BTreeSet<&str> = AgentEvent::ALL_TYPE_NAMES.iter().copied().collect();
    for (event, hook) in HOOK_MAPPINGS {
        assert!(
            registry.contains(event),
            "映射表引擎事件 {event}（→ {hook}）不在 AgentEvent enum 中"
        );
    }
}

#[test]
fn unmapped_engine_events_exist_in_enum() {
    let registry: BTreeSet<&str> = AgentEvent::ALL_TYPE_NAMES.iter().copied().collect();
    for event in UNMAPPED_EVENTS {
        assert!(
            registry.contains(event),
            "无对应清单引擎事件 {event} 不在 AgentEvent enum 中"
        );
    }
}

// ── 2. 全集划分：38 = 11 映射 + 27 无对应 ──

#[test]
fn mapping_partitions_all_engine_events() {
    let registry: BTreeSet<&str> = AgentEvent::ALL_TYPE_NAMES.iter().copied().collect();
    let mapped: BTreeSet<&str> = mapped_engine_events().into_iter().collect();
    let unmapped: BTreeSet<&str> = UNMAPPED_EVENTS.iter().copied().collect();

    assert_eq!(
        mapped.len(),
        11,
        "映射引擎事件必须为 11 个（tool-end 双钩子去重）"
    );
    assert_eq!(unmapped.len(), 27, "无对应引擎事件必须为 27 个");
    assert_eq!(
        registry.len(),
        38,
        "AgentEvent enum 必须为 38 种域事件（31 基线 + T-AB-17 任务域七变体）"
    );

    let union: BTreeSet<&str> = mapped.union(&unmapped).copied().collect();
    assert_eq!(
        union,
        registry,
        "映射清单 ∪ 无对应清单 必须恰好等于全部引擎事件（38 = 11 + 27）"
    );
    let overlap: BTreeSet<&str> = mapped.intersection(&unmapped).copied().collect();
    assert!(overlap.is_empty(), "映射清单与无对应清单不得重叠：{overlap:?}");
}

// ── 3. 钩子名冻结 ──

#[test]
fn hook_names_are_frozen_14() {
    let names: BTreeSet<&str> = HOOK_NAMES.iter().copied().collect();
    assert_eq!(names.len(), 14, "14 钩子名必须唯一");
    for name in HOOK_NAMES {
        assert!(
            name.contains('.'),
            "钩子名 {name} 必须是点分命名（禁令 14）"
        );
    }
    // 补源钩子（model.beforeRequest/afterResponse）属于 14 钩子全集
    for hook in SOURCE_PENDING_HOOKS {
        assert!(
            names.contains(hook),
            "补源钩子 {hook} 必须在 14 钩子全集内"
        );
    }
}

#[test]
fn every_hook_name_has_mapping_row() {
    let mapped_hooks: BTreeSet<&str> = HOOK_MAPPINGS.iter().map(|(_, h)| *h).collect();
    let pending: BTreeSet<&str> = SOURCE_PENDING_HOOKS.iter().copied().collect();
    let covered: BTreeSet<&str> = mapped_hooks.union(&pending).copied().collect();
    let frozen: BTreeSet<&str> = HOOK_NAMES.iter().copied().collect();
    // 映射行 12 行 = 12 个不同钩子（tool-end 两行映射 tool.post/tool.error）
    assert_eq!(mapped_hooks.len(), 12, "映射行去重后必须覆盖 12 个钩子");
    // 补源钩子不在映射行内（无引擎事件源，M14 补源）
    assert!(
        mapped_hooks.is_disjoint(&pending),
        "补源钩子不得出现在映射行内（M14 补源，E1 只挂钩）"
    );
    assert_eq!(
        covered,
        frozen,
        "映射钩子 ∪ 补源钩子 必须恰好等于 14 钩子全集"
    );
}

#[test]
fn only_tool_end_has_two_hooks() {
    let mut counts: std::collections::BTreeMap<&str, Vec<&str>> =
        std::collections::BTreeMap::new();
    for (event, hook) in HOOK_MAPPINGS {
        counts.entry(event).or_default().push(hook);
    }
    for (event, hooks) in &counts {
        if *event == "tool-end" {
            assert_eq!(
                hooks,
                &vec!["tool.post", "tool.error"],
                "tool-end 必须映射 tool.post 与 tool.error 两钩子"
            );
        } else {
            assert_eq!(
                hooks.len(),
                1,
                "引擎事件 {event} 不得映射多个钩子（同源多钩子仅 tool-end 特例）"
            );
        }
    }
}

// ── 4. 背压级别列锁定（映射表「背压级别」↔ 静态判定）──

/// 按映射表构造最小样本事件（仅必填字段），供背压判定
fn sample_event(wire: &str) -> AgentEvent {
    let v = match wire {
        "agent-start" => json!({"type":"agent-start","sessionId":"s","timestamp":"t"}),
        "run-terminal" => json!({"type":"run-terminal","sessionId":"s","runId":"r","timestamp":"t","terminal":"completed"}),
        "turn-start" => json!({"type":"turn-start","sessionId":"s","turnIndex":0,"timestamp":"t"}),
        "turn-end" => json!({"type":"turn-end","sessionId":"s","turnIndex":0,"timestamp":"t","toolCallCount":0}),
        "tool-start" => json!({"type":"tool-start","sessionId":"s","batchId":"b","timestamp":"t","call":{"id":"c","toolName":"n","summary":"s","input":{},"category":"terminal","concurrency":"parallel"}}),
        "tool-end" => json!({"type":"tool-end","sessionId":"s","batchId":"b","timestamp":"t","result":{"id":"c","toolName":"n","output":{"text":"x"},"isError":false,"durationMs":1}}),
        "context-compression-start" => json!({"type":"context-compression-start","sessionId":"s","timestamp":"t","reason":"threshold","tokensBefore":100}),
        "context-compression-end" => json!({"type":"context-compression-end","sessionId":"s","timestamp":"t","aborted":false}),
        "runtime-error" => json!({"type":"runtime-error","sessionId":"s","timestamp":"t","error":"boom"}),
        "subagent-started" => json!({"type":"subagent-started","sessionId":"s","subagentId":"a","subagentRunId":"r","role":"researcher","capabilityMode":"read-only","startedAt":"t"}),
        "subagent-ended" => json!({"type":"subagent-ended","sessionId":"s","subagentId":"a","subagentRunId":"r","status":"completed","endedAt":"t"}),
        other => panic!("映射表含未登记样本的事件 {other}"),
    };
    serde_json::from_value(v).unwrap_or_else(|e| panic!("事件 {wire} 样本构造失败：{e}"))
}

#[test]
fn mapped_backpressure_annotations_match_judgement() {
    // 映射引擎事件全部为 Critical（Delta/Soft 仅 message-delta 与
    // subagent-event 的 kind 级分类，均不在映射面内）
    let mut seen = BTreeSet::new();
    for (event, hook) in HOOK_MAPPINGS {
        if !seen.insert(*event) {
            continue;
        }
        assert_eq!(
            event_backpressure(&sample_event(event)),
            BackpressureLevel::Critical,
            "映射事件 {event}（→ {hook}）背压必须是 Critical（落库不丢）"
        );
    }
}

// ── 5. 钩子名在 hooks.ts 存在（跨 TS 侧锁定）──

#[test]
fn hook_names_exist_in_hooks_ts() {
    let source = std::fs::read_to_string(HOOKS_TS_PATH)
        .unwrap_or_else(|e| panic!("读取 {HOOKS_TS_PATH} 失败：{e}"));
    for name in HOOK_NAMES {
        let literal = format!("'{name}'");
        assert!(
            source.contains(&literal),
            "钩子名 {name} 未以字面量 {literal} 出现在 hooks.ts（I7-M13 映射表契约要求 14 钩子全声明）"
        );
    }
}

// ── 6. 约束来源锚定（防映射表脱离既有轮次结论）──

#[test]
fn mapping_contract_anchors() {
    // 第一批接 6 个映射（agent-start/run-terminal/turn-start/turn-end/
    // tool-start/tool-end → session.start/session.end/turn.start/turn.end/
    // tool.pre/tool.post）：与 02 方案 M13 第一批接口径一致
    let first_batch: BTreeSet<&str> = [
        "agent-start",
        "run-terminal",
        "turn-start",
        "turn-end",
        "tool-start",
        "tool-end",
    ]
    .into_iter()
    .collect();
    let mapped: BTreeSet<&str> = mapped_engine_events().into_iter().collect();
    assert!(
        first_batch.is_subset(&mapped),
        "第一批接 6 个引擎事件必须全部在映射面内"
    );
    // 全部映射事件数量锚定（38 - 11 = 27 无对应）
    assert_eq!(
        AgentEvent::ALL_TYPE_NAMES.len() - mapped.len(),
        UNMAPPED_EVENTS.len(),
        "38 - 映射数 = 无对应数 必须成立"
    );
}
