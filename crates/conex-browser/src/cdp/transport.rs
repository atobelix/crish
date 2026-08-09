//! 连接层（维度 11 §2：WS 建立/身份校验/心跳/断线检测/指数退避重连）
//!
//! - `CdpEndpoint`：端点契约（维度 10 产出、本模块消费；Debug 脱敏，全链路不落日志）
//! - `ExpectedBrowser`：身份校验预期（getVersion 产品名/版本比对，防错连遗留实例）
//! - `RestoreHook`：恢复流程钩子（enable 序列/会话重建/拦截重挂，lib.rs 实现，
//!   测试注入 Recording 实现）
//! - `Transport`：单长连接常驻 + 断线才重连（browser-use 每步重连反例的正面形态）；
//!   重连成功 → 恢复流程 → `ConnectionRestored`；连续 3 次失败上报
//!   `disconnected` 信号（维度 10 崩溃重启次级信号，R-9）
//!
//! 断线判定唯一可信信号：reader 循环退出（Close 帧/Err/EOF）。ping 无 pong 不判定
//! （WS 标准允许对端不答 pong），由 TCP keepalive / reader 兜底。

use crate::cdp::bus::BrowserEvent;
use crate::cdp::client::{CdpClient, ConnectConfig};
use crate::cdp::domains::names::BROWSER_GET_VERSION;
use crate::cdp::domains::BrowserVersionResult;
use crate::cdp::error::{BrowserError, CdpError};
use crate::cdp::types::CdpEvent;
use async_trait::async_trait;
use serde_json::Value;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, watch};
use uuid::Uuid;

/// 身份校验超时（Browser.getVersion，§2.2）。
pub const VERIFY_TIMEOUT: Duration = Duration::from_secs(5);
/// 重连退避初始间隔（1s）。
pub const BACKOFF_INITIAL: Duration = Duration::from_secs(1);
/// 重连退避上限（30s）。
pub const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// 抖动区间（±20%，防共振）。
pub const BACKOFF_JITTER_RANGE: (f64, f64) = (0.8, 1.2);
/// 连续失败上报阈值（CdpDisconnected 次级信号，§2.4 第 5 步）。
pub const RECONNECT_REPORT_FAILURES: u32 = 3;

/// 端点契约（维度 10 产出，本模块消费）。
///
/// 端口来自 DevToolsActivePort，ws_path 为 Chrome 生成的 per-session UUID 路径，
/// 二者即三重随机面中的两重（10 文档 §7.1），全链路不落日志/事件（10 文档 §7.3）。
#[derive(Clone)]
pub struct CdpEndpoint {
    pub port: u16,
    pub ws_path: String,
}

impl CdpEndpoint {
    /// 拼接连接 URL（仅 loopback）。
    pub fn url(&self) -> String {
        format!(
            "ws://127.0.0.1:{}/{}",
            self.port,
            self.ws_path.trim_start_matches('/')
        )
    }
}

impl fmt::Debug for CdpEndpoint {
    /// Debug 输出脱敏（端口与 path 不落日志，10 文档 §7.3 硬要求）。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CdpEndpoint { <redacted> }")
    }
}

/// 身份校验预期（三重校验的第 2 重：getVersion 产品名/版本比对）。
#[derive(Debug, Clone, Default)]
pub struct ExpectedBrowser {
    /// 产品名前缀（如 "Chrome/"）；Some 时 getVersion product 必须命中
    pub product_prefix: Option<String>,
    /// 最低主版本线（如 120）；Some 时实测主版本不得低于
    pub min_major: Option<u64>,
}

/// 连接状态（工具面门禁与面板指示条依据，R-9-4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Connecting,
    Connected,
    Lost,
}

/// 恢复流程钩子：连接建立（含重连）后执行的状态恢复清单（§2.4）。
/// 由 lib.rs 实现（enable 序列/会话重建/拦截重挂/TargetsReconciled），
/// 测试注入 Recording 实现。恢复完成前工具面不可用（ready=false）。
#[async_trait]
pub trait RestoreHook: Send + Sync {
    /// 恢复流程（幂等、可重入）。
    async fn restore(&self, client: &CdpClient) -> Result<(), BrowserError>;
}

/// 连接共享状态（supervisor 与命令面共用）。
struct Shared {
    client: Mutex<Option<Arc<CdpClient>>>,
    conn_state: watch::Sender<ConnectionState>,
    ready: watch::Sender<bool>,
    disconnected: watch::Sender<bool>,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Arc<CdpClient>>> {
        // 锁纪律（B8）：中毒恢复数据继续使用，不 panic
        self.client.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// 连接生命周期管理者：建连/校验 → 常驻连接 → 断线检测 → 指数退避重连 → 恢复。
pub struct Transport {
    shared: Arc<Shared>,
    event_tx: broadcast::Sender<CdpEvent>,
    stop_tx: watch::Sender<bool>,
    conn_id: Uuid,
    _supervisor: tokio::task::JoinHandle<()>,
}

impl Drop for Transport {
    /// 收尾（M3）：停止 supervisor（watch send 同步）+ abort 任务句柄——
    /// 调用方遗漏 `shutdown` 时不留常驻重连任务；连接按 Drop 自然收敛
    /// （supervisor 释放 Arc<Shared> → 客户端 Drop → 任务/流句柄收尾）。
    fn drop(&mut self) {
        let _ = self.stop_tx.send(true);
        self._supervisor.abort();
    }
}

impl Transport {
    /// 建连（握手 + 身份校验），**不执行恢复流程**——恢复由调用方在全部
    /// 订阅就绪后经 `restore_now` 触发（订阅时序铁律：tokio broadcast
    /// 新订阅者不补发订阅前消息，restore 期间产生的 attachedToTarget 等
    /// 事件一旦在订阅前发出即静默丢失——联调 E1 根因）。
    pub async fn connect(
        endpoint: CdpEndpoint,
        expected: ExpectedBrowser,
        bus_tx: broadcast::Sender<BrowserEvent>,
        epoch: Arc<AtomicU64>,
        restore: Arc<dyn RestoreHook>,
    ) -> Result<Arc<Self>, BrowserError> {
        let client = Self::try_connect_once(&endpoint, &expected).await?;

        let shared = Arc::new(Shared {
            client: Mutex::new(Some(client.clone())),
            conn_state: watch::channel(ConnectionState::Connected).0,
            ready: watch::channel(true).0,
            disconnected: watch::channel(false).0,
        });
        let (event_tx, _) = broadcast::channel(4096);
        let (stop_tx, stop_rx) = watch::channel(false);

        // 订阅时序铁律：事件重发面在恢复流程前完成订阅（先订阅后动作）。
        // 若在 restore 之后才 subscribe，恢复期间的事件全部丢失。
        let forward_rx = client.subscribe();
        spawn_forward(forward_rx, &event_tx);

        // —— 断线检测 + 重连 supervisor ——
        let shared_sup = shared.clone();
        let bus_tx_sup = bus_tx.clone();
        let epoch_sup = epoch.clone();
        let mut stop_rx_sup = stop_rx.clone();
        let event_tx_sup = event_tx.clone();
        let supervisor = tokio::spawn(async move {
            loop {
                // 等当前客户端断线
                let client = match shared_sup.lock().as_ref().cloned() {
                    Some(c) => c,
                    None => break,
                };
                let mut lost_rx = client.lost();
                tokio::select! {
                    _ = stop_rx_sup.changed() => break,
                    changed = lost_rx.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        if !*lost_rx.borrow() {
                            continue;
                        }
                    }
                }
                // —— 断线处理（§2.4 1-2 步；pending 清空已由 reader 完成）——
                *shared_sup.lock() = None;
                let _ = shared_sup.conn_state.send(ConnectionState::Lost);
                let _ = shared_sup.ready.send(false);
                let _ = bus_tx_sup.send(BrowserEvent::ConnectionLost { attempt: 0 });

                // —— 指数退避重连（§2.4 3-5 步）——
                let mut attempt: u32 = 0;
                let mut consecutive_failures: u32 = 0;
                loop {
                    attempt += 1;
                    let delay = backoff_delay(attempt);
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        _ = stop_rx_sup.changed() => return,
                    }
                    let start = Instant::now();
                    match Self::try_connect_once(&endpoint, &expected).await {
                        Ok(new_client) => {
                            // 订阅时序铁律：重连同样先订阅事件重发面再跑恢复
                            let forward_rx = new_client.subscribe();
                            match restore.restore(&new_client).await {
                                Ok(()) => {
                                    spawn_forward(forward_rx, &event_tx_sup);
                                    *shared_sup.lock() = Some(new_client);
                                    let _ = shared_sup.conn_state.send(ConnectionState::Connected);
                                    let _ = shared_sup.ready.send(true);
                                    let _ = bus_tx_sup.send(BrowserEvent::ConnectionRestored {
                                        elapsed_ms: start.elapsed().as_millis() as u64,
                                        epoch: epoch_sup.load(Ordering::Relaxed),
                                    });
                                    break;
                                }
                                Err(e) => {
                                    tracing::warn!("重连后恢复流程失败（继续退避）：{e}");
                                    new_client.close().await;
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!("重连失败（attempt={attempt}）：{e}");
                        }
                    }
                    consecutive_failures += 1;
                    if consecutive_failures >= RECONNECT_REPORT_FAILURES {
                        // CdpDisconnected 次级信号（维度 10 崩溃重启，§2.4 第 5 步）；
                        // 进程存活前提下持续重试，周期上报
                        let _ = shared_sup.disconnected.send(true);
                        let _ = bus_tx_sup.send(BrowserEvent::ConnectionLost {
                            attempt: consecutive_failures,
                        });
                        consecutive_failures = 0;
                    }
                }
            }
        });

        Ok(Arc::new(Transport {
            shared,
            event_tx,
            stop_tx,
            conn_id: Uuid::new_v4(),
            _supervisor: supervisor,
        }))
    }

    /// 首启恢复（调用方在**全部订阅就绪后**调用——事件泵/版本驱动/对话框/
    /// 活动标签先订阅，再执行恢复流程，保证 restore 期间产生的
    /// attachedToTarget / frameNavigated 等事件不丢失）。
    pub async fn restore_now(&self, restore: &dyn RestoreHook) -> Result<(), BrowserError> {
        let client = self
            .shared
            .lock()
            .as_ref()
            .cloned()
            .ok_or_else(|| BrowserError::Restore("恢复时无活动连接".to_string()))?;
        restore.restore(&client).await
    }

    /// 单次建连 + 身份校验（三重校验的 1a/1b：ws_path bearer + getVersion 比对；
    /// 1c 会话级绑定由维度 10 的 SessionToken 持有，本模块不感知）。
    async fn try_connect_once(
        endpoint: &CdpEndpoint,
        expected: &ExpectedBrowser,
    ) -> Result<Arc<CdpClient>, BrowserError> {
        let client = Arc::new(
            CdpClient::connect_with_config(&endpoint.url(), ConnectConfig::default())
                .await?,
        );
        // 身份校验：getVersion 回包与预期比对（5s 超时）
        let ver: BrowserVersionResult = match tokio::time::timeout(
            VERIFY_TIMEOUT,
            client.send_command(BROWSER_GET_VERSION, None, None),
        )
        .await
        {
            Err(_) => return Err(BrowserError::HandshakeTimeout),
            Ok(Err(e)) => {
                return Err(BrowserError::Connect(format!("身份校验命令失败：{e}")))
            }
            Ok(Ok(v)) => serde_json::from_value::<BrowserVersionResult>(v).map_err(|e| {
                BrowserError::Connect(format!("getVersion 回包解析失败：{e}"))
            })?,
        };

        if let Some(prefix) = &expected.product_prefix {
            match ver.product.as_deref() {
                Some(p) if p.starts_with(prefix) => {}
                Some(p) => {
                    return Err(BrowserError::VerifyMismatch {
                        expected: prefix.clone(),
                        actual: p.to_string(),
                    })
                }
                None => {
                    return Err(BrowserError::Connect(
                        "getVersion 回包缺少 product 字段".to_string(),
                    ))
                }
            }
        }
        if let Some(min) = expected.min_major {
            let major = ver.major_version();
            if major != 0 && major < min {
                return Err(BrowserError::VerifyMismatch {
                    expected: format!("Chrome >= {min}"),
                    actual: ver
                        .product
                        .clone()
                        .unwrap_or_else(|| major.to_string()),
                });
            }
        }
        Ok(client)
    }

    /// 订阅原始事件面（跨重连稳定句柄：重连后由 forward 任务自动接入）。
    pub fn subscribe_events(&self) -> broadcast::Receiver<CdpEvent> {
        self.event_tx.subscribe()
    }

    /// 连接状态订阅。
    pub fn subscribe_state(&self) -> watch::Receiver<ConnectionState> {
        self.shared.conn_state.subscribe()
    }

    /// 恢复完成信号（R-9-4：true = 工具面可用）。
    pub fn subscribe_ready(&self) -> watch::Receiver<bool> {
        self.shared.ready.subscribe()
    }

    /// 当前是否可服务（恢复期 false）。
    pub fn is_ready(&self) -> bool {
        *self.shared.ready.borrow()
    }

    /// CdpDisconnected 次级信号订阅（维度 10 崩溃重启）。
    pub fn subscribe_disconnected(&self) -> watch::Receiver<bool> {
        self.shared.disconnected.subscribe()
    }

    /// 连接标识（仅诊断日志用，不含端点信息）。
    pub fn conn_id(&self) -> Uuid {
        self.conn_id
    }

    /// 关闭：停止 supervisor + 发送 Close 帧（急停/会话结束路径）。
    pub async fn shutdown(&self) {
        let _ = self.stop_tx.send(true);
        // 先取出客户端再 await（std MutexGuard 不得跨 await 存活）
        let client = self.shared.lock().as_ref().cloned();
        if let Some(client) = client {
            client.close().await;
        }
    }
}

/// 发送通道实现：委托当前连接客户端（重连对发送面透明；
/// 恢复期返回 ConnectionLost，工具面 not_ready 的结构化映射在维度 17 工具层）。
#[async_trait]
impl crate::cdp::sender::CommandChannel for Transport {
    async fn send_command(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, CdpError> {
        // 先取出客户端再 await（std MutexGuard 不得跨 await 存活）
        let client = self.shared.lock().as_ref().cloned();
        match client {
            Some(client) => {
                client
                    .send_command_with_timeout(method, params, session_id, timeout)
                    .await
            }
            None => Err(CdpError::ConnectionLost),
        }
    }

    async fn send_command_no_wait(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
    ) -> Result<(), CdpError> {
        let client = self.shared.lock().as_ref().cloned();
        match client {
            Some(client) => client.send_command_no_wait(method, params, session_id).await,
            None => Err(CdpError::ConnectionLost),
        }
    }

    fn is_ready(&self) -> bool {
        Transport::is_ready(self)
    }
}

/// 事件重发面：客户端事件 → transport 稳定面。
/// 接收端由调用方**在恢复流程前**创建并传入（订阅时序铁律：tokio broadcast
/// 新订阅者从写游标开始读，不补发订阅前消息——恢复期事件若在订阅前发出即丢失）。
fn spawn_forward(mut rx: broadcast::Receiver<CdpEvent>, event_tx: &broadcast::Sender<CdpEvent>) {
    let tx = event_tx.clone();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let _ = tx.send(ev);
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// 退避基准序列：1s → 2s → 4s → … 上限 30s（§2.4 第 3 步）。
pub fn backoff_base(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(62);
    let secs = (1u64 << shift).min(BACKOFF_MAX.as_secs());
    Duration::from_secs(secs)
}

/// 确定性抖动因子（±20% 区间内；按 attempt 递推，进程间自然错开防共振）。
pub fn jitter_factor(attempt: u32) -> f64 {
    let mut state = (attempt as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    // xorshift64：轻量确定性伪随机
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    let unit = (state % 1000) as f64 / 1000.0; // [0, 1)
    let (lo, hi) = BACKOFF_JITTER_RANGE;
    lo + unit * (hi - lo)
}

/// 退避延迟 = 基准 × 抖动（重连调度用）。
pub fn backoff_delay(attempt: u32) -> Duration {
    let base_ms = backoff_base(attempt).as_millis() as f64;
    Duration::from_millis((base_ms * jitter_factor(attempt)) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::bus::{BusHandle, TabSummary};
    use crate::cdp::mock::{MockReply, MockServer};
    use crate::cdp::version::VersionTracker;
    use serde_json::json;

    /// 测试用恢复钩子：计数运行次数，可选在恢复时广播 TargetsReconciled。
    struct RecordingRestoreHook {
        runs: Arc<std::sync::atomic::AtomicUsize>,
        reconciled: bool,
        bus_tx: Option<broadcast::Sender<BrowserEvent>>,
    }

    impl RecordingRestoreHook {
        fn new(runs: Arc<std::sync::atomic::AtomicUsize>) -> Self {
            RecordingRestoreHook {
                runs,
                reconciled: false,
                bus_tx: None,
            }
        }
        fn with_reconcile(
            runs: Arc<std::sync::atomic::AtomicUsize>,
            bus_tx: broadcast::Sender<BrowserEvent>,
        ) -> Self {
            RecordingRestoreHook {
                runs,
                reconciled: true,
                bus_tx: Some(bus_tx),
            }
        }
    }

    #[async_trait]
    impl RestoreHook for RecordingRestoreHook {
        async fn restore(&self, _client: &CdpClient) -> Result<(), BrowserError> {
            self.runs.fetch_add(1, Ordering::SeqCst);
            if self.reconciled {
                if let Some(tx) = &self.bus_tx {
                    let _ = tx.send(BrowserEvent::TargetsReconciled {
                        tabs: vec![
                            TabSummary {
                                target_id: "T1".to_string(),
                                session: "S1".to_string(),
                                url: "https://a.example".to_string(),
                                title: "A".to_string(),
                            },
                            TabSummary {
                                target_id: "T2".to_string(),
                                session: "S2".to_string(),
                                url: "https://b.example".to_string(),
                                title: "B".to_string(),
                            },
                        ],
                    });
                }
            }
            Ok(())
        }
    }

    fn mock_version_reply() -> MockReply {
        MockReply::Ok(json!({
            "protocolVersion": "1.3",
            "product": "Chrome/131.0.6778.204",
            "revision": "@abc",
            "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "jsVersion": "13.1.71",
            "webkitVersion": "537.36"
        }))
    }

    /// 验收 9.1-10：1s→2s→4s 序列 + 抖动区间断言
    #[test]
    fn transport_backoff_sequence() {
        assert_eq!(backoff_base(1), Duration::from_secs(1));
        assert_eq!(backoff_base(2), Duration::from_secs(2));
        assert_eq!(backoff_base(3), Duration::from_secs(4));
        assert_eq!(backoff_base(4), Duration::from_secs(8));
        assert_eq!(backoff_base(5), Duration::from_secs(16));
        // 上限 30s
        assert_eq!(backoff_base(6), Duration::from_secs(30));
        assert_eq!(backoff_base(10), Duration::from_secs(30));
        // 抖动区间 [0.8, 1.2]×base
        let (lo, hi) = BACKOFF_JITTER_RANGE;
        for attempt in 1..=12u32 {
            let j = jitter_factor(attempt);
            assert!(
                (lo..=hi).contains(&j),
                "attempt={attempt} 抖动 {j} 超出区间"
            );
            let delay = backoff_delay(attempt);
            let base_ms = backoff_base(attempt).as_millis() as f64;
            assert!(
                delay.as_millis() as f64 >= base_ms * lo,
                "attempt={attempt} 延迟低于下界"
            );
            assert!(
                delay.as_millis() as f64 <= base_ms * hi,
                "attempt={attempt} 延迟高于上界"
            );
        }
    }

    /// 验收 9.1-9：mock 端收到 Ping（间隔可注入）
    #[tokio::test]
    async fn transport_heartbeat_sent_on_interval() {
        let mock = MockServer::spawn().await;
        let client = CdpClient::connect_with_config(
            &mock.url("/devtools/browser/heartbeat"),
            ConnectConfig {
                heartbeat: Duration::from_millis(50),
                ..Default::default()
            },
        )
        .await
        .expect("建连失败");
        // 等 3 个心跳周期
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            mock.ping_count() > 0,
            "心跳间隔内应收到 Ping（实际 {}）",
            mock.ping_count()
        );
        client.close().await;
    }

    /// M3：Transport Drop 后 supervisor 任务终止——调用方遗漏 shutdown 时
    /// 重连任务不得常驻泄漏（stop 通知 + abort 双路径收尾）。
    #[tokio::test]
    async fn transport_drop_stops_supervisor() {
        let mock = MockServer::spawn().await;
        mock.set_auto_reply("Browser.getVersion", mock_version_reply());
        let bus = BusHandle::new(64, 8);
        let tracker = Arc::new(VersionTracker::new(
            bus.event_tx(),
            Duration::from_millis(50),
        ));
        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let endpoint = CdpEndpoint {
            port: mock.addr.port(),
            ws_path: "/devtools/browser/drop-supervisor".to_string(),
        };
        let transport = Transport::connect(
            endpoint,
            ExpectedBrowser::default(),
            bus.event_tx(),
            tracker.epoch_handle(),
            Arc::new(RecordingRestoreHook::new(runs.clone())),
        )
        .await
        .expect("建连失败");
        assert_eq!(runs.load(Ordering::SeqCst), 0, "connect 不执行恢复（订阅时序铁律）");
        let handle = transport._supervisor.abort_handle();
        drop(transport);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if handle.is_finished() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "Drop 后 supervisor 任务必须终止"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// 验收 9.1-11：断线重连 → 恢复流程重跑 → VersionReset 广播 →
    /// 全部标签 snapshot_version 跳变（+1000）+ global_epoch+1
    #[tokio::test]
    async fn transport_reconnect_restores_session() {
        let mock = MockServer::spawn().await;
        mock.set_auto_reply("Browser.getVersion", mock_version_reply());

        let bus = BusHandle::new(64, 8);
        let tracker = Arc::new(VersionTracker::new(
            bus.event_tx(),
            Duration::from_millis(50),
        ));
        // 先订阅后动作（订阅时序铁律）
        let mut bus_rx = bus.subscribe();
        crate::cdp::version::spawn_version_driver(bus.subscribe(), tracker.clone());

        // 断线前：tab-1 已有一次显式推进（版本 1）
        tracker.bump("tab-1", crate::cdp::bus::VersionReason::InputInjected);
        assert_eq!(tracker.snapshot_version("tab-1"), 1);

        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook = Arc::new(RecordingRestoreHook::new(runs.clone()));
        let endpoint = CdpEndpoint {
            port: mock.addr.port(),
            ws_path: "/devtools/browser/reconnect".to_string(),
        };
        let transport = Transport::connect(
            endpoint,
            ExpectedBrowser {
                product_prefix: Some("Chrome/".to_string()),
                min_major: None,
            },
            bus.event_tx(),
            tracker.epoch_handle(),
            hook.clone(),
        )
        .await
        .expect("建连失败");

        // 订阅时序铁律：首启恢复由调用方在订阅就绪后显式触发
        transport
            .restore_now(hook.as_ref())
            .await
            .expect("首次恢复失败");
        assert_eq!(runs.load(Ordering::SeqCst), 1, "首次恢复应执行一次恢复流程");
        assert!(transport.is_ready());

        // 断线 → 重连（退避 1s）→ 恢复
        mock.close_connection();

        // 等待 VersionReset（重连 + 版本跳变全链路）
        let mut saw_lost = false;
        let mut saw_restored = false;
        let mut saw_reset = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        while tokio::time::Instant::now() < deadline {
            tokio::select! {
                ev = bus_rx.recv() => match ev {
                    Ok(BrowserEvent::ConnectionLost { .. }) => saw_lost = true,
                    Ok(BrowserEvent::ConnectionRestored { .. }) => saw_restored = true,
                    Ok(BrowserEvent::VersionReset { .. }) => { saw_reset = true; break; }
                    Ok(_) | Err(_) => {}
                },
                _ = tokio::time::sleep(Duration::from_millis(10)) => {}
            }
        }
        assert!(saw_lost, "应广播 ConnectionLost");
        assert!(saw_restored, "应广播 ConnectionRestored");
        assert!(saw_reset, "应广播 VersionReset");
        assert_eq!(runs.load(Ordering::SeqCst), 2, "重连应再次执行恢复流程");
        assert_eq!(mock.connection_count(), 2, "应建立两次连接（断线才重连）");
        assert!(transport.is_ready(), "恢复完成后应恢复可用");

        // 版本跳变断言：+1000、epoch+1、旧版本全部作废
        assert_eq!(tracker.snapshot_version("tab-1"), 1001);
        assert_eq!(tracker.epoch(), 1);
        let stale = tracker.validate_snapshot("tab-1", 1);
        assert!(stale.is_err(), "旧版本 1 应判定 Stale");
        assert!(tracker.validate_snapshot("tab-1", 1001).is_ok());
    }

    mod reconnect {
        use super::*;

        /// 验收 9.1-30：重连后 TargetsReconciled 携带全部标签
        #[tokio::test]
        async fn reconnect_targets_reconciled_after_restore() {
            let mock = MockServer::spawn().await;
            mock.set_auto_reply("Browser.getVersion", mock_version_reply());

            let bus = BusHandle::new(64, 8);
            let tracker = Arc::new(VersionTracker::new(
                bus.event_tx(),
                Duration::from_millis(50),
            ));
            let mut bus_rx = bus.subscribe();

            let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let hook = Arc::new(RecordingRestoreHook::with_reconcile(
                runs.clone(),
                bus.event_tx(),
            ));
            let endpoint = CdpEndpoint {
                port: mock.addr.port(),
                ws_path: "/devtools/browser/reconcile".to_string(),
            };
            let transport = Transport::connect(
                endpoint,
                ExpectedBrowser::default(),
                bus.event_tx(),
                tracker.epoch_handle(),
                hook.clone(),
            )
            .await
            .expect("建连失败");
            // 首启恢复（订阅时序铁律：connect 不执行恢复，由调用方触发）
            transport
                .restore_now(hook.as_ref())
                .await
                .expect("首次恢复失败");

            mock.close_connection();

            // 重连后应收到：TargetsReconciled（恢复流程内广播）→ ConnectionRestored
            let mut saw_reconciled: Option<Vec<TabSummary>> = None;
            let mut saw_restored = false;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
            while tokio::time::Instant::now() < deadline {
                match bus_rx.try_recv() {
                    Ok(BrowserEvent::TargetsReconciled { tabs }) => {
                        saw_reconciled = Some(tabs);
                    }
                    Ok(BrowserEvent::ConnectionRestored { .. }) => {
                        saw_restored = true;
                        break;
                    }
                    Ok(_) => continue,
                    Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    Err(_) => break,
                }
            }
            let tabs = saw_reconciled.expect("重连后应广播 TargetsReconciled");
            assert_eq!(tabs.len(), 2, "应携带全部标签");
            assert_eq!(tabs[0].target_id, "T1");
            assert_eq!(tabs[1].target_id, "T2");
            assert!(saw_restored, "恢复完成后应广播 ConnectionRestored");
            assert_eq!(runs.load(Ordering::SeqCst), 2);
        }
    }

    /// 端点 Debug 脱敏回归（10 文档 §7.3：端口/路径不进日志）。
    #[test]
    fn transport_endpoint_debug_redacted() {
        let ep = CdpEndpoint {
            port: 41234,
            ws_path: "/devtools/browser/secret-uuid".to_string(),
        };
        let text = format!("{ep:?}");
        assert!(!text.contains("41234"));
        assert!(!text.contains("secret-uuid"));
        assert!(!text.contains("ws://"));
        assert!(text.contains("redacted"));
        // url() 仍可正常拼接（仅在需要建连时调用，不留日志）
        assert!(ep.url().starts_with("ws://127.0.0.1:41234/"));
    }

    /// 恢复期发事件（模拟真实浏览器 restore 期间 attachedToTarget 事件流）。
    struct EmittingRestoreHook {
        mock: Arc<MockServer>,
    }

    #[async_trait]
    impl RestoreHook for EmittingRestoreHook {
        async fn restore(&self, _client: &CdpClient) -> Result<(), BrowserError> {
            self.mock.send_event(
                "Target.attachedToTarget",
                json!({
                    "sessionId": "S1",
                    "targetInfo": { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" },
                    "waitingForDebugger": false,
                }),
                None,
            );
            Ok(())
        }
    }

    /// 回归（联调 E1 根因）：restore 期间产生的 WS 事件必须送达订阅面——
    /// 事件重发面须在 restore **前**完成订阅（tokio broadcast 新订阅者从写游标
    /// 开始读，不补发订阅前消息；订阅在 restore 之后即事件全部丢失）。
    #[tokio::test]
    async fn transport_restore_events_not_lost() {
        let mock = Arc::new(MockServer::spawn().await);
        mock.set_auto_reply("Browser.getVersion", mock_version_reply());

        let hook = Arc::new(EmittingRestoreHook { mock });
        let endpoint = CdpEndpoint {
            port: hook.mock.addr.port(),
            ws_path: "/devtools/browser/restore-events".to_string(),
        };
        let transport = Transport::connect(
            endpoint,
            ExpectedBrowser::default(),
            broadcast::channel(64).0,
            Arc::new(AtomicU64::new(0)),
            hook.clone(),
        )
        .await
        .expect("建连失败");

        // 订阅时序铁律：事件面在 restore 前订阅（调用方契约）
        let mut events = transport.subscribe_events();

        // 恢复流程触发 mock 发出 attachedToTarget
        transport
            .restore_now(hook.as_ref())
            .await
            .expect("恢复失败");

        // restore 期间的事件必须已送达（若订阅晚于 restore 则此处超时）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            match tokio::time::timeout(Duration::from_millis(200), events.recv()).await {
                Ok(Ok(ev)) if ev.method == "Target.attachedToTarget" => break,
                Ok(Ok(_)) => {}
                Ok(Err(_)) => panic!("事件通道关闭"),
                Err(_) => {
                    assert!(
                        tokio::time::Instant::now() < deadline,
                        "restore 期间事件丢失（订阅时序回归）"
                    );
                }
            }
        }
    }

    /// 重连风暴（评审 P2 补强）：3 次循环断线 → 每次重连恢复 → 最终收敛。
    /// 单调性断言：global_epoch 逐轮 +1、快照版本每轮 +1000、旧版本全部 Stale；
    /// 收敛断言：连接数/恢复次数精确等于 1 + 3、最终版本 3001。
    #[tokio::test]
    async fn transport_reconnect_storm_monotonic_convergence() {
        let mock = MockServer::spawn().await;
        mock.set_auto_reply("Browser.getVersion", mock_version_reply());

        let bus = BusHandle::new(64, 8);
        let tracker = Arc::new(VersionTracker::new(
            bus.event_tx(),
            Duration::from_millis(50),
        ));
        let mut bus_rx = bus.subscribe();
        // 版本驱动订阅（ConnectionRestored → VersionReset 全链路）
        crate::cdp::version::spawn_version_driver(bus.subscribe(), tracker.clone());

        // 风暴前：tab-1 已有版本基线（1）
        tracker.bump("tab-1", crate::cdp::bus::VersionReason::InputInjected);
        assert_eq!(tracker.snapshot_version("tab-1"), 1);

        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook = Arc::new(RecordingRestoreHook::new(runs.clone()));
        let endpoint = CdpEndpoint {
            port: mock.addr.port(),
            ws_path: "/devtools/browser/storm".to_string(),
        };
        let transport = Transport::connect(
            endpoint,
            ExpectedBrowser::default(),
            bus.event_tx(),
            tracker.epoch_handle(),
            hook.clone(),
        )
        .await
        .expect("建连失败");
        transport
            .restore_now(hook.as_ref())
            .await
            .expect("首启恢复失败");
        assert_eq!(mock.connection_count(), 1, "首连 1 次");

        // 3 次循环断线：每轮等待「ConnectionLost → ConnectionRestored → VersionReset」
        let mut lost_total = 0usize;
        for cycle in 1..=3u32 {
            mock.close_connection();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            let mut restored_epoch: Option<u64> = None;
            let mut reset_epoch: Option<u64> = None;
            while tokio::time::Instant::now() < deadline {
                tokio::select! {
                    ev = bus_rx.recv() => match ev {
                        Ok(BrowserEvent::ConnectionLost { attempt }) => {
                            lost_total += 1;
                            assert_eq!(attempt, 0, "断线首信号 attempt=0（未达上报阈值）");
                        }
                        Ok(BrowserEvent::ConnectionRestored { epoch, .. }) => {
                            // 广播时 epoch 为重置前值（重置由版本驱动收到事件后触发）
                            restored_epoch = Some(epoch);
                        }
                        Ok(BrowserEvent::VersionReset { epoch, .. }) => {
                            reset_epoch = Some(epoch);
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    },
                    _ = tokio::time::sleep(Duration::from_millis(10)) => {}
                }
                if reset_epoch.is_some() {
                    break;
                }
            }
            let restored = restored_epoch.expect("第 {cycle} 轮必须广播 ConnectionRestored");
            let reset = reset_epoch.expect("第 {cycle} 轮必须广播 VersionReset");
            // 单调性：epoch 逐轮 +1（reset 后 = cycle；restored 携带前置值 = cycle-1）
            assert_eq!(reset, u64::from(cycle), "global_epoch 必须严格单调递增：第 {cycle} 轮");
            assert_eq!(restored, u64::from(cycle) - 1, "ConnectionRestored 携带重置前 epoch");
            assert!(transport.is_ready(), "每轮恢复完成后必须重新可用");
        }
        // 最终收敛（精确计数，防重连风暴失控）
        assert_eq!(lost_total, 3, "恰好 3 次 ConnectionLost（无多余断线信号）");
        assert_eq!(mock.connection_count(), 4, "首连 + 3 次重连 = 4");
        assert_eq!(runs.load(Ordering::SeqCst), 4, "恢复流程每次重连重跑");
        // 版本单调收敛：1 + 3×1000
        assert_eq!(tracker.epoch(), 3, "epoch 最终 = 3");
        assert_eq!(tracker.snapshot_version("tab-1"), 3001, "版本每轮 +1000");
        // 旧版本全部失效（任一中间态版本均 Stale）
        for stale_version in [1u64, 1001, 2001] {
            assert!(
                tracker.validate_snapshot("tab-1", stale_version).is_err(),
                "版本 {stale_version} 必须判定 Stale"
            );
        }
        assert!(tracker.validate_snapshot("tab-1", 3001).is_ok());
        // 断线 → 重连循环收敛后可继续服务（发送面恢复）
        use crate::cdp::sender::CommandChannel;
        let send = transport
            .send_command("Browser.getVersion", None, None, Duration::from_secs(5))
            .await;
        assert!(send.is_ok(), "收敛后命令面可用：{send:?}");
    }
}
