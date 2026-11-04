//! 账户远程 host 服务：loopback 网关 + relay host 桥。
//!
//! 设备在线状态由 relay 房间天然表达（连接即在线），无需账号中心设备注册表。
//!
//! 看护口径（H2，2026-11-03）：桥死亡 / 票据失败不再按 5s 固定节拍硬循环
//! 重取票据——连续失败按 `bridge::relay_backoff_delay`（1s→30s 指数封顶）
//! 推迟下一次取票；桥存活满 `BRIDGE_STABLE_AFTER` 后死亡视为正常更替，
//! 失败计数清零、可立即重连。每次推迟都在日志里留下失败次数与等待时长。

use crate::auth::AuthManager;
use crate::multi_device_service::MultiDeviceService;
use crate::remote::bridge;
use crate::remote::client::{fetch_host_ticket, http_client, ticket_base_url, RelayTicketError};
use crate::remote::device;
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio::task::JoinHandle;

static START: Once = Once::new();

/// 看护主循环基础节拍（登录态 / 网关 / 桥存活巡检；保持既有 5s 口径）。
const WATCH_INTERVAL: Duration = Duration::from_secs(5);
/// 桥存活达到此时长后死亡视为稳定更替：连续失败计数清零、不退避。
const BRIDGE_STABLE_AFTER: Duration = Duration::from_secs(60);

/// 启动进程级账户远程服务（幂等）。未登录时安静等待；登录后建立
/// loopback 网关与 host relay 桥。
pub fn start_remote_service(auth: Arc<AuthManager>, md: Arc<MultiDeviceService>) {
    START.call_once(|| {
        tauri::async_runtime::spawn(async move {
            run(auth, md).await;
        });
    });
}

async fn run(auth: Arc<AuthManager>, md: Arc<MultiDeviceService>) {
    let device_id = device::stable_device_id();
    let device_name = device::device_name();
    let http = http_client();
    let ticket_base = ticket_base_url();
    let mut bridge_task: Option<JoinHandle<()>> = None;
    let mut bridge_stop: Option<watch::Sender<bool>> = None;
    let mut gateway_addr: Option<std::net::SocketAddr> = None;
    let gateway_secret = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut logged_token: Option<String> = None;
    // 看护退避状态：连续失败次数 / 当前桥的启动时刻 / 下一次允许取票的时刻。
    let mut bridge_failures: u32 = 0;
    let mut bridge_started_at: Option<Instant> = None;
    let mut ticket_not_before: Option<Instant> = None;

    loop {
        let snapshot = auth.get_session_snapshot().await;
        let Some(access_token) = snapshot.access_token else {
            stop_bridge(&mut bridge_task, &mut bridge_stop);
            if gateway_addr.is_some() {
                md.stop_remote_gateway().await;
                gateway_addr = None;
            }
            logged_token = None;
            bridge_failures = 0;
            bridge_started_at = None;
            ticket_not_before = None;
            tokio::time::sleep(WATCH_INTERVAL).await;
            continue;
        };

        if logged_token.as_deref() != Some(access_token.as_str()) {
            stop_bridge(&mut bridge_task, &mut bridge_stop);
            bridge_failures = 0;
            bridge_started_at = None;
            ticket_not_before = None;
            logged_token = Some(access_token.clone());
        }

        if gateway_addr.is_none() {
            match md.ensure_remote_gateway(gateway_secret.clone()).await {
                Ok(addr) => gateway_addr = Some(addr),
                Err(error) => {
                    tracing::warn!(target: "remote", error = %error, "remote gateway start failed");
                    tokio::time::sleep(WATCH_INTERVAL).await;
                    continue;
                }
            }
        }

        // 桥已结束（死亡或从未启动）：先结算退避，再按门控决定是否取票重连。
        if bridge_task.as_ref().is_none_or(|task| task.is_finished()) {
            if bridge_task.is_some() {
                if let Some(task) = bridge_task.take() {
                    task.abort();
                }
                bridge_stop = None;
                let lived = bridge_started_at.map(|started| started.elapsed());
                bridge_started_at = None;
                if lived.is_some_and(|elapsed| elapsed >= BRIDGE_STABLE_AFTER) {
                    // 存活够久的桥死亡是正常更替：不累计失败，允许立即重连。
                    bridge_failures = 0;
                    ticket_not_before = None;
                } else {
                    bridge_failures = bridge_failures.saturating_add(1);
                    let delay = bridge::relay_backoff_delay(bridge_failures);
                    ticket_not_before = Some(Instant::now() + delay);
                    tracing::warn!(
                        target: "remote",
                        category = "transient",
                        failures = bridge_failures,
                        lived_ms = lived.map(|elapsed| elapsed.as_millis() as u64),
                        retry_after_ms = delay.as_millis() as u64,
                        "relay host bridge ended; reconnect deferred by backoff"
                    );
                }
            }
            let backoff_pending =
                ticket_not_before.is_some_and(|deadline| Instant::now() < deadline);
            if !backoff_pending {
                ticket_not_before = None;
                match fetch_host_ticket(
                    &http,
                    &ticket_base,
                    &access_token,
                    &device_id,
                    &device_name,
                )
                .await
                {
                    Ok(ticket) => {
                        let (stop_tx, stop_rx) = watch::channel(false);
                        bridge_stop = Some(stop_tx);
                        bridge_started_at = Some(Instant::now());
                        bridge_task = Some(bridge::spawn_host_bridge(
                            ticket,
                            gateway_addr.expect("gateway ensured"),
                            gateway_secret.clone(),
                            stop_rx,
                        ));
                        tracing::info!(target: "remote", device = %device_id, "relay host bridge started");
                    }
                    Err(RelayTicketError::Unauthorized) => {
                        let _ = auth.check_and_refresh_token().await;
                        // 刷新后仍可能拿到坏票据：与其它失败同口径退避，
                        // 防 5s 节拍反复撞票据端点。
                        bridge_failures = bridge_failures.saturating_add(1);
                        let delay = bridge::relay_backoff_delay(bridge_failures);
                        ticket_not_before = Some(Instant::now() + delay);
                        tracing::warn!(
                            target: "remote",
                            category = "fatal",
                            failures = bridge_failures,
                            retry_after_ms = delay.as_millis() as u64,
                            "relay ticket unauthorized; token refresh attempted, retry deferred by backoff"
                        );
                    }
                    Err(error) => {
                        bridge_failures = bridge_failures.saturating_add(1);
                        let delay = bridge::relay_backoff_delay(bridge_failures);
                        ticket_not_before = Some(Instant::now() + delay);
                        tracing::warn!(
                            target: "remote",
                            category = "transient",
                            error = %error,
                            failures = bridge_failures,
                            retry_after_ms = delay.as_millis() as u64,
                            "relay ticket request failed; retry deferred by backoff"
                        );
                    }
                }
            }
        }

        tokio::time::sleep(WATCH_INTERVAL).await;
    }
}

fn stop_bridge(task: &mut Option<JoinHandle<()>>, stop: &mut Option<watch::Sender<bool>>) {
    if let Some(stop) = stop.take() {
        let _ = stop.send(true);
    }
    if let Some(task) = task.take() {
        task.abort();
    }
}
