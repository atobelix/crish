//! 笔记后端契约（W4-A/B/F：NoteBackend trait + 引擎/测试注入）
//!
//! agent-tools 保持叶子依赖哲学：**不**硬依赖 `conex-doc-collab` /
//! `conex-workspace-store`。真实 store/DocSession 由引擎侧实现本 trait
//! 并经 [`crate::context::ToolContext::note_backend`] 注入；本 crate 仅定义
//! 契约、serde 线格式类型与进程内 [`MemoryNoteBackend`]（dev/test）。
//!
//! # SD-01 纵向切开 / **SD-23** 测旁挂 / **SD-47** 测按域拆
//! 本文件为 **薄 facade**：trait 默认实现 + 子模块 re-export。
//! - [`crate::note_types`]：请求/结果/错误/batch token
//! - [`crate::note_memory`]：MemoryNoteBackend
//! - [`crate::note_plan_ops`]：`plan_block_ops` / `apply_planned_ops`
//! - [`crate::note_md_parse`]：MD 行解析
//! - [`crate::note_backend_json`]：工具 JSON 辅助
//! - 集成测外置 `note_backend_tests.rs`（`#[path]`；**SD-47** 再拆 memory / w4；
//!   **≠ EL-05**；**≠ W6-E**；Memory 测绿 **禁关**生产）
//!
//! # 不变量
//! - 写路径经 `apply_md_fragment` / [`Self::apply_block_ops`]（事务化语义由
//!   实现方保证）；**禁止**工具侧 `fs.write` 后当笔记权威。
//! - 读路径即时 S(树)；**禁止**默认 disk mirror。
//! - `send_to_note` 幂等：同一 `intent_id` 不双插。
//! - batch token：会话内 `batch_id` 占用/释放；非法/过期拒绝写。
//! - **W4-A**：`NoteApplyMdResult.lossy` 进入工具 result（[`apply_result_json`]）；
//!   Store 路径须映射 `ApplyReport.lossy`；**禁止**默默丢弃。
//! - **W4-F**：`block_batch`（ops + dryRun）+ 细粒度 `block_insert` /
//!   `block_update` / `block_delete` / `block_move` 形状；dryRun **零写**权威树；
//!   写中断 → [`NoteBackendError::ExecutionUnknown`]。
//! - **W4-R**：细粒度 `block_set_attr` 默认委托 `apply_block_ops` 单 `SetAttr`。
//!
//! # 诚实边界
//! - **已交付方向**：读/写工具 + lossy（W4-A）+ batch token/审批方向（W4-B）
//!   + **W4-F**：`block_batch`+dryRun、细粒度 insert/update/delete/move、表驱动
//!   矩阵、`execution_unknown`（见 `note_action_matrix` / 工具）
//!   + **W4-R**：独立 `block_set_attr`（Memory 默认路径；**禁**把 Memory 绿写成生产满表）；
//!   Store 真路径见 `conex-note-runtime::StoreNoteBackend`
//! - **≠ EL-05**；**≠ A-AGT-01…08 满表关闭**（须 Store 持久 + **W6-E** 等）
//! - **≠ W6-E**：无千次批 + 恶意扩展闭环
//! - **≠ A-AGT 全表关闭**；Memory 测绿 **禁关**生产 A-AGT / EL-05
//! - **SD-01 不关 EL**；不宣称 Store 后端完成

use async_trait::async_trait;
use std::fmt::Debug;
use std::sync::Arc;

// ── SD-01：公开 API re-export（路径保持 `note_backend::*`）──────────

pub use crate::note_backend_json::{
    apply_result_json, backend_err_to_tool_err, block_batch_result_json,
};
pub use crate::note_memory::MemoryNoteBackend;
pub use crate::note_types::{
    NoteApplyMdRequest, NoteApplyMdResult, NoteApplyMode, NoteBackendError, NoteBatchTokens,
    NoteBlockBatchRequest, NoteBlockBatchResult, NoteBlockDeleteRequest, NoteBlockDeleteResult,
    NoteBlockInsertRequest, NoteBlockInsertResult, NoteBlockMoveRequest, NoteBlockMoveResult,
    NoteBlockOp, NoteBlockOpKind, NoteBlockOpPreview, NoteBlockSetAttrRequest,
    NoteBlockSetAttrResult, NoteBlockUpdateRequest, NoteBlockUpdateResult,
    NoteLossyItem, NoteLossyReport, NoteOutline, NoteOutlineNode, NoteQueryBlockHit,
    NoteQueryBlocksParams, NoteQueryBlocksResult, DEFAULT_BATCH_TOKEN_TTL,
};

// ==================== NoteBackend trait ====================

/// 笔记后端契约（dyn trait + 引擎/测试注入）
///
/// ToolContext 派生 Debug，trait 对象须可打印（对齐 CompressionContextStore）。
#[async_trait]
pub trait NoteBackend: Send + Sync + Debug {
    /// 组合查询块摘要
    async fn query_blocks(
        &self,
        params: NoteQueryBlocksParams,
    ) -> Result<NoteQueryBlocksResult, NoteBackendError>;

    /// 文档标题大纲
    async fn document_outline(
        &self,
        doc_id: &str,
        max_depth: Option<u32>,
    ) -> Result<NoteOutline, NoteBackendError>;

    /// 事务化 apply MD 片段（写路径唯一入口）
    async fn apply_md_fragment(
        &self,
        req: NoteApplyMdRequest,
    ) -> Result<NoteApplyMdResult, NoteBackendError>;

    /// 即时 S(树)：将当前权威块树序列化为 Conex-MD 全文（`document_get_md`）
    ///
    /// # 不变量
    /// - **禁止**读 disk mirror / exports 陈旧快照
    /// - 输出宜含块 ID 注释 `<!--c:…-->`（Memory 伪实现可用非 UUID id；
    ///   Store 走 `document_to_md` / UUID）
    /// - 文档不存在或空树 → `Ok("")`（非 NotFound，便于 Agent 探测）
    async fn get_md(&self, doc_id: &str) -> Result<String, NoteBackendError>;

    /// 可选 batch token 校验钩子（默认：无 batch_id 则放行；有则 Invalid——
    /// 生产实现可覆写；[`MemoryNoteBackend`] 走真实 [`NoteBatchTokens`]）
    async fn validate_batch_token(&self, batch_id: Option<&str>) -> Result<(), NoteBackendError> {
        match batch_id {
            None => Ok(()),
            Some(id) if id.trim().is_empty() => Err(NoteBackendError::BatchTokenInvalid(
                "batch_id must be non-empty".into(),
            )),
            Some(_) => Err(NoteBackendError::BatchTokenInvalid(
                "batch token validation not supported by this backend".into(),
            )),
        }
    }

    /// 批 apply 块 ops（W4-F · `block_batch`）
    ///
    /// # 契约
    /// - `dry_run=true`：**零写**权威树；返回将应用的 preview
    /// - 实写须原子（全有或全无）；失败/中断 **禁止半写**
    /// - `force_execution_unknown` 或实现方检测到中断 →
    ///   [`NoteBackendError::ExecutionUnknown`]（A-AGT-07 形状）
    ///
    /// 默认：未实现 → Invalid（Store 可后挂；Memory 真实现）。
    async fn apply_block_ops(
        &self,
        _req: NoteBlockBatchRequest,
    ) -> Result<NoteBlockBatchResult, NoteBackendError> {
        Err(NoteBackendError::Invalid(
            "apply_block_ops not supported by this backend".into(),
        ))
    }

    /// 细粒度插入一块（W4-F · `block_insert`；可委托 apply_block_ops）
    ///
    /// 默认：转单条 insert op 走 [`Self::apply_block_ops`]。
    async fn block_insert(
        &self,
        req: NoteBlockInsertRequest,
    ) -> Result<NoteBlockInsertResult, NoteBackendError> {
        let kind = req
            .kind
            .clone()
            .unwrap_or_else(|| "paragraph".to_string());
        let batch = self
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: req.doc_id,
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::Insert,
                    id: None,
                    parent_id: req.parent_id,
                    previous_id: req.previous_id,
                    content: Some(req.content),
                    kind: Some(kind.clone()),
                    attrs: None,
                }],
                dry_run: false,
                batch_id: req.batch_id,
                origin: req.origin,
                force_execution_unknown: false,
            })
            .await?;
        let block_id = batch
            .block_ids
            .into_iter()
            .next()
            .ok_or_else(|| {
                NoteBackendError::ApplyFailed("block_insert produced no block_id".into())
            })?;
        Ok(NoteBlockInsertResult { block_id, kind })
    }

    /// 细粒度更新块文本（W4-F · `block_update`；可委托 apply_block_ops）
    ///
    /// **≠ EL-05**；**≠ W6-E**。
    async fn block_update(
        &self,
        req: NoteBlockUpdateRequest,
    ) -> Result<NoteBlockUpdateResult, NoteBackendError> {
        let fallback_id = req.id.clone();
        let batch = self
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: req.doc_id,
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::Update,
                    id: Some(req.id),
                    parent_id: None,
                    previous_id: None,
                    content: Some(req.content),
                    kind: None,
                    attrs: None,
                }],
                dry_run: false,
                batch_id: req.batch_id,
                origin: req.origin,
                force_execution_unknown: false,
            })
            .await?;
        let id = batch
            .block_ids
            .into_iter()
            .next()
            .unwrap_or(fallback_id);
        Ok(NoteBlockUpdateResult { id })
    }

    /// 细粒度删除块（W4-F · `block_delete`；可委托 apply_block_ops）
    ///
    /// **≠ EL-05**；**≠ W6-E**。
    async fn block_delete(
        &self,
        req: NoteBlockDeleteRequest,
    ) -> Result<NoteBlockDeleteResult, NoteBackendError> {
        let fallback_id = req.id.clone();
        let batch = self
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: req.doc_id,
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::Delete,
                    id: Some(req.id),
                    parent_id: None,
                    previous_id: None,
                    content: None,
                    kind: None,
                    attrs: None,
                }],
                dry_run: false,
                batch_id: req.batch_id,
                origin: req.origin,
                force_execution_unknown: false,
            })
            .await?;
        let id = batch
            .block_ids
            .into_iter()
            .next()
            .unwrap_or(fallback_id);
        Ok(NoteBlockDeleteResult { id })
    }

    /// 细粒度移动/重排块（W4-F · `block_move`；可委托 apply_block_ops）
    ///
    /// **≠ EL-05**；**≠ W6-E**。
    async fn block_move(
        &self,
        req: NoteBlockMoveRequest,
    ) -> Result<NoteBlockMoveResult, NoteBackendError> {
        let fallback_id = req.id.clone();
        let batch = self
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: req.doc_id,
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::Move,
                    id: Some(req.id),
                    parent_id: req.parent_id,
                    previous_id: req.previous_id,
                    content: None,
                    kind: None,
                    attrs: None,
                }],
                dry_run: false,
                batch_id: req.batch_id,
                origin: req.origin,
                force_execution_unknown: false,
            })
            .await?;
        let id = batch
            .block_ids
            .into_iter()
            .next()
            .unwrap_or(fallback_id);
        Ok(NoteBlockMoveResult { id })
    }

    /// 细粒度设置块属性（W4-R · `block_set_attr`；可委托 apply_block_ops）
    ///
    /// **≠ EL-05**；**≠ W6-E**。Memory 绿 **禁关**生产 A-AGT。
    async fn block_set_attr(
        &self,
        req: NoteBlockSetAttrRequest,
    ) -> Result<NoteBlockSetAttrResult, NoteBackendError> {
        let fallback_id = req.id.clone();
        let batch = self
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: req.doc_id,
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::SetAttr,
                    id: Some(req.id),
                    parent_id: None,
                    previous_id: None,
                    content: None,
                    kind: None,
                    attrs: Some(req.attrs),
                }],
                dry_run: false,
                batch_id: req.batch_id,
                origin: req.origin,
                force_execution_unknown: false,
            })
            .await?;
        let id = batch
            .block_ids
            .into_iter()
            .next()
            .unwrap_or(fallback_id);
        Ok(NoteBlockSetAttrResult { id })
    }
}

/// Arc 包装助手
pub type NoteBackendHandle = Arc<dyn NoteBackend>;

// ── 测试（SD-23 外置；SD-47 按域拆 memory/w4；≠ EL-05；≠ W6-E）──

#[cfg(test)]
#[path = "note_backend_tests.rs"]
mod tests;
