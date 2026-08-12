//! W1-F / **W6-D-S**：双 [`DocSession`] in-process 互推 harness（A-COL-01 子集骨架）。
//!
//! **诚实**：本 harness 绿 ≠ **W6-D** Strict / ≠ **EL-04**；包锚见 [`crate::w6_d_s`]。
//!
//! # 语义说明
//! - **结构路径（保留）**：[`SimplifiedEncodedOps`] — op 日志 JSON 重放；既有测保持绿。
//! - **文本路径（W1-F 增强）**：从 [`DocSession::last_commit_text_updates`] 取 yrs
//!   update 字节，经 [`DocSession::apply_remote_text_update`] 推到对端（**不**外泄 yrs 类型）。
//!
//! 结构侧仍无真 CRDT encode；文本侧已走真实 yrs state update。
//! 不依赖网络：两 peer 同进程内存互推。

use crate::block_id::BlockId;
use crate::events::DocEvent;
use crate::op::{Op, Origin};
use crate::session::{ApplyError, DocSession, TextUpdatePayload};
use std::collections::HashSet;

/// 简化编码的 op 列表（JSON）。
///
/// # W1-B 迁移
/// 换成 `EncodedUpdate` / CRDT update 二进制后，本类型可删除或仅保留测试兼容层。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimplifiedEncodedOps {
    /// `serde_json` 序列化的 `Vec<Op>`
    pub bytes: Vec<u8>,
}

impl SimplifiedEncodedOps {
    /// 将 ops 编码为简化字节（op 日志重放载荷）。
    pub fn encode(ops: &[Op]) -> Result<Self, serde_json::Error> {
        Ok(Self {
            bytes: serde_json::to_vec(ops)?,
        })
    }

    /// 解码为 op 列表。
    pub fn decode(&self) -> Result<Vec<Op>, serde_json::Error> {
        serde_json::from_slice(&self.bytes)
    }
}

/// 双 peer 侧别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerSide {
    A,
    B,
}

impl PeerSide {
    /// 对端。
    pub fn other(self) -> Self {
        match self {
            PeerSide::A => PeerSide::B,
            PeerSide::B => PeerSide::A,
        }
    }
}

/// 双 [`DocSession`] in-process 互推环境（无网络）。
///
/// 用于 A-COL-01 骨架验收：一端写、推简化 encoded ops、对端树收敛到同 id 结构。
pub struct DualSessionHarness {
    pub peer_a: DocSession,
    pub peer_b: DocSession,
}

impl DualSessionHarness {
    /// 两侧共享同一 `doc_id`（协同同一文档的两个副本）。
    pub fn new(doc_id: impl Into<String>) -> Self {
        let id = doc_id.into();
        Self {
            peer_a: DocSession::new(id.clone()),
            peer_b: DocSession::new(id),
        }
    }

    /// 取只读会话。
    pub fn session(&self, side: PeerSide) -> &DocSession {
        match side {
            PeerSide::A => &self.peer_a,
            PeerSide::B => &self.peer_b,
        }
    }

    /// 取可变会话。
    pub fn session_mut(&mut self, side: PeerSide) -> &mut DocSession {
        match side {
            PeerSide::A => &mut self.peer_a,
            PeerSide::B => &mut self.peer_b,
        }
    }

    /// 在指定 peer 上 `apply`，并返回可推送给对端的简化编码 ops。
    ///
    /// 编码失败映射为 [`ApplyError::Schema`]（骨架阶段不引入独立 harness 错误类型）。
    pub fn apply(
        &mut self,
        side: PeerSide,
        origin: Origin,
        ops: &[Op],
    ) -> Result<(DocEvent, SimplifiedEncodedOps), ApplyError> {
        let event = self.session_mut(side).apply(origin, ops)?;
        let encoded = SimplifiedEncodedOps::encode(ops)
            .map_err(|e| ApplyError::Schema(format!("encode ops: {e}")))?;
        Ok((event, encoded))
    }

    /// 将简化编码 ops 应用到目标 peer（**op 日志重放**；W1-B 后换 update 二进制）。
    ///
    /// 远端以 [`Origin::Remote`] 写入（origin 标签进 batch）。
    /// `Remote` 不入 undo 栈；按 origin 过滤见 [`crate::DocSession::undo`]（A-COL-04）。
    pub fn push(
        &mut self,
        to: PeerSide,
        encoded: &SimplifiedEncodedOps,
    ) -> Result<DocEvent, ApplyError> {
        let ops = encoded
            .decode()
            .map_err(|e| ApplyError::Schema(format!("decode ops: {e}")))?;
        self.session_mut(to).apply(Origin::Remote, &ops)
    }

    /// 本侧 apply 后立刻推到对端（A→B 或 B→A 的便捷路径）。
    ///
    /// **仅**结构 op 日志重放；文本细粒度请用 [`Self::push_text_updates`] /
    /// [`Self::apply_text_and_push`]。
    pub fn apply_and_push(
        &mut self,
        from: PeerSide,
        origin: Origin,
        ops: &[Op],
    ) -> Result<(DocEvent, DocEvent), ApplyError> {
        let (local_ev, encoded) = self.apply(from, origin, ops)?;
        let remote_ev = self.push(from.other(), &encoded)?;
        Ok((local_ev, remote_ev))
    }

    /// 当前侧块树全部 structure id（A-COL-01 并集/收敛断言）。
    pub fn structure_ids(&self, side: PeerSide) -> HashSet<BlockId> {
        self.session(side).tree().nodes.keys().copied().collect()
    }

    /// 两侧 structure id 集合是否相等（最终一致观测）。
    pub fn structure_ids_equal(&self) -> bool {
        self.structure_ids(PeerSide::A) == self.structure_ids(PeerSide::B)
    }

    /// 并发离线后互推两份结构编码：`left`→对端、`right`→对端（顺序固定 A-first 语义：
    /// 先把 `from_left` 的 encoded 推到对端，再把 `from_right` 的 encoded 推到对端）。
    ///
    /// 用于「双 peer 各自 insert 后再交换」而不依赖真实网络。
    pub fn exchange_encoded(
        &mut self,
        from_left: PeerSide,
        encoded_left: &SimplifiedEncodedOps,
        from_right: PeerSide,
        encoded_right: &SimplifiedEncodedOps,
    ) -> Result<(DocEvent, DocEvent), ApplyError> {
        debug_assert_ne!(
            from_left, from_right,
            "exchange_encoded: 两侧须为不同 peer"
        );
        let ev_to_right = self.push(from_left.other(), encoded_left)?;
        let ev_to_left = self.push(from_right.other(), encoded_right)?;
        Ok((ev_to_right, ev_to_left))
    }

    /// 将文本 update 载荷应用到目标 peer（真实 yrs 路径；无 yrs 类型外泄）。
    ///
    /// 对每个 payload 调用 [`DocSession::apply_remote_text_update`]。
    pub fn push_text_updates(
        &mut self,
        to: PeerSide,
        updates: &[TextUpdatePayload],
    ) -> Result<(), ApplyError> {
        for u in updates {
            self.session_mut(to)
                .apply_remote_text_update(u.block_id, &u.bytes)?;
        }
        Ok(())
    }

    /// 把 `from` 侧**上次成功 apply** 的文本 update 推到 `to`。
    pub fn push_last_text_updates(
        &mut self,
        from: PeerSide,
        to: PeerSide,
    ) -> Result<(), ApplyError> {
        let updates = self.session(from).last_commit_text_updates().to_vec();
        self.push_text_updates(to, &updates)
    }

    /// 结构推送：对端因块已删返回 [`ApplyError::NotFound`] 时视为 **删胜 no-op**（M1），
    /// 返回 `Ok(None)`；其它错误上浮。
    ///
    /// 用于 delete ∥ remote update 并发交换：滞后的 TextEdit/UpdateProps/Move 不得复活已删块。
    pub fn push_delete_wins(
        &mut self,
        to: PeerSide,
        encoded: &SimplifiedEncodedOps,
    ) -> Result<Option<DocEvent>, ApplyError> {
        match self.push(to, encoded) {
            Ok(ev) => Ok(Some(ev)),
            Err(ApplyError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// 文本推送：块已删（删胜）时跳过该 payload（`NotFound` → 计为 skipped），不复活节点。
    ///
    /// 返回成功合入的条数。
    pub fn push_text_updates_delete_wins(
        &mut self,
        to: PeerSide,
        updates: &[TextUpdatePayload],
    ) -> Result<usize, ApplyError> {
        let mut applied = 0usize;
        for u in updates {
            match self
                .session_mut(to)
                .apply_remote_text_update(u.block_id, &u.bytes)
            {
                Ok(()) => applied += 1,
                Err(ApplyError::NotFound(_)) => {
                    // M1 删胜：远端文本 update 不得使已删块回魂
                }
                Err(e) => return Err(e),
            }
        }
        Ok(applied)
    }

    /// 混合互推：结构用简化 JSON ops；文本用 yrs update bytes（W1-F）。
    ///
    /// 1. `from` 上 `apply(origin, ops)`  
    /// 2. 结构 ops → 对端 `push`（JSON 重放）  
    /// 3. 若本批产生文本 update → 对端 `apply_remote_text_update`  
    ///
    /// 注意：对端会**先**重放含 `TextEdit` 的结构 ops（若 ops 含文本），再合入 yrs
    /// 全量 state。为避免双重写字，调用方宜将 **结构 Insert/Move/Delete** 与
    /// **TextEdit** 分批：先结构 `apply_and_push`，再 TextEdit + `push_last_text_updates`；
    /// 或本方法仅用于 ops **不含** `TextEdit` 时的结构批，文本另走
    /// [`Self::apply_text_and_push`]。
    pub fn apply_and_push_hybrid(
        &mut self,
        from: PeerSide,
        origin: Origin,
        ops: &[Op],
    ) -> Result<(DocEvent, DocEvent), ApplyError> {
        let (local_ev, encoded) = self.apply(from, origin, ops)?;
        let remote_ev = self.push(from.other(), &encoded)?;
        // 文本：用 yrs bytes 再合入（若对端已由 TextEdit op 写过，全量 state 合入仍应收敛）
        let _ = self.push_last_text_updates(from, from.other());
        Ok((local_ev, remote_ev))
    }

    /// 在 `from` 上做纯文本编辑批，仅用 yrs update 推到对端（**不**重放 TextEdit op）。
    ///
    /// 前置：两侧块结构已存在（先结构互推）。
    pub fn apply_text_and_push(
        &mut self,
        from: PeerSide,
        origin: Origin,
        ops: &[Op],
    ) -> Result<DocEvent, ApplyError> {
        let local_ev = self.session_mut(from).apply(origin, ops)?;
        self.push_last_text_updates(from, from.other())?;
        Ok(local_ev)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block_id::BlockId;
    use crate::ir::{BlockKind, BlockProps};

    /// A-COL-01 骨架：peer A insert 段落 → 推到 B → B 树含同 id 结构。
    ///
    /// 当前为 op 日志重放语义；W1-B 后换 update 二进制互推。
    #[test]
    fn peer_a_insert_paragraph_push_to_b_same_id_structure() {
        let mut h = DualSessionHarness::new("a-col-01-skeleton");
        let id = BlockId::new();
        let ops = [Op::Insert {
            id,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }];

        let (_local_ev, encoded) = h.apply(PeerSide::A, Origin::User, &ops).unwrap();
        h.push(PeerSide::B, &encoded).unwrap();

        // A / B 均含同 id 节点
        let node_a = h.peer_a.tree().get(&id).expect("A 应有插入块");
        let node_b = h.peer_b.tree().get(&id).expect("B 应有同 id 块");
        assert_eq!(node_a.kind, BlockKind::Paragraph);
        assert_eq!(node_b.kind, BlockKind::Paragraph);
        assert_eq!(node_a.order, node_b.order);
        assert_eq!(node_a.parent, node_b.parent);
        // 根子列表结构一致
        assert_eq!(h.peer_a.tree().root_children, h.peer_b.tree().root_children);
        assert_eq!(h.peer_b.tree().root_children, vec![id]);
    }

    #[test]
    fn apply_and_push_b_to_a_roundtrip() {
        let mut h = DualSessionHarness::new("doc-rt");
        let id = BlockId::new();
        h.apply_and_push(
            PeerSide::B,
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "b0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        assert!(h.peer_a.tree().get(&id).is_some());
        assert!(h.peer_b.tree().get(&id).is_some());
    }

    #[test]
    fn simplified_encoded_ops_roundtrip() {
        let id = BlockId::new();
        let ops = vec![Op::Insert {
            id,
            parent: None,
            order: "x".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }];
        let enc = SimplifiedEncodedOps::encode(&ops).unwrap();
        let back = enc.decode().unwrap();
        assert_eq!(back.len(), 1);
        match &back[0] {
            Op::Insert { id: got, .. } => assert_eq!(*got, id),
            other => panic!("unexpected op: {other:?}"),
        }
    }

    /// W1-F / A-COL-01：A 插入段 + 写字 → 结构 JSON 推 + yrs 文本推 → B `read_text` 一致。
    #[test]
    fn w1f_a_insert_and_text_push_yrs_b_read_text_matches() {
        let mut h = DualSessionHarness::new("w1f-text-push");
        let id = BlockId::new();

        // 1) 结构：Insert 互推（简化 JSON）
        h.apply_and_push(
            PeerSide::A,
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        assert!(h.peer_b.tree().get(&id).is_some());

        // 2) 文本：仅 A TextEdit，yrs bytes → B apply_remote_text_update
        h.apply_text_and_push(
            PeerSide::A,
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "hello-w1f".into(),
            }],
        )
        .unwrap();

        assert_eq!(h.peer_a.read_text(&id), "hello-w1f");
        assert_eq!(h.peer_b.read_text(&id), "hello-w1f");
        assert_eq!(
            h.peer_b.tree().get(&id).unwrap().text_snapshot.as_deref(),
            Some("hello-w1f")
        );
        // last_commit_text_updates 有载荷且无空 bytes
        let plds = h.peer_a.last_commit_text_updates();
        assert_eq!(plds.len(), 1);
        assert_eq!(plds[0].block_id, id);
        assert!(!plds[0].bytes.is_empty());
    }

    /// W1-F：双方各写不同块 → 互推 yrs 文本 → 双方最终一致。
    #[test]
    fn w1f_both_peers_write_different_blocks_converge() {
        let mut h = DualSessionHarness::new("w1f-dual-blocks");
        let id_a = BlockId::new();
        let id_b = BlockId::new();

        // A 插入 id_a，推结构
        h.apply_and_push(
            PeerSide::A,
            Origin::User,
            &[Op::Insert {
                id: id_a,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        // B 插入 id_b，推结构
        h.apply_and_push(
            PeerSide::B,
            Origin::User,
            &[Op::Insert {
                id: id_b,
                parent: None,
                order: "a1".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();

        // 各自写不同块（不重放 TextEdit op，只推 yrs）
        h.apply_text_and_push(
            PeerSide::A,
            Origin::User,
            &[Op::TextEdit {
                id: id_a,
                start: 0,
                end: 0,
                insert: "from-A".into(),
            }],
        )
        .unwrap();
        h.apply_text_and_push(
            PeerSide::B,
            Origin::User,
            &[Op::TextEdit {
                id: id_b,
                start: 0,
                end: 0,
                insert: "from-B".into(),
            }],
        )
        .unwrap();

        // 双方结构 + 文本收敛
        assert_eq!(h.peer_a.read_text(&id_a), "from-A");
        assert_eq!(h.peer_b.read_text(&id_a), "from-A");
        assert_eq!(h.peer_a.read_text(&id_b), "from-B");
        assert_eq!(h.peer_b.read_text(&id_b), "from-B");
        assert_eq!(h.peer_a.tree().nodes.len(), h.peer_b.tree().nodes.len());
        assert!(h.peer_a.tree().nodes.contains_key(&id_a));
        assert!(h.peer_a.tree().nodes.contains_key(&id_b));
        assert!(h.peer_b.tree().nodes.contains_key(&id_a));
        assert!(h.peer_b.tree().nodes.contains_key(&id_b));
    }
}
