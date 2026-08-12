//! Memory `apply_md_fragment`（**SD-28** · 唯一 MD 写入口）
//!
//! **≠ EL-05**；**≠ W6-E**；Memory 测绿 **禁关**生产。
//! 不另开写锥：块级 ops 仍走 `apply_block_ops` → `plan_block_ops`。

use super::MemoryNoteBackend;
use crate::note_md_parse::parse_md_lines;
use crate::note_plan_ops::MemBlock;
use crate::note_types::{
    NoteApplyMdRequest, NoteApplyMdResult, NoteApplyMode, NoteBackendError, NoteLossyReport,
};
use serde_json::Map;

impl MemoryNoteBackend {
    /// MD 片段写入（intent 幂等；append_to_block / 定位插入）
    pub(super) fn run_apply_md_fragment(
        &self,
        req: NoteApplyMdRequest,
    ) -> Result<NoteApplyMdResult, NoteBackendError> {
        if req.doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }

        // batch token 可选校验
        self.run_validate_batch_token(req.batch_id.as_deref())?;

        // 幂等：同 intent_id 返回首次结果
        if let Some(ref intent) = req.intent_id {
            if intent.trim().is_empty() {
                return Err(NoteBackendError::Invalid(
                    "intent_id must be non-empty when provided".into(),
                ));
            }
            let intents = self.intents.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(prev) = intents.get(intent) {
                let mut out = prev.clone();
                out.idempotent = true;
                out.inserted = 0;
                return Ok(out);
            }
        }

        let drafts = parse_md_lines(&req.markdown);

        let mut docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        let doc = Self::ensure_doc(&mut docs, &req.doc_id);

        // append_to_block：把 markdown 追加到 after_block_id 或末块
        if req.mode == NoteApplyMode::AppendToBlock {
            let target_id = req
                .after_block_id
                .clone()
                .or_else(|| doc.blocks.last().map(|b| b.id.clone()));
            let Some(tid) = target_id else {
                return Err(NoteBackendError::NotFound(
                    "append_to_block: no target block".into(),
                ));
            };
            let block = doc.blocks.iter_mut().find(|b| b.id == tid).ok_or_else(|| {
                NoteBackendError::NotFound(format!("block not found: {tid}"))
            })?;
            if !block.text.is_empty() && !req.markdown.is_empty() {
                block.text.push('\n');
            }
            block.text.push_str(req.markdown.trim_end());
            let result = NoteApplyMdResult {
                block_ids: vec![tid],
                inserted: 0,
                idempotent: false,
                // Memory 不走真实 P：无 lossy 透出（Store 路径才有 W4-A 真 lossy）
                lossy: NoteLossyReport::default(),
            };
            drop(docs);
            if let Some(ref intent) = req.intent_id {
                let mut intents = self.intents.lock().unwrap_or_else(|e| e.into_inner());
                intents.insert(intent.clone(), result.clone());
            }
            return Ok(result);
        }

        // after_block_id 定位插入点
        let mut insert_at = doc.blocks.len();
        if let Some(ref after) = req.after_block_id {
            match doc.blocks.iter().position(|b| b.id == *after) {
                Some(i) => insert_at = i + 1,
                None => {
                    return Err(NoteBackendError::NotFound(format!(
                        "after_block_id not found: {after}"
                    )));
                }
            }
        }

        // parent_id：Memory 后端仅作存在性校验（扁平列表，不建父子边）
        if let Some(ref parent) = req.parent_id {
            if !doc.blocks.iter().any(|b| b.id == *parent) {
                // 允许 parent 为虚拟根：不存在时若文档非空则报错；空文档放行
                if !doc.blocks.is_empty() {
                    return Err(NoteBackendError::NotFound(format!(
                        "parent_id not found: {parent}"
                    )));
                }
            }
        }

        let mut block_ids = Vec::with_capacity(drafts.len());
        let mut new_blocks = Vec::with_capacity(drafts.len());
        for (kind, text, level) in drafts {
            let id = self.next_id();
            // id 冲突保护（极低概率）
            if doc.blocks.iter().any(|b| b.id == id)
                || new_blocks.iter().any(|b: &MemBlock| b.id == id)
            {
                return Err(NoteBackendError::IdConflict(format!(
                    "block id conflict: {id}"
                )));
            }
            block_ids.push(id.clone());
            new_blocks.push(MemBlock {
                id,
                kind,
                text,
                attrs: Map::new(),
                refs_to: Vec::new(),
                level,
            });
        }

        let inserted = new_blocks.len() as u32;
        for (offset, block) in new_blocks.into_iter().enumerate() {
            doc.blocks.insert(insert_at + offset, block);
        }

        let result = NoteApplyMdResult {
            block_ids,
            inserted,
            idempotent: false,
            // Memory 行解析伪实现：不产生 md-ast LossyReport（≠ Store 真路径）
            lossy: NoteLossyReport::default(),
        };

        drop(docs);
        if let Some(ref intent) = req.intent_id {
            let mut intents = self.intents.lock().unwrap_or_else(|e| e.into_inner());
            intents.insert(intent.clone(), result.clone());
        }
        Ok(result)
    }
}
