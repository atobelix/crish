//! JSON Schema 规范化（P1 阶段 1 步骤 1.2；前缀稳定性——schema 是 tools 数组的
//! 一部分，properties/required 键序漂移会打爆整段缓存前缀）
//!
//! 规则真源：`docs/cache-optimization/03-plans/P6-ts-shell-sync.md` §3.1
//!（R1/R2 是 TS/Rust 双侧共享规范；任何一侧行为与规则冲突即视为 bug）。
//! 实现对照 P1 §3.2 A3（已按 A1-03 修正逐条对齐 R2.1-R2.9）+ 迁移
//! directFetchBridge.canonicalizeJsonSchema 语义并扩到 opencode
//! sanitizeOpenAISchema 的规范化面。
//!
//! 为什么在 agent-provider 而不在 agent-tools：工具注册表（agent-tools）是执行域，
//! wire 域（OpenAI tools 格式）的规范化属于请求构造层，agent-provider 已有
//! `to_openai_tool` / `to_responses_tool` 作为单一出口，在此单点接线（P1 §3.2 A3）。

use serde_json::{json, Map, Value};

/// 递归规范化 JSON Schema：确定性重建（幂等）。
///
/// 规则（P6 §3.1 R2.1-R2.9，逐条对齐）：
/// - R2.1：非对象 / 空 schema → 归一为 `{"type":"object","properties":{}}`；
/// - R2.2：布尔 schema → `{"type":"string"}`（对齐 opencode sanitizeOpenAISchema）；
/// - R2.3：`type` 数组 → 过滤合法类型（object/array/string/number/integer/
///   boolean/null）去重 + 白名单固定序（type 数组语义无序，语义等价输入
///   必须收敛到相同字节）；过滤后单元素 → 收敛为单值字符串；
///   过滤后空 → 丢弃该键；非数组 → 保留；
/// - R2.4：`properties` 键按码点升序，值递归应用本表；非对象 → 丢弃该键
///   （与 R2.5 required 非数组丢弃同类处理）；
/// - R2.5：`required` 数组去重 + 码点升序（过滤非字符串项）；非数组 → 丢弃该键；
/// - R2.6：`const` → `enum: [const值]` 并删除 const 键（对齐 opencode 语义；
///   与既有 enum 并存时 const 覆盖，字面语义）；
/// - R2.7：`$defs` / `definitions` 键按码点排序，每个定义递归应用本表；
/// - R2.8：其余键原值保留；`items` / `oneOf` / `anyOf` / `allOf` 为数组/对象时
///   递归应用本表（数组顺序保留——顺序是语义）；`additionalProperties`（对象）/
///   `not` / `if` / `then` / `else` 递归（P1 §3.2 A3 一致性扩展）；
/// - `$ref`：视为叶子，原样保留、不深入（无法解析远端引用）；
/// - R2.9：输出键序固定：`type` → `properties` → `required` → `items` → `enum`
///   → `$defs` → 其余键按码点升序——**不是全量字典序**，必须与 TS 侧
///   `canonicalizeJsonSchema` 字节一致。
pub fn canonicalize_schema(value: &Value) -> Value {
    // R2.2：布尔 schema → {"type":"string"}（优先级高于 R2.1）
    if value.is_boolean() {
        return json!({ "type": "string" });
    }
    // R2.1：非对象（字符串/数字/数组/null）→ 归一为 {"type":"object","properties":{}}
    let Some(obj) = value.as_object() else {
        return json!({ "type": "object", "properties": {} });
    };

    // 各固定槽位（R2.9 序列化顺序）与其余键收集
    let mut slot_type: Option<Value> = None;
    let mut slot_properties: Option<Value> = None;
    let mut slot_required: Option<Value> = None;
    let mut slot_items: Option<Value> = None;
    let mut slot_enum: Option<Value> = None;
    let mut slot_const: Option<Value> = None;
    let mut slot_defs: Option<Value> = None;
    let mut rest: Map<String, Value> = Map::new();

    for (key, val) in obj {
        match key.as_str() {
            "type" => slot_type = normalize_type(val),
            "properties" => slot_properties = normalize_properties(val),
            "required" => slot_required = normalize_required(val),
            // R2.8：items 对象/数组形态递归，其余形态原值保留
            "items" => slot_items = Some(normalize_subschema(val)),
            // R2.8：enum 原值保留（R2.9 固定键序槽位；const 存在时被 R2.6 覆盖）
            "enum" => slot_enum = Some(val.clone()),
            // R2.6：const → enum: [const 值]（与 enum 并存时 const 覆盖）
            "const" => slot_const = Some(val.clone()),
            // R2.7：$defs 固定槽位，键排序 + 递归
            "$defs" => slot_defs = Some(normalize_defs(val)),
            // R2.7：definitions 同款处理；键位落"其余键"码点升序区（R2.9）
            "definitions" => {
                rest.insert(key.clone(), normalize_defs(val));
            }
            // R2.8：其余键原值保留；含递归的一致性扩展键
            _ => {
                rest.insert(key.clone(), normalize_other(key, val));
            }
        }
    }

    let mut out: Map<String, Value> = Map::new();
    // R2.9：固定键序逐槽位插入（type → properties → required → items → enum → $defs）
    if let Some(v) = slot_type {
        out.insert("type".to_string(), v);
    }
    if let Some(v) = slot_properties {
        out.insert("properties".to_string(), v);
    }
    if let Some(v) = slot_required {
        out.insert("required".to_string(), v);
    }
    if let Some(v) = slot_items {
        out.insert("items".to_string(), v);
    }
    // R2.6：const → {enum: [const值]}（覆盖既有 enum，字面语义）
    if let Some(c) = slot_const {
        out.insert("enum".to_string(), json!([c]));
    } else if let Some(e) = slot_enum {
        out.insert("enum".to_string(), e);
    }
    if let Some(v) = slot_defs {
        out.insert("$defs".to_string(), v);
    }
    // 其余键按码点升序（R2.9 尾部；String::cmp = UTF-8 码点序，P6 R1 同款，
    // 禁止 localeCompare）
    let mut rest_keys: Vec<String> = rest.keys().cloned().collect();
    rest_keys.sort();
    for k in rest_keys {
        if let Some(v) = rest.remove(&k) {
            out.insert(k, v);
        }
    }

    // R2.1：处理后仍为空对象（如 required 非数组被丢弃、type 数组过滤后为空）
    // → 归一，保证幂等
    if out.is_empty() {
        return json!({ "type": "object", "properties": {} });
    }
    Value::Object(out)
}

/// 确定性 JSON 序列化：递归把对象键按码点升序排序后输出紧凑字符串。
///
/// 用途（P1 §1.3/§2.4）：
/// 1. 测试断言——跨形态/跨侧字节一致的确定性基础；
/// 2. P2 前缀哈希的稳定输入基础（防御性确定性：未来任一 crate 引入
///    serde_json preserve_order 时规范化保证不漂移）；
/// 3. tool_call arguments 的 wire 序列化（P1 C2）。
pub fn canonical_json_string(value: &Value) -> String {
    fn render(v: &Value) -> String {
        match v {
            Value::Object(map) => {
                // 显式收集排序，而非依赖 Map 迭代序（防御 preserve_order 形态）
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let body = keys
                    .iter()
                    .map(|k| {
                        format!(
                            "{}:{}",
                            serde_json::to_string(*k).unwrap_or_default(),
                            render(&map[*k])
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!("{{{body}}}")
            }
            Value::Array(items) => {
                let body = items.iter().map(render).collect::<Vec<_>>().join(",");
                format!("[{body}]")
            }
            other => serde_json::to_string(other).unwrap_or_default(),
        }
    }
    render(value)
}

/// R2.3：type 字段归一化。数组形态 → 过滤合法类型 + 去重，按白名单固定序
/// 排序（type 数组语义无序：`["string","number"]` 与 `["number","string"]`
/// 语义等价，必须收敛到相同字节——对齐 P1 E1"去重固定序"）；过滤后单元素
/// 收敛为字符串；过滤后为空 → None（丢弃该键）；非数组 → 原值保留。
fn normalize_type(val: &Value) -> Option<Value> {
    let Some(arr) = val.as_array() else {
        return Some(val.clone());
    };
    let mut seen: Vec<usize> = Vec::new();
    for item in arr {
        if let Some(s) = item.as_str() {
            if let Some(idx) = VALID_TYPE_VALUES.iter().position(|v| *v == s) {
                if !seen.contains(&idx) {
                    seen.push(idx);
                }
            }
        }
    }
    seen.sort_unstable();
    match seen.len() {
        0 => None,
        1 => Some(json!(VALID_TYPE_VALUES[seen[0]])),
        _ => Some(Value::Array(
            seen.iter().map(|i| json!(VALID_TYPE_VALUES[*i])).collect(),
        )),
    }
}

/// R2.4：properties 键按码点升序，值递归应用本表；非对象 → 丢弃该键。
fn normalize_properties(val: &Value) -> Option<Value> {
    let props = val.as_object()?;
    let mut keys: Vec<&String> = props.keys().collect();
    keys.sort();
    let mut sorted: Map<String, Value> = Map::new();
    for k in keys {
        sorted.insert(k.clone(), canonicalize_schema(&props[k]));
    }
    Some(Value::Object(sorted))
}

/// R2.5：required 数组去重 + 码点升序（过滤非字符串项）；非数组 → 丢弃该键。
fn normalize_required(val: &Value) -> Option<Value> {
    let arr = val.as_array()?;
    let mut names: Vec<&str> = Vec::new();
    for item in arr {
        if let Some(s) = item.as_str() {
            if !names.contains(&s) {
                names.push(s);
            }
        }
    }
    names.sort();
    Some(Value::Array(names.into_iter().map(|s| json!(s)).collect()))
}

/// R2.7：$defs / definitions 键按码点排序，每个定义递归应用本表；
/// 非对象形态原值保留（R2.7 只定义对象形态）。
fn normalize_defs(val: &Value) -> Value {
    let Some(defs) = val.as_object() else {
        return val.clone();
    };
    let mut keys: Vec<&String> = defs.keys().collect();
    keys.sort();
    let mut sorted: Map<String, Value> = Map::new();
    for k in keys {
        sorted.insert(k.clone(), canonicalize_schema(&defs[k]));
    }
    Value::Object(sorted)
}

/// R2.8：items / oneOf / anyOf / allOf —— 数组/对象形态递归应用本表，
/// 数组顺序保留（顺序是语义）；其余形态（布尔等）原值保留。
fn normalize_subschema(val: &Value) -> Value {
    match val {
        Value::Object(_) => canonicalize_schema(val),
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_schema).collect()),
        _ => val.clone(),
    }
}

/// R2.8 其余键：原值保留；其中 oneOf/anyOf/allOf 递归（数组/对象），
/// additionalProperties（对象形态）/ not / if / then / else 递归
///（P1 §3.2 A3 的一致性扩展，保证深层键序确定）。
fn normalize_other(key: &str, val: &Value) -> Value {
    match key {
        "oneOf" | "anyOf" | "allOf" => normalize_subschema(val),
        "not" | "if" | "then" | "else" | "additionalProperties" => {
            if val.is_object() {
                canonicalize_schema(val)
            } else {
                val.clone()
            }
        }
        _ => val.clone(),
    }
}

/// 合法 JSON Schema type 取值（R2.3 过滤白名单）
const VALID_TYPE_VALUES: &[&str] = &[
    "object", "array", "string", "number", "integer", "boolean", "null",
];

#[cfg(test)]
mod tests {
    use super::*;

    /// 断言两个 Value 的规范化字节一致（键序无关比对）
    fn assert_same_bytes(actual: &Value, expected: &Value) {
        assert_eq!(
            canonical_json_string(actual),
            canonical_json_string(expected),
            "期望: {}",
            expected
        );
    }

    // ── P1 §3.6 E1 单元测试 ──

    #[test]
    fn canonicalize_schema_sorts_properties_and_required() {
        let input = json!({
            "required": ["b", "a", "b"],
            "type": "object",
            "properties": { "zeta": { "type": "string" }, "alpha": { "type": "integer" } },
        });
        let expected = json!({
            "type": "object",
            "properties": { "alpha": { "type": "integer" }, "zeta": { "type": "string" } },
            "required": ["a", "b"],
        });
        assert_same_bytes(&canonicalize_schema(&input), &expected);
    }

    #[test]
    fn canonicalize_schema_const_to_enum() {
        let input = json!({ "const": 5 });
        let expected = json!({ "enum": [5] });
        assert_same_bytes(&canonicalize_schema(&input), &expected);

        let input = json!({ "const": "hello" });
        let expected = json!({ "enum": ["hello"] });
        assert_same_bytes(&canonicalize_schema(&input), &expected);
    }

    #[test]
    fn canonicalize_schema_type_array_normalized() {
        // 过滤 + 去重 + 白名单固定序（P1 E1：去重固定序）→ 多元素保留数组
        let input = json!({ "type": ["string", "number", "string"] });
        let expected = json!({ "type": ["string", "number"] });
        assert_same_bytes(&canonicalize_schema(&input), &expected);

        // 语义等价的乱序 type 数组 → 相同字节（type 数组语义无序）
        let input = json!({ "type": ["number", "string"] });
        let expected = json!({ "type": ["string", "number"] });
        assert_same_bytes(&canonicalize_schema(&input), &expected);

        // 去重后单元素 → 收敛为单值字符串
        let input = json!({ "type": ["integer", "integer"] });
        let expected = json!({ "type": "integer" });
        assert_same_bytes(&canonicalize_schema(&input), &expected);

        // 过滤后为空 → 丢弃该键 → 空对象归一（R2.1）
        let input = json!({ "type": ["bogus", "wat"] });
        let expected = json!({ "type": "object", "properties": {} });
        assert_same_bytes(&canonicalize_schema(&input), &expected);
    }

    #[test]
    fn canonicalize_schema_ref_is_leaf() {
        let input = json!({ "$ref": "#/$defs/foo" });
        assert_same_bytes(&canonicalize_schema(&input), &input);
    }

    #[test]
    fn canonicalize_schema_is_idempotent() {
        let inputs = [
            json!({
                "type": ["string", "number"],
                "properties": { "b": { "const": 1 }, "a": { "type": "object", "required": ["x"] } },
            }),
            json!({ "const": 5 }),
            json!({ "required": "nope" }),
            json!({ "type": ["bogus"] }),
            json!({ "$ref": "#/$defs/foo" }),
            json!({ "$defs": { "b": { "type": "integer" }, "a": { "type": "string" } } }),
        ];
        for input in &inputs {
            let once = canonicalize_schema(input);
            let twice = canonicalize_schema(&once);
            assert_eq!(
                canonical_json_string(&once),
                canonical_json_string(&twice),
                "幂等失败：{input}"
            );
        }
    }

    #[test]
    fn canonical_json_string_is_order_independent() {
        // 同语义不同插入序的两个 Value → 相同字符串
        let a = json!({ "b": 1, "a": { "z": [1, 2], "y": "s" }, "c": [{ "k": 1 }] });
        let b = json!({ "c": [{ "k": 1 }], "a": { "y": "s", "z": [1, 2] }, "b": 1 });
        assert_eq!(canonical_json_string(&a), canonical_json_string(&b));
    }

    // ── P6 §3.5.2 rust-parity 样例表（A1-23/C10）──
    //
    // 表来源：`docs/cache-optimization/03-plans/P6-ts-shell-sync.md` §3.1 规则
    // 清单（R1/R2）按规则枚举构造；TS 侧实现（T-41 rust-parity.test.ts）与
    // Rust 侧共用同一张表，双侧字节必须一致（P6 §3.5.2：Rust 侧表格在 P1
    // 实现时复制为 cargo 测试）。每个样例同时断言幂等。

    struct ParitySample {
        name: &'static str,
        input: Value,
        expected: Value,
    }

    fn parity_samples() -> Vec<ParitySample> {
        vec![
            // R2.1 非对象/空 → 归一为 {"type":"object","properties":{}}
            ParitySample {
                name: "r2.1 非对象-字符串",
                input: json!("hello"),
                expected: json!({ "type": "object", "properties": {} }),
            },
            ParitySample {
                name: "r2.1 非对象-数字",
                input: json!(42),
                expected: json!({ "type": "object", "properties": {} }),
            },
            ParitySample {
                name: "r2.1 非对象-数组",
                input: json!([1, 2]),
                expected: json!({ "type": "object", "properties": {} }),
            },
            ParitySample {
                name: "r2.1 空对象",
                input: json!({}),
                expected: json!({ "type": "object", "properties": {} }),
            },
            // R2.2 布尔 schema → {"type":"string"}
            ParitySample {
                name: "r2.2 布尔-true",
                input: json!(true),
                expected: json!({ "type": "string" }),
            },
            ParitySample {
                name: "r2.2 布尔-false",
                input: json!(false),
                expected: json!({ "type": "string" }),
            },
            // R2.3 type 数组：过滤 → 去重 → 白名单固定序 → 收敛/删除
            ParitySample {
                name: "r2.3 type 数组过滤收敛",
                input: json!({ "type": ["string", "number", "string"] }),
                expected: json!({ "type": ["string", "number"] }),
            },
            ParitySample {
                name: "r2.3 type 数组语义等价收敛",
                input: json!({ "type": ["number", "string"] }),
                expected: json!({ "type": ["string", "number"] }),
            },
            ParitySample {
                name: "r2.3 type 数组单元素",
                input: json!({ "type": ["integer"] }),
                expected: json!({ "type": "integer" }),
            },
            ParitySample {
                name: "r2.3 type 数组过滤后空",
                input: json!({ "type": ["bogus", "wat"] }),
                expected: json!({ "type": "object", "properties": {} }),
            },
            ParitySample {
                name: "r2.3 type 数组去重保序",
                input: json!({ "type": ["number", "string", "number", "boolean"] }),
                expected: json!({ "type": ["string", "number", "boolean"] }),
            },
            ParitySample {
                name: "r2.3 type 数组过滤非法项",
                input: json!({ "type": ["object", "nope", "array"] }),
                expected: json!({ "type": ["object", "array"] }),
            },
            ParitySample {
                name: "r2.3 type 非数组保留",
                input: json!({ "type": "array" }),
                expected: json!({ "type": "array" }),
            },
            // R2.4 properties：键码点升序 + 递归；非对象 → 丢弃
            ParitySample {
                name: "r2.4 properties 键码点排序并递归",
                input: json!({
                    "type": "object",
                    "properties": {
                        "zebra": { "required": ["q", "a"], "type": "object" },
                        "alpha": { "type": "string" },
                    },
                }),
                expected: json!({
                    "type": "object",
                    "properties": {
                        "alpha": { "type": "string" },
                        "zebra": { "type": "object", "required": ["a", "q"] },
                    },
                }),
            },
            ParitySample {
                name: "r2.4 properties 非对象丢弃",
                input: json!({ "properties": "nope" }),
                expected: json!({ "type": "object", "properties": {} }),
            },
            // R2.5 required：去重 + 码点升序；非数组 → 丢弃
            ParitySample {
                name: "r2.5 required 去重排序",
                input: json!({ "type": "object", "required": ["b", "a", "b", "c"] }),
                expected: json!({ "type": "object", "required": ["a", "b", "c"] }),
            },
            ParitySample {
                name: "r2.5 required 非数组丢弃",
                input: json!({ "type": "object", "required": "nope" }),
                expected: json!({ "type": "object" }),
            },
            ParitySample {
                name: "r2.5 required 过滤非字符串项",
                input: json!({ "required": [2, "b", "a"] }),
                expected: json!({ "required": ["a", "b"] }),
            },
            // R2.6 const → enum
            ParitySample {
                name: "r2.6 const 数字转 enum",
                input: json!({ "const": 5 }),
                expected: json!({ "enum": [5] }),
            },
            ParitySample {
                name: "r2.6 const 字符串转 enum",
                input: json!({ "const": "hello" }),
                expected: json!({ "enum": ["hello"] }),
            },
            ParitySample {
                name: "r2.6 const 覆盖既有 enum",
                input: json!({ "const": 5, "enum": ["a"] }),
                expected: json!({ "enum": [5] }),
            },
            // R2.7 $defs / definitions：键码点升序 + 递归
            ParitySample {
                name: "r2.7 外defs 键排序递归",
                input: json!({ "$defs": { "b": { "type": "integer" }, "a": { "type": "string" } } }),
                expected: json!({ "$defs": { "a": { "type": "string" }, "b": { "type": "integer" } } }),
            },
            ParitySample {
                name: "r2.7 definitions 键排序递归",
                input: json!({ "definitions": { "z": { "type": "integer" }, "y": { "type": "string" } } }),
                expected: json!({ "definitions": { "y": { "type": "string" }, "z": { "type": "integer" } } }),
            },
            ParitySample {
                name: "r2.7 外defs 非对象保留",
                input: json!({ "$defs": "nope" }),
                expected: json!({ "$defs": "nope" }),
            },
            // R2.8 items / oneOf / anyOf / allOf 递归（数组保序）
            ParitySample {
                name: "r2.8 items 对象递归",
                input: json!({
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "q": { "type": "string" }, "a": { "type": "string" } },
                    },
                }),
                expected: json!({
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "a": { "type": "string" }, "q": { "type": "string" } },
                    },
                }),
            },
            ParitySample {
                name: "r2.8 items 元组保序递归",
                input: json!({
                    "type": "array",
                    "items": [
                        { "type": "string", "required": ["x", "y"] },
                        { "type": "integer" },
                    ],
                }),
                expected: json!({
                    "type": "array",
                    "items": [
                        { "type": "string", "required": ["x", "y"] },
                        { "type": "integer" },
                    ],
                }),
            },
            ParitySample {
                name: "r2.8 oneOf 数组递归保序",
                input: json!({
                    "oneOf": [
                        { "type": "string" },
                        { "required": ["b", "a"], "type": "object" },
                    ],
                }),
                expected: json!({
                    "oneOf": [
                        { "type": "string" },
                        { "type": "object", "required": ["a", "b"] },
                    ],
                }),
            },
            ParitySample {
                name: "r2.8 anyOf 与 allOf 递归",
                input: json!({ "anyOf": [{ "type": "number" }], "allOf": [{ "type": "string" }] }),
                expected: json!({ "allOf": [{ "type": "string" }], "anyOf": [{ "type": "number" }] }),
            },
            // R2.8 之外的一致性扩展（P1 §3.2 A3）：not/if/then/else/additionalProperties 递归
            ParitySample {
                name: "r2.8 扩展 not/if/then/else 递归",
                input: json!({
                    "not": { "required": ["b"], "type": "object" },
                    "if": { "const": 1 },
                    "then": { "type": "string" },
                    "else": { "type": "integer" },
                }),
                expected: json!({
                    "not": { "type": "object", "required": ["b"] },
                    "if": { "enum": [1] },
                    "then": { "type": "string" },
                    "else": { "type": "integer" },
                }),
            },
            ParitySample {
                name: "r2.8 additionalProperties 对象递归",
                input: json!({ "type": "object", "additionalProperties": { "required": ["q"], "type": "string" } }),
                expected: json!({ "type": "object", "additionalProperties": { "type": "string", "required": ["q"] } }),
            },
            ParitySample {
                name: "r2.8 additionalProperties 布尔保留",
                input: json!({ "additionalProperties": true }),
                expected: json!({ "additionalProperties": true }),
            },
            // R2.9 固定键序：type → properties → required → items → enum → $defs → 其余码点升序
            ParitySample {
                name: "r2.9 固定键序综合",
                input: json!({
                    "description": "d",
                    "enum": ["x"],
                    "required": ["r"],
                    "items": { "type": "string" },
                    "$defs": { "s": { "type": "string" } },
                    "type": "object",
                    "properties": {},
                    "zebra": 1,
                    "alpha": 2,
                }),
                expected: json!({
                    "type": "object",
                    "properties": {},
                    "required": ["r"],
                    "items": { "type": "string" },
                    "enum": ["x"],
                    "$defs": { "s": { "type": "string" } },
                    "alpha": 2,
                    "description": "d",
                    "zebra": 1,
                }),
            },
            ParitySample {
                name: "r2.9 其余键码点升序（大小写）",
                input: json!({ "Z": 1, "a": 2, "B": 3 }),
                expected: json!({ "B": 3, "Z": 1, "a": 2 }),
            },
            // $ref：视为叶子，原样保留、不深入
            ParitySample {
                name: "r2.ref 外ref 叶子保留",
                input: json!({ "$ref": "#/$defs/foo" }),
                expected: json!({ "$ref": "#/$defs/foo" }),
            },
            // 综合：典型工具 schema 形态
            ParitySample {
                name: "r2 综合-典型工具 schema",
                input: json!({
                    "title": "搜索参数",
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "limit": { "type": ["integer", "null"] },
                        "mode": { "const": "fast" },
                        "query": { "type": "string", "description": "搜索词" },
                    },
                    "additionalProperties": false,
                }),
                expected: json!({
                    "type": "object",
                    "properties": {
                        "limit": { "type": ["integer", "null"] },
                        "mode": { "enum": ["fast"] },
                        "query": { "type": "string", "description": "搜索词" },
                    },
                    "required": ["query"],
                    "additionalProperties": false,
                    "title": "搜索参数",
                }),
            },
        ]
    }

    #[test]
    fn rust_parity_samples_canonicalize_schema() {
        for sample in parity_samples() {
            let actual = canonicalize_schema(&sample.input);
            assert_eq!(
                canonical_json_string(&actual),
                canonical_json_string(&sample.expected),
                "样例 [{}] 字节不一致",
                sample.name
            );
            // 每个样例同时断言幂等
            assert_eq!(
                canonical_json_string(&actual),
                canonical_json_string(&canonicalize_schema(&actual)),
                "样例 [{}] 非幂等",
                sample.name
            );
        }
    }
}
