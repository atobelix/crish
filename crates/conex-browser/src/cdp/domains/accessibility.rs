//! Accessibility 域（会话级）类型。

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Accessibility 域（会话级）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFullAXTreeParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFullAXTreeResult {
    pub nodes: Vec<AXNode>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AXNode {
    #[serde(deserialize_with = "crate::cdp::types::string_or_int")]
    pub node_id: String,
    pub ignored: Option<bool>,
    pub role: Option<AXValue>,
    pub name: Option<AXValue>,
    pub description: Option<AXValue>,
    pub value: Option<AXValue>,
    pub properties: Option<Vec<AXProperty>>,
    #[serde(default, deserialize_with = "crate::cdp::types::opt_vec_string_or_int")]
    pub child_ids: Option<Vec<String>>,
    pub backend_d_o_m_node_id: Option<i64>,
    pub frame_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AXValue {
    #[serde(rename = "type")]
    pub value_type: String,
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AXProperty {
    pub name: String,
    pub value: AXValue,
}
