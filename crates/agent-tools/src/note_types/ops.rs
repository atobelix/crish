//! 笔记请求 / 结果契约（SD-32 从 `note_types` 切开）
//!
//! query / outline / apply_md 线格式；细粒度 block op 见 `note_types_block`（**SD-41**）。
//! **不含** Memory 实现与 plan 引擎。
//! **≠ EL-05**；**≠** 宣称 Store 后端完成；**≠** 重做 plan kinds / set_attr。

use super::error::NoteBackendError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};

// ==================== query_blocks 类型（snake_case 线格式）====================

/// `query_blocks` 入参（对齐 store / TS 契约）
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct NoteQueryBlocksParams {
    pub doc_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind_in: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attrs_eq: Option<Map<String, JsonValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_match: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// 单条命中块摘要
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteQueryBlockHit {
    pub id: String,
    pub kind: String,
    pub snippet: String,
    #[serde(default)]
    pub attrs: Map<String, JsonValue>,
}

/// `query_blocks` 出参
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteQueryBlocksResult {
    pub blocks: Vec<NoteQueryBlockHit>,
    pub truncated: bool,
}

// ==================== document_outline 类型 ====================

/// 大纲节点
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteOutlineNode {
    pub id: String,
    pub level: u32,
    pub title: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<NoteOutlineNode>,
}

/// 文档大纲
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteOutline {
    pub outline: Vec<NoteOutlineNode>,
    pub truncated: bool,
}

// ==================== apply_md 类型 ====================

/// apply / send_to_note 写入模式
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NoteApplyMode {
    /// 解析 MD 为块并插入（默认）
    #[default]
    ApplyMdFragment,
    /// 插入块（与 apply_md_fragment 在 Memory 后端等价：按行插段落）
    InsertBlocks,
    /// 追加到已有块文本
    AppendToBlock,
}

impl NoteApplyMode {
    /// 从工具入参字符串解析；未知 → Invalid
    pub fn parse(s: &str) -> Result<Self, NoteBackendError> {
        match s {
            "apply_md_fragment" | "apply-md-fragment" => Ok(Self::ApplyMdFragment),
            "insert_blocks" | "insert-blocks" => Ok(Self::InsertBlocks),
            "append_to_block" | "append-to-block" => Ok(Self::AppendToBlock),
            other => Err(NoteBackendError::Invalid(format!(
                "unknown apply mode: {other}"
            ))),
        }
    }
}

/// `apply_md_fragment` / `document_apply_md` 请求
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteApplyMdRequest {
    pub doc_id: String,
    pub markdown: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_block_id: Option<String>,
    #[serde(default)]
    pub mode: NoteApplyMode,
    /// 幂等键（send_to_note 的 intent_id；document_apply_md 可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_id: Option<String>,
    /// 会话 batch token（可选校验）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    /// 源消息 id（send_to_note 透传，不参与写入逻辑）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// 来源：user | agent
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// 单条有损/诊断项（对齐 `conex-md-ast::LossyItem` 线格式，叶子 crate 不硬绑 md-ast）
///
/// 机器码常见值：`missing_block_id` / `duplicate_block_id` / `structure_note` 等。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NoteLossyItem {
    /// 机器可读码
    pub code: String,
    /// 人读细节
    pub detail: String,
    /// 源行号（若有）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
}

/// apply 有损汇总（对齐 `conex-md-ast::LossyReport`；工具 result 面可观测）
///
/// # W4-A
/// Store 路径须把 `ApplyReport.lossy` 映射到本结构；Memory 伪实现可返回空
/// （不走真实 P 路径）。**≠ EL-05 / ≠ A-AGT 满表**。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct NoteLossyReport {
    #[serde(default)]
    pub items: Vec<NoteLossyItem>,
}

impl NoteLossyReport {
    /// 无有损项
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

/// apply 结果
///
/// # W4-A 结果面
/// - `lossy`：parse/apply 有损项进入工具 JSON（`apply_result_json`），
///   **禁止** Store 路径默默丢弃（审计 S1）。
/// - **≠ EL-05**：本字段可观测 ≠ A-AGT-01…08 满关；Memory 全绿禁关生产项。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteApplyMdResult {
    /// 新插入（或幂等返回）的块 id 列表
    pub block_ids: Vec<String>,
    /// 本次实际新插入的块数（幂等 hit 时为 0）
    pub inserted: u32,
    /// 是否命中幂等缓存（同 intent_id 重复调用）
    pub idempotent: bool,
    /// 有损报告（W4-A：进入工具 result；空 = 无有损或后端未透出）
    #[serde(default)]
    pub lossy: NoteLossyReport,
}

// ==================== undo_text / redo_text 类型 ====================

/// `undo_text` 结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NoteUndoResult {
    pub doc_id: String,
    pub block_id: String,
    pub rev: u64,
    pub text: String,
    pub is_noop: bool,
}

/// `redo_text` 结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NoteRedoResult {
    pub doc_id: String,
    pub block_id: String,
    pub rev: u64,
    pub text: String,
    pub is_noop: bool,
}
