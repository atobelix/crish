//! Network 域（会话级）命令、结果与事件类型。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Network 域（会话级）
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAllCookiesResult {
    pub cookies: Vec<Cookie>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub expires: f64,
    pub size: i64,
    pub http_only: bool,
    pub secure: bool,
    pub session: bool,
    pub same_site: Option<String>,
    pub priority: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCookiesParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub urls: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCookiesResult {
    pub cookies: Vec<Cookie>,
}

/// `Network.setCookies` / `Storage.setCookies` 的 cookie 参数（CDP CookieParam）：
/// 协议面除 name/value 外全部可选——可选字段 `None` 时**必须省略而非输出 null**
/// （Chrome 151 实测拒绝 null 字段，N2 缺陷：`url:null` 等导致命令失败；
/// 对照实验证实 null 字段需省略）。`expires` 省略即会话 cookie 语义
/// （协议不要求显式发 0/负数）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCookieParam {
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCookiesParams {
    pub cookies: Vec<SetCookieParam>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetResponseBodyParams {
    pub request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetResponseBodyResult {
    pub body: String,
    pub base64_encoded: bool,
}

/// Network.setBlockedURLs 参数（维度 17 门禁三检查点之传输层）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBlockedURLsParams {
    pub urls: Vec<String>,
}

// Network 事件

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestWillBeSentEvent {
    pub request_id: String,
    pub request: NetworkRequest,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkRequest {
    pub url: String,
    pub method: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadingFinishedEvent {
    pub request_id: String,
    pub encoded_data_length: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadingFailedEvent {
    pub request_id: String,
    pub canceled: Option<bool>,
    pub error_text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestFailedEvent {
    pub request_id: String,
}
