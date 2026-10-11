//! tool_call 增量收集（任务书 B2.5；02-provider-semantics.md §2.3、§六.4）
//!
//! 语义锚点：`runtime:provider-openai-chat.ts:173-202`（mergeToolCallDelta）：
//! - 以 `index` 为 key 分组（缺失时用当前 pending 数量兜底，02 §2.3:101）
//! - `id` 覆盖式、`function.name` 覆盖式、`function.arguments` 追加式拼接 JSON 片段
//! - 平铺变体兼容（02 §五 #8）：`function_name` / `name` / `arguments` 直接挂 call 上
//! - 流结束 flush 时 `argumentsText` 经 [parse_arguments] 兜底解析（02 §2.3:261-274），
//!   解析失败不抛错，产出 `{__rawArguments, __parseError}`
//! - 缺 name 不静默丢弃：RU-06 上报 invalid-tool-call 诊断（02 §五 #4）

use std::collections::BTreeMap;

use conex_types::tool::{ProviderDiagnostic, ProviderDiagnosticPhase};
use serde_json::{json, Map, Value};

/// 完整工具调用（增量收集的最终产出，对齐低级事件 `tool-call` 的载荷形态）
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    /// 调用 id（缺失时兜底 `call_{index}`，02 §2.3:102）
    pub id: Option<String>,
    /// 工具名
    pub tool_name: String,
    /// 已解析入参（JSON 对象；解析失败时为 `{__rawArguments,__parseError}` 兜底）
    pub input: Value,
}

/// 收集器内部的一条 pending 调用
#[derive(Debug, Clone, PartialEq)]
struct PendingToolCall {
    /// id（兜底 `call_{index}`，可被后续增量覆盖）
    id: String,
    /// 工具名（缺失表示尚未捕获到 name）
    name: Option<String>,
    /// 追加式拼接的 arguments JSON 片段
    arguments_text: String,
}

/// 工具调用增量收集器
///
/// 跨帧持有状态：`merge` 逐帧合并增量；[ToolCallCollector::finish] 在流结束时
/// flush 全部 pending，产出完整调用与 RU-06 诊断（02 §五 #4）。
#[derive(Debug, Default)]
pub struct ToolCallCollector {
    /// 按 index 分组的 pending（BTreeMap 保证 flush 顺序与 index 升序一致）
    pending: BTreeMap<usize, PendingToolCall>,
}

/// [ToolCallCollector::finish] 的产出
#[derive(Debug, Default, PartialEq)]
pub struct ToolCallFlush {
    /// 名完整的调用（按 index 升序）
    pub calls: Vec<ToolCall>,
    /// RU-06 缺 name 诊断（每条 pending 一条，不静默丢弃）
    pub diagnostics: Vec<ProviderDiagnostic>,
    /// flush 前的 pending 总数（RU-09 判定 partial.pendingCount 用）
    pub pending_len: usize,
}

impl ToolCallCollector {
    /// 新建收集器
    pub fn new() -> Self {
        Self::default()
    }

    /// 是否已捕获到至少一个具名调用（RU-08/09 判定用，02 §五 #5/#6）
    pub fn has_named_calls(&self) -> bool {
        self.pending.values().any(|pending| {
            pending
                .name
                .as_deref()
                .is_some_and(|n| !n.trim().is_empty())
        })
    }

    /// 当前 pending 总数
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    /// 是否尚无任何 pending
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// 合并一个原始 tool_call 增量
    ///
    /// 输入可为：`delta.tool_calls[]` 元素、`delta.function_call`（legacy）、
    /// `choice.tool_calls[]` 元素（平铺变体）。非对象输入直接忽略。
    pub fn merge(&mut self, raw: &Value) {
        let Some(record) = raw.as_object() else {
            return;
        };
        // index 缺失时用当前 pending 数量兜底（02 §2.3:101）
        let index = record
            .get("index")
            .and_then(Value::as_u64)
            .map(|index| index as usize)
            .unwrap_or_else(|| self.pending.len());
        let entry = self
            .pending
            .entry(index)
            .or_insert_with(|| PendingToolCall {
                id: format!("call_{index}"),
                name: None,
                arguments_text: String::new(),
            });
        // id 覆盖式（02 §2.3:101；忽略空串，防止后续 delta 的 id: "" 覆盖真实 id）
        if let Some(id) = string_field(record.get("id")) {
            if !id.trim().is_empty() {
                entry.id = id.to_owned();
            }
        }
        // 标准结构：function.name 覆盖式 / function.arguments 追加式（忽略空 name）
        if let Some(function) = record.get("function").and_then(Value::as_object) {
            if let Some(name) = string_field(function.get("name")) {
                if !name.trim().is_empty() {
                    entry.name = Some(name.to_owned());
                }
            }
            if let Some(arguments) = string_field(function.get("arguments")) {
                entry.arguments_text.push_str(arguments);
            }
        }
        // 平铺变体兼容（02 §五 #8）：name 尚未捕获时补 function_name / name
        if entry.name.is_none() {
            if let Some(name) = string_field(record.get("function_name"))
                .or_else(|| string_field(record.get("name")))
            {
                if !name.trim().is_empty() {
                    entry.name = Some(name.to_owned());
                }
            }
        }
        if let Some(arguments) = string_field(record.get("arguments")) {
            entry.arguments_text.push_str(arguments);
        }
    }

    /// 流结束 flush：名完整 → 完整调用；缺 name → RU-06 诊断（不静默丢，02 §五 #4）
    ///
    /// `&mut self` 消费式调用（内部取走 pending），重复调用产出空结果。
    pub fn finish(&mut self) -> ToolCallFlush {
        let pending = std::mem::take(&mut self.pending);
        let pending_len = pending.len();
        let mut calls = Vec::new();
        let mut diagnostics = Vec::new();
        for (index, pending) in pending {
            let valid_name = pending.name.filter(|n| !n.trim().is_empty());
            match valid_name {
                Some(name) => {
                    let id = if pending.id.trim().is_empty() {
                        format!("call_{index}")
                    } else {
                        pending.id
                    };
                    calls.push(ToolCall {
                        id: Some(id),
                        tool_name: name,
                        input: parse_arguments(&pending.arguments_text),
                    });
                }
                None => diagnostics.push(ProviderDiagnostic {
                    phase: ProviderDiagnosticPhase::InvalidToolCall,
                    reason: Some("function.name missing in streamed tool_call".to_string()),
                    partial: Some(json!({
                        "id": pending.id,
                        "argumentsText": pending.arguments_text.chars().take(200).collect::<String>(),
                    })),
                    ..ProviderDiagnostic::default()
                }),
            }
        }
        ToolCallFlush {
            calls,
            diagnostics,
            pending_len,
        }
    }
}

/// parseArguments 兜底（02 §2.3:261-274，对齐 `runtime:provider-openai-chat.ts:199-202`）
///
/// - 空串 → `{}`
/// - 合法 JSON 对象 → 原样
/// - 合法 JSON 非对象（数组/标量）→ `{ value: <原值> }`
/// - 解析失败 → `{ __rawArguments, __parseError }`（失败不抛错）
pub fn parse_arguments(input: &str) -> Value {
    if input.trim().is_empty() {
        return Value::Object(Map::new());
    }
    match serde_json::from_str::<Value>(input) {
        Ok(parsed) if parsed.is_object() => parsed,
        Ok(parsed) => json!({ "value": parsed }),
        Err(error) => json!({
            "__rawArguments": input,
            "__parseError": error.to_string(),
        }),
    }
}

/// parseFullToolCall（02 §2.3:246-259）：非流式格式混入流式时的完整调用解析
///
/// 用于 `choice.message.tool_calls[]` 元素（02 §五 #7：非流式格式混入流式）。
/// `function.name` 缺失 → 返回 None（丢弃，对齐 TS 行为）；id 缺失兜底
/// `call_{name}`；arguments 缺失视为 `{}`。
pub fn parse_full_tool_call(raw: &Value) -> Option<ToolCall> {
    let record = raw.as_object()?;
    let function = record.get("function")?.as_object()?;
    let name = function.get("name")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let id = string_field(record.get("id"))
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("call_{name}"));
    let arguments_text = string_field(function.get("arguments")).unwrap_or("{}");
    Some(ToolCall {
        id: Some(id),
        tool_name: name.to_owned(),
        input: parse_arguments(arguments_text),
    })
}

/// 取字符串字段（非字符串返回 None）
fn string_field(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_call(index: u64, id: &str, name: &str, arguments: &str) -> Value {
        json!({
            "index": index,
            "id": id,
            "function": { "name": name, "arguments": arguments },
        })
    }

    #[test]
    fn merge_groups_by_index() {
        let mut collector = ToolCallCollector::new();
        collector.merge(&raw_call(0, "call_a", "read_file", r#"{"path":"/a""#));
        collector.merge(&raw_call(1, "call_b", "write_file", r#"{"path":"/b"}"#));
        // 同一 index 的后续增量只带 arguments 片段（JSON 边界处切分）
        collector.merge(&json!({ "index": 0, "function": { "arguments": r#","mode":"r"}"# } }));
        let flush = collector.finish();
        assert_eq!(flush.pending_len, 2);
        assert_eq!(flush.calls.len(), 2);
        assert_eq!(flush.calls[0].tool_name, "read_file");
        // 同一 index 的 arguments 追加式拼接后整体解析
        assert_eq!(flush.calls[0].input, json!({ "path": "/a", "mode": "r" }));
        assert_eq!(flush.calls[1].tool_name, "write_file");
        assert_eq!(flush.calls[1].id.as_deref(), Some("call_b"));
        assert!(flush.diagnostics.is_empty());
    }

    #[test]
    fn id_and_name_are_override_style() {
        let mut collector = ToolCallCollector::new();
        collector.merge(&json!({ "index": 0, "id": "first", "function": { "name": "a" } }));
        // 后续增量覆盖 id 与 name
        collector.merge(&json!({ "index": 0, "id": "second", "function": { "name": "b" } }));
        let flush = collector.finish();
        assert_eq!(flush.calls[0].id.as_deref(), Some("second"));
        assert_eq!(flush.calls[0].tool_name, "b");
    }

    #[test]
    fn missing_index_falls_back_to_pending_len() {
        let mut collector = ToolCallCollector::new();
        collector.merge(&json!({ "id": "c1", "function": { "name": "one" } }));
        collector.merge(&json!({ "id": "c2", "function": { "name": "two" } }));
        let flush = collector.finish();
        assert_eq!(flush.calls.len(), 2);
        assert_eq!(flush.calls[0].id.as_deref(), Some("c1"));
        assert_eq!(flush.calls[1].id.as_deref(), Some("c2"));
    }

    #[test]
    fn missing_id_falls_back_to_call_index() {
        let mut collector = ToolCallCollector::new();
        collector.merge(&json!({ "index": 3, "function": { "name": "read_file" } }));
        let flush = collector.finish();
        assert_eq!(flush.calls[0].id.as_deref(), Some("call_3"));
    }

    #[test]
    fn flat_variant_fields_are_collected() {
        // 02 §五 #8：function_name / name / arguments 直接平铺在 call 上
        let mut collector = ToolCallCollector::new();
        collector.merge(&json!({ "index": 0, "function_name": "read_file" }));
        collector.merge(&json!({ "index": 0, "name": "other" }));
        collector.merge(&json!({ "index": 0, "arguments": r#"{"path":"/x"}"# }));
        let flush = collector.finish();
        assert_eq!(flush.calls.len(), 1);
        assert_eq!(flush.calls[0].tool_name, "read_file", "name 只补缺不覆盖");
        assert_eq!(flush.calls[0].input, json!({ "path": "/x" }));
    }

    #[test]
    fn non_object_merge_input_is_ignored() {
        let mut collector = ToolCallCollector::new();
        collector.merge(&Value::Null);
        collector.merge(&json!([1, 2]));
        collector.merge(&json!("text"));
        assert!(collector.is_empty());
    }

    #[test]
    fn finish_flushes_in_index_order() {
        let mut collector = ToolCallCollector::new();
        collector.merge(&raw_call(2, "c3", "third", "{}"));
        collector.merge(&raw_call(0, "c1", "first", "{}"));
        collector.merge(&raw_call(1, "c2", "second", "{}"));
        let flush = collector.finish();
        let names: Vec<&str> = flush
            .calls
            .iter()
            .map(|call| call.tool_name.as_str())
            .collect();
        assert_eq!(names, vec!["first", "second", "third"]);
    }

    #[test]
    fn missing_name_reports_diagnostic_not_silent_drop() {
        // RU-06：缺 function.name 上报 invalid-tool-call 诊断，不静默丢弃（02 §五 #4）
        let mut collector = ToolCallCollector::new();
        collector
            .merge(&json!({ "index": 0, "id": "call_no_name", "function": { "arguments": "{}" } }));
        collector.merge(&raw_call(1, "call_ok", "read_file", "{}"));
        let flush = collector.finish();
        assert_eq!(flush.calls.len(), 1);
        assert_eq!(flush.calls[0].tool_name, "read_file");
        assert_eq!(flush.diagnostics.len(), 1);
        let diagnostic = &flush.diagnostics[0];
        assert_eq!(diagnostic.phase, ProviderDiagnosticPhase::InvalidToolCall);
        assert_eq!(
            diagnostic.reason.as_deref(),
            Some("function.name missing in streamed tool_call")
        );
        let partial = diagnostic.partial.as_ref().expect("携带 partial");
        assert_eq!(partial["id"], "call_no_name");
    }

    #[test]
    fn flush_of_empty_collector_is_empty() {
        let flush = ToolCallCollector::new().finish();
        assert!(flush.calls.is_empty());
        assert!(flush.diagnostics.is_empty());
        assert_eq!(flush.pending_len, 0);
    }

    #[test]
    fn parse_arguments_empty_yields_empty_object() {
        assert_eq!(parse_arguments(""), json!({}));
        assert_eq!(parse_arguments("  \n "), json!({}));
    }

    #[test]
    fn parse_arguments_object_passes_through() {
        let input = r#"{"path":"/a","recursive":true}"#;
        assert_eq!(
            parse_arguments(input),
            json!({ "path": "/a", "recursive": true })
        );
    }

    #[test]
    fn parse_arguments_non_object_wraps_in_value() {
        assert_eq!(parse_arguments("[1,2]"), json!({ "value": [1, 2] }));
        assert_eq!(parse_arguments("\"str\""), json!({ "value": "str" }));
        assert_eq!(parse_arguments("42"), json!({ "value": 42 }));
        assert_eq!(parse_arguments("null"), json!({ "value": Value::Null }));
    }

    #[test]
    fn parse_arguments_failure_produces_raw_fallback() {
        let input = r#"{"path": "未闭合"#;
        let parsed = parse_arguments(input);
        assert_eq!(parsed["__rawArguments"], input);
        let error = parsed["__parseError"].as_str().expect("携带解析错误文案");
        assert!(!error.is_empty());
    }

    #[test]
    fn parse_full_tool_call_requires_function_name() {
        // 缺 function.name → None（丢弃，对齐 TS parseFullToolCall）
        assert!(parse_full_tool_call(&json!({ "id": "c1" })).is_none());
        assert!(parse_full_tool_call(&json!({ "id": "c1", "function": {} })).is_none());
        assert!(parse_full_tool_call(&Value::Null).is_none());
        assert!(parse_full_tool_call(&json!("str")).is_none());
    }

    #[test]
    fn parse_full_tool_call_with_fallbacks() {
        let call = parse_full_tool_call(&json!({
            "function": { "name": "read_file", "arguments": r#"{"path":"/a"}"# },
        }))
        .expect("name 存在即解析");
        // id 缺失兜底 call_{name}
        assert_eq!(call.id.as_deref(), Some("call_read_file"));
        assert_eq!(call.tool_name, "read_file");
        assert_eq!(call.input, json!({ "path": "/a" }));

        // arguments 缺失视为 {}
        let call = parse_full_tool_call(&json!({
            "id": "c1",
            "function": { "name": "noop" },
        }))
        .expect("解析");
        assert_eq!(call.input, json!({}));
    }

    #[test]
    fn has_named_calls_reflects_captured_names() {
        let mut collector = ToolCallCollector::new();
        assert!(!collector.has_named_calls());
        collector.merge(&json!({ "index": 0, "id": "c0", "function": { "arguments": "{}" } }));
        assert!(
            !collector.has_named_calls(),
            "仅缺 name 的 pending 不算捕获"
        );
        collector.merge(&json!({ "index": 0, "function": { "name": "read_file" } }));
        assert!(collector.has_named_calls());
    }
}
