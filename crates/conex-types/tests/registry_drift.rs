//! 事件注册表漂移护栏（R3 T6 契约生成链路）
//!
//! 唯一事实源：crates/conex-types/src/events.rs 的 [AgentEvent] enum 及
//! message/tool 模块的载荷结构（serde 属性即 wire 规范）。注册表文件
//! contracts/engine-events.json 是给生成脚本（scripts/generate-engine-bindings.mjs）
//! 的机器可读导出，本测试把注册表与 Rust 侧真实 serde 行为双向锁定：
//!
//! - 事件清单：注册表 59 个 type 名与顺序 == [AgentEvent::ALL_TYPE_NAMES]
//!   （enum 声明顺序，编号 1-59 连续；2026-08-05 T-CF-04 定时器域兼容新增
//!   timer-fired/timer-cancelled，38 → 40；同日 T-CF-08 cron 域兼容新增
//!   cron-fired，40 → 41；2026-08-11 任务连续性方案恢复域 + goal 域兼容
//!   新增 8 变体（recovery-* ×5 + goal-* ×3），41 → 49；
//!   2026-08-14 D-03 契约窗口：tool-input-repaired 核销删除 + 9 新观测事件
//!   （steering-evaluated 等，全 Delta 可丢级），49 → 57；
//!   2026-08-16 统一输入流收敛战役 T1a：timeline-truncate 追加 58、
//!   R1 tool-update 死契约删除回落 57；
//!   2026-11-02 BG3 后台结果回注兼容新增 tool-backgrounded / tool-settled，
//!   57 → 59）；
//! - 事件字段：按注册表必填字段构造样本 → 反序列化为 [AgentEvent] →
//!   回序列化，断言必填字段全部在场、且无注册表外字段（字段名漂移即失败）；
//! - 载荷结构：同一模式逐类型回环（struct + tagged enum 全变体）；
//! - 枚举：注册表值逐项反序列化并回写一致 + 变体数锁定；
//! - 背压分级（I5-M7）：每事件 backpressure 字段与
//!   [conex_types::events::event_backpressure] 双向锁定，subagent-event 的
//!   kindBackpressure 与 [conex_types::events::subagent_event_kind_backpressure]
//!   双向锁定（分类静态可判定，04 报告 1e）；
//! - 可达性：注册表内所有 types/enums 必须被事件（或其载荷）传递引用，
//!   禁止注册表塞入与事件链路无关的死条目。
//!
//! 任何一侧改动不同步（改 enum 不更新注册表 / 改注册表不匹配 serde），
//! `cargo test -p conex-types` 立即失败。

use conex_types::error::ProviderErrorKind;
use conex_types::events::{
    AgentEvent, ApprovalDecision, BackpressureLevel, MissAttribution, PermissionRequest,
    RunCacheStats, RunTerminalStatus, SecurityAuditDecision, SecurityAuditOperation,
    SubagentEndStatus, SubagentEventKind, SubagentEventPayload, TimelineTruncateReason,
    ToolMetadata, ToolSettledStatus,
};
use conex_types::impact::ImpactAssessment;
use conex_types::message::{
    AgentMessage, AgentMessageBlock, AgentMessageMetadataKind, AgentMessageRole, ImageContentBlock,
    ToolCallBlock,
};
use conex_types::session::AgentEndReason;
use conex_types::tool::{
    CompressionCacheInvalidation, ContextCompressionCacheBoundaryMetadata,
    ContextCompressionHandoffMetadata, ContextCompressionPolicyAction,
    ContextCompressionPolicyMetadata, ContextCompressionPolicyTier, ContextCompressionReason,
    ContextCompressionRecord, ContextCompressionTrigger,
};
use conex_types::tool::{
    ProviderDiagnostic, ProviderDiagnosticPhase, RuntimeCheckpointKind, RuntimeCheckpointRecord,
    RuntimeCheckpointRestoreRecord, SystemPromptWireMode, ToolArtifact, ToolArtifactKind,
    ToolBatchCall, ToolBatchResult, ToolCategory, ToolConcurrency, ToolOutput,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Map, Value};

/// 注册表 JSON 结构（与 contracts/engine-events.json 逐字段对应）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    contract: String,
    schema_version: u32,
    event_count: u32,
    events: Vec<EventSpec>,
    types: std::collections::BTreeMap<String, TypeSpec>,
    enums: std::collections::BTreeMap<String, EnumSpec>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventSpec {
    id: u32,
    #[serde(rename = "type")]
    wire: String,
    rust_variant: String,
    domain: String,
    fields: Vec<FieldSpec>,
    /// 背压级别（I5-M7：delta/soft/critical，静态可判定）
    backpressure: String,
    /// 持久化决策（D-04 PC-05：是否落库；与 backpressure 正交——
    /// 同背压可不同持久化，三决策不同构）
    persist: bool,
    /// 桥丢帧优先级（D-04 PC-05：soft/critical；缓冲层水位语义）
    bridge_priority: String,
    /// kind 级背压映射（仅 subagent-event 登记：progress=delta、message/tool=soft）
    kind_backpressure: Option<std::collections::BTreeMap<String, String>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldSpec {
    name: String,
    #[serde(rename = "type")]
    ts_type: String,
    required: bool,
    /// F8-07：整数字段标记（number 字段必须显式声明 true/false；
    /// 注册表当前全部未声明 → 漂移测试红，待引擎登记）
    #[serde(default)]
    integer: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum TypeSpec {
    Struct {
        fields: Vec<FieldSpec>,
    },
    Tagged {
        tag: String,
        variants: Vec<VariantSpec>,
    },
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VariantSpec {
    name: String,
    fields: Vec<FieldSpec>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnumSpec {
    wire: String,
    values: Vec<String>,
}

fn registry() -> Registry {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/contracts/engine-events.json");
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("读取事件注册表 {path} 失败：{e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("解析事件注册表失败：{e}"))
}

fn fields_of(spec: &TypeSpec) -> &[FieldSpec] {
    match spec {
        TypeSpec::Struct { fields } => fields,
        TypeSpec::Tagged { .. } => panic!("调用方应区分 tagged 类型"),
    }
}

/// 按注册表类型引用构造最小样本 JSON（只填必填字段）
fn sample_value(reg: &Registry, ty: &str) -> Value {
    if let Some(inner) = ty.strip_suffix("[]") {
        return Value::Array(vec![sample_value(reg, inner)]);
    }
    match ty {
        "string" => Value::String("x".into()),
        "number" => Value::from(0),
        "boolean" => Value::Bool(false),
        "JsonValue" => Value::Null,
        _ => {
            if let Some(spec) = reg.enums.get(ty) {
                let first = spec
                    .values
                    .first()
                    .unwrap_or_else(|| panic!("枚举 {ty} 不能为空"));
                return Value::String(first.clone());
            }
            match reg.types.get(ty) {
                Some(TypeSpec::Struct { fields }) => {
                    let mut obj = Map::new();
                    for f in fields.iter().filter(|f| f.required) {
                        obj.insert(f.name.clone(), sample_value(reg, &f.ts_type));
                    }
                    Value::Object(obj)
                }
                Some(TypeSpec::Tagged { tag, variants }) => {
                    let v = variants
                        .first()
                        .unwrap_or_else(|| panic!("tagged 类型 {ty} 不能没有变体"));
                    let mut obj = Map::new();
                    obj.insert(tag.clone(), Value::String(v.name.clone()));
                    for f in v.fields.iter().filter(|f| f.required) {
                        obj.insert(f.name.clone(), sample_value(reg, &f.ts_type));
                    }
                    Value::Object(obj)
                }
                None => panic!("注册表引用了未知类型 {ty}"),
            }
        }
    }
}

fn build_event_sample(reg: &Registry, ev: &EventSpec) -> Value {
    let mut obj = Map::new();
    // serde tagged enum 需要顶层 type 判别字段（AgentEvent 的 serde tag）
    obj.insert("type".to_string(), Value::String(ev.wire.clone()));
    for f in ev.fields.iter().filter(|f| f.required) {
        obj.insert(f.name.clone(), sample_value(reg, &f.ts_type));
    }
    Value::Object(obj)
}

/// 回环校验：样本 → 反序列化 → 回序列化，断言必填字段在场且无注册表外字段。
fn check_roundtrip<T: Serialize + DeserializeOwned>(
    rust_name: &str,
    fields: &[FieldSpec],
    sample: Value,
) {
    let parsed: T = serde_json::from_value(sample)
        .unwrap_or_else(|e| panic!("{rust_name} 按注册表样本反序列化失败：{e}"));
    let out = serde_json::to_value(&parsed).unwrap();
    let obj = out
        .as_object()
        .unwrap_or_else(|| panic!("{rust_name} 序列化结果必须是对象"));
    for f in fields.iter().filter(|f| f.required) {
        assert!(
            obj.contains_key(&f.name),
            "{rust_name} 序列化缺少注册表必填字段 {}",
            f.name
        );
    }
    for k in obj.keys() {
        assert!(
            fields.iter().any(|f| &f.name == k),
            "{rust_name} 序列化出注册表外字段 {k}"
        );
    }
}

// ── 1. 事件清单与编号 ──

#[test]
fn registry_event_types_match_enum_declaration_order() {
    let reg = registry();
    assert_eq!(
        reg.contract, "engine-events",
        "注册表契约名必须为 engine-events"
    );
    assert_eq!(reg.schema_version, 1);
    assert_eq!(reg.event_count, 59);
    assert_eq!(
        reg.events.len(),
        59,
        "事件注册表必须是 59 条（BG3 后台结果回注新增两事件）"
    );
    assert_eq!(
        AgentEvent::ALL_TYPE_NAMES.len(),
        59,
        "AgentEvent enum 必须是 59 种域事件（BG3 后台结果回注新增两事件）"
    );
    for (i, ev) in reg.events.iter().enumerate() {
        assert_eq!(ev.id as usize, i + 1, "事件编号必须从 1 连续递增");
        assert_eq!(
            ev.wire,
            AgentEvent::ALL_TYPE_NAMES[i],
            "注册表第 {} 条 type 与 enum 声明顺序不一致",
            i + 1
        );
        // rustVariant 必须是对应 enum 变体名（生成器依赖该命名产 TS 类型名）
        assert_eq!(
            ev.rust_variant,
            type_name_guess(&ev.wire),
            "rustVariant 与 wire 不一致：{}",
            ev.wire
        );
        // 每个事件都必须登记 domain（域归属，供生成器与前端路由使用）
        assert!(!ev.domain.is_empty(), "事件 {} 缺 domain 字段", ev.wire);
        // 每个事件都必须携带 sessionId 且必填（协议硬约束，03 §5.1）；
        // 例外：goal-* 三事件（envelope 事件不列 sessionId 变体字段——
        // 会话归属在事件行 session_id 列，读侧信封已含，02-定夺 B2/S9 约定）
        if matches!(
            ev.wire.as_str(),
            "goal-round-started" | "goal-round-completed" | "goal-continuation-decided"
        ) {
            assert!(
                ev.fields.iter().all(|f| f.name != "sessionId"),
                "goal-* 事件 {} 不得登记 sessionId 变体字段（B2/S9 约定）",
                ev.wire
            );
        } else {
            let session = ev
                .fields
                .iter()
                .find(|f| f.name == "sessionId")
                .unwrap_or_else(|| panic!("事件 {} 缺 sessionId 字段", ev.wire));
            assert!(session.required, "事件 {} 的 sessionId 必须必填", ev.wire);
        }
        // 每个事件都必须标注背压级别（I5-M7：静态可判定，04 报告 1e）
        assert!(
            matches!(ev.backpressure.as_str(), "delta" | "soft" | "critical"),
            "事件 {} 的 backpressure 非法：{}",
            ev.wire,
            ev.backpressure
        );
        // 每个事件都必须标注桥丢帧优先级（D-04 PC-05：soft/critical，
        // 缓冲层水位语义；与 event_policy 三字段双向锁定）
        assert!(
            matches!(ev.bridge_priority.as_str(), "soft" | "critical"),
            "事件 {} 的 bridgePriority 非法：{}",
            ev.wire,
            ev.bridge_priority
        );
        // persist 为 bool 由 serde 强校验（缺字段/非布尔即解析失败）；
        // 决策表语义断言见 event_policy_table_drift_locked 双向锁定
        // kindBackpressure 只允许 subagent-event 登记
        if ev.wire != "subagent-event" {
            assert!(
                ev.kind_backpressure.is_none(),
                "事件 {} 不应登记 kindBackpressure（仅 subagent-event 允许）",
                ev.wire
            );
        }
    }
    // subagent-event 必须带 kind 级背压映射（覆盖 SubagentEventKind 全值）
    let subagent_event = reg
        .events
        .iter()
        .find(|e| e.wire == "subagent-event")
        .expect("注册表必须有 subagent-event");
    let kb = subagent_event
        .kind_backpressure
        .as_ref()
        .expect("subagent-event 必须登记 kindBackpressure");
    let kind_enum = &reg.enums["SubagentEventKind"];
    assert_eq!(
        kb.len(),
        kind_enum.values.len(),
        "kindBackpressure 必须覆盖 SubagentEventKind 全值"
    );
    for value in &kind_enum.values {
        assert!(
            matches!(
                kb.get(value).map(String::as_str),
                Some("delta" | "soft" | "critical")
            ),
            "kindBackpressure[{}] 非法或缺失",
            value
        );
    }
}

/// wire 名 → Rust 变体名（PascalCase 拼接，仅用于上述断言）
fn type_name_guess(wire: &str) -> String {
    wire.split('-')
        .map(|part| {
            let mut c = part.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

// ── 2. 事件字段与 serde 行为锁定 ──

#[test]
fn event_fields_match_serde_wire_for_all_events() {
    let reg = registry();
    for ev in &reg.events {
        let sample = build_event_sample(&reg, ev);
        let parsed: AgentEvent = serde_json::from_value(sample)
            .unwrap_or_else(|e| panic!("事件 {} 按注册表样本反序列化失败：{e}", ev.wire));
        let out = serde_json::to_value(&parsed).unwrap();
        let obj = out.as_object().unwrap();
        assert_eq!(
            obj.get("type"),
            Some(&Value::String(ev.wire.clone())),
            "事件 {} 顶层 type 不符",
            ev.wire
        );
        for f in ev.fields.iter().filter(|f| f.required) {
            assert!(
                obj.contains_key(&f.name),
                "事件 {} 序列化缺少必填字段 {}",
                ev.wire,
                f.name
            );
        }
        for k in obj.keys() {
            if k == "type" {
                continue;
            }
            assert!(
                ev.fields.iter().any(|f| &f.name == k),
                "事件 {} 序列化出注册表外字段 {k}",
                ev.wire
            );
        }
    }
}

// ── 3. 载荷结构与 serde 行为锁定 ──

fn check_payload_struct(reg: &Registry, rust_name: &str) {
    let spec = reg
        .types
        .get(rust_name)
        .unwrap_or_else(|| panic!("注册表缺载荷类型 {rust_name}"));
    let fields = fields_of(spec);
    let sample = sample_value(reg, rust_name);
    match rust_name {
        "AgentMessage" => check_roundtrip::<AgentMessage>(rust_name, fields, sample),
        "ToolCallBlock" => check_roundtrip::<ToolCallBlock>(rust_name, fields, sample),
        "ToolOutput" => check_roundtrip::<ToolOutput>(rust_name, fields, sample),
        "ToolArtifact" => check_roundtrip::<ToolArtifact>(rust_name, fields, sample),
        "ToolBatchCall" => check_roundtrip::<ToolBatchCall>(rust_name, fields, sample),
        "ToolBatchResult" => check_roundtrip::<ToolBatchResult>(rust_name, fields, sample),
        "ProviderDiagnostic" => check_roundtrip::<ProviderDiagnostic>(rust_name, fields, sample),
        "RuntimeCheckpointRecord" => {
            check_roundtrip::<RuntimeCheckpointRecord>(rust_name, fields, sample)
        }
        "RuntimeCheckpointRestoreRecord" => {
            check_roundtrip::<RuntimeCheckpointRestoreRecord>(rust_name, fields, sample)
        }
        "ToolMetadata" => check_roundtrip::<ToolMetadata>(rust_name, fields, sample),
        "PermissionRequest" => check_roundtrip::<PermissionRequest>(rust_name, fields, sample),
        "ContextCompressionPolicyMetadata" => {
            check_roundtrip::<ContextCompressionPolicyMetadata>(rust_name, fields, sample)
        }
        "ContextCompressionHandoffMetadata" => {
            check_roundtrip::<ContextCompressionHandoffMetadata>(rust_name, fields, sample)
        }
        "ContextCompressionCacheBoundaryMetadata" => {
            check_roundtrip::<ContextCompressionCacheBoundaryMetadata>(rust_name, fields, sample)
        }
        "ContextCompressionRecord" => {
            check_roundtrip::<ContextCompressionRecord>(rust_name, fields, sample)
        }
        "RunCacheStats" => check_roundtrip::<RunCacheStats>(rust_name, fields, sample),
        "ImpactAssessment" => check_roundtrip::<ImpactAssessment>(rust_name, fields, sample),
        "SubagentEventPayload" => {
            check_roundtrip::<SubagentEventPayload>(rust_name, fields, sample)
        }
        "TurnUsage" => check_roundtrip::<TurnUsage>(rust_name, fields, sample),
        other => panic!("注册表含未接入漂移检查的载荷类型 {other}"),
    }
}

#[test]
fn payload_structs_match_serde_wire() {
    let reg = registry();
    for (name, spec) in &reg.types {
        // tagged 载荷（AgentMessageBlock）由专门的变体回环测试覆盖
        if matches!(spec, TypeSpec::Tagged { .. }) {
            continue;
        }
        check_payload_struct(&reg, name);
    }
}

#[test]
fn tagged_message_block_all_variants_match_serde_wire() {
    let reg = registry();
    let spec = reg
        .types
        .get("AgentMessageBlock")
        .expect("注册表必须含 AgentMessageBlock");
    let TypeSpec::Tagged { tag, variants } = spec else {
        panic!("AgentMessageBlock 必须是 tagged 类型");
    };
    assert_eq!(tag, "type");
    for v in variants {
        let mut obj = Map::new();
        obj.insert(tag.clone(), Value::String(v.name.clone()));
        for f in v.fields.iter().filter(|f| f.required) {
            obj.insert(f.name.clone(), sample_value(&reg, &f.ts_type));
        }
        let parsed: AgentMessageBlock = serde_json::from_value(Value::Object(obj))
            .unwrap_or_else(|e| panic!("AgentMessageBlock.{:?} 反序列化失败：{e}", v.name));
        let out = serde_json::to_value(&parsed).unwrap();
        let out_obj = out.as_object().unwrap();
        assert_eq!(out_obj.get("type"), Some(&Value::String(v.name.clone())));
        for f in v.fields.iter().filter(|f| f.required) {
            assert!(
                out_obj.contains_key(&f.name),
                "AgentMessageBlock.{:?} 序列化缺少必填字段 {}",
                v.name,
                f.name
            );
        }
        for k in out_obj.keys() {
            if k == "type" {
                continue;
            }
            assert!(
                v.fields.iter().any(|f| &f.name == k),
                "AgentMessageBlock.{:?} 序列化出注册表外字段 {k}",
                v.name
            );
        }
    }
}

// ── 4. 枚举值锁定 ──

macro_rules! check_enum {
    ($reg:expr, $name:literal, $ty:ty, $expected:expr) => {
        let spec = &$reg.enums[$name];
        assert!(
            spec.wire == "lowercase" || spec.wire == "kebab-case",
            "枚举 {}.{} 的 wire 声明非法：{}",
            stringify!($name),
            stringify!($ty),
            spec.wire
        );
        assert_eq!(
            spec.values.len(),
            $expected,
            "枚举 {}.{} 注册表值数与变体数不一致",
            stringify!($name),
            stringify!($ty)
        );
        for v in &spec.values {
            let parsed: $ty = serde_json::from_value(Value::String(v.clone()))
                .unwrap_or_else(|e| panic!("枚举 {} 值 {v} 反序列化失败：{e}", $name));
            assert_eq!(
                serde_json::to_value(parsed).unwrap(),
                Value::String(v.clone()),
                "枚举 {} 值 {v} 回写不一致",
                $name
            );
        }
    };
}

#[test]
fn enum_values_match_serde_wire() {
    let reg = registry();
    check_enum!(reg, "AgentMessageRole", AgentMessageRole, 4);
    check_enum!(reg, "AgentEndReason", AgentEndReason, 5);
    check_enum!(reg, "RunTerminalStatus", RunTerminalStatus, 3);
    check_enum!(reg, "ApprovalDecision", ApprovalDecision, 3);
    check_enum!(reg, "ToolCategory", ToolCategory, 7);
    check_enum!(reg, "ToolConcurrency", ToolConcurrency, 3);
    check_enum!(reg, "ToolArtifactKind", ToolArtifactKind, 5);
    check_enum!(reg, "ProviderDiagnosticPhase", ProviderDiagnosticPhase, 11);
    check_enum!(reg, "SystemPromptWireMode", SystemPromptWireMode, 2);
    check_enum!(reg, "ProviderErrorKind", ProviderErrorKind, 13);
    check_enum!(reg, "RuntimeCheckpointKind", RuntimeCheckpointKind, 3);
    check_enum!(
        reg,
        "ContextCompressionTrigger",
        ContextCompressionTrigger,
        10
    );
    check_enum!(reg, "ContextCompressionReason", ContextCompressionReason, 8);
    check_enum!(
        reg,
        "ContextCompressionPolicyTier",
        ContextCompressionPolicyTier,
        5
    );
    check_enum!(
        reg,
        "ContextCompressionPolicyAction",
        ContextCompressionPolicyAction,
        2
    );
    check_enum!(
        reg,
        "CompressionCacheInvalidation",
        CompressionCacheInvalidation,
        4
    );
    check_enum!(reg, "MissAttribution", MissAttribution, 8);
    check_enum!(reg, "SecurityAuditOperation", SecurityAuditOperation, 9);
    check_enum!(reg, "SecurityAuditDecision", SecurityAuditDecision, 6);
    check_enum!(reg, "SubagentEventKind", SubagentEventKind, 3);
    check_enum!(reg, "SubagentEndStatus", SubagentEndStatus, 3);
    // 统一输入流收敛战役 T1a：timeline-truncate.reason + AgentMessage.metadata.kind
    check_enum!(reg, "TimelineTruncateReason", TimelineTruncateReason, 2);
    // I1-α④ 补位（主控裁决）：+ ToolPromiseRecovery / + GoalContinue，5 → 7
    check_enum!(reg, "AgentMessageMetadataKind", AgentMessageMetadataKind, 7);
    // BG3 后台结果回注（2026-11-02）：tool-settled.status 四值与注册表
    // 终态子集 1:1
    check_enum!(reg, "ToolSettledStatus", ToolSettledStatus, 4);
}

/// 事件总数仍为 59：`operation` 是 security-audit 载荷内的字段值
/// （SecurityAuditOperation 枚举），不是独立事件类型——新增 operation
/// 值不改变事件清单；本测试锚定「注册表值 ↔ serde 行为」双向不漂移。
#[test]
fn security_audit_undeclared_write_operation_stays_in_sync() {
    let reg = registry();
    // 事件总数保持 59（operation 值是载荷内字段，非独立事件类型；
    // 2026-08-04 T-AB-17 任务域兼容新增七事件，31 → 38；
    // 2026-08-05 T-CF-04 定时器域兼容新增两事件，38 → 40；
    // 同日 T-CF-08 cron 域兼容新增 cron-fired，40 → 41；
    // 2026-08-11 D8 恢复域 + goal 域兼容新增 8 事件，41 → 49；
    // 2026-08-14 D-03 契约窗口：tool-input-repaired 核销删除 + 9 新观测
    // 事件，49 → 57；2026-08-16 统一输入流收敛战役 T1a：timeline-truncate，
    // 57 → 58；同日 R1 tool-update 死契约删除，58 → 57；
    // 2026-11-02 BG3 后台结果回注兼容新增两事件，57 → 59）
    assert_eq!(reg.event_count, 59, "新增 operation 值不得改变事件总数");
    assert_eq!(reg.events.len(), 59);

    // 注册表必须登记 undeclared-write（T-ESC-02 新值）
    let spec = &reg.enums["SecurityAuditOperation"];
    assert!(
        spec.values.contains(&"undeclared-write".to_string()),
        "注册表 SecurityAuditOperation 必须登记 undeclared-write：{:?}",
        spec.values
    );

    // wire 值双向一致（serde rename 锁定）
    let parsed: SecurityAuditOperation =
        serde_json::from_value(Value::String("undeclared-write".into()))
            .unwrap_or_else(|e| panic!("undeclared-write 反序列化失败：{e}"));
    assert_eq!(parsed, SecurityAuditOperation::UndeclaredWrite);
    assert_eq!(
        serde_json::to_value(parsed).unwrap(),
        Value::String("undeclared-write".into()),
        "undeclared-write 回写不一致"
    );
}

// ── 5. 可达性：注册表不允许死条目 ──

#[test]
fn registry_entries_are_reachable_from_events() {
    let reg = registry();
    // 从 49 事件出发做传递闭包；JsonValue/string/number/boolean 为基元。
    let mut reachable: std::collections::BTreeSet<String> = reg
        .events
        .iter()
        .flat_map(|e| e.fields.iter())
        .map(|f| f.ts_type.clone())
        .collect();
    let mut queue: Vec<String> = reachable.iter().cloned().collect();
    while let Some(ty) = queue.pop() {
        if let Some(inner) = ty.strip_suffix("[]") {
            let inner = inner.to_string();
            if reachable.insert(inner.clone()) {
                queue.push(inner);
            }
            continue;
        }
        if matches!(ty.as_str(), "string" | "number" | "boolean" | "JsonValue") {
            continue;
        }
        if reg.enums.contains_key(&ty) {
            continue;
        }
        if let Some(spec) = reg.types.get(&ty) {
            let names: Vec<String> = match spec {
                TypeSpec::Struct { fields } => fields.iter().map(|f| f.ts_type.clone()).collect(),
                TypeSpec::Tagged { variants, .. } => variants
                    .iter()
                    .flat_map(|v| v.fields.iter())
                    .map(|f| f.ts_type.clone())
                    .collect(),
            };
            for n in names {
                if reachable.insert(n.clone()) {
                    queue.push(n);
                }
            }
            continue;
        }
        panic!("注册表类型引用指向未定义条目：{ty}");
    }
    for name in reg.types.keys() {
        assert!(
            reachable.contains(name),
            "注册表载荷类型 {name} 未被任何事件传递引用（死条目）"
        );
    }
    // 例外登记（统一输入流收敛战役 T1a）：AgentMessageMetadataKind 是
    // `AgentMessage.metadata.kind` 的来源标记常量集——`metadata` 字段保持
    // JsonValue（详案-T1 §1.3：不改字段类型），故枚举位**结构上不被任何字段
    // ts_type 引用**，而是经生成常量 AGENT_MESSAGE_METADATA_KIND_VALUES 暴露
    // 给前端。此处显式把它视为可达，避免误判为死条目。
    reachable.insert("AgentMessageMetadataKind".to_string());
    for name in reg.enums.keys() {
        assert!(
            reachable.contains(name),
            "注册表枚举 {name} 未被任何事件传递引用（死条目）"
        );
    }
    // 每个事件必填字段引用的类型必须可达（防必填字段引用了 JsonValue 语义的拼写错误）
    for ev in &reg.events {
        for f in &ev.fields {
            if !f.required {
                continue;
            }
            assert!(
                reachable.contains(&f.ts_type),
                "事件 {} 必填字段 {} 的类型 {} 不可达",
                ev.wire,
                f.name,
                f.ts_type
            );
        }
    }
}

// ── 5.5 F8-07：整数字段元数据锁——number 字段必须显式声明 integer，
//      非整数字段（Rust f64：比率/金额）白名单锁定，防「浮点→整数」
//      语义漂移（生成 parser 依赖此标记引入整数校验）──

#[test]
fn registry_integer_markers_lock_fractional_whitelist() {
    let reg = registry();
    let mut unmarked: Vec<(String, String)> = Vec::new();
    let mut fractional: Vec<(String, String)> = Vec::new();
    let mut check_fields = |where_: &str, fields: &[FieldSpec]| {
        for f in fields {
            if f.ts_type == "number" || f.ts_type == "number[]" {
                match f.integer {
                    Some(true) => {}
                    Some(false) => fractional.push((where_.to_string(), f.name.clone())),
                    None => unmarked.push((where_.to_string(), f.name.clone())),
                }
            }
        }
    };
    for ev in &reg.events {
        check_fields(&ev.wire, &ev.fields);
    }
    for (name, spec) in &reg.types {
        match spec {
            TypeSpec::Struct { fields } => check_fields(name, fields),
            TypeSpec::Tagged { variants, .. } => {
                for v in variants {
                    check_fields(&format!("{name}.{}", v.name), &v.fields);
                }
            }
        }
    }
    assert!(
        unmarked.is_empty(),
        "number 字段必须显式声明 integer 标记（生成 parser 整数校验依赖）：{unmarked:?}"
    );
    // Rust 侧 f64 白名单（比率/金额字段）：hitRatio / writeRatio / missedCostUsd
    let mut whitelist: Vec<(String, String)> = vec![
        ("RunCacheStats".to_string(), "hitRatio".to_string()),
        ("RunCacheStats".to_string(), "writeRatio".to_string()),
        ("cache-waste-alert".to_string(), "missedCostUsd".to_string()),
    ];
    // 顺序无关（遍历序 = 事件先于类型）：排序后集合比较
    fractional.sort();
    whitelist.sort();
    assert_eq!(
        fractional, whitelist,
        "非整数字段集合必须与 Rust f64 白名单一致（新增浮点字段需同步登记）"
    );
}

// ── 6. 信封帧（emit 层注入 runId/sequence/schemaVersion）与事件体并存 ──

#[test]
fn envelope_wire_fields_are_separate_from_event_body() {
    // runId/sequence/schemaVersion 属信封（emit 层注入），不得进入事件体注册表
    let reg = registry();
    // 特例：run-terminal 与 timeline-truncate 事件体自带 runId（03 §5.1-16；
    // 详案-T1 §1.2(a) timeline-truncate 对齐 run-terminal 先例），其余事件
    // 不得把信封 runId/sequence/schemaVersion 登记为事件体字段
    let body_run_id_events = ["run-terminal", "timeline-truncate"];
    for ev in &reg.events {
        let carries_body_run_id = body_run_id_events.contains(&ev.wire.as_str());
        for f in &ev.fields {
            assert_ne!(
                f.name, "sequence",
                "事件 {} 不应把信封 sequence 登记为事件体字段",
                ev.wire
            );
            assert_ne!(
                f.name, "schemaVersion",
                "事件 {} 不应把信封 schemaVersion 登记为事件体字段",
                ev.wire
            );
            if !carries_body_run_id {
                assert_ne!(
                    f.name, "runId",
                    "事件 {} 不应把信封 runId 登记为事件体字段",
                    ev.wire
                );
            }
        }
        if carries_body_run_id {
            assert!(
                ev.fields.iter().any(|f| f.name == "runId" && f.required),
                "事件 {} 必须登记必填 runId",
                ev.wire
            );
        }
    }
    // 样本构造覆盖全量事件时，run-terminal / timeline-truncate 的 runId 必须
    // 能被 serde 接受（事件体自带 runId，信封注入同值覆盖）
    for wire in body_run_id_events {
        let ev = reg
            .events
            .iter()
            .find(|e| e.wire == wire)
            .unwrap_or_else(|| panic!("注册表必须有 {wire}"));
        let sample = build_event_sample(&reg, ev);
        let parsed: AgentEvent = serde_json::from_value(sample)
            .unwrap_or_else(|e| panic!("{wire} 注册表样本反序列化失败：{e}"));
        let out = serde_json::to_value(&parsed).unwrap();
        assert_eq!(out["runId"], json!("x"), "{wire} 事件体 runId 应存在");
    }
}

// ── 7. 背压三级分类（I5-M7：注册表 backpressure 字段 ↔ Rust 判定函数双向锁定）──

use conex_types::events::{event_backpressure, subagent_event_kind_backpressure};

/// 每事件背压分级：注册表 backpressure 字段与 Rust 静态判定函数一致
/// （分类静态可判定，不许运行时拍脑袋——04 报告 1e / 02 方案 M7 内容 3）
#[test]
fn backpressure_level_matches_rust_judgement_for_all_events() {
    let reg = registry();
    for ev in &reg.events {
        let sample = build_event_sample(&reg, ev);
        let parsed: AgentEvent = serde_json::from_value(sample)
            .unwrap_or_else(|e| panic!("事件 {} 按注册表样本反序列化失败：{e}", ev.wire));
        let expected = match ev.backpressure.as_str() {
            "delta" => BackpressureLevel::Delta,
            "soft" => BackpressureLevel::Soft,
            "critical" => BackpressureLevel::Critical,
            other => panic!("事件 {} 注册表 backpressure 非法：{other}", ev.wire),
        };
        assert_eq!(
            event_backpressure(&parsed),
            expected,
            "事件 {} 的背压分级与注册表不一致",
            ev.wire
        );
    }
}

/// subagent-event kind 级背压：kindBackpressure 映射与 Rust kind 判定函数
/// 一致（progress=Delta 可丢、message/tool=Soft 尽力）
#[test]
fn subagent_event_kind_backpressure_matches_registry() {
    let reg = registry();
    let ev = reg
        .events
        .iter()
        .find(|e| e.wire == "subagent-event")
        .expect("注册表必须有 subagent-event");
    let kb = ev
        .kind_backpressure
        .as_ref()
        .expect("kindBackpressure 必须存在");
    for (kind, expected) in [
        (SubagentEventKind::Progress, BackpressureLevel::Delta),
        (SubagentEventKind::Message, BackpressureLevel::Soft),
        (SubagentEventKind::Tool, BackpressureLevel::Soft),
    ] {
        let wire = serde_json::to_value(kind).unwrap();
        let level = serde_json::to_value(expected).unwrap();
        let wire_str = wire.as_str().unwrap();
        assert_eq!(
            kb.get(wire_str).map(String::as_str),
            Some(level.as_str().unwrap()),
            "kindBackpressure[{}] 与 Rust kind 判定不一致",
            wire_str
        );
        assert_eq!(
            subagent_event_kind_backpressure(kind),
            expected,
            "kind {wire_str} 的 Rust 背压判定不符"
        );
    }
}

/// 分级语义锚定（防分级漂移破坏既有语义）：
/// - message-delta 保持 Delta（既有非持久化语义，buffer.rs 先例）；
/// - subagent-started / subagent-ended 为 Critical（必达落库）；
/// - subagent-event 基级为 Delta（progress 类可丢），kind 级再分 message/tool=Soft；
/// - 任务域（T-AB-17，01 方案 §4.5 表）：task-output/task-heartbeat=Delta
///   （可丢不落库）、task-suspicious=Soft（尽力投递留痕）、task-started/
///   task-completed/task-failed/task-killed=Critical（终态必达落库）；
/// - 定时器域（T-CF-04，02-CF §4.7 表）：timer-fired=Critical（数据面必达
///   落库）、timer-cancelled=Soft（早退命中/显式取消，尽力投递）；
/// - cron 域（T-CF-08，02-CF §4.7 表）：cron-fired=Critical（数据面必达落库）；
/// - 终态/审批/审计等既有关键事件保持 Critical（不改变既有丢帧语义）。
#[test]
fn backpressure_classification_semantics_anchored() {
    let reg = registry();
    let level_of = |wire: &str| {
        reg.events
            .iter()
            .find(|e| e.wire == wire)
            .unwrap_or_else(|| panic!("注册表缺事件 {wire}"))
            .backpressure
            .clone()
    };
    assert_eq!(
        level_of("message-delta"),
        "delta",
        "message-delta 必须保持 Delta（可丢）"
    );
    assert_eq!(
        level_of("subagent-started"),
        "critical",
        "subagent-started 必达"
    );
    assert_eq!(
        level_of("subagent-ended"),
        "critical",
        "subagent-ended 必达"
    );
    assert_eq!(
        level_of("subagent-event"),
        "delta",
        "subagent-event 基级为 Delta"
    );
    // 任务域七事件分级锚定（T-AB-17 §4.5 冻结契约，防分级漂移）
    assert_eq!(
        level_of("task-output"),
        "delta",
        "task-output 为 Delta（可丢不落库）"
    );
    assert_eq!(
        level_of("task-heartbeat"),
        "delta",
        "task-heartbeat 为 Delta（可丢不落库）"
    );
    assert_eq!(
        level_of("task-suspicious"),
        "soft",
        "task-suspicious 为 Soft（尽力投递留痕）"
    );
    for wire in [
        "task-started",
        "task-completed",
        "task-failed",
        "task-killed",
    ] {
        assert_eq!(
            level_of(wire),
            "critical",
            "任务事件 {wire} 为 Critical（终态必达落库）"
        );
    }
    // 定时器域两事件分级锚定（T-CF-04 §4.7 冻结契约，防分级漂移）
    assert_eq!(
        level_of("timer-fired"),
        "critical",
        "timer-fired 为 Critical（数据面必达落库）"
    );
    assert_eq!(
        level_of("timer-cancelled"),
        "soft",
        "timer-cancelled 为 Soft（尽力投递）"
    );
    // cron 域事件分级锚定（T-CF-08 §4.7 冻结契约，防分级漂移）
    assert_eq!(
        level_of("cron-fired"),
        "critical",
        "cron-fired 为 Critical（数据面必达落库）"
    );
    // 既有关键事件全部保持 Critical（对齐 buffer.rs drop_class_of：非 delta 全 Critical）
    for wire in [
        "agent-start",
        "agent-end",
        "message-end",
        "tool-end",
        "run-terminal",
        "approval-requested",
        "approval-resolved",
        "checkpoint-created",
        "checkpoint-restored",
        "security-audit",
    ] {
        assert_eq!(
            level_of(wire),
            "critical",
            "事件 {wire} 必须保持 Critical（既有语义）"
        );
    }
}

// ── 7.5 三字段双向锁定（D-04 PC-05：单一分类函数 event_policy 三值 ==
//      注册表三字段（backpressure / persist / bridgePriority）；分类唯一
//      事实源，消灭 event_class / event_backpressure / drop_class_of 多套
//      分类漂移；消费方（orchestrator is_non_persistent / buffer drop_class_of）
//      迁移后经本测试同步锁定）──

use conex_types::events::{event_policy, DropClass, EventPolicy, PersistenceDecision};

/// 全事件域（49 类）三决策双向锁定：event_policy(event) 三值逐事件 ==
/// 注册表三字段（backpressure / persist / bridgePriority）
#[test]
fn event_policy_table_drift_locked() {
    let reg = registry();
    for ev in &reg.events {
        let sample = build_event_sample(&reg, ev);
        let parsed: AgentEvent = serde_json::from_value(sample)
            .unwrap_or_else(|e| panic!("事件 {} 按注册表样本反序列化失败：{e}", ev.wire));
        let policy = event_policy(&parsed);
        // backpressure 双向锁定
        let expected_bp = match ev.backpressure.as_str() {
            "delta" => BackpressureLevel::Delta,
            "soft" => BackpressureLevel::Soft,
            "critical" => BackpressureLevel::Critical,
            other => panic!("事件 {} 注册表 backpressure 非法：{other}", ev.wire),
        };
        assert_eq!(
            policy.backpressure, expected_bp,
            "事件 {} 的背压分级与注册表不一致",
            ev.wire
        );
        // persist 双向锁定
        let expected_persist = if ev.persist {
            PersistenceDecision::Persist
        } else {
            PersistenceDecision::NoPersist
        };
        assert_eq!(
            policy.persist, expected_persist,
            "事件 {} 的持久化决策与注册表不一致",
            ev.wire
        );
        // bridgePriority 双向锁定
        let expected_bridge = match ev.bridge_priority.as_str() {
            "soft" => DropClass::Soft,
            "critical" => DropClass::Critical,
            other => panic!("事件 {} 注册表 bridgePriority 非法：{other}", ev.wire),
        };
        assert_eq!(
            policy.bridge_priority, expected_bridge,
            "事件 {} 的桥丢帧优先级与注册表不一致",
            ev.wire
        );
    }
}

/// 定案表逐行显式断言（D-04 §3.3：漂移清零后的定案表，PC-05/PC-01/PC-02
/// 共用——关键行：task-output=Delta+NoPersist+Critical（增量不落库）、
/// message-delta=Delta+NoPersist+Soft（唯一桥可丢）、run-terminal=
/// Critical+Persist+Critical（终态必达落库）、timer/cron 仅实时轨等）
#[test]
fn event_policy_decision_table_rows_anchored() {
    use conex_types::events::{
        BackpressureLevel as Bp, DropClass as Dc, PersistenceDecision as Pd,
    };
    let reg = registry();
    let policy_of = |wire: &str| -> EventPolicy {
        let ev = reg
            .events
            .iter()
            .find(|e| e.wire == wire)
            .unwrap_or_else(|| panic!("注册表缺事件 {wire}"));
        let sample = build_event_sample(&reg, ev);
        let parsed: AgentEvent = serde_json::from_value(sample)
            .unwrap_or_else(|e| panic!("事件 {wire} 按注册表样本反序列化失败：{e}"));
        event_policy(&parsed)
    };
    // 行 = (wire, backpressure, persist, bridge_priority)
    let rows: &[(&str, Bp, Pd, Dc)] = &[
        ("message-delta", Bp::Delta, Pd::NoPersist, Dc::Soft),
        ("task-output", Bp::Delta, Pd::NoPersist, Dc::Critical),
        ("task-heartbeat", Bp::Delta, Pd::NoPersist, Dc::Critical),
        ("task-suspicious", Bp::Soft, Pd::NoPersist, Dc::Critical),
        ("timer-fired", Bp::Critical, Pd::NoPersist, Dc::Critical),
        ("cron-fired", Bp::Critical, Pd::NoPersist, Dc::Critical),
        ("timer-cancelled", Bp::Soft, Pd::NoPersist, Dc::Critical),
        ("task-started", Bp::Critical, Pd::Persist, Dc::Critical),
        ("task-completed", Bp::Critical, Pd::Persist, Dc::Critical),
        ("task-failed", Bp::Critical, Pd::Persist, Dc::Critical),
        ("task-killed", Bp::Critical, Pd::Persist, Dc::Critical),
        ("run-terminal", Bp::Critical, Pd::Persist, Dc::Critical),
        (
            "approval-requested",
            Bp::Critical,
            Pd::Persist,
            Dc::Critical,
        ),
        ("message-end", Bp::Critical, Pd::Persist, Dc::Critical),
    ];
    for (wire, bp, persist, bridge) in rows {
        let policy = policy_of(wire);
        assert_eq!(
            policy.backpressure, *bp,
            "定案表行 {wire} backpressure 不符"
        );
        assert_eq!(policy.persist, *persist, "定案表行 {wire} persist 不符");
        assert_eq!(
            policy.bridge_priority, *bridge,
            "定案表行 {wire} bridgePriority 不符"
        );
    }
}

/// subagent-event kind 级三决策（D-04 PC-05）：progress=Delta+NoPersist+
/// Critical（可丢增量不落库）、message/tool=Soft+Persist+Critical（尽力
/// 落库，既有 is_non_persistent 语义保持——orchestrator 测试锚点）
#[test]
fn subagent_event_policy_kind_level_decisions() {
    let sample = |kind: SubagentEventKind| AgentEvent::SubagentEvent {
        session_id: "s1".into(),
        subagent_id: "sub-1".into(),
        subagent_run_id: "sr-1".into(),
        event: SubagentEventPayload {
            kind,
            payload: None,
        },
    };
    let progress = event_policy(&sample(SubagentEventKind::Progress));
    assert_eq!(progress.backpressure, BackpressureLevel::Delta);
    assert_eq!(progress.persist, PersistenceDecision::NoPersist);
    assert_eq!(progress.bridge_priority, DropClass::Critical);
    for kind in [SubagentEventKind::Message, SubagentEventKind::Tool] {
        let policy = event_policy(&sample(kind));
        assert_eq!(policy.backpressure, BackpressureLevel::Soft);
        assert_eq!(policy.persist, PersistenceDecision::Persist);
        assert_eq!(policy.bridge_priority, DropClass::Critical);
    }
}

// ── 8. 定时器域（T-CF-04：02-CF 方案 §4.1/§4.7 冻结契约）──

/// timer-fired 背压必须为 Critical（02-CF §4.7 表：必达落库——数据面，
/// AI 实际唤醒走 steering 面，事件与唤醒解耦）
#[test]
fn timer_fired_backpressure_is_critical() {
    let event = AgentEvent::TimerFired {
        session_id: "s1".into(),
        timer_id: "timer-1".into(),
        prompt: "检查编译".into(),
        fired_at_ms: 1_785_456_600_000,
    };
    assert_eq!(event_backpressure(&event), BackpressureLevel::Critical);
}

/// timer-cancelled 背压必须为 Soft（02-CF §4.7 表：尽力投递——早退命中/
/// 显式取消的通知，可丢弃重发）
#[test]
fn timer_cancelled_backpressure_is_soft() {
    let event = AgentEvent::TimerCancelled {
        session_id: "s1".into(),
        timer_id: "timer-1".into(),
        reason: "early-exit".into(),
        cancelled_at_ms: 1_785_456_600_000,
    };
    assert_eq!(event_backpressure(&event), BackpressureLevel::Soft);
}

/// 累计基线 41 → 49（任务连续性方案 D8 事件登记）：两枚定时器事件
/// 按 enum 声明序登记为 37/38（timer-fired=critical、timer-cancelled=soft；
/// 2026-08-14 D-03 契约窗口 tool-input-repaired 核销前移为 38/39，
/// 2026-08-16 R1 tool-update 死契约删除再前移为 37/38），
/// cron-fired 由 T-CF-08（F9 轮）登记为 39（原 41 → 40 → 39），恢复域 +
/// goal 域 8 事件由 D8（2026-08-11）登记为 40-47（原 42-49 → 41-48 →
/// 40-47，见
/// [registry_drift_cron_fired_registered] 与
/// [registry_drift_recovery_and_goal_events_registered]）。
#[test]
fn registry_drift_timer_events_registered() {
    let reg = registry();
    // 累计基线：38 → 40 → 41 → 49 → 57 → 58 → 57 → 59（D-03 契约窗口：
    // tool-input-repaired 核销 + 9 新观测事件已登记；T1a 统一输入流收敛战役
    // 追加 timeline-truncate；R1 tool-update 死契约删除回落 57；BG3 后台
    // 结果回注兼容新增两事件升至 59）
    assert_eq!(
        reg.event_count, 59,
        "累计基线必须为 59（BG3 后台结果回注新增两事件）"
    );
    assert_eq!(reg.events.len(), 59);
    assert_eq!(
        AgentEvent::ALL_TYPE_NAMES.len(),
        59,
        "AgentEvent enum 变体数必须为 59"
    );

    // timer-fired（37）：Critical 必达落库，字段 sessionId/timerId/prompt/firedAtMs
    let fired = reg
        .events
        .iter()
        .find(|e| e.wire == "timer-fired")
        .expect("注册表必须登记 timer-fired");
    assert_eq!(
        fired.id, 37,
        "timer-fired 编号必须为 37（声明序，R1 tool-update 删除前移）"
    );
    assert_eq!(fired.rust_variant, "TimerFired");
    assert_eq!(fired.domain, "timer", "timer-fired 必须归属 timer 域");
    assert_eq!(
        fired.backpressure, "critical",
        "timer-fired 必须为 Critical（必达落库）"
    );
    assert!(
        fired.kind_backpressure.is_none(),
        "timer-fired 不得登记 kindBackpressure"
    );
    let fired_fields: Vec<&str> = fired.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        fired_fields,
        vec!["sessionId", "timerId", "prompt", "firedAtMs"],
        "timer-fired 字段形状与 §4.7 不符"
    );

    // timer-cancelled（38）：Soft 尽力投递，字段 sessionId/timerId/reason/cancelledAtMs
    let cancelled = reg
        .events
        .iter()
        .find(|e| e.wire == "timer-cancelled")
        .expect("注册表必须登记 timer-cancelled");
    assert_eq!(
        cancelled.id, 38,
        "timer-cancelled 编号必须为 38（声明序，R1 tool-update 删除前移）"
    );
    assert_eq!(cancelled.rust_variant, "TimerCancelled");
    assert_eq!(
        cancelled.domain, "timer",
        "timer-cancelled 必须归属 timer 域"
    );
    assert_eq!(
        cancelled.backpressure, "soft",
        "timer-cancelled 必须为 Soft（尽力投递）"
    );
    assert!(
        cancelled.kind_backpressure.is_none(),
        "timer-cancelled 不得登记 kindBackpressure"
    );
    let cancelled_fields: Vec<&str> = cancelled.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        cancelled_fields,
        vec!["sessionId", "timerId", "reason", "cancelledAtMs"],
        "timer-cancelled 字段形状与 §4.7 不符"
    );

    // 两事件字段全部必填（无可选字段；reason 为 String 承载 early-exit|cancelled）
    for ev in [&fired, &cancelled] {
        assert!(
            ev.fields.iter().all(|f| f.required),
            "事件 {} 的字段必须全部必填",
            ev.wire
        );
    }

    // cron-fired 由 T-CF-08 登记为 39（R1 tool-update 删除前移）；D8 新事件
    // 追加在 40-47，D-03 九观测事件追加在 48-56（见
    // [registry_drift_cron_fired_registered]）
    let cron = reg
        .events
        .iter()
        .find(|e| e.wire == "cron-fired")
        .expect("cron-fired 必须已由 T-CF-08 登记");
    assert_eq!(
        cron.id, 39,
        "cron-fired 编号必须为 39（声明序，R1 tool-update 删除前移）"
    );

    // 注册表样本 ↔ serde 行为双向一致（build_event_sample 构造 → 反序列化
    // → 回序列化，必填字段全在场）
    for ev in [&fired, &cancelled, &cron] {
        let sample = build_event_sample(&reg, ev);
        let parsed: AgentEvent = serde_json::from_value(sample)
            .unwrap_or_else(|e| panic!("事件 {} 按注册表样本反序列化失败：{e}", ev.wire));
        assert_eq!(
            parsed.type_name(),
            ev.wire,
            "事件 {} 的 type_name 与注册表 wire 不一致",
            ev.wire
        );
    }
}

/// cron-fired 背压必须为 Critical（02-CF §4.7 表：必达落库——数据面，
/// AI 实际唤醒走 steering 面，事件与唤醒解耦）
#[test]
fn cron_fired_backpressure_is_critical() {
    let event = AgentEvent::CronFired {
        session_id: "s1".into(),
        cron_id: "cron-1".into(),
        prompt: "检查编译".into(),
        expression: "0 9 * * *".into(),
        iteration: 1,
        fired_at_ms: 1_785_456_600_000,
    };
    assert_eq!(event_backpressure(&event), BackpressureLevel::Critical);
}

/// cron-fired 登记终态断言（累计 41 → 49 → 59）：编号 39（2026-08-16
/// R1 tool-update 死契约删除前移 1 位，原 40）、Critical、
/// 字段形状 sessionId/cronId/prompt/expression/iteration/firedAtMs 全量必填，
/// 与 serde 行为双向一致（T-CF-08，02-CF §4.7 冻结契约）；
/// D8 恢复域 + goal 域 8 事件追加在 40-47（见
/// [registry_drift_recovery_and_goal_events_registered]），D-03 九观测事件
/// 追加在 48-56，BG3 两事件追加在 58-59。
#[test]
fn registry_drift_cron_fired_registered() {
    let reg = registry();
    // 累计基线终态：40 → 41 → 49 → 57 → 58（T1a 追加 timeline-truncate）
    // → 57（R1 tool-update 死契约删除）→ 59（BG3 后台结果回注新增两事件）
    assert_eq!(reg.event_count, 59);
    assert_eq!(reg.events.len(), 59);
    assert_eq!(
        AgentEvent::ALL_TYPE_NAMES.len(),
        59,
        "AgentEvent enum 变体数必须为 59（BG3 后台结果回注新增两事件）"
    );

    // cron-fired（39）：Critical 必达落库，字段 sessionId/cronId/prompt/
    // expression/iteration/firedAtMs
    let cron = reg
        .events
        .iter()
        .find(|e| e.wire == "cron-fired")
        .expect("注册表必须登记 cron-fired");
    assert_eq!(
        cron.id, 39,
        "cron-fired 编号必须为 39（声明序，R1 tool-update 删除前移）"
    );
    assert_eq!(cron.rust_variant, "CronFired");
    assert_eq!(cron.domain, "cron", "cron-fired 必须归属 cron 域");
    assert_eq!(
        cron.backpressure, "critical",
        "cron-fired 必须为 Critical（必达落库）"
    );
    assert!(
        cron.kind_backpressure.is_none(),
        "cron-fired 不得登记 kindBackpressure（仅 subagent-event 允许）"
    );
    let cron_fields: Vec<&str> = cron.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        cron_fields,
        vec![
            "sessionId",
            "cronId",
            "prompt",
            "expression",
            "iteration",
            "firedAtMs"
        ],
        "cron-fired 字段形状与 §4.7 不符"
    );
    // 字段全部必填（无可选字段）
    assert!(
        cron.fields.iter().all(|f| f.required),
        "cron-fired 的字段必须全部必填"
    );
    // 协议硬约束：sessionId 必填在场（registry_event_types_match_enum_declaration_order
    // 全局断言亦覆盖，此处双保险）
    let session = cron
        .fields
        .iter()
        .find(|f| f.name == "sessionId")
        .expect("cron-fired 必须携带 sessionId");
    assert!(session.required, "cron-fired 的 sessionId 必须必填");

    // 注册表样本 ↔ serde 行为双向一致
    let sample = build_event_sample(&reg, cron);
    let parsed: AgentEvent = serde_json::from_value(sample)
        .unwrap_or_else(|e| panic!("cron-fired 按注册表样本反序列化失败：{e}"));
    let out = serde_json::to_value(&parsed).unwrap();
    let obj = out.as_object().unwrap();
    assert_eq!(obj.get("type"), Some(&Value::String("cron-fired".into())));
    for f in &cron.fields {
        assert!(
            obj.contains_key(&f.name),
            "cron-fired 序列化缺少必填字段 {}",
            f.name
        );
    }
    assert_eq!(
        parsed.type_name(),
        "cron-fired",
        "cron-fired 的 type_name 与注册表 wire 不一致"
    );
}

// ── 8.5 恢复域 + goal 域登记（任务连续性方案 D8：41 → 49）──

/// 恢复域五事件 + goal 域三事件登记终态断言（累计 49）：编号 40-47 与
/// enum 声明序一一对应、rustVariant/domain/backpressure 全量锁定、
/// 字段形状与 D8 §4.1 冻结契约一致、与 serde 行为双向一致
/// （2026-08-11 事件登记，载荷 = orchestrator recovery.rs append_event
/// payload 的基元镜像；goal-* 为 envelope 事件不列 sessionId，B2/S9 约定）
#[test]
fn registry_drift_recovery_and_goal_events_registered() {
    let reg = registry();
    // 编号与 domain/backpressure 断言表（声明序 = 注册表序 = 40-47；
    // 2026-08-14 D-03 契约窗口 tool-input-repaired 核销后前移为 41-48，
    // 2026-08-16 R1 tool-update 死契约删除再前移 1 位，原 42-49 → 40-47）
    let expected: &[(&str, &str, &str)] = &[
        ("recovery-escalated", "RecoveryEscalated", "recovery"),
        ("recovery-steering", "RecoverySteering", "recovery"),
        ("recovery-fork", "RecoveryFork", "recovery"),
        ("recovery-report", "RecoveryReport", "recovery"),
        ("recovery-budget-denied", "RecoveryBudgetDenied", "recovery"),
        ("goal-round-started", "GoalRoundStarted", "goal"),
        ("goal-round-completed", "GoalRoundCompleted", "goal"),
        (
            "goal-continuation-decided",
            "GoalContinuationDecided",
            "goal",
        ),
    ];
    for (offset, (wire, variant, domain)) in expected.iter().enumerate() {
        let id = 40 + offset as u32;
        let ev = reg
            .events
            .iter()
            .find(|e| e.wire == *wire)
            .unwrap_or_else(|| panic!("注册表必须登记 {wire}"));
        assert_eq!(ev.id, id, "{wire} 编号必须为 {id}（声明序）");
        assert_eq!(ev.rust_variant, *variant, "{wire} rustVariant 不符");
        assert_eq!(ev.domain, *domain, "{wire} 必须归属 {domain} 域");
        assert_eq!(
            ev.backpressure, "critical",
            "{wire} 必须为 Critical（落库必达）"
        );
        assert!(
            ev.kind_backpressure.is_none(),
            "{wire} 不得登记 kindBackpressure（仅 subagent-event 允许）"
        );
        // 注册表样本 ↔ serde 行为双向一致
        let sample = build_event_sample(&reg, ev);
        let parsed: AgentEvent = serde_json::from_value(sample)
            .unwrap_or_else(|e| panic!("事件 {wire} 按注册表样本反序列化失败：{e}"));
        assert_eq!(parsed.type_name(), *wire, "事件 {wire} 的 type_name 不符");
        // 全部字段形状与 D8 §4.1 冻结契约一致（含必填/可选标记）
        let wire_fields: Vec<&str> = ev.fields.iter().map(|f| f.name.as_str()).collect();
        match *wire {
            "recovery-escalated" => {
                assert_eq!(
                    wire_fields,
                    vec![
                        "sessionId",
                        "subagentRunId",
                        "kind",
                        "retries",
                        "elapsedMs",
                        "detail"
                    ],
                    "recovery-escalated 字段形状与 D8 §4.1 不符"
                );
                assert!(
                    !ev.fields[1].required,
                    "subagentRunId 必须可选（W1 熔断侧 None）"
                );
                assert!(!ev.fields[5].required, "detail 必须可选（W1 熔断侧 Some）");
            }
            "recovery-steering" => {
                assert_eq!(
                    wire_fields,
                    vec![
                        "sessionId",
                        "subagentId",
                        "subagentRunId",
                        "fingerprint",
                        "retries",
                        "remainingStatus",
                        "pending",
                        "createdAtMs"
                    ],
                    "recovery-steering 字段形状与 D8 §4.1 不符"
                );
                assert!(
                    ev.fields.iter().all(|f| f.required),
                    "recovery-steering 字段必须全必填"
                );
            }
            "recovery-fork" => {
                assert_eq!(
                    wire_fields,
                    vec![
                        "sessionId",
                        "fingerprint",
                        "subagentId",
                        "fromRunId",
                        "fromLeafId",
                        "newRunId",
                        "newLeafId",
                        "contextMode"
                    ],
                    "recovery-fork 字段形状与 D8 §4.1 不符"
                );
                assert!(
                    ev.fields.iter().all(|f| f.required),
                    "recovery-fork 字段必须全必填"
                );
            }
            "recovery-report" => {
                assert_eq!(
                    wire_fields,
                    vec![
                        "sessionId",
                        "subagentId",
                        "subagentRunId",
                        "stuckAtMs",
                        "suggestion"
                    ],
                    "recovery-report 字段形状与 D8 §4.1 不符"
                );
                assert!(
                    ev.fields.iter().all(|f| f.required),
                    "recovery-report 字段必须全必填"
                );
            }
            "recovery-budget-denied" => {
                assert_eq!(
                    wire_fields,
                    vec!["sessionId", "subagentRunId", "fingerprint", "count", "max"],
                    "recovery-budget-denied 字段形状与 D8 §4.1 不符"
                );
                assert!(
                    !ev.fields[1].required,
                    "subagentRunId 必须可选（W6 D2 主 run 侧 None）"
                );
            }
            "goal-round-started" => {
                assert_eq!(
                    wire_fields,
                    vec!["round", "maxRounds", "goal"],
                    "goal-round-started 字段形状与 D8 §4.1 不符"
                );
                assert!(
                    ev.fields.iter().all(|f| f.required),
                    "goal-round-started 字段必须全必填"
                );
            }
            "goal-round-completed" => {
                assert_eq!(
                    wire_fields,
                    vec![
                        "round",
                        "toolCallCount",
                        "toolSuccessCount",
                        "messageCount",
                        "decision",
                        "reasonDetail",
                        "stalledDelta",
                        "evidence"
                    ],
                    "goal-round-completed 字段形状与 D8 §4.1（B2 统一字段集）不符"
                );
                assert!(
                    ev.fields.iter().all(|f| f.required),
                    "goal-round-completed 字段必须全必填"
                );
            }
            "goal-continuation-decided" => {
                assert_eq!(
                    wire_fields,
                    vec!["action", "reason", "prompt", "progressSignature", "detail"],
                    "goal-continuation-decided 字段形状与 D8 §4.1 不符"
                );
                assert!(!ev.fields[2].required, "prompt 必须可选");
                assert!(!ev.fields[3].required, "progressSignature 必须可选");
                assert!(!ev.fields[4].required, "detail 必须可选");
            }
            other => panic!("断言表未覆盖新事件 {other}"),
        }
    }
    // 与 ALL_TYPE_NAMES 声明序对齐（40-47 为 D8 八事件，追加在 CronFired
    // 之后；D-03 九观测事件续在其后 48-56）
    let tail: Vec<&str> = AgentEvent::ALL_TYPE_NAMES[39..47].to_vec();
    let expected_wires: Vec<&str> = expected.iter().map(|(w, _, _)| *w).collect();
    assert_eq!(
        tail, expected_wires,
        "enum 声明序尾部（40-47）必须为 8 新事件"
    );
}

// ── 8.6 D-03 观测补全九事件登记（2026-08-14 契约窗口：49 → 57）──

/// D-03 九观测事件登记终态断言（编号 48-56 与 enum 声明序一一对应、
/// rustVariant/domain/backpressure/persist/bridgePriority 全量锁定（PC-05
/// 三字段默认值：Delta + NoPersist + Critical——可追溯性不阻塞主链）、
/// 字段形状与 D-03 §三.1 契约定义一致、与 serde 行为双向一致；全 Delta
/// 可丢级，禁 Critical（主控裁决 R-16））
#[test]
fn registry_drift_d03_observation_events_registered() {
    let reg = registry();
    // 编号与三决策断言表（声明序 = 注册表序 = 48-56，R1 tool-update
    // 死契约删除前移 1 位，原 49-57）
    let expected: &[(&str, &str, &str, &[&str])] = &[
        (
            "steering-evaluated",
            "SteeringEvaluated",
            "steering",
            &[
                "sessionId",
                "timestamp",
                "phase",
                "hitStrategies",
                "steeringCountBefore",
                "steeringCountAfter",
                "budgetRemaining",
                "reset",
            ],
        ),
        (
            "control-intent",
            "ControlIntent",
            "control",
            &[
                "sessionId",
                "timestamp",
                "kind",
                "intentId",
                "source",
                "reason",
                "state",
            ],
        ),
        (
            "hook-outcome",
            "HookOutcome",
            "hook",
            &[
                "sessionId",
                "timestamp",
                "hookType",
                "outcome",
                "hookName",
                "blockedReason",
            ],
        ),
        (
            "summary-background",
            "SummaryBackground",
            "summary",
            &[
                "sessionId",
                "timestamp",
                "phase",
                "attempt",
                "reason",
                "messageId",
            ],
        ),
        (
            "stage-summary-milestone",
            "StageSummaryMilestone",
            "summary",
            &[
                "sessionId",
                "timestamp",
                "milestoneType",
                "tier",
                "milestoneIndex",
            ],
        ),
        (
            "nudge-enqueued",
            "NudgeEnqueued",
            "steering",
            &[
                "sessionId",
                "timestamp",
                "reason",
                "targetRing",
                "overwrote",
            ],
        ),
        (
            "recovery-acknowledged",
            "RecoveryAcknowledged",
            "recovery",
            &["sessionId", "timestamp", "notificationId", "subagentRunId"],
        ),
        (
            "recovery-retry-attempted",
            "RecoveryRetryAttempted",
            "recovery",
            &[
                "sessionId",
                "timestamp",
                "attempt",
                "delayMs",
                "budgetRemaining",
                "fromRunId",
                "newRunId",
            ],
        ),
        (
            "provider-request-anchored",
            "ProviderRequestAnchored",
            "diagnostic",
            &[
                "sessionId",
                "timestamp",
                "turnIndex",
                "model",
                "requestStartedAtMs",
            ],
        ),
    ];
    for (offset, (wire, variant, domain, field_names)) in expected.iter().enumerate() {
        let id = 48 + offset as u32;
        let ev = reg
            .events
            .iter()
            .find(|e| e.wire == *wire)
            .unwrap_or_else(|| panic!("注册表必须登记 {wire}"));
        assert_eq!(ev.id, id, "{wire} 编号必须为 {id}（声明序）");
        assert_eq!(ev.rust_variant, *variant, "{wire} rustVariant 不符");
        assert_eq!(ev.domain, *domain, "{wire} 必须归属 {domain} 域");
        // PC-05 三决策默认值：全 Delta + NoPersist + Critical
        // （可追溯性不阻塞主链，增量可丢不落库；桥缓冲不丢）
        assert_eq!(ev.backpressure, "delta", "{wire} 必须为 Delta（可丢）");
        assert!(!ev.persist, "{wire} 必须 NoPersist（不落库）");
        assert_eq!(ev.bridge_priority, "critical", "{wire} 桥丢帧必须 Critical");
        assert!(
            ev.kind_backpressure.is_none(),
            "{wire} 不得登记 kindBackpressure（仅 subagent-event 允许）"
        );
        // 字段形状与 D-03 §三.1 契约定义一致（含必填/可选标记）
        let wire_fields: Vec<&str> = ev.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            wire_fields, *field_names,
            "{wire} 字段形状与 D-03 §三.1 不符"
        );
        // sessionId 必填在场（全局断言亦覆盖，此处双保险）
        let session = ev
            .fields
            .iter()
            .find(|f| f.name == "sessionId")
            .expect("{wire} 必须携带 sessionId");
        assert!(session.required, "{wire} 的 sessionId 必须必填");
        // 注册表样本 ↔ serde 行为双向一致 + event_policy 三决策一致
        let sample = build_event_sample(&reg, ev);
        let parsed: AgentEvent = serde_json::from_value(sample)
            .unwrap_or_else(|e| panic!("事件 {wire} 按注册表样本反序列化失败：{e}"));
        assert_eq!(parsed.type_name(), *wire, "事件 {wire} 的 type_name 不符");
        let policy = event_policy(&parsed);
        assert_eq!(
            policy.backpressure,
            BackpressureLevel::Delta,
            "{wire} 背压判定不符"
        );
        assert_eq!(
            policy.persist,
            PersistenceDecision::NoPersist,
            "{wire} 持久化判定不符"
        );
        assert_eq!(
            policy.bridge_priority,
            DropClass::Critical,
            "{wire} 桥丢帧判定不符"
        );
    }
    // 与 ALL_TYPE_NAMES 声明序对齐（48-56 为 D-03 九观测事件，追加在
    // goal-continuation-decided 之后；timeline-truncate 由 T1a 追加在 57
    // （R1 tool-update 删除后），故此处只取前 9 项校验）
    let tail: Vec<&str> = AgentEvent::ALL_TYPE_NAMES[47..56].to_vec();
    let expected_wires: Vec<&str> = expected.iter().map(|(w, _, _, _)| *w).collect();
    assert_eq!(
        tail, expected_wires,
        "enum 声明序尾部（48-56）必须为 9 新事件"
    );
}

/// tool-input-repaired 核销终态断言（D-03 EV-01）：enum 变体 + type_name +
/// 注册表 ×2 + redact 判定全部移除，生产代码零命中；观测需求由
/// tool-start 实际入参 executedInput 字段承载（主控裁决 R-15）
#[test]
fn registry_drift_tool_input_repaired_revoked() {
    let reg = registry();
    assert!(
        reg.events.iter().all(|e| e.wire != "tool-input-repaired"),
        "注册表不得残留 tool-input-repaired（D-03 核销）"
    );
    assert!(
        AgentEvent::ALL_TYPE_NAMES
            .iter()
            .all(|n| *n != "tool-input-repaired"),
        "enum 不得残留 tool-input-repaired（D-03 核销）"
    );
}

// ── 8.7 统一输入流收敛战役 T1a：timeline-truncate 事件 + 新枚举登记 ──

/// timeline-truncate 事件登记终态断言（累计 59）：编号 57（声明序尾插后
/// BG3 两事件续接 58/59，事件域 retraction）、rustVariant=TimelineTruncate、
/// 三决策 Critical+Persist+Critical（default required，决定 3——R1 撤回
/// 语义关键事件须 over-refuse）、字段形状 sessionId/runId/boundarySeq/
/// reason/targetMessageId/timestamp 全量必填、与 serde 行为双向一致、seq
/// 归属 `TimelineTruncate.sequence > boundarySeq` 不变量随 schema 锁定。
#[test]
fn registry_drift_timeline_truncate_registered() {
    let reg = registry();
    // 累计基线终态：57 → 58（T1a 统一输入流收敛战役追加）→ 57
    // （R1 tool-update 死契约删除）→ 59（BG3 后台结果回注新增两事件）
    assert_eq!(reg.event_count, 59);
    assert_eq!(reg.events.len(), 59);
    assert_eq!(
        AgentEvent::ALL_TYPE_NAMES.len(),
        59,
        "AgentEvent enum 变体数必须为 59"
    );

    // timeline-truncate（57）：Critical 必达落库，字段 sessionId/runId/
    // boundarySeq/reason/targetMessageId/timestamp
    let ev = reg
        .events
        .iter()
        .find(|e| e.wire == "timeline-truncate")
        .expect("注册表必须登记 timeline-truncate");
    assert_eq!(
        ev.id, 57,
        "timeline-truncate 编号必须为 57（声明序尾插，R1 tool-update 删除后）"
    );
    assert_eq!(ev.rust_variant, "TimelineTruncate");
    assert_eq!(
        ev.domain, "retraction",
        "timeline-truncate 必须归属 retraction 域"
    );
    // default required（决定 3）：Critical+Persist+Critical 三决策显式锁定
    assert_eq!(
        ev.backpressure, "critical",
        "timeline-truncate 必须为 Critical（必达落库）"
    );
    assert!(ev.persist, "timeline-truncate 必须 Persist（落库）");
    assert_eq!(
        ev.bridge_priority, "critical",
        "timeline-truncate 桥丢帧必须 Critical"
    );
    assert!(
        ev.kind_backpressure.is_none(),
        "timeline-truncate 不得登记 kindBackpressure（仅 subagent-event 允许）"
    );
    let wire_fields: Vec<&str> = ev.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        wire_fields,
        vec![
            "sessionId",
            "runId",
            "boundarySeq",
            "reason",
            "targetMessageId",
            "timestamp"
        ],
        "timeline-truncate 字段形状与详案-T1 §1.2(a) 不符"
    );
    // 字段全部必填（default required）
    assert!(
        ev.fields.iter().all(|f| f.required),
        "timeline-truncate 的字段必须全部必填（default required）"
    );
    // sessionId/runId 必填在场（协议硬约束全局断言亦覆盖）
    for name in ["sessionId", "runId"] {
        let f = ev
            .fields
            .iter()
            .find(|f| f.name == name)
            .unwrap_or_else(|| panic!("timeline-truncate 缺 {name} 字段"));
        assert!(f.required, "timeline-truncate 的 {name} 必须必填");
    }
    // reason 引用新枚举 TimelineTruncateReason（注册表内部类型引用自洽）
    let reason = ev
        .fields
        .iter()
        .find(|f| f.name == "reason")
        .expect("timeline-truncate 缺 reason 字段");
    assert_eq!(
        reason.ts_type, "TimelineTruncateReason",
        "reason 必须引用 TimelineTruncateReason"
    );

    // 注册表样本 ↔ serde 行为双向一致 + event_policy 三决策一致
    let sample = build_event_sample(&reg, ev);
    let parsed: AgentEvent = serde_json::from_value(sample)
        .unwrap_or_else(|e| panic!("timeline-truncate 按注册表样本反序列化失败：{e}"));
    assert_eq!(
        parsed.type_name(),
        "timeline-truncate",
        "type_name 与注册表 wire 不一致"
    );

    // seq 归属不变量：`TimelineTruncate.sequence > boundarySeq` 是运行期
    // 取号不变量，与声明序位置无关；BG3 两事件（58/59）为桥直发实时轨
    // 事件（信封 runId/sequence 均缺省，不占会话 sequence），声明序续接在
    // timeline-truncate 之后不影响本不变量。此处锁定 timeline-truncate
    // 仍居声明序第 57 位、尾位为 BG3 的 tool-settled。
    assert_eq!(
        AgentEvent::ALL_TYPE_NAMES[56],
        "timeline-truncate",
        "timeline-truncate 必须居 enum 声明序第 57 位"
    );
    assert_eq!(
        AgentEvent::ALL_TYPE_NAMES.last().copied(),
        Some("tool-settled"),
        "enum 声明序尾位必须为 tool-settled（BG3 追加）"
    );

    // 新枚举双向锁定（数值已在 enum_values_match_serde_wire 锁定，此处锚定 wire 语义）
    let reason_spec = &reg.enums["TimelineTruncateReason"];
    assert_eq!(reason_spec.wire, "kebab-case");
    assert_eq!(reason_spec.values, vec!["user-requested", "error-rollback"]);
    let kind_spec = &reg.enums["AgentMessageMetadataKind"];
    assert_eq!(kind_spec.wire, "kebab-case");
    assert_eq!(
        kind_spec.values,
        vec![
            "steering",
            "nudge",
            "diagnostic",
            "context-state",
            "injection",
            "tool-promise-recovery",
            "goal-continue",
        ]
    );
}

// ── 8.8 BG3 后台结果回注：tool-backgrounded / tool-settled 事件 + 新枚举登记 ──

/// BG3 两事件登记终态断言（累计 59）：编号 58/59（声明序尾插，事件域
/// tool）、rustVariant=ToolBackgrounded/ToolSettled、三决策
/// Critical+Persist+Critical（policy 默认臂——桥直发实时轨事件不占会话
/// sequence，但契约分级与 tool-end 同级锁定）、字段形状全量必填、与 serde
/// 行为双向一致；新枚举 ToolSettledStatus 四值与工具后台注册表终态子集
/// 1:1（数值已在 enum_values_match_serde_wire 锁定，此处锚定 wire 语义）。
#[test]
fn registry_drift_tool_background_events_registered() {
    let reg = registry();
    assert_eq!(reg.event_count, 59);
    assert_eq!(reg.events.len(), 59);
    assert_eq!(AgentEvent::ALL_TYPE_NAMES.len(), 59);

    // tool-backgrounded（58）：字段 sessionId/callId/toolName/elapsedMs
    let bg = reg
        .events
        .iter()
        .find(|e| e.wire == "tool-backgrounded")
        .expect("注册表必须登记 tool-backgrounded");
    assert_eq!(bg.id, 58, "tool-backgrounded 编号必须为 58（声明序尾插）");
    assert_eq!(bg.rust_variant, "ToolBackgrounded");
    assert_eq!(bg.domain, "tool", "tool-backgrounded 必须归属 tool 域");
    assert_eq!(bg.backpressure, "critical");
    assert!(bg.persist, "tool-backgrounded 必须 Persist（默认臂口径）");
    assert_eq!(bg.bridge_priority, "critical");
    assert!(bg.kind_backpressure.is_none());
    let bg_fields: Vec<&str> = bg.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        bg_fields,
        vec!["sessionId", "callId", "toolName", "elapsedMs"],
        "tool-backgrounded 字段形状与 BG3 定案不符"
    );
    assert!(
        bg.fields.iter().all(|f| f.required),
        "tool-backgrounded 字段必须全部必填"
    );
    let elapsed = bg
        .fields
        .iter()
        .find(|f| f.name == "elapsedMs")
        .expect("tool-backgrounded 缺 elapsedMs 字段");
    assert_eq!(elapsed.ts_type, "number");
    assert_eq!(elapsed.integer, Some(true), "elapsedMs 必须为整数（u64）");

    // tool-settled（59）：字段 sessionId/callId/toolName/status/result，
    // status 引用 ToolSettledStatus、result 复用 ToolBatchResult
    let st = reg
        .events
        .iter()
        .find(|e| e.wire == "tool-settled")
        .expect("注册表必须登记 tool-settled");
    assert_eq!(st.id, 59, "tool-settled 编号必须为 59（声明序尾位）");
    assert_eq!(st.rust_variant, "ToolSettled");
    assert_eq!(st.domain, "tool", "tool-settled 必须归属 tool 域");
    assert_eq!(st.backpressure, "critical");
    assert!(st.persist, "tool-settled 必须 Persist（默认臂口径）");
    assert_eq!(st.bridge_priority, "critical");
    assert!(st.kind_backpressure.is_none());
    let st_fields: Vec<&str> = st.fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        st_fields,
        vec!["sessionId", "callId", "toolName", "status", "result"],
        "tool-settled 字段形状与 BG3 定案不符"
    );
    assert!(
        st.fields.iter().all(|f| f.required),
        "tool-settled 字段必须全部必填"
    );
    let status = st
        .fields
        .iter()
        .find(|f| f.name == "status")
        .expect("tool-settled 缺 status 字段");
    assert_eq!(
        status.ts_type, "ToolSettledStatus",
        "status 必须引用 ToolSettledStatus"
    );
    let result = st
        .fields
        .iter()
        .find(|f| f.name == "result")
        .expect("tool-settled 缺 result 字段");
    assert_eq!(
        result.ts_type, "ToolBatchResult",
        "result 必须复用 ToolBatchResult（与 tool-end 同构）"
    );

    // 注册表样本 ↔ serde 行为双向一致
    for ev in [bg, st] {
        let sample = build_event_sample(&reg, ev);
        let parsed: AgentEvent = serde_json::from_value(sample)
            .unwrap_or_else(|e| panic!("{} 按注册表样本反序列化失败：{e}", ev.wire));
        assert_eq!(
            parsed.type_name(),
            ev.wire,
            "type_name 与注册表 wire 不一致"
        );
    }

    // 新枚举 wire 语义锚定（四值 = 注册表终态子集 SettledOk/SettledErr/
    // Cancelled/OutcomeUnknown）
    let status_spec = &reg.enums["ToolSettledStatus"];
    assert_eq!(status_spec.wire, "kebab-case");
    assert_eq!(
        status_spec.values,
        vec!["ok", "error", "cancelled", "outcome-unknown"]
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. 设备协议注册表护栏（R0-03：device-protocol.json ↔
//    crates/conex-device-protocol/src/** 双向锁定）
//
// 唯一事实源：crates/conex-device-protocol/src/（TY-P5 从 conex-types 拆出），
// 注册表 crates/conex-device-protocol/contracts/device-protocol.json 是给
// 生成脚本（scripts/generate-engine-bindings.mjs，R0-03 泛化为多注册表分发）
// 的机器可读导出。本段把注册表与 Rust 侧真实 serde 行为锁定：
//
// - kind 全量：注册表 117 条 kind（messageId 1-117 连续）== 模块
//   [conex_device_protocol::all_kinds]（静态 29 + remote 44 + result 44），
//   且 messages 与 kinds 一一对应（id/kind/rustVariant 引用可解析）；
// - 错误码全量：注册表 errors 段（common+protocol+business）去重后 45 个
//   == [conex_device_protocol::ALL_ERROR_CODES]，且 common 码必须重新登记在
//   protocol|business（防分段漂移）；
// - 能力位全量：注册表 capabilities 段 17 位 ==
//   [conex_device_protocol::ALL_CAPABILITIES] 的 wire 名（serde camelCase）；
// - 事件双面策略：注册表 events 段 49 条与 engine-events.json /
//   [AgentEvent::ALL_TYPE_NAMES] 同名同序；sync 标志 == [SYNC_ELIGIBLE_TYPES]
//   白名单；strategy 与 [event_cross_strategy] 逐一锁定（13/18/10 分组）；
// - 消息体字段：29 条静态消息（内联 fields）按注册表必填字段构造样本 →
//   反序列化为对应 Rust 类型 → 回序列化，断言必填字段在场且无注册表外
//   字段（字段名漂移即失败）；
// - 协议常量：注册表 constants 段关键项与 [conex_device_protocol::version]
//   常量一致（MAX_FRAME_BYTES / EVENT_WINDOW / MAX_SUBSCRIPTIONS /
//   MAX_STREAMS 等）。
//
// 任何一侧改动不同步（改 Rust 类型不更新注册表 / 改注册表不匹配 serde），
// `cargo test -p conex-types --test registry_drift` 立即失败；生成产物（TS 面）
// 漂移由 packages/shared-types/src/generated/device/drift.test.ts 与 CI
// engine-bindings-drift job 兜底。
//
// 注：本段是唯一跨 crate 的测试引用——dev-dependency 单向（conex-types 的
// 测试目标 → conex-device-protocol），lib 依赖图仍保持
// conex-device-protocol → conex-types 单向（c.1 边界）。

use conex_device_protocol::events::event_cross_strategy;
use conex_device_protocol::version::{
    ALL_CAPABILITIES, EVENT_WINDOW, MAX_FRAME_BYTES, MAX_STREAMS, MAX_SUBSCRIPTIONS,
    MIN_PROTOCOL_VERSION, PROTOCOL_VERSION,
};
use conex_device_protocol::{
    all_kinds, CommandRequest, CommandResult, DeviceErrorCode, DeviceReady, DeviceUnlink,
    ErrorBody, EventAck, EventsPush, Heartbeat, HeartbeatOk, Hello, HelloOk, PairAudit,
    PairChallenge, PairHello, PairOk, PairVerify, Refresh, Resume, ResumeDone, ResumePage,
    SessionRemoved, SessionUpdated, SessionUpdatedAll, StreamChunk, StreamClose, StreamOpen,
    StreamResume, Subscribe, SubscribeAll, SubscribeOk, ALL_ERROR_CODES, REMOTE_KINDS,
    RESULT_KINDS,
};
use conex_device_protocol::{Capability, EventRedactStrategy, SYNC_ELIGIBLE_TYPES};

/// 设备注册表 JSON 结构（与 contracts/device-protocol.json 逐字段对应）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRegistry {
    contract: String,
    schema_version: u32,
    protocol_version: u32,
    message_count: u32,
    kinds: Vec<DeviceKindSpec>,
    messages: Vec<DeviceMessageSpec>,
    commands: Vec<DeviceCommandSpec>,
    events: Vec<DeviceEventSpec>,
    errors: DeviceErrorsSpec,
    capabilities: Vec<DeviceCapabilitySpec>,
    types: std::collections::BTreeMap<String, TypeSpec>,
    enums: std::collections::BTreeMap<String, EnumSpec>,
    constants: std::collections::BTreeMap<String, Value>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceKindSpec {
    kind: String,
    family: String,
    direction: String,
    auth_phase: String,
    message_id: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceMessageSpec {
    id: u32,
    kind: String,
    rust_variant: String,
    family: String,
    #[serde(default)]
    fields: Option<Vec<FieldSpec>>,
    #[serde(default)]
    params_type: Option<String>,
    #[serde(default)]
    result_type: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceCommandSpec {
    number: String,
    name: String,
    kind: String,
    tauri_command: String,
    surface: String,
    registered: bool,
    domain: String,
    write: bool,
    outbox: bool,
    idempotency_key: String,
    params_type: String,
    result_type: String,
    error_codes: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceEventSpec {
    id: u32,
    #[serde(rename = "type")]
    wire: String,
    strategy: String,
    realtime: DeviceEventRealtimeSpec,
    sync: bool,
    push_level: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceEventRealtimeSpec {
    push: bool,
    backpressure: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceErrorsSpec {
    common_to_all_commands: Vec<String>,
    protocol: Vec<DeviceErrorEntrySpec>,
    business: Vec<DeviceErrorEntrySpec>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceErrorEntrySpec {
    code: String,
    retryable: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceCapabilitySpec {
    name: String,
    owner: String,
    commands: Vec<String>,
}

fn device_registry() -> DeviceRegistry {
    // TY-P5：设备协议注册表随 crate 拆分迁到 conex-device-protocol/contracts，
    // 测试文件保留在本 crate（dev-dependency 单向，见段首注）
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../conex-device-protocol/contracts/device-protocol.json"
    );
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("读取设备注册表 {path} 失败：{e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("解析设备注册表失败：{e}"))
}

/// 注册表错误码去重全集（common 优先序，与生成 errors.ts 同序）
fn all_device_error_codes(reg: &DeviceRegistry) -> Vec<&str> {
    let mut seen = std::collections::BTreeSet::new();
    let mut codes = Vec::new();
    for code in &reg.errors.common_to_all_commands {
        if seen.insert(code.as_str()) {
            codes.push(code.as_str());
        }
    }
    for entry in reg.errors.protocol.iter().chain(reg.errors.business.iter()) {
        if seen.insert(entry.code.as_str()) {
            codes.push(entry.code.as_str());
        }
    }
    codes
}

/// 设备样本覆盖表：注册表以 JsonValue/string 建模但 Rust 侧有更强 wire 类型
/// 的字段（配对码 / 游标映射 / 错误码），构造样本时用合法值替代裸 null/"x"。
fn device_sample_override(owner: &str, field: &str) -> Option<Value> {
    match (owner, field) {
        ("PairHello", "code") => Some(json!("CXN-7K4P-Q2MB-9XRT")),
        ("Subscribe", "lastSequences") => Some(json!({ "s-1": 7 })),
        ("ErrorBody", "code") => Some(json!("cmd.denied")),
        _ => None,
    }
}

/// 按注册表类型引用构造最小样本 JSON（只填必填字段；结构体字段先以当前类型名
/// 为上级查 [`device_sample_override`]，未命中再递归构造）
fn device_sample_value(reg: &DeviceRegistry, ty: &str) -> Value {
    if let Some(inner) = ty.strip_suffix("[]") {
        return Value::Array(vec![device_sample_value(reg, inner)]);
    }
    match ty {
        "string" => Value::String("x".into()),
        "number" => Value::from(0),
        "boolean" => Value::Bool(false),
        "JsonValue" => Value::Null,
        _ => {
            if let Some(spec) = reg.enums.get(ty) {
                let first = spec
                    .values
                    .first()
                    .unwrap_or_else(|| panic!("枚举 {ty} 不能为空"));
                return Value::String(first.clone());
            }
            match reg.types.get(ty) {
                Some(TypeSpec::Struct { fields }) => {
                    let mut obj = Map::new();
                    for f in fields.iter().filter(|f| f.required) {
                        obj.insert(
                            f.name.clone(),
                            device_sample_override(ty, &f.name)
                                .unwrap_or_else(|| device_sample_value(reg, &f.ts_type)),
                        );
                    }
                    Value::Object(obj)
                }
                Some(TypeSpec::Tagged { tag, variants }) => {
                    let v = variants
                        .first()
                        .unwrap_or_else(|| panic!("tagged 类型 {ty} 不能没有变体"));
                    let mut obj = Map::new();
                    obj.insert(tag.clone(), Value::String(v.name.clone()));
                    for f in v.fields.iter().filter(|f| f.required) {
                        obj.insert(f.name.clone(), device_sample_value(reg, &f.ts_type));
                    }
                    Value::Object(obj)
                }
                None => panic!("设备注册表引用了未知类型 {ty}"),
            }
        }
    }
}

/// 按注册表 rustVariant 映射到 Rust 类型做回环校验（29 条静态消息体 +
/// 命令/响应/错误信封，全量覆盖 117 kind 的 wire 载荷形态）
fn check_device_body_roundtrip(rust_variant: &str, fields: &[FieldSpec], sample: Value) {
    match rust_variant {
        "PairHello" => check_roundtrip::<PairHello>(rust_variant, fields, sample),
        "PairChallenge" => check_roundtrip::<PairChallenge>(rust_variant, fields, sample),
        "PairVerify" => check_roundtrip::<PairVerify>(rust_variant, fields, sample),
        "PairOk" => check_roundtrip::<PairOk>(rust_variant, fields, sample),
        "Hello" => check_roundtrip::<Hello>(rust_variant, fields, sample),
        "HelloOk" => check_roundtrip::<HelloOk>(rust_variant, fields, sample),
        "Refresh" => check_roundtrip::<Refresh>(rust_variant, fields, sample),
        "DeviceReady" => check_roundtrip::<DeviceReady>(rust_variant, fields, sample),
        "DeviceUnlink" => check_roundtrip::<DeviceUnlink>(rust_variant, fields, sample),
        "PairAudit" => check_roundtrip::<PairAudit>(rust_variant, fields, sample),
        "Subscribe" => check_roundtrip::<Subscribe>(rust_variant, fields, sample),
        "SubscribeAll" => check_roundtrip::<SubscribeAll>(rust_variant, fields, sample),
        "SubscribeOk" => check_roundtrip::<SubscribeOk>(rust_variant, fields, sample),
        "EventsPush" => check_roundtrip::<EventsPush>(rust_variant, fields, sample),
        "EventAck" => check_roundtrip::<EventAck>(rust_variant, fields, sample),
        "Resume" => check_roundtrip::<Resume>(rust_variant, fields, sample),
        "ResumePage" => check_roundtrip::<ResumePage>(rust_variant, fields, sample),
        "ResumeDone" => check_roundtrip::<ResumeDone>(rust_variant, fields, sample),
        "SessionUpdated" => check_roundtrip::<SessionUpdated>(rust_variant, fields, sample),
        "SessionRemoved" => check_roundtrip::<SessionRemoved>(rust_variant, fields, sample),
        "SessionUpdatedAll" => check_roundtrip::<SessionUpdatedAll>(rust_variant, fields, sample),
        "StreamOpen" => check_roundtrip::<StreamOpen>(rust_variant, fields, sample),
        "StreamChunk" => check_roundtrip::<StreamChunk>(rust_variant, fields, sample),
        "StreamResume" => check_roundtrip::<StreamResume>(rust_variant, fields, sample),
        "StreamClose" => check_roundtrip::<StreamClose>(rust_variant, fields, sample),
        "Heartbeat" => check_roundtrip::<Heartbeat>(rust_variant, fields, sample),
        "HeartbeatOk" => check_roundtrip::<HeartbeatOk>(rust_variant, fields, sample),
        "ErrorBody" => check_roundtrip::<ErrorBody>(rust_variant, fields, sample),
        "CommandRequest" => check_roundtrip::<CommandRequest>(rust_variant, fields, sample),
        "CommandResult" => check_roundtrip::<CommandResult>(rust_variant, fields, sample),
        other => panic!("未接入设备回环校验的 rustVariant {other}"),
    }
}

// ── 9.1 kind 全量：注册表 117 条 ↔ Rust all_kinds() ──

#[test]
fn device_registry_kinds_match_rust_all_kinds() {
    let reg = device_registry();
    assert_eq!(
        reg.contract, "device-protocol",
        "注册表契约名必须为 device-protocol"
    );
    assert_eq!(reg.schema_version, 1);
    assert_eq!(reg.protocol_version, 1);
    assert_eq!(
        reg.message_count, 117,
        "M6 §1.1：kind 总数必须为 117（基线 103 + G 系列 remote/result 各 +7）"
    );
    assert_eq!(reg.kinds.len(), 117);
    assert_eq!(reg.messages.len(), 117);

    // kinds 与 messages 一一对应（id/kind 双键）
    for (i, kind) in reg.kinds.iter().enumerate() {
        assert_eq!(
            kind.message_id as usize,
            i + 1,
            "kind messageId 必须从 1 连续递增"
        );
        let msg = &reg.messages[i];
        assert_eq!(msg.id as usize, i + 1, "message id 必须与 kinds 对齐");
        assert_eq!(msg.kind, kind.kind, "message.kind 必须与 kinds 对齐");
        assert!(
            matches!(
                kind.family.as_str(),
                "pair"
                    | "auth"
                    | "device"
                    | "events"
                    | "remote"
                    | "result"
                    | "stream"
                    | "heartbeat"
                    | "error"
            ),
            "kind {} 的 family 非法：{}",
            kind.kind,
            kind.family
        );
        assert!(
            matches!(
                kind.direction.as_str(),
                "mobile-to-desktop" | "desktop-to-mobile" | "both"
            ),
            "kind {} 的 direction 非法：{}",
            kind.kind,
            kind.direction
        );
        assert!(
            matches!(
                kind.auth_phase.as_str(),
                "pairing" | "handshake" | "session" | "both"
            ),
            "kind {} 的 authPhase 非法：{}",
            kind.kind,
            kind.auth_phase
        );
        // rustVariant 必须可解析（types 表内或命令/响应信封）
        assert!(
            reg.types.contains_key(&msg.rust_variant)
                || matches!(
                    msg.rust_variant.as_str(),
                    "CommandRequest" | "CommandResult"
                ),
            "message {} 的 rustVariant {} 未在 types 登记",
            msg.kind,
            msg.rust_variant
        );
        // family 与 kinds 对齐；remote/result 必须声明可解析的 params/result 类型
        assert_eq!(msg.family, kind.family, "message.family 必须与 kinds 对齐");
        if matches!(msg.family.as_str(), "remote" | "result") {
            let params = msg
                .params_type
                .as_deref()
                .expect("remote/result 必须声明 paramsType");
            let result = msg
                .result_type
                .as_deref()
                .expect("remote/result 必须声明 resultType");
            assert!(
                reg.types.contains_key(params),
                "{} 的 paramsType {} 未登记",
                msg.kind,
                params
            );
            assert!(
                reg.types.contains_key(result),
                "{} 的 resultType {} 未登记",
                msg.kind,
                result
            );
        }
    }

    // 与 Rust 侧 117 全量集合一致（all_kinds = 静态 29 + remote 44 + result 44）
    let rust_kinds: std::collections::BTreeSet<&str> = all_kinds().into_iter().collect();
    assert_eq!(rust_kinds.len(), 117);
    let reg_kinds: std::collections::BTreeSet<&str> =
        reg.kinds.iter().map(|k| k.kind.as_str()).collect();
    assert_eq!(
        reg_kinds, rust_kinds,
        "注册表 kind 集合与 Rust all_kinds() 不一致"
    );
}

// ── 9.2 错误码全量：注册表去重 45 ↔ Rust ALL_ERROR_CODES ──

#[test]
fn device_registry_error_codes_match_rust_all_error_codes() {
    let reg = device_registry();
    let codes = all_device_error_codes(&reg);
    assert_eq!(
        codes.len(),
        45,
        "注册表错误码去重后必须为 45（D3 §6.2 / M6 §6.2）"
    );
    // common 码必须重新登记在 protocol|business（防分段漂移）
    let protocol_business: std::collections::BTreeSet<&str> = reg
        .errors
        .protocol
        .iter()
        .chain(reg.errors.business.iter())
        .map(|e| e.code.as_str())
        .collect();
    for code in &reg.errors.common_to_all_commands {
        assert!(
            protocol_business.contains(code.as_str()),
            "common 错误码 {code} 必须重新登记在 protocol|business"
        );
    }
    let reg_set: std::collections::BTreeSet<&str> = codes.into_iter().collect();
    let rust_set: std::collections::BTreeSet<&str> = ALL_ERROR_CODES.iter().copied().collect();
    assert_eq!(
        reg_set, rust_set,
        "注册表错误码集合与 Rust ALL_ERROR_CODES 不一致"
    );
    // retryable 标志 ↔ Rust 静态判定表（D3 §6.2：retryable=true 才允许自动重试）
    for entry in reg.errors.protocol.iter().chain(reg.errors.business.iter()) {
        let code: DeviceErrorCode = serde_json::from_value(Value::String(entry.code.clone()))
            .unwrap_or_else(|e| panic!("错误码 {} 反序列化失败：{e}", entry.code));
        assert_eq!(
            entry.retryable,
            code.retryable(),
            "错误码 {} 的 retryable 与 Rust 静态判定表不一致",
            entry.code
        );
    }
}

// ── 9.2.5 命令面：44 条 C01-C44 ↔ Rust REMOTE_KINDS/RESULT_KINDS ──

#[test]
fn device_registry_commands_match_rust_kinds() {
    let reg = device_registry();
    assert_eq!(
        reg.commands.len(),
        44,
        "命令必须为 44 条（M6 §4 基线 37：F1 10 + F2 5 + F4 8 + F5 4 + F6 5 + 设备域 5；\
         G 系列 +7：G2 模型 C38/C39、G3 会话操作 C40-C43、G7 技能 C44）"
    );
    let error_codes: std::collections::BTreeSet<&str> =
        all_device_error_codes(&reg).into_iter().collect();
    let command_numbers: std::collections::BTreeSet<&str> =
        reg.commands.iter().map(|c| c.number.as_str()).collect();
    for (i, cmd) in reg.commands.iter().enumerate() {
        let expected_number = format!("C{:02}", i + 1);
        assert_eq!(cmd.number, expected_number, "命令编号必须 C01-C44 连续");
        assert_eq!(
            cmd.kind,
            format!("remote.{}", cmd.name),
            "命令 kind 必须为 remote.<name>"
        );
        assert!(
            !cmd.tauri_command.is_empty(),
            "命令 {} 缺 tauriCommand",
            cmd.kind
        );
        assert!(
            matches!(cmd.surface.as_str(), "engine" | "gui"),
            "命令 {} surface 非法",
            cmd.kind
        );
        assert!(!cmd.domain.is_empty(), "命令 {} 缺 domain", cmd.kind);
        assert!(
            !cmd.idempotency_key.is_empty(),
            "命令 {} 缺 idempotencyKey",
            cmd.kind
        );
        // outbox 语义锁定：出站队列化的必然是写命令（审批/写文件/设置/自动化）
        if cmd.outbox {
            assert!(cmd.write, "命令 {} outbox=true 但 write=false", cmd.kind);
        }
        assert!(
            reg.types.contains_key(&cmd.params_type),
            "命令 {} paramsType 未登记",
            cmd.kind
        );
        assert!(
            reg.types.contains_key(&cmd.result_type),
            "命令 {} resultType 未登记",
            cmd.kind
        );
        for code in &cmd.error_codes {
            assert!(
                error_codes.contains(code.as_str()),
                "命令 {} 引用未登记错误码 {code}",
                cmd.kind
            );
        }
    }
    // 白名单（M6 §4.7 B/C 面：registered=true ∩ surface=engine）必须成规模非空
    let whitelist_count = reg
        .commands
        .iter()
        .filter(|c| c.registered && c.surface == "engine")
        .count();
    assert!(
        whitelist_count >= 10,
        "命令白名单必须成规模非空：{whitelist_count}"
    );
    // remote.* 44 个 kind == Rust REMOTE_KINDS；result.* 44 个 kind == RESULT_KINDS
    let remote_kinds: std::collections::BTreeSet<&str> =
        reg.commands.iter().map(|c| c.kind.as_str()).collect();
    let rust_remote: std::collections::BTreeSet<&str> = REMOTE_KINDS.iter().copied().collect();
    assert_eq!(
        remote_kinds, rust_remote,
        "注册表 remote.* kind 与 Rust REMOTE_KINDS 不一致"
    );
    let result_kinds: std::collections::BTreeSet<&str> = reg
        .kinds
        .iter()
        .filter(|k| k.family == "result")
        .map(|k| k.kind.as_str())
        .collect();
    let rust_result: std::collections::BTreeSet<&str> = RESULT_KINDS.iter().copied().collect();
    assert_eq!(
        result_kinds, rust_result,
        "注册表 result.* kind 与 Rust RESULT_KINDS 不一致"
    );
    // C 编号集合必须与命令表一一对应（防能力位引用悬空）
    assert_eq!(command_numbers.len(), 44);
}

// ── 9.3 能力位全量：注册表 17 位 ↔ Rust ALL_CAPABILITIES wire 名 ──

#[test]
fn device_registry_capabilities_match_rust_all_capabilities() {
    let reg = device_registry();
    assert_eq!(reg.capabilities.len(), 17, "能力位必须为 17 位（M6 §11.2）");
    let reg_names: Vec<String> = reg.capabilities.iter().map(|c| c.name.clone()).collect();
    let rust_wire: Vec<String> = ALL_CAPABILITIES
        .iter()
        .map(|c| {
            serde_json::to_value(c)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(
        reg_names, rust_wire,
        "注册表能力位名（camelCase）与 Rust ALL_CAPABILITIES 序列化名不一致"
    );
    // 每个能力位必须可反序列化还原
    for name in &reg_names {
        let parsed: Capability = serde_json::from_value(Value::String(name.clone()))
            .unwrap_or_else(|e| panic!("能力位 {name} 反序列化失败：{e}"));
        assert_eq!(
            serde_json::to_value(parsed).unwrap(),
            Value::String(name.clone())
        );
    }
    // owner 域合法；C 编号引用必须命中命令表（通配符/kind 字面量允许）
    let command_numbers: std::collections::BTreeSet<&str> =
        reg.commands.iter().map(|c| c.number.as_str()).collect();
    for cap in &reg.capabilities {
        assert!(
            matches!(cap.owner.as_str(), "desktop" | "mobile" | "both"),
            "能力位 {} 的 owner 非法：{}",
            cap.name,
            cap.owner
        );
        for reference in &cap.commands {
            if reference.len() == 3 && reference.starts_with('C') {
                assert!(
                    command_numbers.contains(reference.as_str()),
                    "能力位 {} 引用了未登记命令 {reference}",
                    cap.name
                );
            }
        }
    }
}

// ── 9.4 事件双面策略：49 条同名同序 + sync 白名单 + strategy 逐一锁定 ──

#[test]
fn device_registry_events_match_engine_and_sync_whitelist() {
    let reg = device_registry();
    let engine = registry();
    // 事件段 59 条（49 变体 + D-03 九观测事件 + T1b timeline-truncate；
    // 2026-08-14 契约窗口 tool-input-repaired 核销 + 9 新事件 49 → 57；
    // 2026-08-16 统一输入流收敛战役 T1b 补链 timeline-truncate 57 → 58；
    // 同日 R1 tool-update 死契约删除回落 57；
    // 2026-11-02 BG3 后台结果回注新增两事件 57 → 59）
    assert_eq!(
        reg.events.len(),
        59,
        "事件段必须为 59 条（BG3 后台结果回注新增两事件）"
    );
    let mut strategy_counts: std::collections::BTreeMap<&str, usize> =
        std::collections::BTreeMap::new();
    for (i, ev) in reg.events.iter().enumerate() {
        assert_eq!(ev.id as usize, i + 1, "事件编号必须从 1 连续递增");
        assert_eq!(
            ev.wire,
            AgentEvent::ALL_TYPE_NAMES[i],
            "事件第 {} 条与 AgentEvent 声明顺序不一致",
            i + 1
        );
        assert_eq!(
            ev.wire, engine.events[i].wire,
            "设备注册表事件段与 engine-events.json 同名同序（D3 §7 透传基）"
        );
        assert!(matches!(
            ev.strategy.as_str(),
            "transparent" | "redacted" | "tuple"
        ));
        assert!(matches!(
            ev.realtime.backpressure.as_str(),
            "delta" | "soft" | "critical"
        ));
        assert!(matches!(
            ev.push_level.as_str(),
            "p0" | "p1" | "p2" | "none"
        ));
        // 49 变体全部可经实时面 events.push 下发（P-3 冻结，无 push=false 事件）
        assert!(
            ev.realtime.push,
            "事件 {} 必须可实时推送（events.push）",
            ev.wire
        );
        // sync 标志 ↔ 同步面白名单
        assert_eq!(
            ev.sync,
            SYNC_ELIGIBLE_TYPES.contains(&ev.wire.as_str()),
            "事件 {} 的 sync 标志与 SYNC_ELIGIBLE_TYPES 不一致",
            ev.wire
        );
        // strategy ↔ Rust 静态判定（M6 §5.1 13/18/10 分组）
        let sample = build_event_sample(&engine, &engine.events[i]);
        let parsed: AgentEvent = serde_json::from_value(sample)
            .unwrap_or_else(|e| panic!("事件 {} 按注册表样本反序列化失败：{e}", ev.wire));
        let expected = match ev.strategy.as_str() {
            "transparent" => EventRedactStrategy::Transparent,
            "redacted" => EventRedactStrategy::Redacted,
            "tuple" => EventRedactStrategy::Tuple,
            other => panic!("事件 {} 注册表 strategy 非法：{other}", ev.wire),
        };
        assert_eq!(
            event_cross_strategy(&parsed),
            expected,
            "事件 {} 的跨端裁剪策略与 Rust 判定不一致",
            ev.wire
        );
        *strategy_counts.entry(ev.strategy.as_str()).or_insert(0) += 1;
    }
    // strategy 分组计数（M6 §5.1 13/18/10 基线 + D8 登记 8 变体扩展：
    // recovery-fork=transparent → T 14；recovery-escalated/steering/report/
    // budget-denied + goal-round-started/completed=redacted → R 24；
    // goal-continuation-decided=tuple（prompt 任务级内容 fail-closed）→ U 11；
    // 2026-08-14 D-03 契约窗口：tool-input-repaired 核销（-1 U）+ 9 观测事件
    // 全 redacted（观测字段无正文敏感，对齐 recovery-* 桌面观测面先例）
    // → T 14 / R 33 / U 10；
    // 2026-08-16 T1b：timeline-truncate=transparent（event_cross_strategy 同判，
    // Critical 必达会话内事件透传不裁剪，R1 主控裁决）→ T 15 / R 33 / U 10；
    // 同日 R1：tool-update（redacted）死契约删除 → T 15 / R 32 / U 10；
    // 2026-11-02 BG3：tool-backgrounded / tool-settled 跨端策略未裁决、
    // 先行登记 fail-closed 元组兜底（对齐未登记变体网关默认）→ U 12，
    // 策略裁决归 MOB 移动端消费批次）
    assert_eq!(
        strategy_counts.get("transparent").copied().unwrap_or(0),
        15,
        "透明透传必须为 15 类（M6 §5.1 13 + D8 recovery-fork + T1b timeline-truncate）"
    );
    assert_eq!(
        strategy_counts.get("redacted").copied().unwrap_or(0),
        32,
        "摘要化必须为 32 类（M6 §5.1 18 + D8 六事件 + D-03 九观测事件 - R1 tool-update 删除）"
    );
    assert_eq!(
        strategy_counts.get("tuple").copied().unwrap_or(0),
        12,
        "元组下发必须为 12 类（M6 §5.1 10 + D8 goal-continuation-decided - D-03 tool-input-repaired 核销 + BG3 两事件 fail-closed 兜底）"
    );
}

// ── 9.5 消息体字段：29 条静态消息 ↔ Rust serde 双向锁定 ──

#[test]
fn device_registry_static_message_bodies_match_serde_wire() {
    let reg = device_registry();
    let mut checked = 0;
    for msg in &reg.messages {
        let Some(fields) = &msg.fields else {
            continue; // remote/result 走 CommandRequest/CommandResult 信封（下方单独锁）
        };
        let mut obj = Map::new();
        for f in fields.iter().filter(|f| f.required) {
            obj.insert(
                f.name.clone(),
                device_sample_override(&msg.rust_variant, &f.name)
                    .unwrap_or_else(|| device_sample_value(&reg, &f.ts_type)),
            );
        }
        check_device_body_roundtrip(&msg.rust_variant, fields, Value::Object(obj));
        checked += 1;
    }
    assert_eq!(
        checked, 29,
        "静态消息（内联 fields）必须为 29 条（117 - 44 - 44）"
    );

    // 命令/响应信封单独锁定（remote.* / result.* 共 88 条共用两个 body 类型）
    let request_fields = match reg.types.get("CommandRequest") {
        Some(TypeSpec::Struct { fields }) => fields,
        _ => panic!("types 表必须登记 CommandRequest"),
    };
    let result_fields = match reg.types.get("CommandResult") {
        Some(TypeSpec::Struct { fields }) => fields,
        _ => panic!("types 表必须登记 CommandResult"),
    };
    let request_sample = device_sample_value(&reg, "CommandRequest");
    check_device_body_roundtrip("CommandRequest", request_fields, request_sample);
    let result_sample = device_sample_value(&reg, "CommandResult");
    check_device_body_roundtrip("CommandResult", result_fields, result_sample);
}

// ── 9.6 协议常量：注册表 constants 段 ↔ Rust version 常量 ──

#[test]
fn device_registry_constants_match_rust_version_consts() {
    let reg = device_registry();
    let consts = &reg.constants;
    let expect_u64 = |key: &str, expected: u64| {
        let v = consts
            .get(key)
            .unwrap_or_else(|| panic!("注册表缺常量 {key}"));
        let actual = v
            .as_u64()
            .unwrap_or_else(|| panic!("常量 {key} 必须为整数"));
        assert_eq!(actual, expected, "常量 {key} 与 Rust version 常量不一致");
    };
    expect_u64("PROTOCOL_VERSION", PROTOCOL_VERSION as u64);
    expect_u64("MIN_PROTOCOL_VERSION", MIN_PROTOCOL_VERSION as u64);
    expect_u64("MAX_FRAME_BYTES", MAX_FRAME_BYTES as u64);
    expect_u64("EVENT_WINDOW", EVENT_WINDOW as u64);
    expect_u64("MAX_SUBSCRIPTIONS", MAX_SUBSCRIPTIONS as u64);
    expect_u64("MAX_STREAMS", MAX_STREAMS as u64);
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. 字段集合全等护栏（最大实例口径；补 §2/§3 回环的 Option 盲区）
//
// §2/§3 的回环样本只按注册表「必填」字段构造：Rust 侧若有注册表未登记的
// Option 字段（skip_serializing_if = "Option::is_none"），样本不给值 →
// 反序列化为 None → 回序列化被跳过，回环断言看不见——R7 修复的
// PermissionRequest.requesterRunId/reason 丢失正是此盲区（注册表漏登记
// 时既有测试全绿）。本节以「最大实例」补上字段集合全等断言：
//
// - 每个被注册表覆盖的 struct / tagged 变体 / 事件变体各构造一个全字段
//   满载的 Rust 实例：穷尽字面量书写（Rust 侧增删字段时本节先编译失败，
//   编译器即第一道漂移锁），Option 字段一律 Some，Vec 给一元素；
// - 序列化后取键集合，断言与注册表登记字段名集合全等（事件与 tagged
//   变体另加 tag 键 "type"）。wire 名口径（rename_all / rename /
//   skip_serializing_if）全部由 serde 序列化本身给出，不做反射或名猜测。
//
// 覆盖边界：以注册表现有登记为界——types 段全部 struct、AgentMessageBlock
// 的全部登记变体、events 段全部事件；未登记类型不纳入。
//
// 存量漂移基线 FIELD_SET_DRIFT_BASELINE：本节上线时全量比对发现的既有
// 字段级漂移（均为 Rust 有、注册表漏登记的可选字段）。基线只豁免
// 「实际多出且已登记于此」的字段；注册表多登记的方向（missing）不设
// 基线、直接失败。基线条目必须保持「仍在漂移」：漂移被修复（注册表
// 补登记或 Rust 删字段）后条目自动失效并使测试失败，强制移除——
// 基线只准随漂移修复而缩小，不准新增掩盖新漂移（新漂移必须修注册表
// 或 Rust 本身，而不是进基线）。

use conex_types::events::TurnUsage;
use std::collections::BTreeSet;
use std::sync::Arc;

/// 存量字段漂移基线：（归属名，wire 字段名）。
/// 归属名口径：struct = Rust 类型名；tagged 变体 = "AgentMessageBlock.{wire}"；
/// 事件 = "event:{wire}"。
/// 初始 7 条（event:turn-end/usage、event:tool-start/turnIndex、
/// event:tool-end/{attempt,deduplicated,executedInput}、subagent 两事件的
/// subagentSessionId）已随注册表补登记全部愈合，基线归零（2026-11-01）。
const FIELD_SET_DRIFT_BASELINE: &[(&str, &str)] = &[];

fn field_set_of(value: &Value) -> BTreeSet<String> {
    value
        .as_object()
        .unwrap_or_else(|| panic!("字段集合断言要求对象型序列化结果，实际：{value}"))
        .keys()
        .cloned()
        .collect()
}

/// 断言「注册表登记字段集合 == 最大实例序列化键集合」。
/// extra 方向仅豁免基线条目；missing 方向无豁免。
fn assert_field_set(owner: &str, registered: &BTreeSet<String>, actual: &BTreeSet<String>) {
    let baseline: BTreeSet<&str> = FIELD_SET_DRIFT_BASELINE
        .iter()
        .filter(|(o, _)| *o == owner)
        .map(|(_, f)| *f)
        .collect();
    for f in &baseline {
        assert!(
            actual.contains(*f) && !registered.contains(*f),
            "{owner} 的基线条目 {f} 已不再漂移（注册表已补登记或 Rust 已删字段）：\
             请从 FIELD_SET_DRIFT_BASELINE 移除该条目"
        );
    }
    let extra: Vec<&String> = actual
        .difference(registered)
        .filter(|k| !baseline.contains(k.as_str()))
        .collect();
    let missing: Vec<&String> = registered.difference(actual).collect();
    assert!(
        extra.is_empty() && missing.is_empty(),
        "{owner} 字段集合漂移：Rust 序列化多出注册表外字段 {extra:?}，\
         注册表登记但序列化缺失字段 {missing:?}"
    );
}

fn mx_string() -> String {
    "x".to_string()
}

// ── 最大实例：载荷 struct ──

fn mx_tool_output() -> ToolOutput {
    ToolOutput {
        text: Some(mx_string()),
        json: Some(json!(null)),
        artifacts: Some(vec![ToolArtifact {
            kind: ToolArtifactKind::File,
            title: mx_string(),
            uri: Some(mx_string()),
            text: Some(mx_string()),
            metadata: Some(json!(null)),
        }]),
    }
}

fn mx_tool_metadata() -> ToolMetadata {
    ToolMetadata {
        category: Some(mx_string()),
        is_read_only: Some(false),
        fatal_on_error: Some(false),
        concurrency: Some(mx_string()),
    }
}

fn mx_agent_message() -> AgentMessage {
    AgentMessage {
        id: mx_string(),
        role: AgentMessageRole::Assistant,
        created_at: mx_string(),
        blocks: vec![AgentMessageBlock::Text { text: mx_string() }],
        metadata: Some(json!(null)),
        client_message_id: Some(mx_string()),
        content: Some(mx_string()),
    }
}

fn mx_tool_batch_call() -> ToolBatchCall {
    ToolBatchCall {
        id: mx_string(),
        tool_name: mx_string(),
        summary: mx_string(),
        input: json!(null),
        category: ToolCategory::Terminal,
        concurrency: ToolConcurrency::Parallel,
    }
}

fn mx_tool_batch_result() -> ToolBatchResult {
    ToolBatchResult {
        id: mx_string(),
        tool_name: mx_string(),
        output: mx_tool_output(),
        is_error: false,
        duration_ms: 0,
    }
}

fn mx_provider_diagnostic() -> ProviderDiagnostic {
    ProviderDiagnostic {
        phase: ProviderDiagnosticPhase::RequestStart,
        provider_id: Some(mx_string()),
        endpoint: Some(mx_string()),
        url: Some(mx_string()),
        attempt: Some(0),
        max_attempts: Some(0),
        elapsed_ms: Some(0),
        status: Some(0),
        status_text: Some(mx_string()),
        retryable: Some(false),
        reason: Some(mx_string()),
        error_kind: Some(ProviderErrorKind::Aborted),
        retry_after_ms: Some(0),
        chunks: Some(0),
        bytes: Some(0),
        headers: Some(json!(null)),
        configured_model: Some(mx_string()),
        actual_model: Some(mx_string()),
        model_mismatch: Some(false),
        stream_requested: Some(false),
        system_prompt_wire_mode: Some(SystemPromptWireMode::NativeSystemRole),
        has_system_role: Some(false),
        system_prompt_present: Some(false),
        system_message_count: Some(0),
        rewritten_system_message_count: Some(0),
        message_count: Some(0),
        tool_count: Some(0),
        message_role_counts: Some(json!(null)),
        partial: Some(json!(null)),
    }
}

fn mx_runtime_checkpoint_record() -> RuntimeCheckpointRecord {
    RuntimeCheckpointRecord {
        id: mx_string(),
        kind: RuntimeCheckpointKind::WorkspaceCheckpoint,
        label: mx_string(),
        tool_call_id: mx_string(),
        tool_name: mx_string(),
        artifact_uri: Some(mx_string()),
        manifest_path: Some(mx_string()),
        snapshot_path: Some(mx_string()),
        source_path: Some(mx_string()),
        metadata: Some(json!(null)),
    }
}

fn mx_runtime_checkpoint_restore_record() -> RuntimeCheckpointRestoreRecord {
    RuntimeCheckpointRestoreRecord {
        checkpoint_id: mx_string(),
        tool_call_id: mx_string(),
        tool_name: mx_string(),
        restored: vec![mx_string()],
        deleted: vec![mx_string()],
        skipped: vec![mx_string()],
        metadata: Some(json!(null)),
    }
}

fn mx_permission_request() -> PermissionRequest {
    PermissionRequest {
        id: mx_string(),
        session_id: mx_string(),
        cwd: mx_string(),
        tool_call_id: mx_string(),
        tool_name: mx_string(),
        parameters: json!(null),
        summary: mx_string(),
        tool_metadata: mx_tool_metadata(),
        metadata: Some(json!(null)),
        requester_run_id: Some(mx_string()),
        reason: Some(mx_string()),
    }
}

fn mx_compression_policy() -> ContextCompressionPolicyMetadata {
    ContextCompressionPolicyMetadata {
        tier: ContextCompressionPolicyTier::Manual,
        action: ContextCompressionPolicyAction::Compact,
        forced: false,
        threshold_exceeded: false,
        provider_retry: false,
    }
}

fn mx_compression_handoff() -> ContextCompressionHandoffMetadata {
    ContextCompressionHandoffMetadata {
        trigger: ContextCompressionTrigger::Auto,
        reason: ContextCompressionReason::Manual,
        tier: ContextCompressionPolicyTier::Manual,
        action: ContextCompressionPolicyAction::Compact,
        provider_retry: false,
        summary: mx_string(),
        compressed_message_count: 0,
        kept_message_count: 0,
        tokens_before: 0,
        tokens_after: 0,
        threshold_tokens: 0,
        first_kept_message_id: Some(mx_string()),
        last_message_id: Some(mx_string()),
        last_user_message_id: Some(mx_string()),
        completed_task_summaries: vec![mx_string()],
        pending_tasks: vec![mx_string()],
        session_events: vec![mx_string()],
        file_snapshot_hints: vec![mx_string()],
        recent_successful_commands: vec![mx_string()],
        recent_failed_diagnostics: vec![mx_string()],
    }
}

fn mx_compression_cache_boundary() -> ContextCompressionCacheBoundaryMetadata {
    ContextCompressionCacheBoundaryMetadata {
        kind: mx_string(),
        version: 1,
        stable_prefix_hash: mx_string(),
        cache_key: mx_string(),
        structured_summary_cache_key: mx_string(),
        structured_summary_stable_hash: mx_string(),
        invalidates: vec![CompressionCacheInvalidation::PromptStablePrefix],
        invalidation_reason: ContextCompressionReason::Manual,
        compressed_message_ids: vec![mx_string()],
        kept_message_ids: vec![mx_string()],
        first_kept_message_id: Some(mx_string()),
    }
}

fn mx_compression_record() -> ContextCompressionRecord {
    ContextCompressionRecord {
        id: mx_string(),
        trigger: ContextCompressionTrigger::Auto,
        reason: Some(ContextCompressionReason::Manual),
        policy: Some(mx_compression_policy()),
        summary: mx_string(),
        first_kept_message_id: Some(mx_string()),
        compressed_message_ids: vec![mx_string()],
        kept_message_ids: vec![mx_string()],
        tokens_before: 0,
        tokens_after: 0,
        threshold_tokens: Some(0),
        created_at: mx_string(),
        handoff: Some(mx_compression_handoff()),
        cache_boundary: Some(mx_compression_cache_boundary()),
        details: Some(json!(null)),
    }
}

fn mx_run_cache_stats() -> RunCacheStats {
    RunCacheStats {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cache_miss_tokens: 0,
        sample_count: 0,
        hit_ratio: Some(0.0),
        write_ratio: Some(0.0),
        missed_tokens: 0,
        warm_until_ms: Some(0),
    }
}

fn mx_turn_usage() -> TurnUsage {
    TurnUsage {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cache_miss_tokens: 0,
    }
}

fn mx_impact_assessment() -> ImpactAssessment {
    ImpactAssessment {
        file_count: 0,
        total_size_bytes: 0,
        directory_count: 0,
        cross_directory: false,
        flagged: false,
    }
}

fn mx_subagent_event_payload() -> SubagentEventPayload {
    SubagentEventPayload {
        kind: SubagentEventKind::Progress,
        payload: Some(json!(null)),
    }
}

/// 注册表 types 段 struct 的最大实例序列化（未接入的类型直接 panic，
/// 与 §3 check_payload_struct 同一纪律：新登记类型必须接线）。
fn maximal_struct_json(rust_name: &str) -> Value {
    match rust_name {
        "AgentMessage" => serde_json::to_value(mx_agent_message()).unwrap(),
        "ToolOutput" => serde_json::to_value(mx_tool_output()).unwrap(),
        "ToolArtifact" => serde_json::to_value(ToolArtifact {
            kind: ToolArtifactKind::File,
            title: mx_string(),
            uri: Some(mx_string()),
            text: Some(mx_string()),
            metadata: Some(json!(null)),
        })
        .unwrap(),
        "ToolBatchCall" => serde_json::to_value(mx_tool_batch_call()).unwrap(),
        "ToolBatchResult" => serde_json::to_value(mx_tool_batch_result()).unwrap(),
        "ProviderDiagnostic" => serde_json::to_value(mx_provider_diagnostic()).unwrap(),
        "RuntimeCheckpointRecord" => serde_json::to_value(mx_runtime_checkpoint_record()).unwrap(),
        "RuntimeCheckpointRestoreRecord" => {
            serde_json::to_value(mx_runtime_checkpoint_restore_record()).unwrap()
        }
        "ToolMetadata" => serde_json::to_value(mx_tool_metadata()).unwrap(),
        "PermissionRequest" => serde_json::to_value(mx_permission_request()).unwrap(),
        "ContextCompressionPolicyMetadata" => {
            serde_json::to_value(mx_compression_policy()).unwrap()
        }
        "ContextCompressionHandoffMetadata" => {
            serde_json::to_value(mx_compression_handoff()).unwrap()
        }
        "ContextCompressionCacheBoundaryMetadata" => {
            serde_json::to_value(mx_compression_cache_boundary()).unwrap()
        }
        "ContextCompressionRecord" => serde_json::to_value(mx_compression_record()).unwrap(),
        "RunCacheStats" => serde_json::to_value(mx_run_cache_stats()).unwrap(),
        "ImpactAssessment" => serde_json::to_value(mx_impact_assessment()).unwrap(),
        "SubagentEventPayload" => serde_json::to_value(mx_subagent_event_payload()).unwrap(),
        "TurnUsage" => serde_json::to_value(mx_turn_usage()).unwrap(),
        other => panic!("注册表含未接入字段集合断言的载荷类型 {other}"),
    }
}

#[test]
fn payload_struct_field_sets_match_registry() {
    let reg = registry();
    for (name, spec) in &reg.types {
        let TypeSpec::Struct { fields } = spec else {
            continue;
        };
        let registered: BTreeSet<String> = fields.iter().map(|f| f.name.clone()).collect();
        let actual = field_set_of(&maximal_struct_json(name));
        assert_field_set(name, &registered, &actual);
    }
}

// ── 最大实例：AgentMessageBlock tagged 变体 ──

fn maximal_block_variant(wire: &str) -> AgentMessageBlock {
    match wire {
        "text" => AgentMessageBlock::Text { text: mx_string() },
        "thought" => AgentMessageBlock::Thought {
            text: mx_string(),
            redacted: Some(false),
        },
        "tool-call" => AgentMessageBlock::ToolCall(ToolCallBlock {
            id: mx_string(),
            tool_name: mx_string(),
            input: json!(null),
        }),
        "tool-result" => AgentMessageBlock::ToolResult {
            tool_call_id: mx_string(),
            tool_name: mx_string(),
            output: mx_tool_output(),
            is_error: false,
        },
        "image" => AgentMessageBlock::Image(ImageContentBlock {
            url: Some(mx_string()),
            data: Some(mx_string()),
            mime_type: mx_string(),
            alt: Some(mx_string()),
        }),
        other => panic!("注册表含未接入字段集合断言的 AgentMessageBlock 变体 {other}"),
    }
}

#[test]
fn tagged_block_variant_field_sets_match_registry() {
    let reg = registry();
    let spec = reg
        .types
        .get("AgentMessageBlock")
        .expect("注册表必须含 AgentMessageBlock");
    let TypeSpec::Tagged { tag, variants } = spec else {
        panic!("AgentMessageBlock 必须是 tagged 类型");
    };
    assert_eq!(tag, "type");
    for v in variants {
        let mut registered: BTreeSet<String> = v.fields.iter().map(|f| f.name.clone()).collect();
        registered.insert(tag.clone());
        let actual = field_set_of(&serde_json::to_value(maximal_block_variant(&v.name)).unwrap());
        assert_field_set(
            &format!("AgentMessageBlock.{}", v.name),
            &registered,
            &actual,
        );
    }
}

// ── 最大实例：事件变体 ──

/// 注册表 events 段事件的最大实例（按 rust_variant 分发；未接入直接
/// panic，与 §3 同一纪律：新登记事件必须接线）。
#[allow(clippy::too_many_lines)]
fn maximal_event(rust_variant: &str) -> AgentEvent {
    let s = mx_string();
    match rust_variant {
        "AgentStart" => AgentEvent::AgentStart {
            session_id: s.clone(),
            timestamp: s.clone(),
        },
        "AgentEnd" => AgentEvent::AgentEnd {
            session_id: s.clone(),
            timestamp: s.clone(),
            reason: AgentEndReason::Stop,
            error: Some(s.clone()),
        },
        "TurnStart" => AgentEvent::TurnStart {
            session_id: s.clone(),
            turn_index: 0,
            timestamp: s.clone(),
        },
        "TurnEnd" => AgentEvent::TurnEnd {
            session_id: s.clone(),
            turn_index: 0,
            timestamp: s.clone(),
            tool_call_count: 0,
            usage: Some(TurnUsage::default()),
        },
        "MessageStart" => AgentEvent::MessageStart {
            session_id: s.clone(),
            message: Arc::new(mx_agent_message()),
        },
        "MessageDelta" => AgentEvent::MessageDelta {
            session_id: s.clone(),
            timestamp: s.clone(),
            message_id: s.clone(),
            block: AgentMessageBlock::Text { text: s.clone() },
        },
        "MessageEnd" => AgentEvent::MessageEnd {
            session_id: s.clone(),
            message: Arc::new(mx_agent_message()),
            turn_index: Some(0),
        },
        "ToolStart" => AgentEvent::ToolStart {
            session_id: s.clone(),
            batch_id: s.clone(),
            call: mx_tool_batch_call(),
            timestamp: s.clone(),
            turn_index: Some(0),
        },
        "ToolEnd" => AgentEvent::ToolEnd {
            session_id: s.clone(),
            batch_id: s.clone(),
            result: mx_tool_batch_result(),
            timestamp: s.clone(),
            attempt: Some(0),
            deduplicated: Some(false),
            executed_input: Some(json!(null)),
        },
        "ToolBatchStart" => AgentEvent::ToolBatchStart {
            session_id: s.clone(),
            batch_id: s.clone(),
            timestamp: s.clone(),
            summary: s.clone(),
            calls: vec![mx_tool_batch_call()],
        },
        "ToolBatchEnd" => AgentEvent::ToolBatchEnd {
            session_id: s.clone(),
            batch_id: s.clone(),
            timestamp: s.clone(),
            calls: vec![mx_tool_batch_result()],
        },
        "ContextCompressionStart" => AgentEvent::ContextCompressionStart {
            session_id: s.clone(),
            timestamp: s.clone(),
            reason: s.clone(),
            tokens_before: 0,
        },
        "ContextCompressionEnd" => AgentEvent::ContextCompressionEnd {
            session_id: s.clone(),
            timestamp: s.clone(),
            result: Some(Box::new(mx_compression_record())),
            aborted: false,
            error: Some(s.clone()),
        },
        "ProviderDiagnostic" => AgentEvent::ProviderDiagnostic {
            session_id: s.clone(),
            timestamp: s.clone(),
            diagnostic: mx_provider_diagnostic(),
        },
        "RuntimeError" => AgentEvent::RuntimeError {
            session_id: s.clone(),
            timestamp: s.clone(),
            error: s.clone(),
            retryable: Some(false),
        },
        "RuntimeSteering" => AgentEvent::RuntimeSteering {
            session_id: s.clone(),
            timestamp: s.clone(),
            reason: s.clone(),
            message: mx_agent_message(),
        },
        "RuntimeInterventionRequired" => AgentEvent::RuntimeInterventionRequired {
            session_id: s.clone(),
            timestamp: s.clone(),
            reason: s.clone(),
            choices: vec![s.clone()],
            message: s.clone(),
        },
        "ApprovalRequested" => AgentEvent::ApprovalRequested {
            session_id: s.clone(),
            request: mx_permission_request(),
            timestamp: s.clone(),
        },
        "ApprovalResolved" => AgentEvent::ApprovalResolved {
            session_id: s.clone(),
            tool_call_id: s.clone(),
            request_id: Some(s.clone()),
            decision: ApprovalDecision::Approved,
            timestamp: s.clone(),
        },
        "CheckpointCreated" => AgentEvent::CheckpointCreated {
            session_id: s.clone(),
            timestamp: s.clone(),
            checkpoint: mx_runtime_checkpoint_record(),
        },
        "CheckpointRestored" => AgentEvent::CheckpointRestored {
            session_id: s.clone(),
            timestamp: s.clone(),
            restore: mx_runtime_checkpoint_restore_record(),
        },
        "RunTerminal" => AgentEvent::RunTerminal {
            session_id: s.clone(),
            run_id: s.clone(),
            timestamp: s.clone(),
            terminal: RunTerminalStatus::Completed,
            error: Some(s.clone()),
        },
        "CacheStatsUpdated" => AgentEvent::CacheStatsUpdated {
            session_id: s.clone(),
            timestamp: s.clone(),
            stats: mx_run_cache_stats(),
        },
        "CacheWasteAlert" => AgentEvent::CacheWasteAlert {
            session_id: s.clone(),
            timestamp: s.clone(),
            attribution: MissAttribution::Cold,
            missed_tokens: 0,
            idle_ms: 0,
            model_changed: false,
            missed_cost_usd: Some(0.0),
        },
        "ColdCacheWarning" => AgentEvent::ColdCacheWarning {
            session_id: s.clone(),
            timestamp: s.clone(),
            ttl_seconds: 0,
            idle_ms: 0,
            resend_estimate_tokens: 0,
        },
        "SecurityAudit" => AgentEvent::SecurityAudit {
            session_id: s.clone(),
            timestamp: s.clone(),
            operation: SecurityAuditOperation::Delete,
            targets: vec![s.clone()],
            impact: mx_impact_assessment(),
            decision: SecurityAuditDecision::Allowed,
            permission_mode: Some(s.clone()),
            tool_call_id: Some(s.clone()),
        },
        "SubagentStarted" => AgentEvent::SubagentStarted {
            session_id: s.clone(),
            subagent_id: s.clone(),
            subagent_run_id: s.clone(),
            role: s.clone(),
            capability_mode: s.clone(),
            started_at: s.clone(),
            description: Some(s.clone()),
            mode: Some(s.clone()),
            parent_tool_call_id: Some(s.clone()),
            subagent_session_id: Some(s.clone()),
        },
        "SubagentEvent" => AgentEvent::SubagentEvent {
            session_id: s.clone(),
            subagent_id: s.clone(),
            subagent_run_id: s.clone(),
            event: mx_subagent_event_payload(),
        },
        "SubagentEnded" => AgentEvent::SubagentEnded {
            session_id: s.clone(),
            subagent_id: s.clone(),
            subagent_run_id: s.clone(),
            status: SubagentEndStatus::Completed,
            summary: Some(s.clone()),
            ended_at: s.clone(),
            subagent_session_id: Some(s.clone()),
        },
        "TaskStarted" => AgentEvent::TaskStarted {
            session_id: s.clone(),
            task_id: s.clone(),
            command: s.clone(),
            cwd: s.clone(),
            owner_run_id: s.clone(),
            is_daemon: false,
        },
        "TaskOutput" => AgentEvent::TaskOutput {
            session_id: s.clone(),
            task_id: s.clone(),
            line: Some(s.clone()),
            chunk: Some(s.clone()),
            line_count: Some(0),
        },
        "TaskHeartbeat" => AgentEvent::TaskHeartbeat {
            session_id: s.clone(),
            task_id: s.clone(),
            resource: json!(null),
        },
        "TaskSuspicious" => AgentEvent::TaskSuspicious {
            session_id: s.clone(),
            task_id: s.clone(),
            silence_ms: 0,
            last_output_at_ms: 0,
        },
        "TaskCompleted" => AgentEvent::TaskCompleted {
            session_id: s.clone(),
            task_id: s.clone(),
            exit_code: 0,
            duration_ms: 0,
            line_count: 0,
        },
        "TaskFailed" => AgentEvent::TaskFailed {
            session_id: s.clone(),
            task_id: s.clone(),
            exit_code: 0,
            tail: vec![s.clone()],
            duration_ms: 0,
        },
        "TaskKilled" => AgentEvent::TaskKilled {
            session_id: s.clone(),
            task_id: s.clone(),
            via_force: false,
            diagnostics: Some(s.clone()),
        },
        "TimerFired" => AgentEvent::TimerFired {
            session_id: s.clone(),
            timer_id: s.clone(),
            prompt: s.clone(),
            fired_at_ms: 0,
        },
        "TimerCancelled" => AgentEvent::TimerCancelled {
            session_id: s.clone(),
            timer_id: s.clone(),
            reason: s.clone(),
            cancelled_at_ms: 0,
        },
        "CronFired" => AgentEvent::CronFired {
            session_id: s.clone(),
            cron_id: s.clone(),
            prompt: s.clone(),
            expression: s.clone(),
            iteration: 0,
            fired_at_ms: 0,
        },
        "RecoveryEscalated" => AgentEvent::RecoveryEscalated {
            session_id: s.clone(),
            subagent_run_id: Some(s.clone()),
            kind: s.clone(),
            retries: 0,
            elapsed_ms: 0,
            detail: Some(s.clone()),
        },
        "RecoverySteering" => AgentEvent::RecoverySteering {
            session_id: s.clone(),
            subagent_id: s.clone(),
            subagent_run_id: s.clone(),
            fingerprint: s.clone(),
            retries: 0,
            remaining_status: s.clone(),
            pending: false,
            created_at_ms: 0,
        },
        "RecoveryFork" => AgentEvent::RecoveryFork {
            session_id: s.clone(),
            fingerprint: s.clone(),
            subagent_id: s.clone(),
            from_run_id: s.clone(),
            from_leaf_id: s.clone(),
            new_run_id: s.clone(),
            new_leaf_id: s.clone(),
            context_mode: s.clone(),
        },
        "RecoveryReport" => AgentEvent::RecoveryReport {
            session_id: s.clone(),
            subagent_id: s.clone(),
            subagent_run_id: s.clone(),
            stuck_at_ms: 0,
            suggestion: s.clone(),
        },
        "RecoveryBudgetDenied" => AgentEvent::RecoveryBudgetDenied {
            session_id: s.clone(),
            subagent_run_id: Some(s.clone()),
            fingerprint: s.clone(),
            count: 0,
            max: 0,
        },
        "GoalRoundStarted" => AgentEvent::GoalRoundStarted {
            round: 0,
            max_rounds: 0,
            goal: s.clone(),
        },
        "GoalRoundCompleted" => AgentEvent::GoalRoundCompleted {
            round: 0,
            tool_call_count: 0,
            tool_success_count: 0,
            message_count: 0,
            decision: s.clone(),
            reason_detail: s.clone(),
            stalled_delta: 0,
            evidence: s.clone(),
        },
        "GoalContinuationDecided" => AgentEvent::GoalContinuationDecided {
            action: s.clone(),
            reason: s.clone(),
            prompt: Some(s.clone()),
            progress_signature: Some(s.clone()),
            detail: Some(s.clone()),
        },
        "SteeringEvaluated" => AgentEvent::SteeringEvaluated {
            session_id: s.clone(),
            timestamp: s.clone(),
            phase: s.clone(),
            hit_strategies: vec![s.clone()],
            steering_count_before: 0,
            steering_count_after: 0,
            budget_remaining: Some(0),
            reset: false,
        },
        "ControlIntent" => AgentEvent::ControlIntent {
            session_id: s.clone(),
            timestamp: s.clone(),
            kind: s.clone(),
            intent_id: s.clone(),
            source: Some(s.clone()),
            reason: Some(s.clone()),
            state: s.clone(),
        },
        "HookOutcome" => AgentEvent::HookOutcome {
            session_id: s.clone(),
            timestamp: s.clone(),
            hook_type: s.clone(),
            outcome: s.clone(),
            hook_name: Some(s.clone()),
            blocked_reason: Some(s.clone()),
        },
        "SummaryBackground" => AgentEvent::SummaryBackground {
            session_id: s.clone(),
            timestamp: s.clone(),
            phase: s.clone(),
            attempt: 0,
            reason: Some(s.clone()),
            message_id: Some(s.clone()),
        },
        "StageSummaryMilestone" => AgentEvent::StageSummaryMilestone {
            session_id: s.clone(),
            timestamp: s.clone(),
            milestone_type: s.clone(),
            tier: Some(s.clone()),
            milestone_index: Some(0),
        },
        "NudgeEnqueued" => AgentEvent::NudgeEnqueued {
            session_id: s.clone(),
            timestamp: s.clone(),
            reason: s.clone(),
            target_ring: s.clone(),
            overwrote: false,
        },
        "RecoveryAcknowledged" => AgentEvent::RecoveryAcknowledged {
            session_id: s.clone(),
            timestamp: s.clone(),
            notification_id: Some(s.clone()),
            subagent_run_id: s.clone(),
        },
        "RecoveryRetryAttempted" => AgentEvent::RecoveryRetryAttempted {
            session_id: s.clone(),
            timestamp: s.clone(),
            attempt: 0,
            delay_ms: 0,
            budget_remaining: 0,
            from_run_id: s.clone(),
            new_run_id: s.clone(),
        },
        "ProviderRequestAnchored" => AgentEvent::ProviderRequestAnchored {
            session_id: s.clone(),
            timestamp: s.clone(),
            turn_index: 0,
            model: Some(s.clone()),
            request_started_at_ms: 0,
        },
        "TimelineTruncate" => AgentEvent::TimelineTruncate {
            session_id: s.clone(),
            run_id: s.clone(),
            boundary_seq: 0,
            reason: TimelineTruncateReason::UserRequested,
            target_message_id: s.clone(),
            timestamp: s.clone(),
        },
        // BG3（2026-11-02）：后台回注两事件的最大样本（字段集断言
        // 接入——settled 的 result 复用 ToolEnd 的 mx 样本构造）
        "ToolBackgrounded" => AgentEvent::ToolBackgrounded {
            session_id: s.clone(),
            call_id: s.clone(),
            tool_name: s.clone(),
            elapsed_ms: 0,
        },
        "ToolSettled" => AgentEvent::ToolSettled {
            session_id: s.clone(),
            call_id: s.clone(),
            tool_name: s.clone(),
            status: ToolSettledStatus::Ok,
            result: mx_tool_batch_result(),
        },
        other => panic!("注册表含未接入字段集合断言的事件变体 {other}"),
    }
}

#[test]
fn event_field_sets_match_registry() {
    let reg = registry();
    for ev in &reg.events {
        let mut registered: BTreeSet<String> = ev.fields.iter().map(|f| f.name.clone()).collect();
        registered.insert("type".to_string());
        let actual = field_set_of(&serde_json::to_value(maximal_event(&ev.rust_variant)).unwrap());
        assert_field_set(&format!("event:{}", ev.wire), &registered, &actual);
    }
}
