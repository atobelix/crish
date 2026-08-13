//! undo + 远端文本合入（SR-06g · 拆分 · ≠ EL）：非 apply 主路径的两条写锥。
//!
//! - [`DocSession::undo`]：W1-U 撤销栈顶一步（rev 单调 +1，同源 commit 面）
//! - [`DocSession::apply_remote_text_update`]：远端文本 update 合入（A-MEM-03）
//!
//! 由父模 [`crate::session`] 以私有 `mod` 接线（无孤儿）；经 [`super::emit_commit`] /
//! [`super::capture_memory_snapshot`] 复用门面统一 commit 面。拆分只切不修，
//! **未**预置 CT-01 CAS 逻辑。
use super::*;
use crate::events::{BlockUpsert, DocEvent, ProjectionDiff};
use crate::op::Origin;
use crate::tx::{TxGuard, TxId};

impl DocSession {
    /// 远端文本 update 合入指定块（冷块先 rehydrate，A-MEM-03）。
    ///
    /// 写锥：成功后与 `apply` **同源** `on_committed`（结构可逆 snapshot + Text 字节），
    /// 禁止静默涨 rev 不落盘（A-INV-01 / W1-A）。
    ///
    /// **P-H2**：`on_committed` 失败 → 树/文本/rev/last_tx 回滚到合入前（方案 A 快照）。
    pub fn apply_remote_text_update(
        &mut self,
        id: BlockId,
        bytes: &[u8],
    ) -> Result<(), ApplyError> {
        if !self.tree.nodes.contains_key(&id) {
            return Err(ApplyError::NotFound(id.to_string()));
        }
        // P-H2：突变前快照
        let pre = self.capture_memory_snapshot();
        match self.apply_remote_text_update_inner(id, bytes) {
            Ok(()) => Ok(()),
            Err(e) => {
                self.restore_memory_snapshot(pre);
                Err(e)
            }
        }
    }

    fn apply_remote_text_update_inner(
        &mut self,
        id: BlockId,
        bytes: &[u8],
    ) -> Result<(), ApplyError> {
        let new_text = self.text_engine.apply_remote_update(id, bytes)?;
        if let Some(n) = self.tree.nodes.get_mut(&id) {
            n.text_snapshot = Some(new_text);
        }
        self.rev += 1;
        let rev = self.rev;
        let tx_id = TxId::new();
        self.last_tx_id = Some(tx_id);
        self.last_text_updates = vec![TextUpdatePayload {
            block_id: id,
            bytes: bytes.to_vec(),
        }];

        // 统一 commit 面：结构可逆 + 文本 update
        self.emit_commit(
            Origin::Remote,
            tx_id,
            rev,
            &[TextUpdatePayload {
                block_id: id,
                bytes: bytes.to_vec(),
            }],
        )?;
        Ok(())
    }
    /// Undo v1：撤销栈顶一步（一次 apply 批）。
    ///
    /// - `filter = None`：撤栈顶（无论 User/Agent）
    /// - `filter = Some(o)`：仅当栈顶 origin == o 时撤，否则 [`UndoError::OriginMismatch`]
    ///   （A-COL-04：可按 origin 过滤，不误撤）
    /// - 恢复结构 + 文本 plain 权威；**rev 单调 +1** 并走同源 `on_committed`
    /// - 跨热集冷藏：结构正确；文本以栈内 plain 快照为准（细粒度 yrs 史允许截断，A-MEM-04）
    /// - 删块步被撤 → 块与文本按快照恢复（A-INV-09c 后半）
    /// - `on_committed` 失败 → 内存态与栈深度回滚到 undo 前（P-H2 同向）
    ///
    /// **redo 本波未交付**。
    pub fn undo(&mut self, filter: Option<Origin>) -> Result<DocEvent, UndoError> {
        let top = self.undo_stack.last().ok_or(UndoError::Empty)?;
        if let Some(expected) = filter {
            if top.origin != expected {
                return Err(UndoError::OriginMismatch {
                    expected,
                    actual: top.origin,
                });
            }
        }
        let entry = self
            .undo_stack
            .pop()
            .expect("undo_stack 非空（已 last 检查）");

        // persist 失败时回滚到 undo 前内存态，并把 entry 压回栈
        let pre_undo = self.capture_memory_snapshot();
        let rev_before = self.rev;

        // 恢复树与文本 plain；不回退 rev 历史值（协同单调）
        self.tree = entry.pre.tree.clone();
        self.text_engine.restore(entry.pre.text.clone());
        self.rev = rev_before.saturating_add(1);
        let rev = self.rev;

        let tx = TxGuard::begin();
        let tx_id = tx.id();
        self.last_tx_id = Some(tx_id);
        self.last_text_updates = Vec::new();

        // 结构 snapshot 已含 text_snapshot；文本 update 可空
        if let Err(e) = self.emit_commit(Origin::System, tx_id, rev, &[]) {
            self.restore_memory_snapshot(pre_undo);
            self.undo_stack.push(entry);
            return Err(UndoError::Persist(e.to_string()));
        }
        tx.commit();

        let upserts: Vec<BlockUpsert> = self.tree.nodes.values().map(block_to_upsert).collect();
        let text_touches: Vec<BlockId> = upserts.iter().map(|u| u.id).collect();

        Ok(DocEvent::Projection {
            diff: ProjectionDiff {
                doc_id: self.doc_id.clone(),
                rev,
                upserts,
                removes: vec![],
                text_touches,
                full_rebuild: true,
            },
        })
    }
}
