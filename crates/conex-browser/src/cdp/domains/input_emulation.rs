//! Input / Emulation 域（会话级）命令类型。

use serde::Serialize;

// ---------------------------------------------------------------------------
// Input 域（会话级，统一注入管线，维度 12/14 共用）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchMouseEventParams {
    #[serde(rename = "type")]
    pub event_type: String,
    pub x: f64,
    pub y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub button: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buttons: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub click_count: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pointer_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchKeyEventParams {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unmodified_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows_virtual_key_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_virtual_key_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<i32>,
}

/// Input.insertText 参数（IME 安全兜底 / 纯文本粘贴路径，M-7/U-8）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertTextParams {
    pub text: String,
}

// ---------------------------------------------------------------------------
// Emulation 域（会话级）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDeviceMetricsOverrideParams {
    pub width: i32,
    pub height: i32,
    pub device_scale_factor: f64,
    pub mobile: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_height: Option<i32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetUserAgentOverrideParams {
    pub user_agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accept_language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGeolocationOverrideParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accuracy: Option<f64>,
}
