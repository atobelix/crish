use conex_types::history::HistoryMessage;
use serde::Deserialize;

/// 全保真工具调用数据结构（支持直接反序列化 MessageToolCall 真实输出，包含 output, status, images 等）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) struct HydratedToolCall {
    pub(crate) id: String,
    #[serde(alias = "toolName", alias = "tool_name")]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) arguments: Option<serde_json::Value>,
    /// 真实工具执行输出文本或结构化数据
    #[serde(default)]
    pub(crate) output: Option<serde_json::Value>,
    /// 状态（success / error / running / pending_approval 等）
    #[serde(default)]
    pub(crate) status: Option<String>,
    /// 多模态图片引用（可选）
    #[serde(default)]
    pub(crate) images: Option<Vec<serde_json::Value>>,
}

/// 兼容老数据 / 独立 tool_call_results_json 条目
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) struct HydratedToolResult {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) output: Option<serde_json::Value>,
    #[serde(default, alias = "is_error")]
    pub(crate) is_error: Option<bool>,
    #[serde(default)]
    pub(crate) status: Option<String>,
}

/// tool_calls_json → HydratedToolCall 列表
pub(crate) fn parse_hydrated_tool_calls(entry: &HistoryMessage) -> Vec<HydratedToolCall> {
    let Some(json) = entry.tool_calls_json.as_deref() else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        tracing::warn!(message_id = %entry.id, "hydrate: tool_calls_json 整体不可解析，工具部分跳过");
        return Vec::new();
    };
    let parsed: Vec<HydratedToolCall> = items
        .iter()
        .filter_map(|item| serde_json::from_value::<HydratedToolCall>(item.clone()).ok())
        .collect();
    if parsed.len() != items.len() {
        tracing::warn!(
            message_id = %entry.id,
            kept = parsed.len(),
            total = items.len(),
            "hydrate: tool_calls_json 部分条目缺 id/name，跳过不可映射条目"
        );
    }
    parsed
}

/// tool_call_results_json → HydratedToolResult 列表
pub(crate) fn parse_tool_call_results(entry: &HistoryMessage) -> Vec<HydratedToolResult> {
    let Some(json) = entry.tool_call_results_json.as_deref() else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        tracing::warn!(message_id = %entry.id, "hydrate: tool_call_results_json 整体不可解析，结果部分跳过");
        return Vec::new();
    };
    let parsed: Vec<HydratedToolResult> = items
        .iter()
        .filter_map(|item| serde_json::from_value::<HydratedToolResult>(item.clone()).ok())
        .collect();
    if parsed.len() != items.len() {
        tracing::warn!(
            message_id = %entry.id,
            kept = parsed.len(),
            total = items.len(),
            "hydrate: tool_call_results_json 部分条目缺 id，跳过不可映射条目"
        );
    }
    parsed
}

/// 提取真实输出文本（字符串直接返回，对象提取 text 或格式化为 JSON 串）
pub(crate) fn extract_output_text(output_val: &Option<serde_json::Value>) -> Option<String> {
    match output_val {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Object(map)) => {
            if let Some(serde_json::Value::String(text)) = map.get("text") {
                Some(text.clone())
            } else {
                Some(serde_json::to_string(map).unwrap_or_default())
            }
        }
        Some(other) => Some(other.to_string()),
    }
}

/// arguments（JSON 串、对象或原始参数串）→ ToolCallBlock.input（结构化 Value）
pub(crate) fn parse_arguments(arguments: &Option<serde_json::Value>) -> serde_json::Value {
    match arguments {
        None | Some(serde_json::Value::Null) => serde_json::Value::Null,
        Some(serde_json::Value::String(raw)) => serde_json::from_str::<serde_json::Value>(raw)
            .unwrap_or_else(|_| serde_json::Value::String(raw.clone())),
        Some(val) => val.clone(),
    }
}
