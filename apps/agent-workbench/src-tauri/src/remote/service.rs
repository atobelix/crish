//! 账户远程 host 服务：loopback 网关 + relay host 桥。
//!
//! 设备在线状态由 relay 房间天然表达（连接即在线），无需账号中心设备注册表。

use crate::auth::AuthManager;
use crate::multi_device_service::MultiDeviceService;
use crate::remote::bridge;
use crate::remote::client::{fetch_host_ticket, http_client, ticket_base_url, RelayTicketError};
use crate::remote::device;
use std::sync::{Arc, Once};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinHandle;

static START: Once = Once::new();

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

    loop {
        let snapshot = auth.get_session_snapshot().await;
        let Some(access_token) = snapshot.access_token else {
            stop_bridge(&mut bridge_task, &mut bridge_stop);
            if gateway_addr.is_some() {
                md.stop_remote_gateway().await;
                gateway_addr = None;
            }
            logged_token = None;
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        };

        if logged_token.as_deref() != Some(access_token.as_str()) {
            stop_bridge(&mut bridge_task, &mut bridge_stop);
            logged_token = Some(access_token.clone());
        }

        if gateway_addr.is_none() {
            match md.ensure_remote_gateway(gateway_secret.clone()).await {
                Ok(addr) => gateway_addr = Some(addr),
                Err(error) => {
                    tracing::warn!(target: "remote", error = %error, "remote gateway start failed");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            }
        }

        if bridge_task.as_ref().map_or(true, |task| task.is_finished()) {
            if let Some(task) = bridge_task.take() {
                task.abort();
            }
            bridge_stop = None;
            match fetch_host_ticket(&http, &ticket_base, &access_token, &device_id, &device_name)
                .await
            {
                Ok(ticket) => {
                    let (stop_tx, stop_rx) = watch::channel(false);
                    bridge_stop = Some(stop_tx);
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
                }
                Err(error) => {
                    tracing::warn!(target: "remote", error = %error, "relay ticket request failed");
                }
            }
        }

        tokio::time::sleep(Duration::from_secs(5)).await;
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
