//! hydrate 路径（SR-06g · 拆分 · ≠ EL）：load_doc blob → 重建树 + 冷文本登记（G-HYD-2）。
//!
//! - [`DocSession::hydrate`]：公开构造入口（空 blob = 新文档合法）
//! - [`DocSession::ingest_hydrate_blob`]：snapshot + pending 两路结构解码
//!
//! 由父模 [`crate::session`] 以私有 `mod` 接线（无孤儿）。拆分只切不修，语义零改动。
use super::*;
use crate::persistence::{HydrateBlob, UpdateKind};
use crate::structure_codec::{
    decode_structure_from_snapshot, decode_structure_payload, is_structure_payload,
    StructureCodecError,
};
use crate::text_engine::TextEngine;

impl DocSession {
    /// 从 `PersistencePlugin::load_doc` 的 blob 重建会话（G-HYD-2）。
    ///
    /// 成功不变量：树无环语义由载荷保证；各叶 `text_snapshot` 登记为冷文本；
    /// `rev` 取自最后一帧结构 snapshot。空 blob → 空会话（新文档合法）。
    ///
    /// 载荷不可解码 → [`HydrateError::Corrupt`]，**禁止**静默 `new` 空树当成功。
    pub fn hydrate(doc_id: impl Into<String>, blob: HydrateBlob) -> Result<Self, HydrateError> {
        let mut session = Self::new(doc_id);
        session.ingest_hydrate_blob(blob)?;
        Ok(session)
    }

    /// 消费 hydrate blob（可在已有 session 上替换权威态；通常仅 `hydrate` 构造路径调用）。
    fn ingest_hydrate_blob(&mut self, blob: HydrateBlob) -> Result<(), HydrateError> {
        let has_snap = blob.snapshot.as_ref().is_some_and(|s| !s.is_empty());
        let has_pending = !blob.pending.is_empty();
        if !has_snap && !has_pending {
            return Ok(());
        }

        let mut tree = BlockTree::default();
        let mut rev = 0u64;
        let mut got_structure = false;

        if let Some(snap) = &blob.snapshot {
            if !snap.is_empty() {
                match decode_structure_from_snapshot(snap) {
                    Ok(s) => {
                        rev = s.rev;
                        tree = s.tree;
                        got_structure = true;
                    }
                    Err(StructureCodecError::Empty) if has_pending => {
                        // snapshot 帧无结构（仅历史文本帧）→ 交给 pending
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        }

        for u in &blob.pending {
            match u.kind {
                UpdateKind::Structure | UpdateKind::Combined => {
                    if !is_structure_payload(&u.bytes) {
                        return Err(HydrateError::Corrupt(
                            "pending structure bytes are not CDCS payload".into(),
                        ));
                    }
                    let s = decode_structure_payload(&u.bytes)?;
                    rev = s.rev;
                    tree = s.tree;
                    got_structure = true;
                }
                UpdateKind::Text => {
                    // 文本权威以结构内 text_snapshot 为准；yrs pending 不强制热合入
                    // （A-MEM-02 冷可读；热集按需 rehydrate）
                }
            }
        }

        if !got_structure {
            return Err(HydrateError::Corrupt(
                "hydrate blob has data but no recoverable structure snapshot".into(),
            ));
        }

        self.tree = tree;
        self.rev = rev;
        // 按节点 text_snapshot 登记 TextEngine 冷文本（不强制全热，G-HYD-2 / A-MEM-02）
        self.text_engine = TextEngine::with_max_hot(self.text_engine.max_hot());
        for (id, node) in &self.tree.nodes {
            let text = node.text_snapshot.clone().unwrap_or_default();
            self.text_engine.init_block_with_text(*id, text);
        }
        // hydrate 重建权威后清空内存 undo（跨进程无栈；进程内冷边界 undo 见 W1-U 热集测）
        self.undo_stack.clear();
        Ok(())
    }
}
