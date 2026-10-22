//! Browser / Target 域（browser 级）命令与事件类型。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Browser 域（browser 级，无 session_id）
// ---------------------------------------------------------------------------

/// Browser.getVersion 结果（身份校验 + 能力探测输入）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVersionResult {
    pub protocol_version: Option<String>,
    pub product: Option<String>,
    pub revision: Option<String>,
    pub user_agent: Option<String>,
    pub js_version: Option<String>,
    pub web_kit_version: Option<String>,
}

impl BrowserVersionResult {
    /// 产品名（如 "Chrome/131.0.6778.204"）→ 主版本号（如 131），解析失败返回 0。
    pub fn major_version(&self) -> u64 {
        self.product
            .as_deref()
            .and_then(|p| p.split('/').nth(1))
            .and_then(|v| v.split('.').next())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// Target 域（browser 级）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
    pub target_id: String,
    #[serde(rename = "type")]
    pub target_type: String,
    pub title: String,
    pub url: String,
    pub attached: Option<bool>,
    pub browser_context_id: Option<String>,
    pub opener_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTargetsResult {
    pub target_infos: Vec<TargetInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachToTargetParams {
    pub target_id: String,
    pub flatten: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachToTargetResult {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDiscoverTargetsParams {
    pub discover: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAutoAttachParams {
    pub auto_attach: bool,
    pub wait_for_debugger_on_start: bool,
    pub flatten: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTargetParams {
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTargetResult {
    pub target_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseTargetParams {
    pub target_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseTargetResult {
    pub success: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateTargetParams {
    pub target_id: String,
}

/// Target.targetCreated / targetInfoChanged 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetCreatedEvent {
    pub target_info: TargetInfo,
}

/// Target.attachedToTarget 事件参数（双层路由建立点）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedToTargetEvent {
    pub session_id: String,
    pub target_info: TargetInfo,
    pub waiting_for_debugger: Option<bool>,
}

/// Target.targetDestroyed 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDestroyedEvent {
    pub target_id: String,
}
