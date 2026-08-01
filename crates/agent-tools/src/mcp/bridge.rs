//! MCP 客户端桥（任务书 B5.4：stdio 子进程 + JSON-RPC 2.0 最小客户端）
//!
//! 设计（对齐 MCP 官方 stdio 规范，不引入 mcp 生态依赖）：
//! - 子进程经 tokio::process 拉起，stdin/stdout/stderr 全管道
//! - 消息按行分隔 JSON（MCP stdio 传输：每条 JSON-RPC 消息独占一行）
//! - 会话流程：initialize → notifications/initialized → tools/list → tools/call
//! - 请求/响应按递增 id 配对（oneshot 挂起表）；notification 忽略
//! - 生命周期：读线程 EOF 与轮询 try_wait 双路检测崩溃；stop 杀进程清理
//! - 工具适配：tools/list 结果 → ToolDefinition（名称前缀 `mcp_<server>__<tool>`
//!   防冲突）；tools/call 经 Tool trait 适配器进入统一执行器
//!
//! 错误协议：启动失败 → mcp.connection_failed；协议违规 → mcp.protocol_violation；
//! 请求超时 → runtime.timeout；server 未运行 → mcp.connection_failed。

use crate::definition::{default_input_schema, Tool, ToolDefinition, ToolError};
use crate::mcp::servers::McpServerConfig;
use async_trait::async_trait;
use conex_types::error::codes;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

/// MCP 协议版本（2025-03-26：官方当前稳定版；对端版本不回退协商）
pub const MCP_PROTOCOL_VERSION: &str = "2025-03-26";
/// tools/call 默认超时（任务书：30 秒）
pub const DEFAULT_MCP_CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// 握手 initialize 超时
pub const DEFAULT_MCP_INIT_TIMEOUT: Duration = Duration::from_secs(10);
/// 工具枚举 tools/list 超时
pub const DEFAULT_MCP_LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// 崩溃监测轮询间隔（进程退出后 stdout EOF 可能不立即到来时的兜底）
const CRASH_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// stderr 保留最近行数（诊断用）
const STDERR_TAIL_LIMIT: usize = 20;

/// 运行状态原子编码（state: AtomicU8）
const STATE_STOPPED: u8 = 0;
const STATE_STARTING: u8 = 1;
const STATE_READY: u8 = 2;
const STATE_DEGRADED: u8 = 3;
const STATE_EXITED: u8 = 4;

/// MCP server 运行状态（03 §3.2 C 组 list-mcp-servers 的 state 语义子集）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum McpServerRuntimeState {
    /// 未启动 / 已停止
    #[default]
    Stopped,
    /// 握手与工具枚举进行中
    Starting,
    /// 就绪（initialize 完成且工具已枚举）
    Ready,
    /// 降级（进程在跑但工具枚举失败，可 restart 重试）
    Degraded,
    /// 进程已退出（崩溃或被杀）
    Exited,
}

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

/// 会话内工具索引条目：远端工具名 + 适配后的本地定义
#[derive(Debug, Clone)]
struct McpToolHandle {
    server_tool_name: String,
    def: ToolDefinition,
}

/// MCP server 会话：一个 stdio 子进程 + JSON-RPC 通道
///
/// 会话可被桥与工具适配器共享（Arc）；最后一个引用释放时 Drop 兜底杀进程。
pub struct McpServerSession {
    server_id: String,
    state: AtomicU8,
    /// 子进程句柄（stop / 崩溃监测取走，取走后进程已回收）
    child: Mutex<Option<Child>>,
    /// 写端（请求与通知经此下发）
    stdin: Mutex<Option<ChildStdin>>,
    /// 请求 id 自增
    next_id: AtomicU64,
    /// 挂起请求表：id → 响应投递通道
    pending: std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    /// 已枚举工具定义（Ready 后非空）
    tools: RwLock<Option<Vec<ToolDefinition>>>,
    /// 前缀名 → 远端工具句柄（get_adapter 查表）
    tool_index: RwLock<HashMap<String, McpToolHandle>>,
    /// 退出原因（崩溃 / 被停止；首个写入者生效）
    exit_reason: std::sync::Mutex<Option<String>>,
    /// stderr 尾部（诊断）
    stderr_tail: std::sync::Mutex<Vec<String>>,
    /// tools/call 超时（可经桥配置覆盖）
    call_timeout: Duration,
}

impl McpServerSession {
    /// 会话所属 server id
    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    /// 当前运行状态
    pub fn state(&self) -> McpServerRuntimeState {
        runtime_state_of(self.state.load(Ordering::SeqCst))
    }

    /// 会话是否可收发请求（Starting / Ready / Degraded）
    pub fn is_running(&self) -> bool {
        matches!(
            self.state(),
            McpServerRuntimeState::Starting
                | McpServerRuntimeState::Ready
                | McpServerRuntimeState::Degraded
        )
    }

    /// 已枚举工具定义（未就绪为空）
    pub fn tools(&self) -> Vec<ToolDefinition> {
        self.tools
            .read()
            .expect("工具表读锁中毒后不可恢复")
            .clone()
            .unwrap_or_default()
    }

    /// 退出原因（未退出为 None）
    pub fn exit_reason(&self) -> Option<String> {
        self.exit_reason
            .lock()
            .expect("退出原因锁中毒后不可恢复")
            .clone()
    }

    /// stderr 尾部（最近若干行，诊断用）
    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail
            .lock()
            .expect("stderr 缓冲锁中毒后不可恢复")
            .clone()
    }

    /// 设置运行状态（原子写）
    pub(crate) fn set_state(&self, state: McpServerRuntimeState) {
        self.state.store(runtime_state_code(state), Ordering::SeqCst);
    }

    /// 标记会话已退出（崩溃 / 被停止；幂等）
    ///
    /// 首个退出原因生效；同时释放挂起请求（投递端 drop → 接收端
    /// 收到 RecvError，由 request 映射为 connection_failed）。
    pub(crate) fn mark_exited(&self, reason: impl Into<String>) {
        {
            let mut exit_reason = self.exit_reason.lock().expect("退出原因锁中毒后不可恢复");
            if exit_reason.is_none() {
                *exit_reason = Some(reason.into());
            }
        }
        self.state.store(STATE_EXITED, Ordering::SeqCst);
        let pending = std::mem::take(
            &mut *self.pending.lock().expect("请求表锁中毒后不可恢复"),
        );
        drop(pending);
    }

    /// 记录一行 stderr（环形尾部）
    pub(crate) fn push_stderr_line(&self, line: String) {
        let mut tail = self.stderr_tail.lock().expect("stderr 缓冲锁中毒后不可恢复");
        tail.push(line);
        while tail.len() > STDERR_TAIL_LIMIT {
            tail.remove(0);
        }
    }

    /// 启动子进程并建立会话（仅进程拉起与后台任务；握手由桥驱动）
    pub(crate) async fn spawn(
        config: &McpServerConfig,
        call_timeout: Duration,
    ) -> Result<Arc<Self>, ToolError> {
        let mut command = Command::new(&config.command);
        command
            .args(&config.args)
            .envs(&config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|e| {
            ToolError::new(
                codes::MCP_CONNECTION_FAILED,
                format!("启动 MCP server {} 失败（command={}）：{e}", config.server_id, config.command),
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| connection_failed(format!("无法取得 {} 的 stdin", config.server_id)))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| connection_failed(format!("无法取得 {} 的 stdout", config.server_id)))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| connection_failed(format!("无法取得 {} 的 stderr", config.server_id)))?;

        let session = Arc::new(McpServerSession {
            server_id: config.server_id.clone(),
            state: AtomicU8::new(STATE_STOPPED),
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            next_id: AtomicU64::new(0),
            pending: std::sync::Mutex::new(HashMap::new()),
            tools: RwLock::new(None),
            tool_index: RwLock::new(HashMap::new()),
            exit_reason: std::sync::Mutex::new(None),
            stderr_tail: std::sync::Mutex::new(Vec::new()),
            call_timeout,
        });
        session.set_state(McpServerRuntimeState::Starting);
        spawn_reader(&session, stdout);
        spawn_stderr_drainer(&session, stderr);
        spawn_crash_monitor(&session);
        Ok(session)
    }

    /// 停止会话：标记退出 + 杀子进程 + 回收 + 关闭写端（幂等）
    pub async fn stop(&self) {
        self.mark_exited("已停止");
        let child = self.child.lock().await.take();
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.stdin.lock().await.take();
    }

    /// JSON-RPC 请求-响应（initialize / tools/list / tools/call 共用）
    ///
    /// 写失败 / 会话已退出 → mcp.connection_failed；响应含 error →
    /// mcp.protocol_violation；超时 → runtime.timeout（挂起项移除，防泄漏）。
    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, ToolError> {
        if !self.is_running() {
            return Err(self.unavailable_error());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("请求表锁中毒后不可恢复")
            .insert(id, tx);
        let payload = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .expect("JSON-RPC 请求序列化不可能失败");
        // MCP stdio 规范：消息按行分隔，必须带换行结束
        let mut payload = payload.into_bytes();
        payload.push(b'\n');
        let written = {
            let mut stdin = self.stdin.lock().await;
            let Some(writer) = stdin.as_mut() else {
                return Err(self.unavailable_error());
            };
            async {
                writer.write_all(&payload).await?;
                writer.flush().await?;
                Ok(())
            }
            .await
            .map_err(|e: std::io::Error| {
                ToolError::new(
                    codes::MCP_CONNECTION_FAILED,
                    format!("写入 MCP server {} stdin 失败：{e}", self.server_id),
                )
            })
        };
        if let Err(e) = written {
            self.pending
                .lock()
                .expect("请求表锁中毒后不可恢复")
                .remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => response_result(&self.server_id, response),
            Ok(Err(_)) => Err(self.unavailable_error()),
            Err(_) => {
                self.pending
                    .lock()
                    .expect("请求表锁中毒后不可恢复")
                    .remove(&id);
                Err(ToolError::new(
                    codes::RUNTIME_TIMEOUT,
                    format!("MCP 请求超时（{}ms）：{}", timeout.as_millis(), method),
                ))
            }
        }
    }

    /// 发送 JSON-RPC 通知（无响应，fire-and-forget）
    async fn send_notification(&self, method: &str, params: Value) -> Result<(), ToolError> {
        if !self.is_running() {
            return Err(self.unavailable_error());
        }
        let payload = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .expect("JSON-RPC 通知序列化不可能失败");
        let mut payload = payload.into_bytes();
        payload.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        let Some(writer) = stdin.as_mut() else {
            return Err(self.unavailable_error());
        };
        writer.write_all(&payload).await.map_err(|e| {
            ToolError::new(
                codes::MCP_CONNECTION_FAILED,
                format!("写入 MCP server {} stdin 失败：{e}", self.server_id),
            )
        })?;
        writer.flush().await.map_err(|e| {
            ToolError::new(
                codes::MCP_CONNECTION_FAILED,
                format!("写入 MCP server {} stdin 失败：{e}", self.server_id),
            )
        })
    }

    /// 调用远端工具（tools/call；超时默认 30 秒）
    ///
    /// display_name 用于错误消息（注册表内的前缀名，人读更清晰）。
    pub(crate) async fn call_tool(
        &self,
        tool_name: &str,
        display_name: &str,
        args: Value,
    ) -> Result<Value, ToolError> {
        let params = json!({ "name": tool_name, "arguments": args });
        let result = self
            .request("tools/call", params, self.call_timeout)
            .await?;
        adapt_call_result(&result, display_name)
    }

    /// 枚举远端工具（tools/list）
    pub(crate) async fn list_tools_remote(&self) -> Result<Vec<McpToolInfo>, ToolError> {
        let result = self.request("tools/list", json!({}), DEFAULT_MCP_LIST_TIMEOUT).await?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ToolError::new(
                    codes::MCP_PROTOCOL_VIOLATION,
                    format!("MCP server {} 的 tools/list 响应缺少 tools 数组", self.server_id),
                )
            })?;
        tools.iter().map(parse_tool_info).collect()
    }

    /// 写入工具枚举结果：填充定义缓存 + 前缀名索引
    pub(crate) fn set_tools(&self, tools: &[McpToolInfo], defs: &[ToolDefinition]) {
        let index = tools
            .iter()
            .zip(defs)
            .map(|(info, def)| {
                (
                    def.name.clone(),
                    McpToolHandle {
                        server_tool_name: info.name.clone(),
                        def: def.clone(),
                    },
                )
            })
            .collect();
        *self.tools.write().expect("工具表写锁中毒后不可恢复") = Some(defs.to_vec());
        *self.tool_index.write().expect("工具索引写锁中毒后不可恢复") = index;
    }

    /// 会话不可用时的错误（含退出原因，便于诊断崩溃）
    fn unavailable_error(&self) -> ToolError {
        let reason = self
            .exit_reason()
            .map(|r| format!("（{r}）"))
            .unwrap_or_default();
        ToolError::new(
            codes::MCP_CONNECTION_FAILED,
            format!("MCP server {} 不可用{}", self.server_id, reason),
        )
    }
}

impl Drop for McpServerSession {
    fn drop(&mut self) {
        // 兜底：引用归零时尽力杀进程（同步 start_kill；stdin 随字段
        // 释放关闭，子进程读到 EOF 自行退出）
        if let Ok(mut guard) = self.child.try_lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.start_kill();
            }
        }
    }
}

/// MCP 工具适配器：把远端 tools/call 包装成本地 Tool trait 实现
pub struct McpToolAdapter {
    session: Arc<McpServerSession>,
    server_tool_name: String,
    def: ToolDefinition,
}

#[async_trait]
impl Tool for McpToolAdapter {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, args: Value) -> Result<Value, ToolError> {
        self.session
            .call_tool(&self.server_tool_name, &self.def.name, args)
            .await
    }
}

/// MCP 客户端桥：server 运行生命周期 + 工具注册桥接
#[derive(Default)]
pub struct McpClientBridge {
    sessions: std::sync::Mutex<HashMap<String, Arc<McpServerSession>>>,
    /// tools/call 超时（默认 30 秒）
    call_timeout: Duration,
}

impl McpClientBridge {
    /// 空桥（默认超时：tools/call 30 秒）
    pub fn new() -> Self {
        Self {
            sessions: std::sync::Mutex::new(HashMap::new()),
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
    pub async fn start(&self, config: &McpServerConfig) -> Result<Vec<ToolDefinition>, ToolError> {
        config.validate()?;
        {
            let sessions = self.sessions.lock().expect("会话表锁中毒后不可恢复");
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
            .expect("会话表锁中毒后不可恢复")
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

        match &result {
            Ok(_) => Ok(result.expect("Ok 分支必有值")),
            Err(_) => {
                session.set_state(McpServerRuntimeState::Degraded);
                Err(result.expect_err("Err 分支必有值"))
            }
        }
    }

    /// 停止 server：杀子进程 + 清理（未运行 → mcp.server_not_found）
    pub async fn stop(&self, server_id: &str) -> Result<(), ToolError> {
        let session = self
            .sessions
            .lock()
            .expect("会话表锁中毒后不可恢复")
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

    /// 停止全部 server，返回停止数量
    pub async fn stop_all(&self) -> usize {
        let sessions = std::mem::take(
            &mut *self.sessions.lock().expect("会话表锁中毒后不可恢复"),
        );
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
            .expect("会话表锁中毒后不可恢复")
            .get(server_id)
            .map(|s| s.state())
            .unwrap_or(McpServerRuntimeState::Stopped)
    }

    /// 是否可收发请求
    pub fn is_running(&self, server_id: &str) -> bool {
        self.sessions
            .lock()
            .expect("会话表锁中毒后不可恢复")
            .get(server_id)
            .map(|s| s.is_running())
            .unwrap_or(false)
    }

    /// 已枚举工具定义（未启动 / 未就绪为 None）
    pub fn tools(&self, server_id: &str) -> Option<Vec<ToolDefinition>> {
        self.sessions
            .lock()
            .expect("会话表锁中毒后不可恢复")
            .get(server_id)
            .map(|s| s.tools())
            .filter(|tools| !tools.is_empty())
    }

    /// 取工具适配器（tool_name 为注册表前缀名；未就绪返回 None）
    pub fn get_adapter(&self, server_id: &str, tool_name: &str) -> Option<Arc<dyn Tool>> {
        let session = self
            .sessions
            .lock()
            .expect("会话表锁中毒后不可恢复")
            .get(server_id)?
            .clone();
        let handle = session
            .tool_index
            .read()
            .expect("工具索引读锁中毒后不可恢复")
            .get(tool_name)?
            .clone();
        Some(Arc::new(McpToolAdapter {
            session,
            server_tool_name: handle.server_tool_name,
            def: handle.def,
        }))
    }

    /// 当前管理的 server id 列表（含降级 / 已退出但未清理的）
    pub fn managed_servers(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .sessions
            .lock()
            .expect("会话表锁中毒后不可恢复")
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids
    }
}

// ==================== 协议与适配（纯函数，可单测） ====================

/// 工具名前缀：`mcp_<sanitize(server_id)>__<tool_name>`（防跨 server 冲突）
pub fn mcp_tool_name(server_id: &str, tool_name: &str) -> String {
    format!("mcp_{}__{}", sanitize_id_part(server_id), tool_name)
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
/// 名称加 `mcp_<server>__` 前缀；缺 description 用空串；缺 inputSchema
/// 回退兜底形状（02 §二.6：{type:'object',properties:{},additionalProperties:true}）。
pub fn adapt_tool_list(server_id: &str, tools: &[McpToolInfo]) -> Vec<ToolDefinition> {
    tools
        .iter()
        .map(|tool| ToolDefinition {
            name: mcp_tool_name(server_id, &tool.name),
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
fn parse_tool_info(value: &Value) -> Result<McpToolInfo, ToolError> {
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
    let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
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
fn initialize_params() -> Value {
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
fn response_result(server_id: &str, response: Value) -> Result<Value, ToolError> {
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

fn connection_failed(message: impl Into<String>) -> ToolError {
    ToolError::new(codes::MCP_CONNECTION_FAILED, message)
}

fn runtime_state_of(code: u8) -> McpServerRuntimeState {
    match code {
        STATE_STARTING => McpServerRuntimeState::Starting,
        STATE_READY => McpServerRuntimeState::Ready,
        STATE_DEGRADED => McpServerRuntimeState::Degraded,
        STATE_EXITED => McpServerRuntimeState::Exited,
        _ => McpServerRuntimeState::Stopped,
    }
}

fn runtime_state_code(state: McpServerRuntimeState) -> u8 {
    match state {
        McpServerRuntimeState::Stopped => STATE_STOPPED,
        McpServerRuntimeState::Starting => STATE_STARTING,
        McpServerRuntimeState::Ready => STATE_READY,
        McpServerRuntimeState::Degraded => STATE_DEGRADED,
        McpServerRuntimeState::Exited => STATE_EXITED,
    }
}

// ==================== 后台任务 ====================

/// stdout 读线程：行分隔 JSON-RPC 消息 → 按 id 投递到挂起请求
///
/// EOF（进程退出 / stdout 关闭）→ 标记会话退出，释放全部挂起请求。
fn spawn_reader(session: &Arc<McpServerSession>, stdout: tokio::process::ChildStdout) {
    let session = session.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            handle_response_line(&session, &line);
        }
        session.mark_exited("stdout 关闭（进程退出或通道中断）");
    });
}

/// 单行分发：无 id（notification / 对端请求）忽略；有 id → 投递
fn handle_response_line(session: &McpServerSession, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
        // 非 JSON 行：部分 server 会在 stdout 上打日志，容忍并忽略
        return;
    };
    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        return;
    };
    if let Some(tx) = session
        .pending
        .lock()
        .expect("请求表锁中毒后不可恢复")
        .remove(&id)
    {
        let _ = tx.send(message);
    }
}

/// stderr 排空线程：环形缓冲保留最近行（诊断），避免管道写满阻塞子进程
fn spawn_stderr_drainer(session: &Arc<McpServerSession>, stderr: tokio::process::ChildStderr) {
    let session = session.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            session.push_stderr_line(line);
        }
    });
}

/// 崩溃监测线程：轮询 try_wait，进程退出后标记会话并回收句柄
///
/// 与 stdout EOF 双路冗余：部分 server 退出时子进程仍持有 stdout
/// 管道（如守护化），仅靠 EOF 会漏报。
fn spawn_crash_monitor(session: &Arc<McpServerSession>) {
    let session = session.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(CRASH_POLL_INTERVAL).await;
            if session.state() == McpServerRuntimeState::Exited {
                return;
            }
            let exited = {
                let mut guard = session.child.lock().await;
                match guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            guard.take();
                            Some(format!("进程退出（{status}）"))
                        }
                        Ok(None) => None,
                        Err(e) => {
                            guard.take();
                            Some(format!("进程状态查询失败：{e}"))
                        }
                    },
                    // stop() 已取走句柄并完成清理
                    None => None,
                }
            };
            if let Some(reason) = exited {
                session.mark_exited(reason);
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mcp_tool_name_prefixes_and_sanitizes() {
        assert_eq!(mcp_tool_name("files", "read"), "mcp_files__read");
        assert_eq!(mcp_tool_name("my.server", "read"), "mcp_my_server__read");
        assert_eq!(mcp_tool_name("a b.c!", "x-y"), "mcp_a_b_c___x-y");
        assert_eq!(sanitize_id_part("ok-name_1"), "ok-name_1");
    }

    #[test]
    fn adapt_tool_list_builds_prefixed_defs() {
        let tools = vec![
            McpToolInfo {
                name: "read".to_string(),
                description: "读文件".to_string(),
                input_schema: json!({ "type": "object", "properties": {} }),
            },
            // 缺 description / inputSchema：回退默认
            McpToolInfo {
                name: "write".to_string(),
                description: String::new(),
                input_schema: Value::Null,
            },
        ];
        let defs = adapt_tool_list("files", &tools);
        assert_eq!(defs.len(), 2);
        assert_eq!(defs[0].name, "mcp_files__read");
        assert_eq!(defs[0].description, "读文件");
        assert_eq!(defs[0].input_schema, json!({ "type": "object", "properties": {} }));
        assert_eq!(defs[1].name, "mcp_files__write");
        assert_eq!(
            defs[1].input_schema,
            json!({ "type": "object", "properties": {}, "additionalProperties": true })
        );
        assert!(!defs[0].dangerous);
        // 序列化 camelCase，可作为注册表工具列表载荷
        let value = serde_json::to_value(&defs[0]).unwrap();
        assert_eq!(value["name"], "mcp_files__read");
        assert_eq!(value["inputSchema"], json!({ "type": "object", "properties": {} }));
    }

    #[test]
    fn parse_tool_info_requires_name() {
        let err = parse_tool_info(&json!({ "description": "无名字" })).unwrap_err();
        assert_eq!(err.code(), "mcp.protocol_violation");
        let info = parse_tool_info(&json!({ "name": "t" })).unwrap();
        assert_eq!(info.name, "t");
        assert!(info.description.is_empty());
        assert_eq!(
            info.input_schema,
            json!({ "type": "object", "properties": {}, "additionalProperties": true })
        );
    }

    #[test]
    fn adapt_call_result_concats_text_and_structured() {
        let result = json!({
            "content": [
                { "type": "text", "text": "第一段" },
                { "type": "text", "text": "第二段" },
                { "type": "image", "data": "abc" }
            ],
            "structuredContent": { "sum": 3 },
            "isError": false
        });
        let out = adapt_call_result(&result, "mcp_s__add").unwrap();
        assert_eq!(out["text"], "第一段\n第二段");
        assert_eq!(out["json"], json!({ "sum": 3 }));
        assert_eq!(out["isError"], false);
        // content 原样透传
        assert_eq!(out["content"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn adapt_call_result_is_error_maps_to_execution_failed() {
        let result = json!({
            "content": [{ "type": "text", "text": "boom 失败" }],
            "isError": true
        });
        let err = adapt_call_result(&result, "mcp_s__boom").unwrap_err();
        assert_eq!(err.code(), "tool.execution_failed");
        assert!(err.to_string().contains("boom 失败"));
        // 无 text 时的兜底消息
        let err = adapt_call_result(&json!({ "isError": true }), "mcp_s__boom").unwrap_err();
        assert!(err.to_string().contains("isError=true"));
    }

    #[test]
    fn adapt_call_result_empty_result_ok() {
        let out = adapt_call_result(&json!({}), "mcp_s__x").unwrap();
        assert!(out.get("text").is_none());
        assert!(out.is_object());
    }

    #[test]
    fn response_result_maps_json_rpc_error() {
        let err = response_result(
            "s1",
            json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "方法不存在" } }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "mcp.protocol_violation");
        assert!(err.to_string().contains("方法不存在"));

        let err = response_result("s1", json!({ "jsonrpc": "2.0", "id": 1 })).unwrap_err();
        assert_eq!(err.code(), "mcp.protocol_violation");

        let result = response_result("s1", json!({ "jsonrpc": "2.0", "id": 1, "result": { "ok": true } }))
            .unwrap();
        assert_eq!(result["ok"], true);
    }

    #[test]
    fn default_call_timeout_is_30_seconds() {
        assert_eq!(DEFAULT_MCP_CALL_TIMEOUT, Duration::from_secs(30));
    }

    #[test]
    fn runtime_state_roundtrip() {
        for state in [
            McpServerRuntimeState::Stopped,
            McpServerRuntimeState::Starting,
            McpServerRuntimeState::Ready,
            McpServerRuntimeState::Degraded,
            McpServerRuntimeState::Exited,
        ] {
            assert_eq!(runtime_state_of(runtime_state_code(state)), state);
        }
        // serde lowercase（对齐前端 state 字符串）
        assert_eq!(serde_json::to_string(&McpServerRuntimeState::Degraded).unwrap(), "\"degraded\"");
    }

    /// 会话不可用错误：退出原因进消息
    #[test]
    fn unavailable_error_includes_exit_reason() {
        let session = McpServerSession {
            server_id: "s1".to_string(),
            state: AtomicU8::new(STATE_EXITED),
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            next_id: AtomicU64::new(0),
            pending: std::sync::Mutex::new(HashMap::new()),
            tools: RwLock::new(None),
            tool_index: RwLock::new(HashMap::new()),
            exit_reason: std::sync::Mutex::new(Some("进程退出（exit status: 1）".to_string())),
            stderr_tail: std::sync::Mutex::new(Vec::new()),
            call_timeout: DEFAULT_MCP_CALL_TIMEOUT,
        };
        let err = session.unavailable_error();
        assert_eq!(err.code(), "mcp.connection_failed");
        assert!(err.to_string().contains("进程退出"));
    }
}
