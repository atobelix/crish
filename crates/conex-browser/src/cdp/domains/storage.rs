//! Storage / DOMStorage 域（会话级）命令与结果类型。

use super::network::{Cookie, SetCookieParam};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Storage 域（会话级，维度 16 登录态/配额）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearDataForOriginParams {
    pub origin: String,
    pub storage_types: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetUsageAndQuotaParams {
    pub origin: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetUsageAndQuotaResult {
    pub usage: f64,
    pub quota: f64,
    pub usage_breakdown: Option<Vec<StorageUsageForType>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsageForType {
    pub storage_type: String,
    pub usage: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageGetCookiesParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_context_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageGetCookiesResult {
    pub cookies: Vec<Cookie>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSetCookiesParams {
    pub cookies: Vec<SetCookieParam>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_context_id: Option<String>,
}

// ---------------------------------------------------------------------------
// DOMStorage 域（会话级，维度 16 storage_state localStorage 注入/导出聚合）
// ---------------------------------------------------------------------------

/// DOMStorage 存储区标识（storageId：securityOrigin + 存储类型；
/// `isLocalStorage=true` 即 localStorage，false 为 sessionStorage）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageId {
    pub security_origin: String,
    pub is_local_storage: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetDOMStorageItemsParams {
    pub storage_id: StorageId,
}

/// getDOMStorageItems 结果：entries 为 `[name, value]` 字符串对
/// （畸形单元素对由消费方跳过）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetDOMStorageItemsResult {
    pub entries: Vec<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDOMStorageItemParams {
    pub storage_id: StorageId,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDOMStorageItemParams {
    pub storage_id: StorageId,
    pub key: String,
}
