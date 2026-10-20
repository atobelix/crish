//! MCP 桥生命周期与注册域（SR-06a-6 · 拆分 · ≠ EL）
//!
//! 从 `bridge.rs` 按逻辑域切出的 registry 域：
//! - `McpClientBridge`：server 运行生命周期管理（start 握手编排 /
//!   stop / stop_all / 状态查询 / 适配器取用 / managed 列表），会话表
//!   单锁持有（锁中毒恢复经 `bridge_session::recover_lock`）
//! - `McpToolAdapter`：远端 tools/call 包装成本地 Tool trait 实现
//!
//! 依赖方向：经 `super::bridge_session`（会话/调用执行）与
//! `super::bridge_protocol`（协议/参数适配）引用；本模不反向依赖任何
//! 上层。公开 API 与拆分前一致（`bridge` 门面 re-export 保持）。
//! 诚实边界：仅结构拆分，注册/生命周期/鉴权语义零改动（≠ EL /
//! ≠ 打开完成 / ≠ 结构债清零）。

use crate::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_types::error::codes;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use super::bridge_protocol::{
    adapt_tool_list, initialize_params, DEFAULT_MCP_CALL_TIMEOUT, DEFAULT_MCP_INIT_TIMEOUT,
};
use super::bridge_session::{recover_lock, McpServerRuntimeState, McpServerSession};

/// MCP 动态工具适配器：把远端 tools/call 包装成本地 Tool trait 实现
///
/// 废除静态持有 Arc<McpServerSession> 的悬挂死指针模式，采用弱引用网桥 + 动态寻址
/// （Arc<McpClientBridge> + server_id），子进程重启后自动路由到最新健康会话（BC11-2）
pub struct McpDynamicToolAdapter {
    bridge: Arc<McpClientBridge>,
    server_id: String,
    server_tool_name: String,
    def: ToolDefinition,
}

impl McpDynamicToolAdapter {
    pub fn new(
        bridge: Arc<McpClientBridge>,
        server_id: impl Into<String>,
        server_tool_name: impl Into<String>,
        def: ToolDefinition,
    ) -> Self {
        Self {
            bridge,
            server_id: server_id.into(),
            server_tool_name: server_tool_name.into(),
            def,
        }
    }

    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    pub fn server_tool_name(&self) -> &str {
        &self.server_tool_name
    }
}

#[async_trait]
impl Tool for McpDynamicToolAdapter {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(
        &self,
        _ctx: &crate::context::ToolContext,
        args: Value,
    ) -> Result<Value, ToolError> {
        let session = {
            let sessions = self.bridge.sessions.lock().unwrap_or_else(recover_lock);
            sessions.get(&self.server_id).cloned()
        };
        let Some(session) = session else {
            return Err(ToolError::new(
                codes::MCP_CONNECTION_FAILED,
                format!("MCP server {} 不可用（未注册会话）", self.server_id),
            ));
        };
        if !session.is_running() {
            return Err(session.unavailable_error());
        }
        session
            .call_tool(&self.server_tool_name, &self.def.name, args)
            .await
    }
}

/// 兼容别名：McpToolAdapter 指向 McpDynamicToolAdapter
pub type McpToolAdapter = McpDynamicToolAdapter;

/// MCP 客户端桥：server 运行生命周期 + 工具注册桥接
#[derive(Clone, Default)]
pub struct McpClientBridge {
    pub(crate) sessions: Arc<std::sync::Mutex<HashMap<String, Arc<McpServerSession>>>>,
    /// tools/call 超时（默认 30 秒）
    call_timeout: Duration,
}

impl McpClientBridge {
    /// 空桥（默认超时：tools/call 30 秒）
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(std::sync::Mutex::new(HashMap::new())),
            call_timeout: DEFAULT_MCP_CALL_TIMEOUT,
        }
    }

    /// 覆盖 tools/call 超时（测试 / 策略调整用）
    pub fn with_call_timeout(mut self, call_timeout: Duration) -> Self {
        self.call_timeout = call_timeout;
        self
    }

    /// 启动 MCP server：拉起子进程 → initialize 握手 → tools/list 枚举
    ///
    /// 返回适配后的本地工具定义（名称 `mcp_<server>__<tool>`）。
    /// - 已就绪：幂等返回缓存定义；正在启动：报错（避免并发拉起）
    /// - 降级 / 已退出：替换重建会话
    /// - 握手失败：进程被杀、会话不入表、返回 mcp.* 错误
    /// - 工具枚举失败：会话保留（Degraded），返回错误
    pub async fn start(
        &self,
        config: &crate::mcp::servers::McpServerConfig,
    ) -> Result<Vec<ToolDefinition>, ToolError> {
        config.validate()?;
        {
            let sessions = self.sessions.lock().unwrap_or_else(recover_lock);
            if let Some(session) = sessions.get(&config.server_id) {
                match session.state() {
                    McpServerRuntimeState::Ready => return Ok(session.tools()),
                    McpServerRuntimeState::Starting => {
                        return Err(ToolError::new(
                            codes::MCP_CONNECTION_FAILED,
                            format!("MCP server {} 正在启动中", config.server_id),
                        ));
                    }
                    McpServerRuntimeState::Degraded | McpServerRuntimeState::Exited => {
                        // 重建：让出锁后统一走拉起路径
                    }
                    McpServerRuntimeState::Stopped => {}
                }
            }
        }
        let session = McpServerSession::spawn(config, self.call_timeout).await?;
        self.sessions
            .lock()
            .unwrap_or_else(recover_lock)
            .insert(config.server_id.clone(), session.clone());

        let result: Result<Vec<ToolDefinition>, ToolError> = async {
            session
                .request("initialize", initialize_params(), DEFAULT_MCP_INIT_TIMEOUT)
                .await
                .map_err(|e| {
                    ToolError::new(
                        codes::MCP_CONNECTION_FAILED,
                        format!("MCP server {} 握手失败：{e}", config.server_id),
                    )
                })?;
            session
                .send_notification("notifications/initialized", json!({}))
                .await
                .map_err(|e| {
                    ToolError::new(
                        codes::MCP_CONNECTION_FAILED,
                        format!("MCP server {} 初始化通知失败：{e}", config.server_id),
                    )
                })?;
            let tools = session.list_tools_remote().await?;
            let defs = adapt_tool_list(&config.server_id, &tools);
            session.set_tools(&tools, &defs);
            session.set_state(McpServerRuntimeState::Ready);
            Ok(defs)
        }
        .await;

        // PE-07 T07.6 C 模式（Q17 样板简化）：538/541 的 match + expect/expect_err
        // 样板对整体简化为直接返回 result（result 本身即 Result<Vec<ToolDefinition>, ToolError>）
        if result.is_err() && session.state() != McpServerRuntimeState::Exited {
            // 握手 / 工具枚举失败：进程保留（Degraded），供 restart 重建重试（不覆盖已 Exited 终态）
            session.set_state(McpServerRuntimeState::Degraded);
        }
        result
    }

    /// 停止 server：杀子进程 + 清理（未运行 → mcp.server_not_found）
    pub async fn stop(&self, server_id: &str) -> Result<(), ToolError> {
        let session = self
            .sessions
            .lock()
            .unwrap_or_else(recover_lock)
            .remove(server_id);
        match session {
            Some(session) => {
                session.stop().await;
                Ok(())
            }
            None => Err(ToolError::new(
                codes::MCP_SERVER_NOT_FOUND,
                format!("MCP server 未运行：{server_id}"),
            )),
        }
    }

    /// 重启 server（先 stop 再 start）
    pub async fn restart(
        &self,
        config: &crate::mcp::servers::McpServerConfig,
    ) -> Result<Vec<ToolDefinition>, ToolError> {
        // 重启语义：旧实例可能已不存在（stop 报 not_found）——不阻断重启，
        // 但必须留痕，避免把「停不掉」伪装成干净重启。
        if let Err(error) = self.stop(&config.server_id).await {
            tracing::warn!(
                server_id = %config.server_id,
                code = error.code(),
                "重启前停止 MCP server 失败，继续尝试启动：{}",
                error
            );
        }
        self.start(config).await
    }

    /// 指数退避自愈重启 server（最多重试 max_retries 次，500ms -> 1000ms -> 2000ms -> 4000ms）
    pub async fn restart_with_backoff(
        &self,
        config: &crate::mcp::servers::McpServerConfig,
        max_retries: usize,
    ) -> Result<Vec<ToolDefinition>, ToolError> {
        let mut delay = std::time::Duration::from_millis(500);
        let max_delay = std::time::Duration::from_millis(4000);
        let mut last_err = None;

        for attempt in 0..=max_retries {
            if attempt > 0 {
                tracing::info!(
                    server_id = %config.server_id,
                    attempt,
                    delay_ms = delay.as_millis(),
                    "MCP server 崩溃/启动失败，执行指数退避重试拉起"
                );
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(max_delay);
            }
            match self.restart(config).await {
                Ok(defs) => return Ok(defs),
                Err(e) => {
                    tracing::warn!(
                        server_id = %config.server_id,
                        attempt,
                        error = %e,
                        "MCP server 重启尝试失败"
                    );
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| {
            ToolError::new(
                codes::MCP_CONNECTION_FAILED,
                format!("MCP server {} 重启重试次数超限", config.server_id),
            )
        }))
    }

    /// 停止全部 server，返回停止数量
    pub async fn stop_all(&self) -> usize {
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap_or_else(recover_lock));
        let count = sessions.len();
        for session in sessions.values() {
            session.stop().await;
        }
        count
    }

    /// 运行状态查询（未启动视为 Stopped）
    pub fn state(&self, server_id: &str) -> McpServerRuntimeState {
        self.sessions
            .lock()
            .unwrap_or_else(recover_lock)
            .get(server_id)
            .map(|s| s.state())
            .unwrap_or(McpServerRuntimeState::Stopped)
    }

    /// 是否可收发请求
    pub fn is_running(&self, server_id: &str) -> bool {
        self.sessions
            .lock()
            .unwrap_or_else(recover_lock)
            .get(server_id)
            .map(|s| s.is_running())
            .unwrap_or(false)
    }

    /// 获取当前健康且运行中的会话（is_running 为真且未进入 Exited 终态）
    pub fn get_active_session(&self, server_id: &str) -> Option<Arc<McpServerSession>> {
        let sessions = self.sessions.lock().unwrap_or_else(recover_lock);
        let session = sessions.get(server_id)?;
        if session.is_running() {
            Some(session.clone())
        } else {
            None
        }
    }

    /// 已枚举工具定义（未启动 / 未就绪为 None）
    pub fn tools(&self, server_id: &str) -> Option<Vec<ToolDefinition>> {
        self.sessions
            .lock()
            .unwrap_or_else(recover_lock)
            .get(server_id)
            .map(|s| s.tools())
            .filter(|tools| !tools.is_empty())
    }

    /// 取工具适配器（tool_name 为注册表前缀名；未就绪返回 None）
    pub fn get_adapter(&self, server_id: &str, tool_name: &str) -> Option<Arc<dyn Tool>> {
        let session = self
            .sessions
            .lock()
            .unwrap_or_else(recover_lock)
            .get(server_id)?
            .clone();
        let handle = session
            .tool_index
            .read()
            .unwrap_or_else(recover_lock)
            .get(tool_name)?
            .clone();
        Some(Arc::new(McpDynamicToolAdapter {
            bridge: Arc::new(self.clone()),
            server_id: server_id.to_string(),
            server_tool_name: handle.server_tool_name,
            def: handle.def,
        }))
    }

    /// 显式传入 Arc<McpClientBridge> 构造动态适配器
    pub fn get_dynamic_adapter(
        bridge: Arc<McpClientBridge>,
        server_id: &str,
        tool_name: &str,
    ) -> Option<Arc<dyn Tool>> {
        let session = bridge
            .sessions
            .lock()
            .unwrap_or_else(recover_lock)
            .get(server_id)?
            .clone();
        let handle = session
            .tool_index
            .read()
            .unwrap_or_else(recover_lock)
            .get(tool_name)?
            .clone();
        Some(Arc::new(McpDynamicToolAdapter {
            bridge,
            server_id: server_id.to_string(),
            server_tool_name: handle.server_tool_name,
            def: handle.def,
        }))
    }

    /// 当前管理的 server id 列表（含降级 / 已退出但未清理的）
    pub fn managed_servers(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .sessions
            .lock()
            .unwrap_or_else(recover_lock)
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids
    }
}

#[cfg(test)]
#[path = "bridge_registry_tests.rs"]
mod tests;
