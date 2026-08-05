//! 事件注册表漂移护栏（R3 T6 契约生成链路）
//!
//! 唯一事实源：crates/conex-types/src/events.rs 的 [AgentEvent] enum 及
//! message/tool 模块的载荷结构（serde 属性即 wire 规范）。注册表文件
//! contracts/engine-events.json 是给生成脚本（scripts/generate-engine-bindings.mjs）
//! 的机器可读导出，本测试把注册表与 Rust 侧真实 serde 行为双向锁定：
//!
//! - 事件清单：注册表 38 个 type 名与顺序 == [AgentEvent::ALL_TYPE_NAMES]
//!   （enum 声明顺序，编号 1-38 连续）；
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

use conex_types::{
    AgentEndReason, AgentEvent, AgentMessage, AgentMessageBlock, AgentMessageRole,
    ApprovalDecision, BackpressureLevel, ImpactAssessment, MissAttribution, PermissionRequest,
    ProviderDiagnostic, ProviderDiagnosticPhase, ProviderErrorKind, RunCacheStats,
    RunTerminalStatus, RuntimeCheckpointKind, RuntimeCheckpointRecord,
    RuntimeCheckpointRestoreRecord, SecurityAuditDecision, SecurityAuditOperation,
    SubagentEndStatus, SubagentEventKind, SubagentEventPayload, SystemPromptWireMode,
    ToolArtifact, ToolArtifactKind, ToolBatchCall, ToolBatchResult, ToolCallBlock, ToolCategory,
    ToolConcurrency, ToolMetadata, ToolOutput, ToolProgressUpdate,
};
use conex_types::tool::{
    CompressionCacheInvalidation, ContextCompressionCacheBoundaryMetadata,
    ContextCompressionHandoffMetadata, ContextCompressionPolicyAction,
    ContextCompressionPolicyMetadata, ContextCompressionPolicyTier, ContextCompressionReason,
    ContextCompressionRecord, ContextCompressionTrigger,
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
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum TypeSpec {
    Struct { fields: Vec<FieldSpec> },
    Tagged { tag: String, variants: Vec<VariantSpec> },
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
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("读取事件注册表 {path} 失败：{e}"));
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
    assert_eq!(reg.contract, "engine-events", "注册表契约名必须为 engine-events");
    assert_eq!(reg.schema_version, 1);
    assert_eq!(reg.event_count, 38);
    assert_eq!(reg.events.len(), 38, "事件注册表必须是 38 条");
    assert_eq!(
        AgentEvent::ALL_TYPE_NAMES.len(),
        38,
        "AgentEvent enum 必须是 38 种域事件"
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
        assert_eq!(ev.rust_variant, type_name_guess(&ev.wire), "rustVariant 与 wire 不一致：{}", ev.wire);
        // 每个事件都必须登记 domain（域归属，供生成器与前端路由使用）
        assert!(!ev.domain.is_empty(), "事件 {} 缺 domain 字段", ev.wire);
        // 每个事件都必须携带 sessionId 且必填（协议硬约束，03 §5.1）
        let session = ev
            .fields
            .iter()
            .find(|f| f.name == "sessionId")
            .unwrap_or_else(|| panic!("事件 {} 缺 sessionId 字段", ev.wire));
        assert!(session.required, "事件 {} 的 sessionId 必须必填", ev.wire);
        // 每个事件都必须标注背压级别（I5-M7：静态可判定，04 报告 1e）
        assert!(
            matches!(ev.backpressure.as_str(), "delta" | "soft" | "critical"),
            "事件 {} 的 backpressure 非法：{}",
            ev.wire,
            ev.backpressure
        );
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
            matches!(kb.get(value).map(String::as_str), Some("delta" | "soft" | "critical")),
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
        "ToolProgressUpdate" => check_roundtrip::<ToolProgressUpdate>(rust_name, fields, sample),
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
    check_enum!(reg, "ContextCompressionTrigger", ContextCompressionTrigger, 8);
    check_enum!(reg, "ContextCompressionReason", ContextCompressionReason, 6);
    check_enum!(reg, "ContextCompressionPolicyTier", ContextCompressionPolicyTier, 5);
    check_enum!(reg, "ContextCompressionPolicyAction", ContextCompressionPolicyAction, 2);
    check_enum!(
        reg,
        "CompressionCacheInvalidation",
        CompressionCacheInvalidation,
        4
    );
    check_enum!(reg, "MissAttribution", MissAttribution, 8);
    check_enum!(reg, "SecurityAuditOperation", SecurityAuditOperation, 6);
    check_enum!(reg, "SecurityAuditDecision", SecurityAuditDecision, 6);
    check_enum!(reg, "SubagentEventKind", SubagentEventKind, 3);
    check_enum!(reg, "SubagentEndStatus", SubagentEndStatus, 3);
}

/// 事件总数仍为 38：`operation` 是 security-audit 载荷内的字段值
/// （SecurityAuditOperation 枚举），不是独立事件类型——新增 operation
/// 值不改变事件清单；本测试锚定「注册表值 ↔ serde 行为」双向不漂移。
#[test]
fn security_audit_undeclared_write_operation_stays_in_sync() {
    let reg = registry();
    // 事件总数保持 38（operation 值是载荷内字段，非独立事件类型；
    // 2026-08-04 T-AB-17 任务域兼容新增七事件，31 → 38）
    assert_eq!(reg.event_count, 38, "新增 operation 值不得改变事件总数");
    assert_eq!(reg.events.len(), 38);

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
    // 从 38 事件出发做传递闭包；JsonValue/string/number/boolean 为基元。
    let mut reachable: std::collections::BTreeSet<String> =
        reg.events.iter().flat_map(|e| e.fields.iter()).map(|f| f.ts_type.clone()).collect();
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
                TypeSpec::Tagged { variants, .. } => {
                    variants.iter().flat_map(|v| v.fields.iter()).map(|f| f.ts_type.clone()).collect()
                }
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

// ── 6. 信封帧（emit 层注入 runId/sequence/schemaVersion）与事件体并存 ──

#[test]
fn envelope_wire_fields_are_separate_from_event_body() {
    // runId/sequence/schemaVersion 属信封（emit 层注入），不得进入事件体注册表
    let reg = registry();
    for ev in &reg.events {
        // 特例：run-terminal 事件体自带 runId（03 §5.1-16），唯一例外，
        // 其余事件不得把信封 runId/sequence/schemaVersion 登记为事件体字段
        let is_run_terminal = ev.wire == "run-terminal";
        for f in &ev.fields {
            assert_ne!(f.name, "sequence", "事件 {} 不应把信封 sequence 登记为事件体字段", ev.wire);
            assert_ne!(f.name, "schemaVersion", "事件 {} 不应把信封 schemaVersion 登记为事件体字段", ev.wire);
            if !is_run_terminal {
                assert_ne!(f.name, "runId", "事件 {} 不应把信封 runId 登记为事件体字段", ev.wire);
            }
        }
        if is_run_terminal {
            assert!(
                ev.fields.iter().any(|f| f.name == "runId" && f.required),
                "run-terminal 必须登记必填 runId"
            );
        }
    }
    // 样本构造覆盖全量事件时，run-terminal 的 runId 必须能被 serde 接受
    let run_terminal = reg
        .events
        .iter()
        .find(|e| e.wire == "run-terminal")
        .expect("注册表必须有 run-terminal");
    let sample = build_event_sample(&reg, run_terminal);
    let parsed: AgentEvent = serde_json::from_value(sample)
        .unwrap_or_else(|e| panic!("run-terminal 注册表样本反序列化失败：{e}"));
    let out = serde_json::to_value(&parsed).unwrap();
    assert_eq!(out["runId"], json!("x"));
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
    let kb = ev.kind_backpressure.as_ref().expect("kindBackpressure 必须存在");
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
    assert_eq!(level_of("message-delta"), "delta", "message-delta 必须保持 Delta（可丢）");
    assert_eq!(level_of("subagent-started"), "critical", "subagent-started 必达");
    assert_eq!(level_of("subagent-ended"), "critical", "subagent-ended 必达");
    assert_eq!(level_of("subagent-event"), "delta", "subagent-event 基级为 Delta");
    // 任务域七事件分级锚定（T-AB-17 §4.5 冻结契约，防分级漂移）
    assert_eq!(level_of("task-output"), "delta", "task-output 为 Delta（可丢不落库）");
    assert_eq!(level_of("task-heartbeat"), "delta", "task-heartbeat 为 Delta（可丢不落库）");
    assert_eq!(level_of("task-suspicious"), "soft", "task-suspicious 为 Soft（尽力投递留痕）");
    for wire in ["task-started", "task-completed", "task-failed", "task-killed"] {
        assert_eq!(level_of(wire), "critical", "任务事件 {wire} 为 Critical（终态必达落库）");
    }
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
        assert_eq!(level_of(wire), "critical", "事件 {wire} 必须保持 Critical（既有语义）");
    }
}
