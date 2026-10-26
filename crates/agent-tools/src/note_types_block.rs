//! 细粒度 block op 契约（**SD-41** 从 `note_types_ops` 抽出）
//!
//! `block_batch` / insert / update / delete / move / set_attr 线格式；
//! **不含** Memory 实现、plan 引擎、`note_block_set_attr` 工具。
//! **≠ EL-05**；**≠** 宣称 Store 后端完成；**≠** 重做 plan kinds / set_attr。

use super::error::NoteBackendError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};

// ==================== block_batch / 细粒度 block op（W4-F）====================

/// 块级 op 种类（`block_batch.ops[].op`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteBlockOpKind {
    Insert,
    Update,
    Delete,
    Move,
    SetAttr,
}

impl NoteBlockOpKind {
    /// 从工具入参字符串解析
    pub fn parse(s: &str) -> Result<Self, NoteBackendError> {
        match s {
            "insert" => Ok(Self::Insert),
            "update" => Ok(Self::Update),
            "delete" => Ok(Self::Delete),
            "move" => Ok(Self::Move),
            "set_attr" | "set-attr" => Ok(Self::SetAttr),
            other => Err(NoteBackendError::Invalid(format!(
                "unknown block op: {other}"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Insert => "insert",
            Self::Update => "update",
            Self::Delete => "delete",
            Self::Move => "move",
            Self::SetAttr => "set_attr",
        }
    }
}

/// 单条块 op（批内原子单元）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockOp {
    pub op: NoteBlockOpKind,
    /// 目标块 id（update/delete/move/set_attr 必填；insert 可选预分配）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// 插入锚点：前序兄弟（≡ after_block_id）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_id: Option<String>,
    /// insert/update 文本内容
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// insert 块 kind（默认 paragraph）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// insert 的初始属性或 set_attr 的增量属性；update 不接受 attrs。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attrs: Option<Map<String, JsonValue>>,
}

/// `block_batch` / apply_block_ops 请求
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockBatchRequest {
    pub doc_id: String,
    pub ops: Vec<NoteBlockOp>,
    /// dryRun=true → 校验并返回预览，**零写**权威树（A-AGT-05）
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// 测试/协议：强制触发 execution_unknown 中断（**不**半写）
    #[serde(default)]
    pub force_execution_unknown: bool,
}

/// 单条 op 预览（dryRun 或成功结果面）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockOpPreview {
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// 人读摘要（content 截断等）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// `apply_block_ops` 结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockBatchResult {
    /// 是否 dryRun（零写）
    pub dry_run: bool,
    /// 实际应用（或将应用）的 op 数
    pub applied: u32,
    /// 涉及/新生成的块 id
    pub block_ids: Vec<String>,
    /// ops 预览（dryRun 必填形状；实写亦回显）
    pub preview: Vec<NoteBlockOpPreview>,
}

/// 细粒度 `block_insert` 请求
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockInsertRequest {
    pub doc_id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// 细粒度 insert 结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockInsertResult {
    pub block_id: String,
    pub kind: String,
}

/// 细粒度 `block_update` 请求
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockUpdateRequest {
    pub doc_id: String,
    /// 目标块 id
    pub id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// 细粒度 update 结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockUpdateResult {
    pub id: String,
}

/// 细粒度 `block_delete` 请求
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockDeleteRequest {
    pub doc_id: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// 细粒度 delete 结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockDeleteResult {
    pub id: String,
}

/// 细粒度 `block_move` 请求
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockMoveRequest {
    pub doc_id: String,
    /// 被移动的块 id
    pub id: String,
    /// 新位置前序兄弟（缺省 → 父级末尾）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_id: Option<String>,
    /// 新父块（可选；Memory 扁平树可忽略）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// 细粒度 move 结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockMoveResult {
    pub id: String,
}

/// 细粒度 `block_set_attr` 请求（W4-R；≠ EL-05 / ≠ W6-E）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockSetAttrRequest {
    pub doc_id: String,
    /// 目标块 id
    pub id: String,
    pub attrs: Map<String, JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// 细粒度 set_attr 结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteBlockSetAttrResult {
    pub id: String,
}
