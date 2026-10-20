//! 统一发送层（维度 11 §4：五段管线 幂等→急停→审批→审计→传输）
//!
//! ```text
//! execute(cmd) ──▶ ⓪ 能力集 ① 幂等  ② 急停  ③ 审批  ④ 审计(before)  ⑤ 传输+超时  ⑥ 审计(after)
//! ```
//!
//! - 插桩点 = 唯一函数 `CommandSender::execute`，无旁路（send_page/send_browser
//!   均构造 Command 走本管线；恢复期 enable 序列属引擎内部流程，直连低层 client）
//! - ⓪ 能力集（R-12）：attach 会话只读白名单检查（`CommandPolicyHooks::attach_caps`
//!   注入，默认 None = 不启用）——fail-closed，先于幂等/审批一切阶段，拒绝返回
//!   `CdpError::CapabilityDenied` + Blocked 审计，不可审批豁免（17 §2.3 红线同级）
//! - **attach 会话面**（39-E3，R-12 接线）：[AttachCdpProxy]——引擎侧 CDP 会话面
//!   （WS 服务端，loopback 随机端口）。外部浏览器类 MCP（chrome-devtools-mcp 族）
//!   经 `--browserUrl` 指向本会话面而非直连受管实例端点：命令逐条经
//!   [CommandSender::execute] 五段管线（⓪ 能力集拦截在真实连接路径生效），事件经
//!   [ReadonlyCaps::filter_events] 只透传白名单事件。**挂载自检**：bind 前置校验
//!   [CommandSender::has_attach_caps]（hooks 未注入能力集 = 接线不完整 → 拒绝启动，
//!   防「代理已挂载但拦截未生效」的静默安全漏洞）
//! - 幂等：sender 层在途合并（同 IdKey 并发共享同一 pending，仅一次 WS 发送）+
//!   工具层 `hooks::idempotent` 短路（已完成命令缓存）
//! - 急停：`emergency_stop` 旗置位 → 新命令拒绝；`abort_token` 取消在途
//! - 审批：`dangerous == true` 挂起等 `approve`；Deny → 审计(Denied) + 拒绝不发送
//! - 审计：before（method/session/目标摘要，参数已脱敏）/ after（结果 + 耗时）
//! - `CancellationToken`：watch<bool> 自研 30 行实现（workspace 无 tokio-util
//!   直接依赖，零新增依赖；§4.2 注释口径）
//! - `CommandChannel`：发送通道抽象（transport 实现；测试可注入直连 client）

use crate::cdp::client::CdpClient;
use crate::cdp::error::{BrowserError, CancelReason, CdpError};
use crate::cdp::session_caps::ReadonlyCaps;
use crate::cdp::types::CdpEvent;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::WebSocketStream;

/// 常规命令默认超时（§2.3 常规命令 30s，agent-browser 同款）。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// 幂等键（session+method+params hash；Eq+Hash 供在途合并表）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct IdKey {
    pub session: Option<String>,
    pub method: String,
    pub params_hash: u64,
}

impl IdKey {
    pub fn new(session: Option<String>, method: impl Into<String>, params: &Value) -> Self {
        IdKey {
            session,
            method: method.into(),
            params_hash: hash_params(params),
        }
    }
}

/// 参数确定性 hash（FNV-1a over 紧凑 JSON 字节；跨调用稳定，防碰撞余量足够）。
fn hash_params(params: &Value) -> u64 {
    let bytes = params.to_string().into_bytes();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 审计阶段（§4.2 BrowserAuditEvent.phase）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditPhase {
    /// 发送前（含目标摘要）
    Before,
    /// 发送后（结果摘要 + 耗时）
    After,
    /// 审批拒绝（未发送）
    Denied,
    /// 门禁拦截（window.open 域名门禁等，维度 17 接线）
    Blocked,
}

/// 审批/审计视图（参数已脱敏：target_summary 为 url/节点摘要，敏感字段 [REDACTED]）。
#[derive(Debug, Clone)]
pub struct CdpCommandView {
    pub method: String,
    pub session: String,
    pub target_summary: String,
    pub dangerous: bool,
}

/// 审计事件（before/after 两相 + 拒绝/拦截）。
#[derive(Debug, Clone)]
pub struct BrowserAuditEvent {
    pub phase: AuditPhase,
    pub cmd: CdpCommandView,
    pub ok: bool,
    pub duration_ms: Option<u64>,
    /// 动作基于的页面版本（事后还原，13 文档 §4；本层不持有跟踪器，由引擎侧回填）
    pub snapshot_version: u64,
}

/// 审批拒绝（理由进审计与错误面）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalDenied {
    pub reason: String,
}

/// 发送层策略钩子。conex-browser 不依赖 agent-tools：本 trait 在核心侧定义，
/// 引擎侧（conex-browser-tools）用 agent-tools 的审批/审计设施实现并注入（评审乙 §2.11）。
#[async_trait]
pub trait CommandPolicyHooks: Send + Sync {
    /// 幂等判定：返回已有结果则短路（None = 继续发送；在途合并由 sender 层处理）
    async fn idempotent(&self, key: &IdKey) -> Option<Result<Value, CdpError>>;
    /// 审批：Ok(()) = 放行；Err(Deny{reason}) = 拒绝（审计由实现方负责发射）
    async fn approve(&self, cmd: &CdpCommandView) -> Result<(), ApprovalDenied>;
    /// 审计发射（before/after/denied/blocked 四相）
    fn audit(&self, event: BrowserAuditEvent);
    /// 急停旗（共享 AtomicBool，全局急停按钮/快捷键置位，§4.1 ②）
    fn emergency_stop(&self) -> Arc<AtomicBool>;
    /// abort 令牌（用户接管/急停时触发；取消全部在途命令）
    fn abort_token(&self) -> CancellationToken;
    /// 会话只读能力集（R-12，34 §5.2 E-3）：attach 会话由引擎侧注入，
    /// 非白名单命令 fail-closed 拒绝（先于幂等/审批一切阶段，不可审批豁免）。
    /// **默认 None = 不启用**——正常 browser_* 工具面（无 attach 会话）不受影响。
    fn attach_caps(&self) -> Option<Arc<ReadonlyCaps>> {
        None
    }
}

/// 取消令牌：watch<bool> 自研实现（30 行，零新增依赖；§4.2 注释口径：
/// tokio_util 若 workspace 已有则复用，否则自研——本仓库未直接依赖 tokio-util）。
#[derive(Clone)]
pub struct CancellationToken {
    tx: Arc<tokio::sync::watch::Sender<bool>>,
    /// 保活接收端：`watch::Sender::send` 在**无任何接收者**时返回 Err 且不更新值
    /// （tokio 1.x 实测，2026-08-09）——令牌必须自持一个接收端，`cancel()` 才生效；
    /// 否则无订阅者场景（如维度 14 动作层 abort 检查）下取消是静默空操作。
    _rx: Arc<tokio::sync::watch::Receiver<bool>>,
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

impl CancellationToken {
    pub fn new() -> Self {
        let (tx, rx) = tokio::sync::watch::channel(false);
        CancellationToken {
            tx: Arc::new(tx),
            _rx: Arc::new(rx),
        }
    }

    /// 触发取消（幂等）。
    pub fn cancel(&self) {
        // 令牌自身持有接收端（`_rx`），send 正常不可能失败；若失败说明
        // 不变量被破坏，必须留痕（否则取消静默失效 → 在途命令永不返回）。
        if let Err(err) = self.tx.send(true) {
            tracing::warn!("取消信号发送失败（令牌接收端缺失，取消可能失效）：{err}");
        }
    }

    pub fn is_cancelled(&self) -> bool {
        *self.tx.borrow()
    }

    /// 等待取消（在途命令取消路径）。
    pub async fn cancelled(&self) {
        let mut rx = self.tx.subscribe();
        // 已取消则立即返回
        if *rx.borrow() {
            return;
        }
        // 发送端已释放（令牌被 Drop）→ 不会再有取消信号；按「已取消」返回是
        // 既有语义，但必须留痕，避免与「真的收到取消」混淆。
        if let Err(err) = rx.changed().await {
            tracing::debug!("取消等待：令牌已释放（按已取消返回）：{err}");
        }
    }
}

/// 发送通道抽象：transport 实现（重连透明），测试可注入直连 client。
#[async_trait]
pub trait CommandChannel: Send + Sync {
    async fn send_command(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, CdpError>;
    async fn send_command_no_wait(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
    ) -> Result<(), CdpError>;
    /// 恢复期门禁（R-9-4：false = 工具面不可用）。
    fn is_ready(&self) -> bool;
}

/// 直连 client 通道（恢复流程/测试用；is_ready 恒 true）。
#[async_trait]
impl CommandChannel for CdpClient {
    async fn send_command(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, CdpError> {
        self.send_command_with_timeout(method, params, session_id, timeout)
            .await
    }
    async fn send_command_no_wait(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
    ) -> Result<(), CdpError> {
        self.send_command_no_wait(method, params, session_id).await
    }
    fn is_ready(&self) -> bool {
        true
    }
}

/// 命令（统一发送层入参；视图层标注危险语义与目标摘要）。
#[derive(Debug, Clone)]
pub struct Command {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
    pub dangerous: bool,
    pub timeout: Duration,
    /// 目标摘要（url/节点摘要；敏感字段由调用方自行 [REDACTED]）
    pub summary: String,
    pub idempotency_key: Option<IdKey>,
}

impl Command {
    pub fn new(method: impl Into<String>) -> Self {
        Command {
            method: method.into(),
            params: Value::Null,
            session_id: None,
            dangerous: false,
            timeout: DEFAULT_TIMEOUT,
            summary: String::new(),
            idempotency_key: None,
        }
    }

    pub fn params(mut self, params: impl Serialize) -> Self {
        self.params = serde_json::to_value(params).unwrap_or(Value::Null);
        self
    }

    pub fn with_session(mut self, session: impl Into<String>) -> Self {
        self.session_id = Some(session.into());
        self
    }

    pub fn dangerous(mut self) -> Self {
        self.dangerous = true;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn idempotent(mut self, key: IdKey) -> Self {
        self.idempotency_key = Some(key);
        self
    }

    pub fn with_summary(mut self, summary: impl Into<String>) -> Self {
        self.summary = summary.into();
        self
    }
}

/// 在途幂等合并表（IdKey → 结果广播；并发同键共享同一 pending）。
type InFlightMap =
    Arc<std::sync::Mutex<HashMap<IdKey, tokio::sync::broadcast::Sender<Result<Value, CdpError>>>>>;

/// 在途幂等守卫：结果发布 + 完成/取消时从合并表移除（Drop 同步清理）。
struct InFlightGuard {
    map: InFlightMap,
    key: IdKey,
    tx: tokio::sync::broadcast::Sender<Result<Value, CdpError>>,
    /// true = 尚未发布结果（Drop 时发布 Cancelled）
    armed: bool,
}

impl InFlightGuard {
    fn publish(&mut self, result: Result<Value, CdpError>) {
        // 合并等待方可能已全部放弃（超时/取消），无订阅者即无人接收——
        // 不构成命令失败（真实结果已由本次调用返回给主调用方），仅 debug。
        if let Err(err) = self.tx.send(result) {
            tracing::debug!("在途结果无等待方（丢弃）：{err}");
        }
        self.armed = false;
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        // 中途退出（急停/审批拒绝/取消）：合并等待方收到取消错误
        if self.armed {
            if let Err(err) = self.tx.send(Err(CdpError::Cancelled {
                reason: CancelReason::Aborted,
            })) {
                tracing::debug!("取消结果无等待方（丢弃）：{err}");
            }
        }
        if let Ok(mut map) = self.map.lock() {
            map.remove(&self.key);
        }
    }
}

/// 统一发送层（五段管线唯一插桩点）。
pub struct CommandSender {
    channel: Arc<dyn CommandChannel>,
    hooks: Arc<dyn CommandPolicyHooks>,
    in_flight: InFlightMap,
}

impl CommandSender {
    pub fn new(channel: Arc<dyn CommandChannel>, hooks: Arc<dyn CommandPolicyHooks>) -> Self {
        CommandSender {
            channel,
            hooks,
            in_flight: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// attach 会话面装配自检（R-12，39-E3）：hooks 是否已注入只读能力集
    /// （`attach_caps() != None`）。[AttachCdpProxy::bind] 前置校验用——接线不完整
    /// （未注入能力集）时拒绝启动，防止「代理已挂载但拦截未生效」的静默安全漏洞。
    pub fn has_attach_caps(&self) -> bool {
        self.hooks.attach_caps().is_some()
    }
    /// 五段管线执行（能力集→幂等→急停→审批→审计→传输→审计）。
    pub async fn execute(&self, cmd: Command) -> Result<Value, CdpError> {
        // —— ⓪ 会话只读能力集（R-12）：attach 会话白名单检查（fail-closed，
        //    先于一切阶段——非白名单命令不进入幂等合并/缓存/审批，拒绝不可豁免）——
        if let Some(caps) = self.hooks.attach_caps() {
            if !caps.allows_command(&cmd.method) {
                let view = CdpCommandView {
                    method: cmd.method.clone(),
                    session: cmd.session_id.clone().unwrap_or_default(),
                    target_summary: cmd.summary.clone(),
                    dangerous: cmd.dangerous,
                };
                // Blocked 相位：门禁拦截语义（维度 17 接线，含 attach 能力集拦截面）
                self.hooks.audit(BrowserAuditEvent {
                    phase: AuditPhase::Blocked,
                    cmd: view,
                    ok: false,
                    duration_ms: None,
                    snapshot_version: 0,
                });
                return Err(CdpError::CapabilityDenied { method: cmd.method });
            }
        }

        // —— ① 幂等：在途合并（同键并发共享同一 pending，仅一次 WS 发送）——
        let mut guard = None;
        if let Some(key) = cmd.idempotency_key.clone() {
            let existing = self
                .in_flight
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&key)
                .cloned();
            match existing {
                Some(tx) => {
                    // 已在途：共享结果，不再发送
                    let mut rx = tx.subscribe();
                    return rx.recv().await.unwrap_or_else(|_| {
                        Err(CdpError::Internal {
                            method: Some(cmd.method.clone()),
                            message: "幂等合并通道关闭".to_string(),
                        })
                    });
                }
                None => {
                    let (tx, _) = tokio::sync::broadcast::channel(1);
                    self.in_flight
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .insert(key.clone(), tx.clone());
                    guard = Some(InFlightGuard {
                        map: self.in_flight.clone(),
                        key,
                        tx,
                        armed: true,
                    });
                }
            }
        }

        // —— ①' 幂等：工具层短路（已完成命令缓存，agent-tools idempotency 语义）——
        if let Some(key) = &cmd.idempotency_key {
            if let Some(result) = self.hooks.idempotent(key).await {
                // H3 修复：命中时先把结果发布给在途合并等待方，再返回——
                // 否则 guard Drop（armed=true）会向共享 broadcast 发布 Cancelled，
                // 并发同键调用方拿到错误的取消语义而非正确缓存结果。
                if let Some(g) = guard.as_mut() {
                    g.publish(result.clone());
                }
                return result;
            }
        }

        // —— ② 急停：置位即拒绝新命令 ——
        if self.hooks.emergency_stop().load(Ordering::SeqCst) {
            let err = Err(CdpError::Cancelled {
                reason: CancelReason::EmergencyStop,
            });
            if let Some(g) = guard.as_mut() {
                g.publish(err.clone());
            }
            return err;
        }

        let view = CdpCommandView {
            method: cmd.method.clone(),
            session: cmd.session_id.clone().unwrap_or_default(),
            target_summary: cmd.summary.clone(),
            dangerous: cmd.dangerous,
        };

        // —— ③ 审批：dangerous 命令挂起等决 ——
        if cmd.dangerous {
            if let Err(denied) = self.hooks.approve(&view).await {
                self.hooks.audit(BrowserAuditEvent {
                    phase: AuditPhase::Denied,
                    cmd: view,
                    ok: false,
                    duration_ms: None,
                    snapshot_version: 0,
                });
                let err = Err(CdpError::ApprovalDenied {
                    reason: denied.reason,
                });
                if let Some(g) = guard.as_mut() {
                    g.publish(err.clone());
                }
                return err;
            }
        }

        // —— ④ 审计（before）——
        self.hooks.audit(BrowserAuditEvent {
            phase: AuditPhase::Before,
            cmd: view.clone(),
            ok: true,
            duration_ms: None,
            snapshot_version: 0,
        });

        // —— ⑤ 传输 + 超时 + abort 抢断（§2.5 并发管理 + §2.3 超时）——
        let started = Instant::now();
        let token = self.hooks.abort_token();
        let send = self.channel.send_command(
            &cmd.method,
            Some(cmd.params),
            cmd.session_id.as_deref(),
            cmd.timeout,
        );
        let result = tokio::select! {
            r = send => r,
            _ = token.cancelled() => Err(CdpError::Cancelled {
                reason: CancelReason::Aborted,
            }),
        };

        // 发布合并结果（在途等待方共享同一结果）
        if let Some(g) = guard.as_mut() {
            g.publish(result.clone());
        }

        // —— ⑥ 审计（after）——
        self.hooks.audit(BrowserAuditEvent {
            phase: AuditPhase::After,
            cmd: view,
            ok: result.is_ok(),
            duration_ms: Some(started.elapsed().as_millis() as u64),
            snapshot_version: 0,
        });

        result
    }
}

/// attach 会话面 WS 发送侧（命令回包与事件泵共享；tokio Mutex 跨 await 安全）。
type AttachSink = Arc<
    tokio::sync::Mutex<
        futures_util::stream::SplitSink<WebSocketStream<tokio::net::TcpStream>, Message>,
    >,
>;

/// attach 型 MCP 会话面（R-12，39-E3 接线：sender/transport 挂载点）。
///
/// 引擎侧 CDP 会话面：loopback WS 服务端（随机端口），供外部浏览器类 MCP
/// （chrome-devtools-mcp 族）attach。**命令逐条经 [CommandSender::execute] 五段
/// 管线执行**——⓪ 能力集拦截（attach_caps）在真实连接路径生效，非白名单命令
/// 返回 CDP 线格式错误（code -32000 + `capability_disabled` 前缀，语义对齐
/// `tool.browser.capability_disabled`）；**事件经 [ReadonlyCaps::filter_events]
/// 只透传白名单事件**（非白名单事件静默丢弃，fail-closed 透传面）。
///
/// 装配约束（安全红线）：
/// - 仅绑定 `127.0.0.1`（loopback），端口即令牌（DevToolsActivePort 双层
///   不透明 token 同语义，10 §7.3）；
/// - bind 前置自检 [CommandSender::has_attach_caps]——hooks 未注入只读能力集
///   视为接线不完整，拒绝启动（防静默无拦截）；
/// - 会话建立命令（`Target.getTargets/attachToTarget/setAutoAttach/
///   detachFromTarget`）在白名单内（39-E3 实测补充：只读面可达性必需），
///   页面操作面仍逐命令 fail-closed。
///
/// 遗留（引擎装配 seam，域外）：E-1 注入 `--browserUrl` 指向本会话面的
/// `browser_url()`；HTTP `/json/version`/`/json/list` 发现面与 URL 改写、
/// AllowAllPolicy 注入 attach_caps 属引擎侧接线，见 39-E3 报告 §遗留。
pub struct AttachCdpProxy {
    addr: SocketAddr,
    shutdown: CancellationToken,
    accept_task: tokio::task::JoinHandle<()>,
    conn_tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl fmt::Debug for AttachCdpProxy {
    /// Debug 输出脱敏（10 §7.3 硬要求：端口不进日志）。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AttachCdpProxy { <redacted> }")
    }
}

impl AttachCdpProxy {
    /// 挂载 attach 会话面（loopback 随机端口，端口即令牌）。
    ///
    /// - `sender`：统一发送层（**前置自检 has_attach_caps 必须为 true**，否则
    ///   拒绝启动——接线不完整不产生静默无拦截面）；
    /// - `caps`：只读能力集（事件面过滤用；命令面由 sender 的 attach_caps 拦截）；
    /// - `events`：引擎连接的事件流（`CdpClient::subscribe` / `Transport::
    ///   subscribe_events`），经 caps 过滤后转发给外部连接。
    pub async fn bind(
        sender: Arc<CommandSender>,
        caps: Arc<ReadonlyCaps>,
        events: broadcast::Receiver<CdpEvent>,
    ) -> Result<Self, BrowserError> {
        if !sender.has_attach_caps() {
            return Err(BrowserError::Internal(
                "attach 会话面装配失败：hooks 未注入只读能力集（attach_caps=None），拒绝启动——接线不完整（R-12 红线）".to_string(),
            ));
        }
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| BrowserError::Io(format!("attach 会话面绑定失败：{e}")))?;
        let addr = listener
            .local_addr()
            .map_err(|e| BrowserError::Io(format!("attach 会话面地址获取失败：{e}")))?;
        let shutdown = CancellationToken::new();
        let conn_tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> =
            Arc::new(Mutex::new(Vec::new()));
        let shutdown_task = shutdown.clone();
        let conn_tasks_task = conn_tasks.clone();
        let sender_task = sender.clone();
        let caps_task = caps.clone();
        let accept_task = tokio::spawn(async move {
            loop {
                let (stream, _) = match tokio::select! {
                    r = listener.accept() => r,
                    _ = shutdown_task.cancelled() => break,
                } {
                    Ok(v) => v,
                    Err(_) => break,
                };
                // WS 握手失败（非 CDP 客户端）不中断 accept 循环
                let ws = match tokio_tungstenite::accept_async(stream).await {
                    Ok(ws) => ws,
                    Err(_) => continue,
                };
                let sender_conn = sender_task.clone();
                let caps_conn = caps_task.clone();
                let events_conn = events.resubscribe();
                let shutdown_conn = shutdown_task.clone();
                let handle = tokio::spawn(async move {
                    handle_attach_connection(
                        ws,
                        sender_conn,
                        caps_conn,
                        events_conn,
                        shutdown_conn,
                    )
                    .await;
                });
                conn_tasks_task
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push(handle);
            }
        });
        Ok(AttachCdpProxy {
            addr,
            shutdown,
            accept_task,
            conn_tasks,
        })
    }

    /// 暴露端口（attach 端点 token，`--browserUrl` 注入形态）。
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// E-1 注入形态：`http://127.0.0.1:<port>`（外部 MCP `--browserUrl` 指向）。
    pub fn browser_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.addr.port())
    }

    /// 本会话面 WS 端点（发现面 /json/version 改写的目标形态；引擎装配遗留）。
    pub fn ws_url(&self) -> String {
        format!(
            "ws://127.0.0.1:{}/devtools/browser/attach",
            self.addr.port()
        )
    }

    /// 收尾：取消接受循环并断开全部外部连接（会话结束/开关关闭路径）。
    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        self.accept_task.abort();
        let tasks = std::mem::take(&mut *self.conn_tasks.lock().unwrap_or_else(|p| p.into_inner()));
        for t in tasks {
            t.abort();
        }
    }
}

/// 单条外部连接处理：命令循环（经统一发送层）+ 事件泵（白名单透传）双并发。
async fn handle_attach_connection(
    ws: WebSocketStream<tokio::net::TcpStream>,
    sender: Arc<CommandSender>,
    caps: Arc<ReadonlyCaps>,
    events: broadcast::Receiver<CdpEvent>,
    shutdown: CancellationToken,
) {
    let (sink, mut stream) = ws.split();
    let sink: AttachSink = Arc::new(tokio::sync::Mutex::new(sink));

    // —— 事件泵：只透传白名单事件（fail-closed 透传面）——
    let mut filter = caps.filter_events(events);
    let pump_sink = sink.clone();
    let pump_shutdown = shutdown.clone();
    let event_pump = tokio::spawn(async move {
        loop {
            let next = tokio::select! {
                e = filter.next_allowed() => e,
                _ = pump_shutdown.cancelled() => None,
            };
            let Some(event) = next else { break };
            let mut msg = json!({ "method": event.method, "params": event.params });
            if let Some(s) = &event.session_id {
                msg["sessionId"] = Value::String(s.clone());
            }
            let mut s = pump_sink.lock().await;
            if s.send(Message::Text(msg.to_string().into())).await.is_err() {
                break;
            }
        }
    });

    // —— 命令循环：逐条经统一发送层（⓪ 能力集拦截在真实路径生效）——
    loop {
        let msg = tokio::select! {
            m = stream.next() => m,
            _ = shutdown.cancelled() => None,
        };
        let Some(Ok(msg)) = msg else { break };
        match msg {
            Message::Text(text) => {
                if let Some(reply) = handle_attach_command(text.as_str(), &sender).await {
                    let mut s = sink.lock().await;
                    if s.send(Message::Text(reply.into())).await.is_err() {
                        break;
                    }
                }
            }
            Message::Ping(payload) => {
                let mut s = sink.lock().await;
                if s.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            Message::Pong(_) => {}
            Message::Binary(_) | Message::Frame(_) => {}
        }
    }
    event_pump.abort();
}

/// 处理一条外部命令帧：经统一发送层执行并回包；非命令帧（响应/畸形）忽略。
async fn handle_attach_command(text: &str, sender: &CommandSender) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    let method = v.get("method").and_then(|m| m.as_str())?;
    let id = v.get("id").cloned().unwrap_or(Value::Null);
    let session_id = v
        .get("sessionId")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    let mut cmd = Command::new(method.to_string())
        .params(params)
        // 审计目标摘要：attach 会话面无页面摘要面，以会话面标识标记
        .with_summary("mcp-attach");
    if let Some(sid) = &session_id {
        cmd = cmd.with_session(sid.clone());
    }
    let result = sender.execute(cmd).await;
    let mut reply = match result {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(err) => {
            let (code, message) = cdp_error_to_wire(&err);
            json!({ "id": id, "error": { "code": code, "message": message } })
        }
    };
    if let Some(s) = &session_id {
        reply["sessionId"] = Value::String(s.clone());
    }
    Some(reply.to_string())
}

/// 引擎错误 → CDP 线格式错误（attach 会话面回包面；能力集拒绝带
/// `capability_disabled` 前缀，语义对齐 `tool.browser.capability_disabled`）。
fn cdp_error_to_wire(err: &CdpError) -> (i64, String) {
    match err {
        CdpError::CapabilityDenied { method } => (
            -32000,
            format!(
                "capability_disabled: 会话只读能力集拒绝[{method}]（attach 会话仅授予只读命令域）"
            ),
        ),
        CdpError::Protocol { message, .. }
        | CdpError::Internal { message, .. }
        | CdpError::Serialize { message, .. } => (-32603, message.clone()),
        CdpError::DomainUnavailable { method } => (-32601, format!("域/方法不支持[{method}]")),
        CdpError::BadParams { message, .. } => (-32602, message.clone()),
        CdpError::Server { code, message } => (*code, message.clone()),
        CdpError::ContextGone { message, .. } => (-32000, message.clone()),
        CdpError::Timeout { method, elapsed } => (
            -32000,
            format!("命令超时[{method}]：{}ms", elapsed.as_millis()),
        ),
        CdpError::ConnectionLost => (-32000, "CDP 连接已丢失".to_string()),
        CdpError::Cancelled { .. } => (-32000, "命令已取消".to_string()),
        CdpError::ApprovalDenied { reason } => (-32000, reason.clone()),
        CdpError::NotReady(detail) => (-32000, format!("浏览器恢复中：{detail}")),
        CdpError::NoActiveTab => (-32000, "无活动标签会话".to_string()),
        CdpError::NoSuchTab { tab_id } => (-32000, format!("标签 {tab_id} 不存在或已关闭")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::mock::{MockReply, MockServer};
    use serde_json::json;
    use std::path::{Path, PathBuf};
    use std::process::Stdio;

    /// 记录型钩子：管线顺序断言（验收 9.1-20）。
    struct RecordingHooks {
        order: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        token: CancellationToken,
        approve_ok: bool,
        /// 会话只读能力集（R-12）：None = 不启用（默认，正常工具面）
        caps: Mutex<Option<Arc<ReadonlyCaps>>>,
        idempotent_cached: Mutex<Option<Result<Value, CdpError>>>,
        /// 幂等钩子返回前的延迟（H3 测试用：让并发合并方先订阅在途通道，
        /// 确定性复现「缓存命中 + 在途等待方」时序）
        cache_delay: Mutex<Option<Duration>>,
    }

    impl RecordingHooks {
        fn new(approve_ok: bool) -> Self {
            RecordingHooks {
                order: Arc::new(Mutex::new(Vec::new())),
                stop: Arc::new(AtomicBool::new(false)),
                token: CancellationToken::new(),
                approve_ok,
                caps: Mutex::new(None),
                idempotent_cached: Mutex::new(None),
                cache_delay: Mutex::new(None),
            }
        }
        fn set_caps(&self, caps: ReadonlyCaps) {
            *self.caps.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(caps));
        }
        fn record(&self, step: &str) {
            self.order
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(step.to_string());
        }
        fn steps(&self) -> Vec<String> {
            self.order.lock().unwrap_or_else(|p| p.into_inner()).clone()
        }
    }

    #[async_trait]
    impl CommandPolicyHooks for RecordingHooks {
        async fn idempotent(&self, _key: &IdKey) -> Option<Result<Value, CdpError>> {
            self.record("idempotent");
            let delay = *self.cache_delay.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(d) = delay {
                tokio::time::sleep(d).await;
            }
            self.idempotent_cached
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
        }
        async fn approve(&self, _cmd: &CdpCommandView) -> Result<(), ApprovalDenied> {
            self.record("approve");
            if self.approve_ok {
                Ok(())
            } else {
                Err(ApprovalDenied {
                    reason: "测试拒绝".to_string(),
                })
            }
        }
        fn audit(&self, event: BrowserAuditEvent) {
            self.record(match event.phase {
                AuditPhase::Before => "audit:before",
                AuditPhase::After => "audit:after",
                AuditPhase::Denied => "audit:denied",
                AuditPhase::Blocked => "audit:blocked",
            });
        }
        fn emergency_stop(&self) -> Arc<AtomicBool> {
            self.stop.clone()
        }
        fn abort_token(&self) -> CancellationToken {
            self.token.clone()
        }
        fn attach_caps(&self) -> Option<Arc<ReadonlyCaps>> {
            self.caps.lock().unwrap_or_else(|p| p.into_inner()).clone()
        }
    }

    /// 组装：mock 服务端 + 直连 client 通道 + 记录钩子。
    async fn setup(approve_ok: bool) -> (MockServer, Arc<CdpClient>, Arc<RecordingHooks>) {
        let mock = MockServer::spawn().await;
        let client = Arc::new(
            crate::cdp::client::CdpClient::connect(&mock.url("/devtools/browser/sender"))
                .await
                .expect("建连失败"),
        );
        let hooks = Arc::new(RecordingHooks::new(approve_ok));
        (mock, client, hooks)
    }

    /// 验收 9.1-20：幂等→急停→审批→审计(before)→传输→审计(after) 顺序断言
    #[tokio::test]
    async fn sender_pipeline_hooks_order() {
        let (mut mock, client, hooks) = setup(true).await;
        mock.set_auto_reply(
            "Runtime.evaluate",
            MockReply::Ok(json!({ "result": { "value": 1 } })),
        );
        let channel: Arc<dyn CommandChannel> = client;
        let sender = CommandSender::new(channel, hooks.clone());

        let key = IdKey::new(None, "Runtime.evaluate", &json!({ "expression": "1" }));
        let cmd = Command::new("Runtime.evaluate")
            .params(json!({ "expression": "1" }))
            .dangerous()
            .idempotent(key);
        let task = tokio::spawn(async move { sender.execute(cmd).await });
        // 等命令到达 mock（传输段）
        mock.expect_command("Runtime.evaluate").await;
        let result = task.await.expect("任务失败").expect("命令失败");
        assert_eq!(result["result"]["value"], 1);

        let steps = hooks.steps();
        let expected = ["idempotent", "approve", "audit:before", "audit:after"];
        for (i, exp) in expected.iter().enumerate() {
            assert_eq!(steps[i], *exp, "第 {i} 步应为 {exp}，实际 {steps:?}");
        }
        // WireSend 由 mock 收到命令本身证明（audit:before 先于命令到达 mock）
        assert!(steps.len() >= 4);
    }

    /// 验收 9.1-21：急停旗置位 → 新命令 Cancelled(EmergencyStop)，且未发送
    #[tokio::test]
    async fn sender_emergency_stop_blocks_new() {
        let (mock, client, hooks) = setup(true).await;
        hooks.stop.store(true, Ordering::SeqCst);
        let channel: Arc<dyn CommandChannel> = client;
        let sender = CommandSender::new(channel, hooks.clone());

        let err = sender
            .execute(Command::new("Runtime.evaluate").params(json!({ "expression": "1" })))
            .await
            .expect_err("急停应拒绝新命令");
        assert!(matches!(
            err,
            CdpError::Cancelled {
                reason: CancelReason::EmergencyStop
            }
        ));
        assert_eq!(mock.commands_seen(), 0, "急停命令不得发送到线上");
    }

    /// 验收 9.1-22：在途命令经 abort_token 取消、pending 清零
    #[tokio::test]
    async fn sender_emergency_stop_cancels_inflight() {
        let (mock, client, hooks) = setup(true).await;
        let _ = mock; // 不回包（Silent）
        let channel: Arc<dyn CommandChannel> = client.clone();
        let sender = CommandSender::new(channel, hooks.clone());

        let task = tokio::spawn(async move {
            sender
                .execute(Command::new("Page.navigate").params(json!({ "url": "x" })))
                .await
        });
        // 等命令进入 pending（mock 侧收到）
        tokio::time::sleep(Duration::from_millis(50)).await;
        hooks.token.cancel();
        let err = task.await.expect("任务失败").expect_err("应被取消");
        assert!(matches!(
            err,
            CdpError::Cancelled {
                reason: CancelReason::Aborted
            }
        ));
        // pending 清理（PendingGuard Drop 同步移除）
        assert_eq!(client.pending_len().await, 0, "取消后 pending 必须清零");
    }

    /// 验收 9.1-23：Deny → 未发送 + 审计 Denied 事件
    #[tokio::test]
    async fn sender_approval_denied_no_send() {
        let (mock, client, hooks) = setup(false).await;
        let channel: Arc<dyn CommandChannel> = client;
        let sender = CommandSender::new(channel, hooks.clone());

        let err = sender
            .execute(
                Command::new("Input.insertText")
                    .params(json!({ "text": "x" }))
                    .dangerous(),
            )
            .await
            .expect_err("应被拒绝");
        assert!(matches!(err, CdpError::ApprovalDenied { .. }));
        assert_eq!(mock.commands_seen(), 0, "拒绝的命令不得发送到线上");
        let steps = hooks.steps();
        assert!(
            steps.contains(&"audit:denied".to_string()),
            "应有 Denied 审计，实际 {steps:?}"
        );
        assert!(
            !steps.contains(&"audit:before".to_string()),
            "拒绝后不得有 before 审计"
        );
    }

    /// 验收 9.1-24：同 IdKey 在途合并，仅一次 WS 发送
    #[tokio::test]
    async fn sender_idempotent_merges_inflight() {
        let (mock, client, hooks) = setup(true).await;
        let _ = mock; // 不回包直到主动 reply
        let channel: Arc<dyn CommandChannel> = client;
        let sender = Arc::new(CommandSender::new(channel, hooks.clone()));

        let key = IdKey::new(None, "Page.navigate", &json!({ "url": "https://e.com" }));
        let make_cmd = |key: IdKey| {
            Command::new("Page.navigate")
                .params(json!({ "url": "https://e.com" }))
                .idempotent(key)
        };

        let s1 = sender.clone();
        let key1 = key.clone();
        let t1 = tokio::spawn(async move { s1.execute(make_cmd(key1)).await });
        let s2 = sender.clone();
        let key2 = key.clone();
        let t2 = tokio::spawn(async move { s2.execute(make_cmd(key2)).await });

        // 两个并发调用 → 仅一条命令到达 mock
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(
            mock.commands_seen(),
            1,
            "同 IdKey 在途合并应仅一次 WS 发送（实际 {}）",
            mock.commands_seen()
        );
        // 回包 → 两个调用方共享同一结果
        mock.reply(1, json!({ "frameId": "F1" }));
        let r1 = t1.await.expect("任务 1 失败").expect("命令 1 失败");
        let r2 = t2.await.expect("任务 2 失败").expect("命令 2 失败");
        assert_eq!(r1, r2);
        assert_eq!(r1["frameId"], "F1");
    }

    /// H3 回归（评审 29-H3）：幂等缓存命中时，在途合并等待方应收到**正确缓存结果**
    /// 而非 Cancelled。修复前 guard Drop 向共享 broadcast 发布 Cancelled。
    #[tokio::test]
    async fn sender_cache_hit_merger_gets_result_not_cancelled() {
        let (mock, client, hooks) = setup(true).await;
        let _ = mock; // 缓存命中不应有任何命令到达
        *hooks
            .idempotent_cached
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(Ok(json!({ "cached": true })));
        *hooks.cache_delay.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Duration::from_millis(80));
        let channel: Arc<dyn CommandChannel> = client;
        let sender = Arc::new(CommandSender::new(channel, hooks.clone()));

        let key = IdKey::new(None, "Page.navigate", &json!({ "url": "https://e.com" }));
        let make_cmd = |key: IdKey| {
            Command::new("Page.navigate")
                .params(json!({ "url": "https://e.com" }))
                .idempotent(key)
        };

        // A 先插入在途表并进入幂等钩子（延迟 80ms 返回缓存命中）
        let s1 = sender.clone();
        let key1 = key.clone();
        let t1 = tokio::spawn(async move { s1.execute(make_cmd(key1)).await });
        // B 稍后进入：命中在途合并分支，等待 A 发布共享结果
        tokio::time::sleep(Duration::from_millis(20)).await;
        let s2 = sender.clone();
        let key2 = key.clone();
        let t2 = tokio::spawn(async move { s2.execute(make_cmd(key2)).await });

        let r1 = t1.await.expect("任务 A 失败");
        let r2 = t2.await.expect("任务 B 失败");
        assert_eq!(r1.as_ref().expect("A 应收到缓存结果")["cached"], true);
        assert_eq!(
            r2.as_ref().expect("B 应收到缓存结果而非 Cancelled（H3）")["cached"],
            true,
            "合并等待方应共享正确结果"
        );
        assert_eq!(mock.commands_seen(), 0, "缓存命中不得发送命令到线上");
    }

    // ---------- R-12 会话只读能力集（34 §5.2 E-3）管线接线测试 ----------

    /// attach 会话下非白名单命令 fail-closed 拒绝：CapabilityDenied + 零命令发送
    /// + Blocked 审计（且无 before/after 审计——未进入传输段）。
    #[tokio::test]
    async fn sender_attach_caps_denies_non_readonly() {
        let (mock, client, hooks) = setup(true).await;
        hooks.set_caps(ReadonlyCaps::mcp_attach_default());
        let channel: Arc<dyn CommandChannel> = client;
        let sender = CommandSender::new(channel, hooks.clone());

        for method in [
            "Runtime.evaluate",         // 求值类（34 §4.3：唯一拦截点）
            "Input.dispatchMouseEvent", // 交互注入
            "Network.getAllCookies",    // cookie 全量读取
            "Page.navigate",            // 导航
        ] {
            let err = sender
                .execute(Command::new(method).params(json!({})))
                .await
                .expect_err("attach 会话非白名单命令应被拒绝");
            assert!(
                matches!(&err, CdpError::CapabilityDenied { method: m } if m == method),
                "{method} 应返回 CapabilityDenied，实际 {err:?}"
            );
        }
        assert_eq!(mock.commands_seen(), 0, "拒绝的命令不得发送到线上");
        let steps = hooks.steps();
        assert_eq!(
            steps
                .iter()
                .filter(|s| s.as_str() == "audit:blocked")
                .count(),
            4,
            "每条拒绝应有一条 Blocked 审计，实际 {steps:?}"
        );
        assert!(
            !steps.iter().any(|s| s == "audit:before"),
            "拒绝后不得有 before 审计，实际 {steps:?}"
        );
    }

    /// attach 会话下白名单命令正常放行：Page.captureScreenshot 到达线上并成功。
    #[tokio::test]
    async fn sender_attach_caps_allows_readonly() {
        let (mock, client, hooks) = setup(true).await;
        mock.set_auto_reply(
            "Page.captureScreenshot",
            MockReply::Ok(json!({ "data": "base64" })),
        );
        hooks.set_caps(ReadonlyCaps::mcp_attach_default());
        let channel: Arc<dyn CommandChannel> = client;
        let sender = CommandSender::new(channel, hooks.clone());

        let result = sender
            .execute(Command::new("Page.captureScreenshot").params(json!({ "format": "png" })))
            .await
            .expect("只读命令应放行");
        assert_eq!(result["data"], "base64");
        assert_eq!(mock.commands_seen(), 1, "放行的命令应恰好发送一次");
        let steps = hooks.steps();
        assert!(
            steps.contains(&"audit:before".to_string()),
            "应有 before 审计"
        );
        assert!(
            steps.contains(&"audit:after".to_string()),
            "应有 after 审计"
        );
        assert!(
            !steps.contains(&"audit:blocked".to_string()),
            "放行命令不得有 Blocked 审计"
        );
    }

    /// 隔离断言：无能力集注入（默认 None）时正常 browser_* 工具面不受影响——
    /// Runtime.evaluate 照常发送执行（能力集仅 attach 会话生效）。
    #[tokio::test]
    async fn sender_without_caps_normal_tool_surface_unaffected() {
        let (mock, client, hooks) = setup(true).await;
        mock.set_auto_reply(
            "Runtime.evaluate",
            MockReply::Ok(json!({ "result": { "value": 1 } })),
        );
        // hooks 默认无能力集（RecordingHooks::new 不 set_caps）
        let channel: Arc<dyn CommandChannel> = client;
        let sender = CommandSender::new(channel, hooks.clone());

        let result = sender
            .execute(Command::new("Runtime.evaluate").params(json!({ "expression": "1" })))
            .await
            .expect("无能力集时正常面应放行");
        assert_eq!(result["result"]["value"], 1);
        assert_eq!(mock.commands_seen(), 1, "命令应到达线上");
        assert!(
            !hooks.steps().contains(&"audit:blocked".to_string()),
            "正常面不得出现能力集拦截审计"
        );
    }

    /// 能力集先于审批段：dangerous 非白名单命令被拒且不触发 approve 钩子
    /// （17 §2.3 默认拒绝面不可审批豁免——红线语义）。
    #[tokio::test]
    async fn sender_attach_caps_rejects_before_approval() {
        let (mock, client, hooks) = setup(true).await;
        hooks.set_caps(ReadonlyCaps::mcp_attach_default());
        let channel: Arc<dyn CommandChannel> = client;
        let sender = CommandSender::new(channel, hooks.clone());

        let err = sender
            .execute(
                Command::new("Input.dispatchMouseEvent")
                    .params(json!({ "type": "mousePressed" }))
                    .dangerous(),
            )
            .await
            .expect_err("交互注入应被能力集拒绝");
        assert!(matches!(err, CdpError::CapabilityDenied { .. }));
        let steps = hooks.steps();
        assert!(
            !steps.contains(&"approve".to_string()),
            "能力集拒绝必须先于审批（不可豁免），实际 {steps:?}"
        );
        assert_eq!(mock.commands_seen(), 0, "拒绝的命令不得发送");
    }

    // ---------- AttachCdpProxy（39-E3：attach 会话面接线真实验证） ----------

    /// attach 会话面装配：mock 服务端（模拟受管实例）+ 引擎 client 通道 +
    /// 注入能力集的钩子 + 会话面（loopback 随机端口）。
    async fn proxy_setup() -> (MockServer, AttachCdpProxy, Arc<RecordingHooks>) {
        let mock = MockServer::spawn().await;
        let client = Arc::new(
            crate::cdp::client::CdpClient::connect(&mock.url("/devtools/browser/proxy"))
                .await
                .expect("引擎 client 建连失败"),
        );
        let hooks = Arc::new(RecordingHooks::new(true));
        hooks.set_caps(ReadonlyCaps::mcp_attach_default());
        let channel: Arc<dyn CommandChannel> = client.clone();
        let sender = Arc::new(CommandSender::new(channel, hooks.clone()));
        let proxy = AttachCdpProxy::bind(
            sender,
            Arc::new(ReadonlyCaps::mcp_attach_default()),
            client.subscribe(),
        )
        .await
        .expect("attach 会话面挂载失败");
        (mock, proxy, hooks)
    }

    /// 外部 CDP 客户端连会话面并发送一条命令（JSON-RPC 帧），返回响应 JSON。
    async fn external_command(proxy: &AttachCdpProxy, id: u64, method: &str) -> Value {
        let (mut ws, _) = tokio_tungstenite::connect_async(proxy.ws_url())
            .await
            .expect("外部客户端连接会话面失败");
        let msg = json!({ "id": id, "method": method, "params": {} });
        ws.send(Message::Text(msg.to_string().into()))
            .await
            .expect("命令发送失败");
        let resp = ws.next().await.expect("读响应失败").expect("帧错误");
        let v: Value =
            serde_json::from_str(resp.to_text().expect("非文本帧")).expect("响应解析失败");
        assert_eq!(v["id"], id, "响应 id 必须回显请求 id");
        v
    }

    /// 装配自检：hooks 未注入能力集（attach_caps=None）→ bind 拒绝启动
    /// （防「代理已挂载但拦截未生效」的静默安全漏洞，R-12 红线）。
    #[tokio::test]
    async fn attach_proxy_bind_requires_caps_injection() {
        let mock = MockServer::spawn().await;
        let client = Arc::new(
            crate::cdp::client::CdpClient::connect(&mock.url("/devtools/browser/proxy-no-caps"))
                .await
                .expect("引擎 client 建连失败"),
        );
        let hooks = Arc::new(RecordingHooks::new(true)); // 不 set_caps
        let channel: Arc<dyn CommandChannel> = client.clone();
        let sender = Arc::new(CommandSender::new(channel, hooks));
        let err = AttachCdpProxy::bind(
            sender,
            Arc::new(ReadonlyCaps::mcp_attach_default()),
            client.subscribe(),
        )
        .await
        .expect_err("接线不完整必须拒绝启动");
        assert!(
            err.to_string().contains("未注入只读能力集"),
            "错误应点名接线缺口，实际 {err:?}"
        );
    }

    /// 外部 MCP 语义拦截（34 §4.3：MCP 自身不拒绝，本面是唯一拦截点）：
    /// evaluate/输入注入/cookie 读取/导航/新建标签 → capability_disabled 语义
    /// + 零线上发送 + Blocked 审计。
    #[tokio::test]
    async fn attach_proxy_denies_eval_input_cookie_navigation_create() {
        let (mock, proxy, hooks) = proxy_setup().await;
        for (i, method) in [
            "Runtime.evaluate",         // 求值类（evaluate_script 工具）
            "Input.dispatchMouseEvent", // 交互注入（click 工具）
            "Input.dispatchKeyEvent",   // 交互注入（type 工具）
            "Network.getAllCookies",    // cookie 全量读取
            "Page.navigate",            // 导航
            "Target.createTarget",      // 新建标签（写入面）
        ]
        .iter()
        .enumerate()
        {
            let v = external_command(&proxy, i as u64 + 1, method).await;
            assert_eq!(
                v["error"]["code"].as_i64(),
                Some(-32000),
                "{method} 应回 CDP 服务器错误码"
            );
            let text = v["error"]["message"].as_str().expect("错误消息缺失");
            assert!(
                text.contains("capability_disabled"),
                "{method} 拒绝语义应含 capability_disabled，实际 {text}"
            );
            assert!(
                text.contains(method),
                "{method} 拒绝消息应点名方法，实际 {text}"
            );
        }
        assert_eq!(
            mock.commands_seen(),
            0,
            "被拒命令不得发送到线上（真实路径零透传）"
        );
        let blocked = hooks
            .steps()
            .iter()
            .filter(|s| s.as_str() == "audit:blocked")
            .count();
        assert_eq!(blocked, 6, "每条拒绝应有一条 Blocked 审计");
    }

    /// 只读面放行：快照/截图/console/network 四类只读命令经会话面到达线上
    /// 并回传真实结果（id 回显 + result 透传 + 恰好各一次发送）。
    #[tokio::test]
    async fn attach_proxy_passes_readonly_commands() {
        let (mock, proxy, _) = proxy_setup().await;
        mock.set_auto_reply(
            "DOMSnapshot.captureSnapshot",
            MockReply::Ok(json!({ "documents": [{ "nodes": [] }] })),
        );
        mock.set_auto_reply(
            "Page.captureScreenshot",
            MockReply::Ok(json!({ "data": "base64" })),
        );
        mock.set_auto_reply("Runtime.enable", MockReply::Ok(json!({})));
        mock.set_auto_reply("Network.enable", MockReply::Ok(json!({})));

        let mut ws = tokio_tungstenite::connect_async(proxy.ws_url())
            .await
            .expect("外部客户端连接会话面失败")
            .0;
        let commands = [
            (
                "DOMSnapshot.captureSnapshot",
                json!({ "computedStyles": ["color"] }),
            ),
            ("Page.captureScreenshot", json!({ "format": "png" })),
            ("Runtime.enable", json!({})),
            ("Network.enable", json!({})),
        ];
        for (i, (method, params)) in commands.iter().enumerate() {
            let frame = json!({ "id": i as u64 + 1, "method": method, "params": params });
            ws.send(Message::Text(frame.to_string().into()))
                .await
                .expect("命令发送失败");
        }
        for i in 0..4u64 {
            let resp = ws.next().await.expect("读响应失败").expect("帧错误");
            let v: Value =
                serde_json::from_str(resp.to_text().expect("非文本帧")).expect("响应解析失败");
            assert_eq!(v["id"], i + 1, "只读命令响应 id 应回显");
            assert!(
                v.get("error").is_none(),
                "只读命令 {} 不应被拦截：{v}",
                commands[i as usize].0
            );
        }
        assert_eq!(mock.commands_seen(), 4, "四类只读命令应恰好各发送一次");
    }

    /// 会话建立面放行（39-E3 实测补充）：Target 域会话路由命令（枚举目标/
    /// 建立 flatten 会话）经会话面到达线上并回传真实 sessionId。
    #[tokio::test]
    async fn attach_proxy_passes_session_establishment_commands() {
        let (mock, proxy, _) = proxy_setup().await;
        mock.set_auto_reply(
            "Target.getTargets",
            MockReply::Ok(json!({ "targetInfos": [{ "targetId": "T1", "type": "page" }] })),
        );
        mock.set_auto_reply(
            "Target.attachToTarget",
            MockReply::Ok(json!({ "sessionId": "S1" })),
        );
        mock.set_auto_reply("Target.setAutoAttach", MockReply::Ok(json!({})));
        mock.set_auto_reply("Target.detachFromTarget", MockReply::Ok(json!({})));

        let mut ws = tokio_tungstenite::connect_async(proxy.ws_url())
            .await
            .expect("外部客户端连接会话面失败")
            .0;
        let commands = [
            ("Target.getTargets", json!({})),
            (
                "Target.attachToTarget",
                json!({ "targetId": "T1", "flatten": true }),
            ),
            (
                "Target.setAutoAttach",
                json!({ "autoAttach": true, "flatten": true }),
            ),
            ("Target.detachFromTarget", json!({ "sessionId": "S1" })),
        ];
        for (i, (method, params)) in commands.iter().enumerate() {
            let frame = json!({ "id": i as u64 + 1, "method": method, "params": params });
            ws.send(Message::Text(frame.to_string().into()))
                .await
                .expect("命令发送失败");
        }
        for i in 0..4u64 {
            let resp = ws.next().await.expect("读响应失败").expect("帧错误");
            let v: Value =
                serde_json::from_str(resp.to_text().expect("非文本帧")).expect("响应解析失败");
            assert_eq!(v["id"], i + 1);
            assert!(
                v.get("error").is_none(),
                "会话建立命令 {} 不应被拦截：{v}",
                commands[i as usize].0
            );
        }
        // 回传的 sessionId 透传（attachToTarget 响应含 S1）
        assert_eq!(mock.commands_seen(), 4);
    }

    /// 事件透传面（真实 attach 路径）：白名单事件（console/network/snapshot）
    /// 到达外部客户端，非白名单事件静默丢弃（fail-closed）。
    #[tokio::test]
    async fn attach_proxy_forwards_whitelisted_events_only() {
        let (mock, proxy, _) = proxy_setup().await;
        let (mut ws, _) = tokio_tungstenite::connect_async(proxy.ws_url())
            .await
            .expect("外部客户端连接会话面失败");

        mock.send_event(
            "Runtime.consoleAPICalled",
            json!({ "type": "log" }),
            Some("S1"),
        );
        mock.send_event(
            "Network.requestWillBeSent",
            json!({ "requestId": "1" }),
            Some("S1"),
        );
        mock.send_event("Page.frameNavigated", json!({ "frame": {} }), None);
        mock.send_event(
            "Runtime.exceptionThrown",
            json!({ "exception": {} }),
            Some("S1"),
        );

        let read_event = async |ws: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >|
               -> Value {
            loop {
                let msg = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
                    .await
                    .expect("等待白名单事件超时")
                    .expect("连接关闭")
                    .expect("帧错误");
                if let Message::Text(t) = msg {
                    return serde_json::from_str(&t).expect("事件解析失败");
                }
            }
        };
        let e1 = read_event(&mut ws).await;
        assert_eq!(
            e1["method"], "Runtime.consoleAPICalled",
            "console 面事件应透传"
        );
        let e2 = read_event(&mut ws).await;
        assert_eq!(
            e2["method"], "Network.requestWillBeSent",
            "network 面事件应透传"
        );
        // 非白名单事件不透传：短暂窗口后不应有第三个事件
        let got_third =
            tokio::time::timeout(std::time::Duration::from_millis(150), ws.next()).await;
        assert!(
            got_third.is_err(),
            "非白名单事件（frameNavigated/exceptionThrown）不得透传，实际 {:?}",
            got_third.ok()
        );
    }

    // ---------- 真实 Chrome 探针（39-E3 真实验证，`#[ignore]`） ----------
    // 运行：`cargo test -p conex-browser --lib cdp::sender::tests::real_chrome_attach_proxy_intercepts_like_mcp -- --ignored --nocapture`
    // 环境变量：`CONEX_TEST_CHROME` 覆盖 Chrome 路径（缺省探测系统安装路径）。

    type TestWs = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    /// 探测 Chrome 可执行文件（CONEX_TEST_CHROME 优先，其次常见安装路径）。
    fn find_chrome() -> PathBuf {
        if let Ok(p) = std::env::var("CONEX_TEST_CHROME") {
            if Path::new(&p).exists() {
                return PathBuf::from(p);
            }
        }
        for c in [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ] {
            if Path::new(c).exists() {
                return PathBuf::from(c);
            }
        }
        for c in [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
        ] {
            if Path::new(c).exists() {
                return PathBuf::from(c);
            }
        }
        panic!("未找到 Chrome/Chromium（真实探针前置），请设置 CONEX_TEST_CHROME");
    }

    /// 启动受管实例（`--remote-debugging-port=0` 随机端口 + 全新 profile），
    /// 轮询 DevToolsActivePort（维度 10 §5.2 语义），返回 (子进程, 端口, ws_path)。
    // G2 禁令豁免（clippy.toml disallowed-methods）：`#[ignore]` 验证专用辅助，
    // spawn 仅拉起受管 Chrome 实例（固定启动参数，无用户自由参数），
    // 调用方保证 kill + wait 清理——对齐 mcp_attach.rs 既有豁免先例。
    #[allow(clippy::disallowed_methods)]
    fn spawn_managed_instance(chrome: &Path, profile: &Path) -> (std::process::Child, u16, String) {
        let mut child = std::process::Command::new(chrome)
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("about:blank")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("拉起 Chrome 失败");

        let port_file = profile.join("DevToolsActivePort");
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(status) = child.try_wait() {
                if status.is_some() {
                    panic!("Chrome 提前退出（受管实例启动失败）");
                }
            }
            if let Ok(lines) = std::fs::read_to_string(&port_file) {
                let parts: Vec<&str> = lines
                    .lines()
                    .map(|l| l.trim())
                    .filter(|l| !l.is_empty())
                    .collect();
                if parts.len() >= 2 {
                    let port: u16 = parts[0]
                        .parse()
                        .unwrap_or_else(|_| panic!("DevToolsActivePort 端口非法：{}", parts[0]));
                    return (child, port, parts[1].to_string());
                }
            }
            if Instant::now() >= deadline {
                panic!(
                    "等待 DevToolsActivePort 超时（30s）：{}",
                    port_file.display()
                );
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }

    /// 经给定 WS 连接发送一条 CDP 命令并等待对应响应（事件帧自动跳过）。
    async fn cdp_call(
        ws: &mut TestWs,
        id: u64,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Value {
        let mut frame = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            frame["sessionId"] = Value::String(s.to_string());
        }
        ws.send(Message::Text(frame.to_string().into()))
            .await
            .expect("命令发送失败");
        loop {
            let resp = ws.next().await.expect("读响应失败").expect("帧错误");
            if let Message::Text(t) = resp {
                let v: Value = serde_json::from_str(&t).expect("响应解析失败");
                if v.get("id").is_some() {
                    return v;
                }
                // 事件帧（无 id）：跳过
            }
        }
    }

    /// data: URL 载荷编码（非保留字符一律 %XX；页面自打日志/自发 fetch 注入源）。
    fn data_url_encode(s: &str) -> String {
        let mut out = String::new();
        for b in s.bytes() {
            match b {
                b'A'..=b'Z'
                | b'a'..=b'z'
                | b'0'..=b'9'
                | b'-'
                | b'_'
                | b'.'
                | b'~'
                | b','
                | b':'
                | b'/' => out.push(b as char),
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    }

    /// 真实 Chrome 探针（39-E3）：模拟外部 MCP attach 双路径断言 R-12 拦截语义。
    /// - **路径 A（接线前现状）**：外部 WS 直连受管实例 CDP 端点——`Runtime.evaluate`
    ///   成功（34 §4.3 实测结论复现：MCP 自身/直连路径无任何拦截）；
    /// - **路径 B（接线后）**：外部 WS 经引擎侧 attach 会话面（[AttachCdpProxy]）——
    ///   求值/输入注入 capability_disabled 拒绝；会话建立 + 快照/截图/console/
    ///   network 只读面真实放行；console/network 白名单事件真实透传。
    // G2 禁令豁免（clippy.toml disallowed-methods）：`#[ignore]` 验证专用测试，
    // spawn 仅拉起受管 Chrome 实例（参数固定，无用户自由参数），进程在 finally
    // 语义下 kill + wait 清理——对齐 mcp_attach.rs 既有豁免先例。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    #[allow(clippy::disallowed_methods)]
    async fn real_chrome_attach_proxy_intercepts_like_mcp() {
        let chrome = find_chrome();
        let profile = tempfile::tempdir().expect("临时 profile 目录");
        let (mut child, port, ws_path) = spawn_managed_instance(&chrome, profile.path());
        let result = async {
            let endpoint = crate::cdp::transport::CdpEndpoint { port, ws_path };
            println!("[39] 受管实例 CDP 端点就绪（端口即令牌）");

            // ===== 路径 A：直连受管实例端点（接线前现状）——拦截不生效 =====
            let (mut direct, _) = tokio_tungstenite::connect_async(endpoint.url())
                .await
                .expect("外部 WS 直连建连失败");
            let targets = cdp_call(&mut direct, 1, "Target.getTargets", json!({}), None).await;
            assert!(targets.get("error").is_none(), "直连 getTargets 应成功：{targets}");
            let target_id = targets["result"]["targetInfos"][0]["targetId"]
                .as_str()
                .expect("应枚举到页面 target")
                .to_string();
            let attached = cdp_call(
                &mut direct,
                2,
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
                None,
            )
            .await;
            assert!(attached.get("error").is_none(), "直连 attachToTarget 应成功");
            let direct_session = attached["result"]["sessionId"]
                .as_str()
                .expect("直连应取得 sessionId")
                .to_string();
            let eval_direct = cdp_call(
                &mut direct,
                3,
                "Runtime.evaluate",
                json!({ "expression": "1+1" }),
                Some(&direct_session),
            )
            .await;
            assert!(
                eval_direct.get("error").is_none(),
                "直连路径 evaluate 应成功（接线前现状：拦截不生效），实际 {eval_direct}"
            );
            println!("[39] 路径 A（直连）evaluate 成功——接线前拦截缺口复现");

            // 直连导航到自打日志页面（console/network 事件注入源）
            let page_html = r#"<script>setInterval(()=>{console.log('probe-39');fetch('http://127.0.0.1:9/x').catch(()=>{})},500)</script>"#;
            let data_url = format!("data:text/html,{}", data_url_encode(page_html));
            let nav = cdp_call(
                &mut direct,
                4,
                "Page.navigate",
                json!({ "url": data_url }),
                Some(&direct_session),
            )
            .await;
            assert!(nav.get("error").is_none(), "直连导航应成功：{nav}");
            drop(direct);

            // ===== 路径 B：经引擎侧 attach 会话面（接线后）——拦截生效 =====
            let client = Arc::new(
                CdpClient::connect(&endpoint.url())
                    .await
                    .expect("引擎 client 建连失败"),
            );
            let hooks = Arc::new(RecordingHooks::new(true));
            hooks.set_caps(ReadonlyCaps::mcp_attach_default());
            let channel: Arc<dyn CommandChannel> = client.clone();
            let sender = Arc::new(CommandSender::new(channel, hooks));
            let proxy = AttachCdpProxy::bind(
                sender,
                Arc::new(ReadonlyCaps::mcp_attach_default()),
                client.subscribe(),
            )
            .await
            .expect("attach 会话面挂载失败");

            let (mut ext, _) = tokio_tungstenite::connect_async(proxy.ws_url())
                .await
                .expect("外部 WS 连会话面失败");

            // 会话建立面：getTargets + attachToTarget 真实放行（只读面可达性必需）
            let targets = cdp_call(&mut ext, 10, "Target.getTargets", json!({}), None).await;
            assert!(
                targets.get("error").is_none(),
                "会话建立面 getTargets 应放行：{targets}"
            );
            let target_id = targets["result"]["targetInfos"]
                .as_array()
                .expect("targetInfos 应为数组")
                .iter()
                .find(|t| t["type"] == "page")
                .and_then(|t| t["targetId"].as_str())
                .expect("应找到页面 target")
                .to_string();
            let attached = cdp_call(
                &mut ext,
                11,
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
                None,
            )
            .await;
            assert!(
                attached.get("error").is_none(),
                "会话建立面 attachToTarget 应放行：{attached}"
            );
            let session = attached["result"]["sessionId"]
                .as_str()
                .expect("会话面应取得 sessionId")
                .to_string();

            // 拒绝面（evaluate_script / 输入注入）→ capability_disabled 语义
            let eval_blocked = cdp_call(
                &mut ext,
                12,
                "Runtime.evaluate",
                json!({ "expression": "1+1" }),
                Some(&session),
            )
            .await;
            let eval_err = eval_blocked["error"]["message"]
                .as_str()
                .expect("evaluate 应被拒绝");
            assert!(
                eval_err.contains("capability_disabled"),
                "经会话面 evaluate 应 capability_disabled，实际 {eval_blocked}"
            );
            let input_blocked = cdp_call(
                &mut ext,
                13,
                "Input.dispatchMouseEvent",
                json!({ "type": "mousePressed", "x": 1, "y": 1, "button": "left", "clickCount": 1 }),
                Some(&session),
            )
            .await;
            assert!(
                input_blocked["error"]["message"]
                    .as_str()
                    .expect("Input 应被拒绝")
                    .contains("capability_disabled"),
                "经会话面 Input 注入应 capability_disabled，实际 {input_blocked}"
            );
            println!("[39] 路径 B（会话面）evaluate/Input 注入被拒（capability_disabled）");

            // 只读面真实放行：快照 / 截图 / console / network
            let snap = cdp_call(
                &mut ext,
                14,
                "DOMSnapshot.captureSnapshot",
                json!({ "computedStyles": ["color"] }),
                Some(&session),
            )
            .await;
            assert!(
                snap.get("error").is_none(),
                "快照只读面应真实放行：{snap}"
            );
            let shot = cdp_call(
                &mut ext,
                15,
                "Page.captureScreenshot",
                json!({ "format": "png" }),
                Some(&session),
            )
            .await;
            assert!(
                shot.get("error").is_none(),
                "截图只读面应真实放行：{shot}"
            );
            assert!(
                shot["result"]["data"].as_str().unwrap_or_default().len() > 100,
                "截图应返回真实 base64 数据"
            );
            let console_on = cdp_call(
                &mut ext,
                16,
                "Runtime.enable",
                json!({}),
                Some(&session),
            )
            .await;
            assert!(
                console_on.get("error").is_none(),
                "console 面 enable 应真实放行：{console_on}"
            );
            let network_on = cdp_call(
                &mut ext,
                17,
                "Network.enable",
                json!({}),
                Some(&session),
            )
            .await;
            assert!(
                network_on.get("error").is_none(),
                "network 面 enable 应真实放行：{network_on}"
            );
            println!("[39] 路径 B（会话面）快照/截图/console/network 只读面全部放行");

            // 事件透传面：页面自打日志 + 自发 fetch → consoleAPICalled /
            // Network.requestWillBeSent 白名单事件经会话面到达外部客户端
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut got_console = false;
            let mut got_network = false;
            while Instant::now() < deadline {
                let resp = tokio::time::timeout(
                    Duration::from_millis(500),
                    ext.next(),
                )
                .await
                .expect("等待白名单事件超时");
                if let Some(Ok(Message::Text(t))) = resp {
                    let v: Value = serde_json::from_str(&t).expect("事件解析失败");
                    match v["method"].as_str() {
                        Some("Runtime.consoleAPICalled") => got_console = true,
                        Some("Network.requestWillBeSent") => got_network = true,
                        Some(m) => {
                            panic!("非白名单事件透传到会话面：{m}（fail-closed 被破坏）")
                        }
                        None => {}
                    }
                }
                if got_console && got_network {
                    break;
                }
            }
            assert!(
                got_console,
                "consoleAPICalled 应经会话面透传（页面自打日志）"
            );
            assert!(
                got_network,
                "Network.requestWillBeSent 应经会话面透传（页面自发 fetch）"
            );
            println!("[39] 路径 B（会话面）console/network 白名单事件真实透传");

            proxy.shutdown().await;
            Ok::<(), Box<dyn std::error::Error>>(())
        }
        .await;

        // 清理：杀受管实例（受管生命周期语义，面板关闭即杀进程）
        let _ = child.kill();
        let _ = child.wait();
        profile.close().ok();
        result.expect("真实 Chrome 探针失败");
    }
}
