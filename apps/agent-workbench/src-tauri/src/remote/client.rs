//! 中继票据与在线设备客户端（host / 设备列表方向）。

use serde::Deserialize;
use std::time::Duration;

pub const DEFAULT_TICKET_BASE_URL: &str = "https://proxy.flowbit.me:8443";

#[derive(Debug, thiserror::Error)]
pub enum RelayTicketError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayTicket {
    pub ticket: String,
    pub relay_url: String,
}

/// 账号内在线设备（中继 `GET /v1/devices` 返回项）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayDevice {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub last_seen_at: u64,
}

#[derive(Debug, Deserialize)]
struct RelayDeviceList {
    #[serde(default)]
    items: Vec<RelayDevice>,
}

pub fn ticket_base_url() -> String {
    std::env::var("CRISH_RELAY_TICKET_BASE")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_TICKET_BASE_URL.to_string())
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default()
}

/// 申请 host 票据。401 单独返回，驱动账号 token 静默续期。
pub async fn fetch_host_ticket(
    http: &reqwest::Client,
    base_url: &str,
    access_token: &str,
    device_id: &str,
    device_name: &str,
) -> Result<RelayTicket, RelayTicketError> {
    let response = http
        .post(format!("{base_url}/v1/ticket/host"))
        .bearer_auth(access_token)
        .json(&serde_json::json!({
            "deviceId": device_id,
            "deviceName": device_name,
        }))
        .send()
        .await
        .map_err(|error| RelayTicketError::Other(error.to_string()))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(RelayTicketError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(RelayTicketError::Other(format!(
            "relay ticket HTTP {}",
            response.status()
        )));
    }
    response
        .json::<RelayTicket>()
        .await
        .map_err(|error| RelayTicketError::Other(error.to_string()))
}

/// 查询账号内当前在线设备（中继房间状态；离线设备不出现在列表中）。
pub async fn fetch_relay_devices(
    http: &reqwest::Client,
    base_url: &str,
    access_token: &str,
) -> Result<Vec<RelayDevice>, RelayTicketError> {
    let response = http
        .get(format!("{base_url}/v1/devices"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| RelayTicketError::Other(error.to_string()))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(RelayTicketError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(RelayTicketError::Other(format!(
            "relay devices HTTP {}",
            response.status()
        )));
    }
    response
        .json::<RelayDeviceList>()
        .await
        .map(|list| list.items)
        .map_err(|error| RelayTicketError::Other(error.to_string()))
}
