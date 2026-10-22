//! DOMSnapshot 域（会话级）采集结果类型。

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// DOMSnapshot 域（会话级，R-3 补齐，维度 13 主采集通道）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSnapshotParams {
    pub computed_styles: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_paint_order: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_dom_rects: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSnapshotResult {
    pub strings: Vec<String>,
    pub documents: Vec<SnapshotDocument>,
}

/// DOMSnapshot 稀疏数据形态（RareStringData / RareBooleanData / RareIntegerData）：
/// `index` 命中节点索引 + `value` 对应值；真实响应为单对象映射（协议文档旧版为
/// 等长扁平数组，Chrome 151 实测已迁移为映射；`value` 全空时字段可能整体省略，
/// 故 value 声明 `#[serde(default)]`）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RareStringData {
    pub index: Vec<i64>,
    #[serde(default)]
    pub value: Vec<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RareBooleanData {
    pub index: Vec<i64>,
    #[serde(default)]
    pub value: Vec<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RareIntegerData {
    pub index: Vec<i64>,
    #[serde(default)]
    pub value: Vec<i64>,
}

/// DOMSnapshot 文档字段（documentURL/title）双形态：Chrome 151 实测为**字符串池
/// 下标**（协议文档旧版为直出字符串）；untagged 双形态兼容 + 池解析入口。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum SnapshotString {
    /// 字符串池下标（Chrome 151+ 实测形态）。
    Index(i64),
    /// 直出字符串（旧版/宽容形态）。
    Literal(String),
}

impl SnapshotString {
    /// 解析为实际字符串（Index 形态经字符串池解析；越界/负值回退空串）。
    pub fn resolve(&self, strings: &[String]) -> String {
        match self {
            SnapshotString::Literal(s) => s.clone(),
            SnapshotString::Index(i) => {
                if *i >= 0 {
                    strings.get(*i as usize).cloned().unwrap_or_default()
                } else {
                    String::new()
                }
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDocument {
    /// 双形态：字符串池下标（Chrome 151+）或直出字符串（旧版）。
    /// 显式 rename：协议键为 `documentURL`（URL 全大写，非 camelCase 规则产物）。
    #[serde(rename = "documentURL")]
    pub document_url: Option<SnapshotString>,
    pub title: Option<SnapshotString>,
    /// 文档所属 frameId（Chrome 151 实测为**字符串池下标**形态，与 documentURL/
    /// title 同漂移——双形态兼容 + 池解析入口；跨域帧不在主会话 DOMSnapshot
    /// 文档集内——文档集的 frameId 集合 = 已 pierce 帧集合，维度 13 §1.5
    /// 跨域递归据此筛选未覆盖帧）。
    #[serde(rename = "frameId")]
    pub frame_id: Option<SnapshotString>,
    /// Chrome 151 实测不发送该字段（协议文档要求但响应省略），缺失按 0。
    #[serde(default)]
    pub node_count: i64,
    pub nodes: SnapshotNode,
    pub layout: SnapshotLayout,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotNode {
    pub parent_index: Vec<i64>,
    pub node_type: Vec<i64>,
    pub node_name: Vec<i64>,
    pub node_value: Vec<i64>,
    /// Chrome 151 实测字段名为 `backendNodeId`（协议文档旧名 `backendDOMNodeId`
    /// 经 alias 兼容）；缺失按无 backend 绑定。
    #[serde(rename = "backendNodeId", alias = "backendDOMNodeId")]
    pub backend_dom_node_id: Option<Vec<i64>>,
    pub attributes: Option<Vec<Vec<i64>>>,
    /// 稀疏字符串数据（RareStringData 映射形态，非旧文档扁平数组）。
    pub input_value: Option<RareStringData>,
    /// 稀疏布尔数据（RareBooleanData 映射形态）。
    pub option_selected: Option<RareBooleanData>,
    /// Chrome 151 实测不发送该字段（全 -1 时省略），缺失按空集。
    #[serde(default)]
    pub child_node_indexes: Vec<i64>,
    /// 稀疏整数数据（RareIntegerData 映射形态，非旧文档扁平数组）。
    pub shadow_root_type: Option<RareIntegerData>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotLayout {
    pub node_index: Vec<i64>,
    pub bounds: Vec<Value>,
}
