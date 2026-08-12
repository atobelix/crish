//! 进程内 [`MemoryNoteBackend`]（SD-01 纵向切开 · **SD-28** query/apply/batch）
//!
//! dev/test + 可注入 ToolContext；**≠** Store 真路径，**≠ EL-05**，**≠ W6-E**。
//! 写路径经 `apply_md_fragment` / `apply_block_ops`（plan → commit）。
//!
//! # SD-28 分模
//! - [`query`]：`query_blocks` / `document_outline` / `get_md` + 即时 S
//! - [`apply`]：`apply_md_fragment`（intent 幂等；仅此 MD 写入口）
//! - [`batch`]：`apply_block_ops`（W4-F；dryRun 零写；仅 `plan_block_ops`）
//!
//! # 诚实边界
//! - Memory 测绿 **禁关**生产 A-AGT / EL-05
//! - **≠** 宣称 Store 后端完成；**≠** 第二套写锥

#[path = "note_memory_query.rs"]
mod query;
#[path = "note_memory_apply.rs"]
mod apply;
#[path = "note_memory_batch.rs"]
mod batch;

use crate::note_backend::NoteBackend;
use crate::note_md_parse::parse_heading_level_from_text;
use crate::note_plan_ops::{MemBlock, MemDoc};
use crate::note_types::{
    NoteApplyMdRequest, NoteApplyMdResult, NoteBackendError, NoteBatchTokens,
    NoteBlockBatchRequest, NoteBlockBatchResult, NoteOutline, NoteQueryBlocksParams,
    NoteQueryBlocksResult,
};
use async_trait::async_trait;
use serde_json::{Map, Value as JsonValue};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// 进程内笔记后端（dev/test + 可注入 ToolContext）
///
/// - `query_blocks` / `document_outline` / `get_md`：内存过滤 / 即时序列化
/// - `apply_md_fragment`：极简 MD 按行插段落 / 识别 ATX 标题；支持 intent 幂等
/// - batch token：内嵌 [`NoteBatchTokens`]
///
/// # 诚实边界
/// - Memory 测绿 **禁关**生产 A-AGT / EL-05
/// - **≠** 宣称 Store 后端完成
/// - **SD-28** · **≠ EL-05** · **≠ W6-E**
#[derive(Debug)]
pub struct MemoryNoteBackend {
    docs: Mutex<HashMap<String, MemDoc>>,
    /// intent_id → 首次 apply 结果（幂等）
    intents: Mutex<HashMap<String, NoteApplyMdResult>>,
    batch_tokens: NoteBatchTokens,
    id_seq: AtomicU64,
}

impl Default for MemoryNoteBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryNoteBackend {
    /// 空后端
    pub fn new() -> Self {
        Self {
            docs: Mutex::new(HashMap::new()),
            intents: Mutex::new(HashMap::new()),
            batch_tokens: NoteBatchTokens::new(),
            id_seq: AtomicU64::new(1),
        }
    }

    /// 自定义 batch TTL
    pub fn with_batch_ttl(ttl: Duration) -> Self {
        Self {
            docs: Mutex::new(HashMap::new()),
            intents: Mutex::new(HashMap::new()),
            batch_tokens: NoteBatchTokens::with_ttl(ttl),
            id_seq: AtomicU64::new(1),
        }
    }

    /// 预置文档块（测试夹具）
    pub fn seed_doc(&self, doc_id: &str, blocks: Vec<(String, String, String)>) {
        // (id, kind, text)
        let mut docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        let mem = docs.entry(doc_id.to_string()).or_default();
        for (id, kind, text) in blocks {
            let level = if kind == "heading" {
                parse_heading_level_from_text(&text).unwrap_or(1)
            } else {
                0
            };
            mem.blocks.push(MemBlock {
                id,
                kind,
                text,
                attrs: Map::new(),
                refs_to: Vec::new(),
                level,
            });
        }
    }

    /// 为块追加属性（测试）
    pub fn set_block_attrs(&self, doc_id: &str, block_id: &str, attrs: Map<String, JsonValue>) {
        let mut docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(doc) = docs.get_mut(doc_id) {
            if let Some(b) = doc.blocks.iter_mut().find(|b| b.id == block_id) {
                b.attrs = attrs;
            }
        }
    }

    /// 为块设置引用目标（测试：ref 过滤）
    pub fn set_block_refs(&self, doc_id: &str, block_id: &str, refs_to: Vec<String>) {
        let mut docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(doc) = docs.get_mut(doc_id) {
            if let Some(b) = doc.blocks.iter_mut().find(|b| b.id == block_id) {
                b.refs_to = refs_to;
            }
        }
    }

    /// 暴露 batch token 管理（测试 / 会话装配）
    pub fn batch_tokens(&self) -> &NoteBatchTokens {
        &self.batch_tokens
    }

    fn next_id(&self) -> String {
        let n = self.id_seq.fetch_add(1, Ordering::SeqCst);
        format!("mem-block-{n}")
    }

    fn ensure_doc<'a>(docs: &'a mut HashMap<String, MemDoc>, doc_id: &str) -> &'a mut MemDoc {
        docs.entry(doc_id.to_string()).or_default()
    }
}

#[async_trait]
impl NoteBackend for MemoryNoteBackend {
    async fn query_blocks(
        &self,
        params: NoteQueryBlocksParams,
    ) -> Result<NoteQueryBlocksResult, NoteBackendError> {
        self.run_query_blocks(params)
    }

    async fn document_outline(
        &self,
        doc_id: &str,
        max_depth: Option<u32>,
    ) -> Result<NoteOutline, NoteBackendError> {
        self.run_document_outline(doc_id, max_depth)
    }

    async fn get_md(&self, doc_id: &str) -> Result<String, NoteBackendError> {
        self.run_get_md(doc_id)
    }

    async fn apply_md_fragment(
        &self,
        req: NoteApplyMdRequest,
    ) -> Result<NoteApplyMdResult, NoteBackendError> {
        self.run_apply_md_fragment(req)
    }

    async fn validate_batch_token(&self, batch_id: Option<&str>) -> Result<(), NoteBackendError> {
        self.run_validate_batch_token(batch_id)
    }

    /// W4-F：块级批 ops；dryRun 零写；force_execution_unknown 中断不半写
    async fn apply_block_ops(
        &self,
        req: NoteBlockBatchRequest,
    ) -> Result<NoteBlockBatchResult, NoteBackendError> {
        self.run_apply_block_ops(req)
    }
}
