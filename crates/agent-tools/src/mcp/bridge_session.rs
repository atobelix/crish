//! MCP 进程/会话/调用执行域（SR-06a-6 · 拆分 · ≠ EL）
//!
//! 从 `bridge.rs` 按逻辑域切出的会话域：stdio 子进程生命周期、
//! JSON-RPC 请求-响应通道、工具枚举缓存与崩溃检测：
//! - `McpServerSession`：一个 stdio 子进程 + JSON-RPC 通道（会话共享，
//!   最后引用 Drop 兜底杀进程）；request/notification/call/list 原语
//! - 状态机：STATE_STOPPED/STARTING/READY/DEGRADED/EXITED（AtomicU8）
//! - 后台任务：stdout 读线程（按 id 投递挂起请求）、stderr 排空线程
//!   （环形尾部诊断）、崩溃监测线程（try_wait 轮询，与 EOF 双路冗余）
//! - `recover_lock`：锁中毒恢复（PE-07 T07.6 A 模式）——`bridge_registry`
//!   经 `pub(crate)` 共用
//!
//! 依赖方向：经 `super::bridge_protocol::…` 引用协议/适配域（本模无
//! registry 依赖）；`bridge_registry`（生命周期）引用本模会话。
//! 诚实边界：仅结构拆分，会话/进程/调用语义零改动（≠ EL / ≠ 打开完成 /
//! ≠ 结构债清零）。

use crate::definition::{ToolDefinition, ToolError};
use crate::mcp::servers::McpServerConfig;
use conex_shared::perf_budget::MCP_STDOUT_MAX_LINE_BYTES;
use conex_types::error::codes;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use super::bridge_protocol::{
    adapt_call_result, connection_failed, parse_tool_info, response_result, McpToolInfo,
    DEFAULT_MCP_LIST_TIMEOUT,
};

/// 崩溃监测轮询间隔（进程退出后 stdout EOF 可能不立即到来时的兜底）
const CRASH_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// stderr 保留最近行数（诊断用）
const STDERR_TAIL_LIMIT: usize = 20;

/// 锁中毒恢复（PE-07 T07.6 A 模式，Q17 处置）：PoisonError → 记录错误并取回守卫继续使用。
///
/// 对齐 AA-01 正面发现 3（handlers/mod.rs:199 先例）：临界区无 await、持锁时间短，
/// 恢复后状态可能不完整但进程不 panic（恶意/异常 MCP server 回调不再级联 DoS）。
/// 仅用于 std `Mutex`/`RwLock`；tokio `Mutex` 无中毒语义，不适用。
/// `pub(crate)`：`bridge_registry` 生命周期域共用。
pub(crate) fn recover_lock<T>(poison: std::sync::PoisonError<T>) -> T {
    tracing::error!("MCP 桥锁中毒，按恢复模式继续（锁内状态可能不完整）：{poison}");
    poison.into_inner()
}

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

/// 会话内工具索引条目：远端工具名 + 适配后的本地定义
///
/// `pub(crate)`：`bridge_registry` 的 get_adapter 经索引读表构造适配器。
#[derive(Debug, Clone)]
pub(crate) struct McpToolHandle {
    pub(crate) server_tool_name: String,
    pub(crate) def: ToolDefinition,
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
    pub(crate) tool_index: RwLock<HashMap<String, McpToolHandle>>,
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
            .unwrap_or_else(recover_lock)
            .clone()
            .unwrap_or_default()
    }

    /// 退出原因（未退出为 None）
    pub fn exit_reason(&self) -> Option<String> {
        self.exit_reason.lock().unwrap_or_else(recover_lock).clone()
    }

    /// stderr 尾部（最近若干行，诊断用）
    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail.lock().unwrap_or_else(recover_lock).clone()
    }

    /// 设置运行状态（原子写）
    pub(crate) fn set_state(&self, state: McpServerRuntimeState) {
        self.state
            .store(runtime_state_code(state), Ordering::SeqCst);
    }

    /// 标记会话已退出（崩溃 / 被停止；幂等）
    ///
    /// 首个退出原因生效；同时释放挂起请求（投递端 drop → 接收端
    /// 收到 RecvError，由 request 映射为 connection_failed）。
    pub(crate) fn mark_exited(&self, reason: impl Into<String>) {
        {
            let mut exit_reason = self.exit_reason.lock().unwrap_or_else(recover_lock);
            if exit_reason.is_none() {
                *exit_reason = Some(reason.into());
            }
        }
        self.state.store(STATE_EXITED, Ordering::SeqCst);
        let pending = std::mem::take(&mut *self.pending.lock().unwrap_or_else(recover_lock));
        drop(pending);
    }

    /// 记录一行 stderr（环形尾部）
    pub(crate) fn push_stderr_line(&self, line: String) {
        let mut tail = self.stderr_tail.lock().unwrap_or_else(recover_lock);
        tail.push(line);
        while tail.len() > STDERR_TAIL_LIMIT {
            tail.remove(0);
        }
    }

    /// 启动子进程并建立会话（仅进程拉起与后台任务；握手由桥驱动）
    // G2 禁令豁免（clippy.toml 文件头「豁免面」）：MCP server 进程注册面——
    // 启动命令来自用户配置的 server command（config.server_id 对应注册表），
    // 是 MCP 子进程的唯一拉起点，非任意命令执行面。
    #[allow(clippy::disallowed_methods)]
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
                format!(
                    "启动 MCP server {} 失败（command={}）：{e}",
                    config.server_id, config.command
                ),
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
    /// `pub(crate)`：`bridge_registry` 的 start 握手（initialize）经此。
    pub(crate) async fn request(
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
            .unwrap_or_else(recover_lock)
            .insert(id, tx);
        let payload = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        // PE-07 T07.6 B 模式（Q17 结果 expect 处置）：序列化本不应失败，
        // 失败时返回错误而非 panic（调用方传播）
        .map_err(|e| {
            ToolError::new(
                codes::RUNTIME_UNEXPECTED_STATE,
                format!("JSON-RPC 请求序列化失败（不应发生）：{e}"),
            )
        })?;
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
            self.pending.lock().unwrap_or_else(recover_lock).remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => response_result(&self.server_id, response),
            Ok(Err(_)) => Err(self.unavailable_error()),
            Err(_) => {
                self.pending.lock().unwrap_or_else(recover_lock).remove(&id);
                Err(ToolError::new(
                    codes::RUNTIME_TIMEOUT,
                    format!("MCP 请求超时（{}ms）：{}", timeout.as_millis(), method),
                ))
            }
        }
    }

    /// 发送 JSON-RPC 通知（无响应，fire-and-forget）
    ///
    /// `pub(crate)`：`bridge_registry` 的 start 握手（notifications/initialized）
    /// 经此。
    pub(crate) async fn send_notification(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(), ToolError> {
        if !self.is_running() {
            return Err(self.unavailable_error());
        }
        let payload = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        // PE-07 T07.6 B 模式（Q17 结果 expect 处置）：序列化本不应失败，
        // 失败时返回错误而非 panic（调用方传播）
        .map_err(|e| {
            ToolError::new(
                codes::RUNTIME_UNEXPECTED_STATE,
                format!("JSON-RPC 通知序列化失败（不应发生）：{e}"),
            )
        })?;
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
        let result = self
            .request("tools/list", json!({}), DEFAULT_MCP_LIST_TIMEOUT)
            .await?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ToolError::new(
                    codes::MCP_PROTOCOL_VIOLATION,
                    format!(
                        "MCP server {} 的 tools/list 响应缺少 tools 数组",
                        self.server_id
                    ),
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
        *self.tools.write().unwrap_or_else(recover_lock) = Some(defs.to_vec());
        *self.tool_index.write().unwrap_or_else(recover_lock) = index;
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
/// U-MEM（10-M1）：单行累计超 [`MCP_STDOUT_MAX_LINE_BYTES`] →
/// `mark_exited("stdout line too long")`（connection_failed 语义，非静默），
/// 替换无界 `lines().next_line()` 形态。
fn spawn_reader(session: &Arc<McpServerSession>, stdout: tokio::process::ChildStdout) {
    let session = session.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line_buf: Vec<u8> = Vec::with_capacity(8 * 1024);
        loop {
            line_buf.clear();
            // 有界读：累计超限 → connection_failed（非静默）
            let read_result = read_line_bounded(&mut reader, &mut line_buf).await;
            match read_result {
                Ok(Some(())) => {
                    // 去掉末尾 \n / \r\n
                    if line_buf.last() == Some(&b'\n') {
                        line_buf.pop();
                    }
                    if line_buf.last() == Some(&b'\r') {
                        line_buf.pop();
                    }
                    match std::str::from_utf8(&line_buf) {
                        Ok(line) => handle_response_line(&session, line),
                        Err(_) => {
                            // 非 UTF-8 行：容忍并忽略（与非 JSON 行同语义）
                        }
                    }
                }
                Ok(None) => break, // EOF
                Err(()) => {
                    // 行长超限：连接失败收场（10-M1 非静默）
                    session.mark_exited("stdout line too long");
                    return;
                }
            }
        }
        session.mark_exited("stdout 关闭（进程退出或通道中断）");
    });
}

/// 有界读一行：累计字节超 [`MCP_STDOUT_MAX_LINE_BYTES`] → `Err(())`；
/// 正常行读完（含 `\n`）→ `Ok(Some(()))`；EOF 且无残留 → `Ok(None)`。
///
/// 实现：`fill_buf`/`consume` 逐块推进（BufReader 内缓冲不残留未消费字节，
/// 与 shell 流式路径同构）；单行触顶立即返回，禁止无界 `next_line()`。
async fn read_line_bounded<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    line_buf: &mut Vec<u8>,
) -> Result<Option<()>, ()> {
    loop {
        let buf = reader.fill_buf().await.map_err(|_| ())?;
        if buf.is_empty() {
            return if line_buf.is_empty() {
                Ok(None)
            } else {
                // 最后一行无换行符：按完整行返回（EOF 收口）
                Ok(Some(()))
            };
        }
        // 在 buf 中找 \n
        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            line_buf.extend_from_slice(&buf[..=pos]);
            reader.consume(pos + 1);
            if line_buf.len() > MCP_STDOUT_MAX_LINE_BYTES {
                return Err(());
            }
            return Ok(Some(()));
        }
        // 无换行：整块入 buf，检查上限
        line_buf.extend_from_slice(buf);
        let n = buf.len();
        reader.consume(n);
        if line_buf.len() > MCP_STDOUT_MAX_LINE_BYTES {
            return Err(());
        }
    }
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
        .unwrap_or_else(recover_lock)
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
#[path = "bridge_session_tests.rs"]
mod tests;
