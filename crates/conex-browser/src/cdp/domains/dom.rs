//! DOM 域（会话级）命令、结果与事件类型。

use super::runtime::RemoteObject;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// DOM 域（会话级）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetDocumentParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pierce: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetDocumentResult {
    pub root: DomNode,
}

/// DOM.getFrameOwner 结果（维度 13 §1.5 跨域 iframe 递归：frameId →
/// 父文档中的 iframe owner 元素 backendNodeId，作尺寸门限与 `|IFRAME|`
/// 标记定位；`backendNodeId` 在 Chrome 151 实测中存在）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFrameOwnerResult {
    pub backend_node_id: Option<i64>,
    pub node_id: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomNode {
    pub node_id: i64,
    pub backend_node_id: Option<i64>,
    pub node_type: Option<i64>,
    pub node_name: Option<String>,
    pub local_name: Option<String>,
    pub node_value: Option<String>,
    pub attributes: Option<Vec<String>>,
    pub children: Option<Vec<DomNode>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRefParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveNodeResult {
    pub object: RemoteObject,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescribeNodeResult {
    pub node: DomNode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetBoxModelResult {
    pub model: BoxModel,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxModel {
    pub content: Vec<f64>,
    pub padding: Vec<f64>,
    pub border: Vec<f64>,
    pub margin: Vec<f64>,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetContentQuadsResult {
    pub quads: Vec<Vec<f64>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushNodesByBackendIdsToFrontendParams {
    pub backend_node_ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushNodesByBackendIdsToFrontendResult {
    pub node_ids: Vec<i64>,
}

/// DOM.scrollIntoViewIfNeeded 参数（R-3 补齐）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollIntoViewIfNeededParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rect: Option<Value>,
}

/// DOM.focus 参数（R-3 补齐）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySelectorParams {
    pub node_id: i64,
    pub selector: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySelectorResult {
    pub node_id: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySelectorAllParams {
    pub node_id: i64,
    pub selector: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySelectorAllResult {
    pub node_ids: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFileInputFilesParams {
    pub files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<i64>,
}

// DOM 事件

/// DOM.childNodeInserted 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildNodeInsertedEvent {
    pub parent_node_id: i64,
    pub previous_node_id: i64,
    pub node: DomNode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildNodeRemovedEvent {
    pub parent_node_id: i64,
    pub node_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterDataModifiedEvent {
    pub node_id: i64,
    pub character_data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeModifiedEvent {
    pub node_id: i64,
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeRemovedEvent {
    pub node_id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetChildNodesEvent {
    pub parent_id: i64,
    pub nodes: Vec<DomNode>,
}
