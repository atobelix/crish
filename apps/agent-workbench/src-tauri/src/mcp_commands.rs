//! MCP 管理面 IPC 命令实现（BC11-1 生产真实接入）
//!
//! 提供 4 个 `#[tauri::command]` 供前端 Settings / Plugin 真实调用：
//! - `workbench_list_mcp_servers`：动态枚举配置与运行状态，反射工具列表
//! - `workbench_start_mcp_server`：拉起 MCP 服务并并入工具注册表
//! - `workbench_stop_mcp_server`：停止 MCP 服务子进程并清理会话
//! - `workbench_toggle_mcp_tool`：细粒度开关工具，同步持久化配置

use agent_tools::mcp::servers::{LocalFileMcpPersistence, McpConfigPersistence, McpTransport};
use agent_tools::mcp::McpServerRuntimeState;
use agent_tools::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

use conex_run::core_error::{map_internal_string, CoreError};
use conex_run::run::CoreRunState;

/// MCP 配置持久化失败 → `Io`（detail 携带 `mcp.config:` 操作名与原始文案，
/// 对齐 map_store_err 风格；持久化错误码统一为 config.invalid，kind 取存储语义）。
fn map_mcp_persistence_err(err: ToolError) -> CoreError {
    CoreError::Io(format!("mcp.config: {err}"))
}

/// MCP 单个工具反射 DTO（对应前端 McpToolDefinitionDto）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDefinitionDto {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefixed_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
    pub enabled: bool,
}

/// MCP 服务信息 DTO（对应前端 McpServerInfo）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub id: String,
    pub name: String,
    pub state: String,
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_defs: Option<Vec<McpToolDefinitionDto>>,
    pub transport: String,
    pub auto_start: bool,
    pub disabled_tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// 列表响应结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpListResponse {
    pub ok: bool,
    pub configured: bool,
    pub servers: Vec<McpServerInfo>,
}

/// 控制响应结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpControlResult {
    pub ok: bool,
    pub server_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

/// 状态枚举转人读小写字符串
fn runtime_state_to_str(state: McpServerRuntimeState) -> &'static str {
    match state {
        McpServerRuntimeState::Ready => "ready",
        McpServerRuntimeState::Starting => "starting",
        McpServerRuntimeState::Stopped => "stopped",
        McpServerRuntimeState::Degraded => "degraded",
        McpServerRuntimeState::Exited => "exited",
    }
}

/// 枚举所有已配置与运行中的 MCP 服务
#[tauri::command]
pub async fn workbench_list_mcp_servers(
    state: State<'_, Arc<CoreRunState>>,
) -> Result<McpListResponse, CoreError> {
    let app_dir = crate::host_paths::app_dir().map_err(map_internal_string)?;
    let persistence = LocalFileMcpPersistence::new(app_dir);
    let saved_configs = persistence.load().await.unwrap_or_default();

    let bridge = state.engine().mcp_bridge();
    let managed_ids = bridge.managed_servers();

    let mut servers = Vec::new();
    let mut visited_ids = std::collections::HashSet::new();

    // 1. 遍历持久化配置
    for config in &saved_configs {
        visited_ids.insert(config.server_id.clone());
        let rt_state = bridge.state(&config.server_id);
        let raw_defs = bridge.tools(&config.server_id).unwrap_or_default();

        let tool_names: Vec<String> = raw_defs.iter().map(|d| d.name.clone()).collect();
        let tool_defs: Vec<McpToolDefinitionDto> = raw_defs
            .iter()
            .map(|d| {
                let short_name = d.name.split("__").last().unwrap_or(&d.name);
                let disabled = config.disabled_tools.contains(&d.name)
                    || config.disabled_tools.contains(&short_name.to_string());
                McpToolDefinitionDto {
                    name: short_name.to_string(),
                    prefixed_name: Some(d.name.clone()),
                    description: Some(d.description.clone()),
                    input_schema: Some(d.input_schema.clone()),
                    enabled: !disabled,
                }
            })
            .collect();

        servers.push(McpServerInfo {
            id: config.server_id.clone(),
            name: config.server_id.clone(),
            state: runtime_state_to_str(rt_state).to_string(),
            tools: tool_names,
            tool_defs: Some(tool_defs),
            transport: match config.transport {
                McpTransport::Stdio => "stdio".to_string(),
                McpTransport::Sse => "sse".to_string(),
            },
            auto_start: config.auto_start,
            disabled_tools: config.disabled_tools.clone(),
            command: if config.transport == McpTransport::Stdio {
                Some(config.command.clone())
            } else {
                None
            },
            args: if config.transport == McpTransport::Stdio {
                Some(config.args.clone())
            } else {
                None
            },
            env: if config.transport == McpTransport::Stdio {
                Some(config.env.clone())
            } else {
                None
            },
            url: if config.transport == McpTransport::Sse {
                config.url.clone()
            } else {
                None
            },
        });
    }

    // 2. 遍历桥中可能存在但未持久化的服务
    for server_id in managed_ids {
        if !visited_ids.contains(&server_id) {
            let rt_state = bridge.state(&server_id);
            let raw_defs = bridge.tools(&server_id).unwrap_or_default();
            let tool_names: Vec<String> = raw_defs.iter().map(|d| d.name.clone()).collect();
            let tool_defs: Vec<McpToolDefinitionDto> = raw_defs
                .iter()
                .map(|d| {
                    let short_name = d.name.split("__").last().unwrap_or(&d.name);
                    McpToolDefinitionDto {
                        name: short_name.to_string(),
                        prefixed_name: Some(d.name.clone()),
                        description: Some(d.description.clone()),
                        input_schema: Some(d.input_schema.clone()),
                        enabled: true,
                    }
                })
                .collect();

            servers.push(McpServerInfo {
                id: server_id.clone(),
                name: server_id.clone(),
                state: runtime_state_to_str(rt_state).to_string(),
                tools: tool_names,
                tool_defs: Some(tool_defs),
                transport: "stdio".to_string(),
                auto_start: false,
                disabled_tools: Vec::new(),
                command: None,
                args: None,
                env: None,
                url: None,
            });
        }
    }

    Ok(McpListResponse {
        ok: true,
        configured: !servers.is_empty(),
        servers,
    })
}

/// 启动指定的 MCP 服务
#[tauri::command]
pub async fn workbench_start_mcp_server(
    state: State<'_, Arc<CoreRunState>>,
    server_id: String,
) -> Result<McpControlResult, CoreError> {
    let app_dir = crate::host_paths::app_dir().map_err(map_internal_string)?;
    let persistence = LocalFileMcpPersistence::new(app_dir);
    let configs = persistence.load().await.map_err(map_mcp_persistence_err)?;

    let config = configs
        .into_iter()
        .find(|c| c.server_id == server_id)
        .ok_or_else(|| CoreError::NotFound(format!("未找到 MCP 服务配置: {}", server_id)))?;

    match state.engine().register_plugin_mcp_server(config).await {
        Ok(_) => Ok(McpControlResult {
            ok: true,
            server_id,
            state: Some("ready".to_string()),
            error: None,
            error_code: None,
        }),
        Err(e) => Ok(McpControlResult {
            ok: false,
            server_id,
            state: Some("error".to_string()),
            error: Some(e.to_string()),
            error_code: Some(e.code().to_string()),
        }),
    }
}

/// 停止指定的 MCP 服务
#[tauri::command]
pub async fn workbench_stop_mcp_server(
    state: State<'_, Arc<CoreRunState>>,
    server_id: String,
) -> Result<McpControlResult, CoreError> {
    let bridge = state.engine().mcp_bridge();
    match bridge.stop(&server_id).await {
        Ok(_) => Ok(McpControlResult {
            ok: true,
            server_id,
            state: Some("stopped".to_string()),
            error: None,
            error_code: None,
        }),
        Err(e) => Ok(McpControlResult {
            ok: false,
            server_id,
            state: Some("error".to_string()),
            error: Some(e.to_string()),
            error_code: Some(e.code().to_string()),
        }),
    }
}

/// 细粒度开关某个 MCP 工具
#[tauri::command]
pub async fn workbench_toggle_mcp_tool(
    state: State<'_, Arc<CoreRunState>>,
    server_id: String,
    tool_name: String,
    enabled: bool,
) -> Result<bool, CoreError> {
    let _ = state;
    let app_dir = crate::host_paths::app_dir().map_err(map_internal_string)?;
    let persistence = LocalFileMcpPersistence::new(app_dir);
    let mut configs = persistence.load().await.map_err(map_mcp_persistence_err)?;

    let config = configs
        .iter_mut()
        .find(|c| c.server_id == server_id)
        .ok_or_else(|| CoreError::NotFound(format!("未找到 MCP 服务配置: {}", server_id)))?;

    let short_name = tool_name
        .split("__")
        .last()
        .unwrap_or(&tool_name)
        .to_string();

    if enabled {
        config
            .disabled_tools
            .retain(|t| t != &tool_name && t != &short_name);
    } else {
        if !config.disabled_tools.contains(&short_name) {
            config.disabled_tools.push(short_name);
        }
    }

    persistence
        .save(&configs)
        .await
        .map_err(map_mcp_persistence_err)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mcp_list_response_serialization() {
        let resp = McpListResponse {
            ok: true,
            configured: true,
            servers: vec![McpServerInfo {
                id: "srv1".to_string(),
                name: "srv1".to_string(),
                state: "ready".to_string(),
                tools: vec!["tool1".to_string()],
                tool_defs: Some(vec![McpToolDefinitionDto {
                    name: "tool1".to_string(),
                    prefixed_name: Some("mcp_srv1__tool1".to_string()),
                    description: Some("test tool".to_string()),
                    input_schema: Some(serde_json::json!({"type": "object"})),
                    enabled: true,
                }]),
                transport: "stdio".to_string(),
                auto_start: true,
                disabled_tools: vec![],
                command: Some("node".to_string()),
                args: Some(vec!["server.js".to_string()]),
                env: None,
                url: None,
            }],
        };

        let val = serde_json::to_value(&resp).unwrap();
        assert_eq!(val["ok"], true);
        assert_eq!(val["configured"], true);
        assert_eq!(val["servers"][0]["id"], "srv1");
        assert_eq!(val["servers"][0]["toolDefs"][0]["name"], "tool1");
        assert_eq!(val["servers"][0]["autoStart"], true);
    }

    #[test]
    fn test_mcp_control_result_serialization() {
        let res = McpControlResult {
            ok: true,
            server_id: "test".to_string(),
            state: Some("ready".to_string()),
            error: None,
            error_code: None,
        };
        let val = serde_json::to_value(&res).unwrap();
        assert_eq!(val["ok"], true);
        assert_eq!(val["serverId"], "test");
        assert_eq!(val["state"], "ready");
    }
}
