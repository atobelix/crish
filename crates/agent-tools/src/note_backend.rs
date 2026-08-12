//! 笔记后端契约（W4-A/B/F：NoteBackend trait + 引擎/测试注入）
//!
//! agent-tools 保持叶子依赖哲学：**不**硬依赖 `conex-doc-collab` /
//! `conex-workspace-store`。真实 store/DocSession 由引擎侧实现本 trait
//! 并经 [`crate::context::ToolContext::note_backend`] 注入；本 crate 仅定义
//! 契约、serde 线格式类型与进程内 [`MemoryNoteBackend`]（dev/test）。
//!
//! # SD-01 纵向切开
//! 本文件为 **薄 facade**：trait 默认实现 + 子模块 re-export。
//! - [`crate::note_types`]：请求/结果/错误/batch token
//! - [`crate::note_memory`]：MemoryNoteBackend
//! - [`crate::note_plan_ops`]：`plan_block_ops` / `apply_planned_ops`
//! - [`crate::note_md_parse`]：MD 行解析
//! - [`crate::note_backend_json`]：工具 JSON 辅助
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
//!
//! # 诚实边界
//! - **已交付方向**：读/写工具 + lossy（W4-A）+ batch token/审批方向（W4-B）
//!   + **W4-F**：`block_batch`+dryRun、细粒度 insert/update/delete/move、表驱动
//!   矩阵、`execution_unknown`（见 `note_action_matrix` / 工具）；
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
    NoteBlockOp, NoteBlockOpKind, NoteBlockOpPreview, NoteBlockUpdateRequest, NoteBlockUpdateResult,
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
}

/// Arc 包装助手
pub type NoteBackendHandle = Arc<dyn NoteBackend>;

// ==================== 集成测（公开 API 面；plan 单测见 note_plan_ops）====================

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn memory_query_and_apply_outline() {
        let backend = MemoryNoteBackend::new();
        backend.seed_doc(
            "doc-1",
            vec![
                ("h1".into(), "heading".into(), "Title".into()),
                ("p1".into(), "paragraph".into(), "hello world".into()),
            ],
        );

        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-1".into(),
                text_match: Some("hello".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1);
        assert_eq!(q.blocks[0].id, "p1");

        let applied = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-1".into(),
                markdown: "## Section\nbody line".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: Some("intent-1".into()),
                batch_id: None,
                message_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();
        assert_eq!(applied.inserted, 2);
        assert!(!applied.idempotent);

        // 幂等
        let again = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-1".into(),
                markdown: "## Section\nbody line".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: Some("intent-1".into()),
                batch_id: None,
                message_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();
        assert!(again.idempotent);
        assert_eq!(again.inserted, 0);
        assert_eq!(again.block_ids, applied.block_ids);

        let outline = backend.document_outline("doc-1", Some(6)).await.unwrap();
        assert!(
            outline.outline.iter().any(|n| n.title == "Title")
                || outline
                    .outline
                    .iter()
                    .any(|n| n.children.iter().any(|c| c.title == "Section")
                        || n.title == "Section"),
            "outline should contain headings: {:?}",
            outline
        );
    }

    #[test]
    fn batch_tokens_acquire_validate_release_expire() {
        let tokens = NoteBatchTokens::with_ttl(Duration::from_millis(50));
        assert!(tokens.validate("b1").is_err());
        tokens.acquire("b1").unwrap();
        tokens.validate("b1").unwrap();
        tokens.release("b1");
        assert!(matches!(
            tokens.validate("b1"),
            Err(NoteBackendError::BatchTokenInvalid(_))
        ));

        tokens.acquire("b2").unwrap();
        std::thread::sleep(Duration::from_millis(80));
        assert!(matches!(
            tokens.validate("b2"),
            Err(NoteBackendError::BatchTokenExpired(_))
        ));
    }

    #[tokio::test]
    async fn memory_apply_requires_valid_batch_when_provided() {
        let backend = MemoryNoteBackend::new();
        let err = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "d".into(),
                markdown: "x".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: Some("missing".into()),
                message_id: None,
                origin: None,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, NoteBackendError::BatchTokenInvalid(_)));

        backend.batch_tokens().acquire("ok-batch").unwrap();
        let r = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "d".into(),
                markdown: "line".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: Some("ok-batch".into()),
                message_id: None,
                origin: None,
            })
            .await
            .unwrap();
        assert_eq!(r.inserted, 1);
    }

    /// W4-A：工具 result JSON 必须含 `lossy.items`（可观测；空数组亦合法）。
    /// **≠ EL-05**；仅证形状，不关 A-AGT。
    #[test]
    fn apply_result_json_exposes_lossy_items() {
        let result = NoteApplyMdResult {
            block_ids: vec!["b1".into()],
            inserted: 1,
            idempotent: false,
            lossy: NoteLossyReport {
                items: vec![NoteLossyItem {
                    code: "missing_block_id".into(),
                    detail: "paragraph without <!--c:UUID-->".into(),
                    line: Some(1),
                }],
            },
        };
        let j = apply_result_json(&result);
        assert_eq!(j["ok"], true);
        assert_eq!(j["inserted"], 1);
        assert_eq!(j["block_ids"][0], "b1");
        let items = j["lossy"]["items"]
            .as_array()
            .expect("lossy.items must be array");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["code"], "missing_block_id");
        assert_eq!(items[0]["line"], 1);
        assert!(
            items[0]["detail"]
                .as_str()
                .unwrap_or("")
                .contains("paragraph"),
            "detail should be human-readable"
        );
    }

    /// W4-A：空 lossy 亦进入结果面（items=[]），禁止缺字段冒充「未定义」。
    #[test]
    fn apply_result_json_empty_lossy_still_present() {
        let result = NoteApplyMdResult {
            block_ids: vec![],
            inserted: 0,
            idempotent: false,
            lossy: NoteLossyReport::default(),
        };
        let j = apply_result_json(&result);
        assert!(j.get("lossy").is_some(), "lossy key required");
        assert!(
            j["lossy"]["items"].as_array().unwrap().is_empty(),
            "empty items when no lossy"
        );
    }

    #[tokio::test]
    async fn memory_get_md_after_apply_contains_content_and_c_comment() {
        let backend = MemoryNoteBackend::new();
        backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-md".into(),
                markdown: "# Hello GetMd\n\nbody of get_md test".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: None,
                message_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();

        let md = backend.get_md("doc-md").await.unwrap();
        assert!(
            md.contains("Hello GetMd") || md.contains("body of get_md"),
            "get_md must contain applied text, got: {md:?}"
        );
        assert!(
            md.contains("<!--c:"),
            "get_md should emit block id comments, got: {md:?}"
        );
        // 空 doc_id 非法
        let err = backend.get_md("").await.unwrap_err();
        assert!(matches!(err, NoteBackendError::Invalid(_)));
        // 未知文档 → 空串（非 mirror）
        assert_eq!(backend.get_md("ghost").await.unwrap(), "");
    }

    // ── W4-F：block_batch / dryRun / execution_unknown（Memory 形状）──

    /// A-AGT-05 形状：dryRun=true 零写权威树，返回 preview
    #[tokio::test]
    async fn w4f_memory_block_batch_dry_run_zero_write() {
        let backend = MemoryNoteBackend::new();
        backend.seed_doc(
            "doc-b",
            vec![("p1".into(), "paragraph".into(), "keep".into())],
        );
        let r = backend
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: "doc-b".into(),
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::Insert,
                    id: None,
                    parent_id: None,
                    previous_id: Some("p1".into()),
                    content: Some("new line".into()),
                    kind: Some("paragraph".into()),
                    attrs: None,
                }],
                dry_run: true,
                batch_id: None,
                origin: Some("agent".into()),
                force_execution_unknown: false,
            })
            .await
            .unwrap();
        assert!(r.dry_run);
        assert_eq!(r.applied, 1);
        assert!(!r.preview.is_empty());
        // 权威树未变
        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-b".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1);
        assert_eq!(q.blocks[0].id, "p1");
    }

    /// 实写 insert 进树
    #[tokio::test]
    async fn w4f_memory_block_batch_apply_insert() {
        let backend = MemoryNoteBackend::new();
        let r = backend
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: "doc-w".into(),
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::Insert,
                    id: None,
                    parent_id: None,
                    previous_id: None,
                    content: Some("hello batch".into()),
                    kind: Some("paragraph".into()),
                    attrs: None,
                }],
                dry_run: false,
                batch_id: None,
                origin: Some("agent".into()),
                force_execution_unknown: false,
            })
            .await
            .unwrap();
        assert!(!r.dry_run);
        assert_eq!(r.applied, 1);
        assert_eq!(r.block_ids.len(), 1);
        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-w".into(),
                text_match: Some("hello batch".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1);
    }

    /// A-AGT-07：execution_unknown 中断 → 可识别码 + 零半写
    #[tokio::test]
    async fn w4f_memory_block_batch_execution_unknown_no_half_write() {
        let backend = MemoryNoteBackend::new();
        backend.seed_doc(
            "doc-x",
            vec![("p1".into(), "paragraph".into(), "only".into())],
        );
        let err = backend
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: "doc-x".into(),
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::Insert,
                    id: None,
                    parent_id: None,
                    previous_id: None,
                    content: Some("must not land".into()),
                    kind: None,
                    attrs: None,
                }],
                dry_run: false,
                batch_id: None,
                origin: Some("agent".into()),
                force_execution_unknown: true,
            })
            .await
            .unwrap_err();
        assert_eq!(err.code(), "note.execution_unknown");
        assert!(matches!(err, NoteBackendError::ExecutionUnknown(_)));
        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-x".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1, "中断不得半写");
        assert_eq!(q.blocks[0].id, "p1");
    }

    /// 细粒度 block_insert 默认路径
    #[tokio::test]
    async fn w4f_memory_block_insert() {
        let backend = MemoryNoteBackend::new();
        let r = backend
            .block_insert(NoteBlockInsertRequest {
                doc_id: "doc-i".into(),
                content: "inserted".into(),
                parent_id: None,
                previous_id: None,
                kind: Some("paragraph".into()),
                batch_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();
        assert!(!r.block_id.is_empty());
        assert_eq!(r.kind, "paragraph");
    }

    /// 细粒度 block_move：b1 移到 b2 之后（Memory）
    #[tokio::test]
    async fn w4f_memory_block_move_reorders() {
        let backend = MemoryNoteBackend::new();
        backend.seed_doc(
            "doc-mv",
            vec![
                ("b1".into(), "paragraph".into(), "one".into()),
                ("b2".into(), "paragraph".into(), "two".into()),
                ("b3".into(), "paragraph".into(), "three".into()),
            ],
        );
        let r = backend
            .block_move(NoteBlockMoveRequest {
                doc_id: "doc-mv".into(),
                id: "b1".into(),
                previous_id: Some("b2".into()),
                parent_id: None,
                batch_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();
        assert_eq!(r.id, "b1");
        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-mv".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        let ids: Vec<&str> = q.blocks.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, vec!["b2", "b1", "b3"]);
    }

    #[test]
    fn w4f_block_batch_result_json_shape() {
        let r = NoteBlockBatchResult {
            dry_run: true,
            applied: 1,
            block_ids: vec!["b1".into()],
            preview: vec![NoteBlockOpPreview {
                op: "insert".into(),
                id: Some("b1".into()),
                kind: Some("paragraph".into()),
                summary: Some("x".into()),
            }],
        };
        let j = block_batch_result_json(&r);
        assert_eq!(j["ok"], true);
        assert_eq!(j["dry_run"], true);
        assert_eq!(j["dryRun"], true);
        assert_eq!(j["applied"], 1);
        assert_eq!(j["preview"][0]["op"], "insert");
    }

    #[test]
    fn w4f_backend_err_execution_unknown_maps_stable_code() {
        let e = backend_err_to_tool_err(
            "block_batch",
            NoteBackendError::ExecutionUnknown("interrupted".into()),
        );
        assert_eq!(e.code(), "note.execution_unknown");
    }
}
