//! 事件注册表漂移护栏（R3 T6 契约生成链路）
//!
//! 唯一事实源：crates/conex-types/src/events.rs 的 [AgentEvent] enum 及
//! message/tool 模块的载荷结构（serde 属性即 wire 规范）。注册表文件
//! contracts/engine-events.json 是给生成脚本（scripts/generate-engine-bindings.mjs）
//! 的机器可读导出，本测试把注册表与 Rust 侧真实 serde 行为双向锁定：
//!
//! - 事件清单：注册表 24 个 type 名与顺序 == [AgentEvent::ALL_TYPE_NAMES]
//!   （enum 声明顺序，编号 1-24 连续）；
//! - 事件字段：按注册表必填字段构造样本 → 反序列化为 [AgentEvent] →
//!   回序列化，断言必填字段全部在场、且无注册表外字段（字段名漂移即失败）；
//! - 载荷结构：同一模式逐类型回环（struct + tagged enum 全变体）；
//! - 枚举：注册表值逐项反序列化并回写一致 + 变体数锁定；
//! - 可达性：注册表内所有 types/enums 必须被事件（或其载荷）传递引用，
//!   禁止注册表塞入与事件链路无关的死条目。
//!
//! 任何一侧改动不同步（改 enum 不更新注册表 / 改注册表不匹配 serde），
//! `cargo test -p conex-types` 立即失败。

use conex_types::{
    AgentEndReason, AgentEvent, AgentMessage, AgentMessageBlock, AgentMessageRole,
    ApprovalDecision, PermissionRequest, ProviderDiagnostic, ProviderDiagnosticPhase,
    ProviderErrorKind, RunTerminalStatus, RuntimeCheckpointKind, RuntimeCheckpointRecord,
    RuntimeCheckpointRestoreRecord, SystemPromptWireMode, ToolArtifact, ToolArtifactKind,
    ToolBatchCall, ToolBatchResult, ToolCallBlock, ToolCategory, ToolConcurrency, ToolMetadata,
    ToolOutput, ToolProgressUpdate,
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
    assert_eq!(reg.event_count, 24);
    assert_eq!(reg.events.len(), 24, "事件注册表必须是 24 条");
    assert_eq!(
        AgentEvent::ALL_TYPE_NAMES.len(),
        24,
        "AgentEvent enum 必须是 24 种域事件"
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
fn event_fields_match_serde_wire_for_all_24() {
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
}

// ── 5. 可达性：注册表不允许死条目 ──

#[test]
fn registry_entries_are_reachable_from_events() {
    let reg = registry();
    // 从 24 事件出发做传递闭包；JsonValue/string/number/boolean 为基元。
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
