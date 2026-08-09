//! 统一发送层（维度 11 §4：五段管线 幂等→急停→审批→审计→传输）
//!
//! ```text
//! execute(cmd) ──▶ ① 幂等  ② 急停  ③ 审批  ④ 审计(before)  ⑤ 传输+超时  ⑥ 审计(after)
//! ```
//!
//! - 插桩点 = 唯一函数 `CommandSender::execute`，无旁路（send_page/send_browser
//!   均构造 Command 走本管线；恢复期 enable 序列属引擎内部流程，直连低层 client）
//! - 幂等：sender 层在途合并（同 IdKey 并发共享同一 pending，仅一次 WS 发送）+
//!   工具层 `hooks::idempotent` 短路（已完成命令缓存）
//! - 急停：`emergency_stop` 旗置位 → 新命令拒绝；`abort_token` 取消在途
//! - 审批：`dangerous == true` 挂起等 `approve`；Deny → 审计(Denied) + 拒绝不发送
//! - 审计：before（method/session/目标摘要，参数已脱敏）/ after（结果 + 耗时）
//! - `CancellationToken`：watch<bool> 自研 30 行实现（workspace 无 tokio-util
//!   直接依赖，零新增依赖；§4.2 注释口径）
//! - `CommandChannel`：发送通道抽象（transport 实现；测试可注入直连 client）

use crate::cdp::client::CdpClient;
use crate::cdp::error::{CancelReason, CdpError};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
        let _ = self.tx.send(true);
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
        let _ = rx.changed().await;
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
type InFlightMap = Arc<
    std::sync::Mutex<HashMap<IdKey, tokio::sync::broadcast::Sender<Result<Value, CdpError>>>>,
>;

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
        let _ = self.tx.send(result);
        self.armed = false;
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        // 中途退出（急停/审批拒绝/取消）：合并等待方收到取消错误
        if self.armed {
            let _ = self.tx.send(Err(CdpError::Cancelled {
                reason: CancelReason::Aborted,
            }));
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
    /// 五段管线执行（幂等→急停→审批→审计→传输→审计）。
    pub async fn execute(&self, cmd: Command) -> Result<Value, CdpError> {
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
                let err = Err(CdpError::ApprovalDenied { reason: denied.reason });
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::mock::{MockReply, MockServer};
    use serde_json::json;

    /// 记录型钩子：管线顺序断言（验收 9.1-20）。
    struct RecordingHooks {
        order: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        token: CancellationToken,
        approve_ok: bool,
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
                idempotent_cached: Mutex::new(None),
                cache_delay: Mutex::new(None),
            }
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
            let delay = *self
                .cache_delay
                .lock()
                .unwrap_or_else(|p| p.into_inner());
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
    }

    /// 组装：mock 服务端 + 直连 client 通道 + 记录钩子。
    async fn setup(
        approve_ok: bool,
    ) -> (MockServer, Arc<CdpClient>, Arc<RecordingHooks>) {
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
        mock.set_auto_reply("Runtime.evaluate", MockReply::Ok(json!({ "result": { "value": 1 } })));
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
            CdpError::Cancelled { reason: CancelReason::EmergencyStop }
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
            CdpError::Cancelled { reason: CancelReason::Aborted }
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
            .execute(Command::new("Input.insertText").params(json!({ "text": "x" })).dangerous())
            .await
            .expect_err("应被拒绝");
        assert!(matches!(err, CdpError::ApprovalDenied { .. }));
        assert_eq!(mock.commands_seen(), 0, "拒绝的命令不得发送到线上");
        let steps = hooks.steps();
        assert!(steps.contains(&"audit:denied".to_string()), "应有 Denied 审计，实际 {steps:?}");
        assert!(!steps.contains(&"audit:before".to_string()), "拒绝后不得有 before 审计");
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
        *hooks
            .cache_delay
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(Duration::from_millis(80));
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
        assert_eq!(
            r1.as_ref().expect("A 应收到缓存结果")["cached"],
            true
        );
        assert_eq!(
            r2.as_ref().expect("B 应收到缓存结果而非 Cancelled（H3）")["cached"],
            true,
            "合并等待方应共享正确结果"
        );
        assert_eq!(mock.commands_seen(), 0, "缓存命中不得发送命令到线上");
    }
}
