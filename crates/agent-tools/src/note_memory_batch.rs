//! Memory `apply_block_ops`（**SD-28** · W4-F 批写）
//!
//! **≠ EL-05**；**≠ W6-E**。dryRun 零写；提交仅 [`apply_planned_ops`]。
//! Memory 测绿 **禁关**生产；**≠** 第二套写锥。

use super::MemoryNoteBackend;
use crate::note_plan_ops::{apply_planned_ops, plan_block_ops};
use crate::note_types::{
    NoteBackendError, NoteBlockBatchRequest, NoteBlockBatchResult, NoteBlockOpPreview,
};

impl MemoryNoteBackend {
    /// 可选 batch token 校验（无 id 放行；有则走内嵌 [`NoteBatchTokens`]）
    pub(super) fn run_validate_batch_token(
        &self,
        batch_id: Option<&str>,
    ) -> Result<(), NoteBackendError> {
        match batch_id {
            None => Ok(()),
            Some(id) => self.batch_tokens.validate(id),
        }
    }

    /// W4-F：块级批 ops；dryRun 零写；force_execution_unknown 中断不半写
    pub(super) fn run_apply_block_ops(
        &self,
        req: NoteBlockBatchRequest,
    ) -> Result<NoteBlockBatchResult, NoteBackendError> {
        if req.doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        self.run_validate_batch_token(req.batch_id.as_deref())?;

        // A-AGT-07：写中断协议——在任何变异前失败，保证零半写
        if req.force_execution_unknown && !req.dry_run {
            return Err(NoteBackendError::ExecutionUnknown(
                "write interrupted before commit; execution state unknown — do not auto-retry write"
                    .into(),
            ));
        }

        // 在锁外规划（仅读当前树做校验）；成功后再一次提交
        let plan = {
            let docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
            let existing = docs.get(&req.doc_id).map(|d| d.blocks.as_slice());
            plan_block_ops(existing, &req.ops, || self.next_id())?
        };

        let preview: Vec<NoteBlockOpPreview> = plan.previews.iter().cloned().collect();
        let block_ids = plan.block_ids.clone();
        let applied = plan.previews.len() as u32;

        if req.dry_run {
            return Ok(NoteBlockBatchResult {
                dry_run: true,
                applied,
                block_ids,
                preview,
            });
        }

        // 原子提交：整批写入（Memory 扁平列表；≠ Store 真事务，仅测形状）
        {
            let mut docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
            let doc = Self::ensure_doc(&mut docs, &req.doc_id);
            apply_planned_ops(doc, plan.mutations)?;
        }

        Ok(NoteBlockBatchResult {
            dry_run: false,
            applied,
            block_ids,
            preview,
        })
    }
}
