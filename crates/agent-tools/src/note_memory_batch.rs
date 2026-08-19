//! Memory `apply_block_ops`（**SD-28** · W4-F 批写）
//!
//! **≠ EL-05**；**≠ W6-E**。dryRun 零写；提交仅 [`apply_planned_ops`]。
//! Memory 测绿 **禁关**生产；**≠** 第二套写锥。

use super::MemoryNoteBackend;
use crate::note_plan_ops::{apply_planned_ops, plan_block_ops};
use crate::note_types::{
    NoteBackendError, NoteBlockBatchRequest, NoteBlockBatchResult, NoteBlockOpPreview,
};
use crate::poison::POISON_RECOVERIES;
use std::sync::atomic::Ordering;

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
            let docs = self.docs.lock().unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-3 观测化）
                tracing::error!("MemoryNoteBackend docs 锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            });
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
            let mut docs = self.docs.lock().unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-3 观测化）
                tracing::error!("MemoryNoteBackend docs 锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            });
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

#[cfg(test)]
mod tests {
    use super::super::capture::with_capture;
    use super::*;
    use crate::poison::{poison_recovery_count, poison_test_guard};

    /// B1-3 毒化测：docs 锁中毒后 apply_block_ops 正常返回 + error 日志
    /// 出现 + 毒丸恢复计数 +2（三要素）。
    ///
    /// +2 依据：docs 锁在同一次调用内被取两次——规划（:44）与提交（:64）
    /// 各自经恢复分支，每次 +1。
    #[test]
    fn poisoned_docs_lock_batch_recovers_with_log_and_count() {
        let _serial = poison_test_guard();
        let backend = MemoryNoteBackend::new();
        let before = poison_recovery_count();
        crate::test_support::poison_std_lock(&backend.docs);
        let (result, lines) = with_capture(|| {
            backend.run_apply_block_ops(NoteBlockBatchRequest {
                doc_id: "d".into(),
                ops: vec![],
                dry_run: false,
                batch_id: None,
                origin: None,
                force_execution_unknown: false,
            })
        });
        let result = result.unwrap();
        assert_eq!(result.applied, 0, "毒化后批写语义不变（恢复模式）");
        assert!(
            lines.iter().any(|l| l.contains("锁中毒")),
            "缺少锁中毒 error 日志，捕获：\n{}",
            lines.join("\n")
        );
        assert_eq!(
            poison_recovery_count(),
            before + 2,
            "docs 锁两处恢复各计数 +1"
        );
    }
}
