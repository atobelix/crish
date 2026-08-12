//! 笔记请求 / 结果契约（SD-32 从 `note_types` 切开）
//!
//! query / outline / apply_md / 细粒度 block op 线格式；**不含** Memory 实现与 plan 引擎。
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
    /// set_attr 属性
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
