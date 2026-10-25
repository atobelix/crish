//! MCP 协议与参数适配域（SR-06a-6 · 拆分 · ≠ EL）
//!
//! 从 `bridge.rs` 按逻辑域切出的纯函数域：MCP 协议常量、wire 形状
//! （`McpToolInfo`）与工具枚举/调用结果的适配与参数校验：
//! - 名称前缀（`mcp_<server>__<tool>` 防冲突）与前缀段净化
//! - tools/list 结果 → 本地 `ToolDefinition` 适配（缺 description /
//!   inputSchema 回退兜底）
//! - tools/call 结果 → Tool trait 输出适配（isError / structuredContent /
//!   text 语义）
//! - JSON-RPC 响应解析、initialize 握手参数、错误构造辅助
//!
//! 依赖方向：本模为最底层（零跨域依赖）；`bridge_session`（调用执行）与
//! `bridge_registry`（生命周期）经 `super::bridge_protocol::…` 引用。
//! 诚实边界：仅结构拆分，协议/适配语义零改动（≠ EL / ≠ 打开完成 /
//! ≠ 结构债清零）。

use crate::definition::{default_input_schema, ToolDefinition, ToolError};
use conex_types::error::codes;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::time::Duration;

/// MCP 协议版本（2025-03-26：官方当前稳定版；对端版本不回退协商）
pub const MCP_PROTOCOL_VERSION: &str = "2025-03-26";
/// tools/call 默认超时（任务书：30 秒）
pub const DEFAULT_MCP_CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// 握手 initialize 超时
pub const DEFAULT_MCP_INIT_TIMEOUT: Duration = Duration::from_secs(10);
/// 工具枚举 tools/list 超时
pub const DEFAULT_MCP_LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// tools/list 返回的单个工具声明（MCP Tool 形状）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    /// 远端工具名（注册表内以 `mcp_<server>__<name>` 出现）
    pub name: String,
    /// 描述（缺省为空串）
    #[serde(default)]
    pub description: String,
    /// 入参 JSON Schema（缺省回退兜底形状）
    #[serde(default)]
    pub input_schema: Value,
}

/// 确定性防冲突前缀命名规范：`mcp_<clean_id>_<short_hash>__<tool>`
///
/// 解决 `my.server` 与 `my_server` 冲突，采用名称主干（字母数字与短横线转小写，其余转下划线，最多20字符）+ 6位哈希后缀，
/// 杜绝跨 server 命名碰撞与同名静默覆盖（BC11-2，对齐 06A §2.3.2 / 06B §2.3.1）。
pub fn format_mcp_tool_name(server_id: &str, tool_name: &str) -> String {
    let clean_id: String = server_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(server_id, &mut hasher);
    let hash_suffix = format!(
        "{:06x}",
        (std::hash::Hasher::finish(&hasher) & 0xFFFFFF) as u32
    );

    format!(
        "mcp_{}_{}__{}",
        clean_id.chars().take(20).collect::<String>(),
        hash_suffix,
        tool_name
    )
}

/// 兼容别名：调用 [format_mcp_tool_name]
pub fn mcp_tool_name(server_id: &str, tool_name: &str) -> String {
    format_mcp_tool_name(server_id, tool_name)
}

/// 前缀段净化：保留字母数字与 `_` `-`，其余替换为 `_`
///
/// server_id 可含点号/空格等（如 `my.server`），必须净化以保证
/// 前缀名稳定且不含歧义字符。
pub fn sanitize_id_part(server_id: &str) -> String {
    server_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 工具列表适配：MCP tools/list 结果 → 本地 ToolDefinition 列表
///
/// 名称加确定性 `mcp_<clean_id>_<short_hash>__` 前缀；缺 description 用空串；缺 inputSchema
/// 回退兜底形状（02 §二.6：{type:'object',properties:{},additionalProperties:true}）。
pub fn adapt_tool_list(server_id: &str, tools: &[McpToolInfo]) -> Vec<ToolDefinition> {
    tools
        .iter()
        .map(|tool| ToolDefinition {
            name: format_mcp_tool_name(server_id, &tool.name),
            description: tool.description.clone(),
            input_schema: if tool.input_schema.is_null() {
                default_input_schema()
            } else {
                tool.input_schema.clone()
            },
            dangerous: false,
            fatal_on_error: false,
        })
        .collect()
}

/// 单个 MCP 工具声明解析（缺 name 视为协议违规）
///
/// `pub(crate)`：`bridge_session` 的 tools/list 枚举经此逐条解析。
pub(crate) fn parse_tool_info(value: &Value) -> Result<McpToolInfo, ToolError> {
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| !n.trim().is_empty())
        .ok_or_else(|| {
            ToolError::new(
                codes::MCP_PROTOCOL_VIOLATION,
                "tools/list 中存在缺少 name 的工具定义",
            )
        })?
        .to_string();
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let input_schema = value
        .get("inputSchema")
        .cloned()
        .unwrap_or_else(default_input_schema);
    Ok(McpToolInfo {
        name,
        description,
        input_schema,
    })
}

/// tools/call 结果适配（MCP CallToolResult → Tool trait 输出）
///
/// - isError=true → Err(tool.execution_failed)（执行失败语义，消息取 text）
/// - structuredContent 存在 → 写入 json 字段（机器可读优先）
/// - text 内容（全部 text 段拼接）→ 写入 text 字段
/// - 原始 content / isError 原样透传，供上层展示
pub fn adapt_call_result(result: &Value, display_name: &str) -> Result<Value, ToolError> {
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if is_error {
        let detail = extract_text_content(result);
        let detail = if detail.is_empty() {
            "MCP server 返回 isError=true".to_string()
        } else {
            detail
        };
        return Err(ToolError::execution_failed(display_name, detail));
    }
    let mut output = Map::new();
    let text = extract_text_content(result);
    if !text.is_empty() {
        output.insert("text".to_string(), json!(text));
    }
    if let Some(structured) = result.get("structuredContent") {
        output.insert("json".to_string(), structured.clone());
    }
    if let Some(content) = result.get("content") {
        output.insert("content".to_string(), content.clone());
    }
    if let Some(flag) = result.get("isError") {
        output.insert("isError".to_string(), flag.clone());
    }
    Ok(Value::Object(output))
}

/// 提取 content 数组内全部 text 段（按序以换行拼接）；非数组返回空串
fn extract_text_content(result: &Value) -> String {
    let Some(content) = result.get("content").and_then(Value::as_array) else {
        return String::new();
    };
    content
        .iter()
        .filter_map(|item| {
            if item.get("type").and_then(Value::as_str) == Some("text") {
                item.get("text").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// initialize 请求参数（MCP 官方握手形状）
///
/// `pub(crate)`：`bridge_registry` 的 start 握手经此构造。
pub(crate) fn initialize_params() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {
            "name": "crish-agent-tools",
            "version": env!("CARGO_PKG_VERSION"),
        }
    })
}

/// JSON-RPC 响应 → result 值（响应含 error 对象 → mcp.protocol_violation）
///
/// `pub(crate)`：`bridge_session` 的 request 响应解析经此。
pub(crate) fn response_result(server_id: &str, response: Value) -> Result<Value, ToolError> {
    if let Some(error) = response.get("error") {
        let code = error.get("code").cloned().unwrap_or(Value::Null);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知 JSON-RPC 错误");
        return Err(ToolError::new(
            codes::MCP_PROTOCOL_VIOLATION,
            format!("MCP server {server_id} 返回 JSON-RPC 错误 {code}：{message}"),
        ));
    }
    response.get("result").cloned().ok_or_else(|| {
        ToolError::new(
            codes::MCP_PROTOCOL_VIOLATION,
            format!("MCP server {server_id} 的响应缺少 result"),
        )
    })
}

/// mcp.connection_failed 错误构造辅助
///
/// `pub(crate)`：`bridge_session` 的 spawn 错误路径共用。
pub(crate) fn connection_failed(message: impl Into<String>) -> ToolError {
    ToolError::new(codes::MCP_CONNECTION_FAILED, message)
}

#[cfg(test)]
#[path = "bridge_protocol_tests.rs"]
mod tests;
