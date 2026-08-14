//! CRDT apply 主路径（SR-06g · 拆分 · ≠ EL）：唯一权威写入口 + 同事务分段。
//!
//! - [`DocSession::apply`]：预校验 + P-H2 快照回滚 + undo 入栈（W1-U）
//! - [`DocSession::apply_after_validate`]：突变 + 自动分段 + 统一 commit 面
//! - move / delete / huge split 子例程 + `segment_order`
//!
//! 由父模 [`crate::session`] 以私有 `mod` 接线（无孤儿）；`use super::*` 持有
//! 会话私有面（`emit_commit` / `capture_memory_snapshot` 等经 `self` 调用）。
//! 拆分只切不修：apply / undo / hydrate 语义零改动，**未**预置 CT-01 CAS 逻辑。
use super::*;
use crate::events::{BlockUpsert, DocEvent, ProjectionDiff};
use crate::ir::{pending_turn_into_kind, BlockNode, BlockProps};
use crate::op::{Op, Origin};
use crate::tx::{TxGuard, TxId};

impl DocSession {
    /// 规划将超长叶拆为多段叶子的 Op 序列（**不**修改会话状态）。
    ///
    /// - 块不存在 → [`ApplyError::NotFound`]
    /// - `utf8_len < T_HUGE` → 空 Vec（A-HUGE-01：无需拆）
    /// - 否则：首段原地 `TextEdit` + 后续 `Insert`/`TextEdit`（`props.attrs["split_of"]=锚点`）
    ///
    /// 调用方可将返回值送入 [`Self::apply`]；首段已 ≤ `T_SEGMENT` 时不会再次触发自动分段。
    pub fn plan_split_huge(&self, id: BlockId) -> Result<Vec<Op>, ApplyError> {
        if !self.tree.nodes.contains_key(&id) {
            return Err(ApplyError::NotFound(id.to_string()));
        }
        let text = self.read_text(&id);
        if text.len() < self.huge_threshold {
            return Ok(Vec::new());
        }
        let segs = partition_utf8(&text, self.segment_target());
        if segs.len() <= 1 {
            return Ok(Vec::new());
        }
        let node = self
            .tree
            .nodes
            .get(&id)
            .ok_or_else(|| ApplyError::NotFound(id.to_string()))?;
        let parent = node.parent;
        let base_order = node.order.clone();
        let kind = node.kind.clone();
        let char_len = text.chars().count() as u32;
        let anchor = id;

        let mut ops = Vec::with_capacity(1 + (segs.len() - 1) * 2);
        // 首段：原地替换全文
        ops.push(Op::TextEdit {
            id,
            start: 0,
            end: char_len,
            insert: segs[0].clone(),
        });
        for (i, seg) in segs.iter().enumerate().skip(1) {
            let seg_id = BlockId::new();
            let mut props = BlockProps::default();
            props.attrs.insert(
                ATTR_SPLIT_OF.into(),
                serde_json::Value::String(anchor.to_string()),
            );
            ops.push(Op::Insert {
                id: seg_id,
                parent,
                order: segment_order(&base_order, i),
                kind: kind.clone(),
                props,
            });
            ops.push(Op::TextEdit {
                id: seg_id,
                start: 0,
                end: 0,
                insert: seg.clone(),
            });
        }
        Ok(ops)
    }
    /// 唯一权威写入口。
    ///
    /// **P-H2（18 补丁 · 方案 A 快照回滚）**：预校验通过后、突变前捕获
    /// Structure+Text+rev；`on_committed` / 同批 huge split / 突变中途 **任一失败**
    /// → 整域回滚到 apply 前，返回错误且 **零半提交**（树/文本/rev ≡ apply 前）。
    ///
    /// **Undo v1**：成功且 `origin ∈ {User, Agent}` 时，将 apply 前快照压入 undo 栈
    ///（一次 apply 批 = 一步；Agent 千次 Op 同批仍一步）。`Remote`/`System` 不入栈。
    pub fn apply(&mut self, origin: Origin, ops: &[Op]) -> Result<DocEvent, ApplyError> {
        let tx = TxGuard::begin();
        let tx_id = tx.id();

        // 预校验（结构 + 文本偏移模拟）：失败则整批不改树/不改文本（A-INV-09a）
        self.validate_batch(ops)?;

        // P-H2：apply 前可恢复快照（默认主路径；与两阶段 prepare 等价「失败见旧态」）
        let pre = self.capture_memory_snapshot();
        match self.apply_after_validate(origin, ops, tx_id) {
            Ok(event) => {
                // W1-U：仅本地 User/Agent 入栈；失败路径不入栈
                if matches!(origin, Origin::User | Origin::Agent) {
                    self.undo_stack.push(UndoEntry { origin, pre });
                }
                tx.commit();
                Ok(event)
            }
            Err(e) => {
                self.restore_memory_snapshot(pre);
                Err(e)
            }
        }
    }
    /// 预校验已通过后的突变 + persist（失败由 [`Self::apply`] 统一回滚）。
    fn apply_after_validate(
        &mut self,
        origin: Origin,
        ops: &[Op],
        tx_id: TxId,
    ) -> Result<DocEvent, ApplyError> {
        let mut upserts = Vec::new();
        let mut removes = Vec::new();
        let mut text_touches = Vec::new();
        let mut text_payloads: Vec<TextUpdatePayload> = Vec::new();

        for op in ops {
            match op {
                Op::Insert {
                    id,
                    parent,
                    order,
                    kind,
                    props,
                } => {
                    let node = BlockNode {
                        id: *id,
                        parent: *parent,
                        order: order.clone(),
                        kind: kind.clone(),
                        props: props.clone(),
                        text_snapshot: Some(String::new()),
                        children: vec![],
                    };
                    if let Some(pid) = parent {
                        if let Some(p) = self.tree.nodes.get_mut(pid) {
                            p.children.push(*id);
                        } else {
                            return Err(ApplyError::NotFound(pid.to_string()));
                        }
                    } else {
                        self.tree.root_children.push(*id);
                    }
                    upserts.push(block_to_upsert(&node));
                    self.tree.nodes.insert(*id, node);
                    // 叶子文本：登记空快照，默认冷（H1）
                    self.text_engine.init_block(*id);
                    // 同父 order 全序：插入后按 fractional 字典序重排兄弟
                    self.tree.resort_children_of(*parent);
                }
                Op::UpdateProps { id, props } => {
                    let n = self
                        .tree
                        .nodes
                        .get_mut(id)
                        .ok_or_else(|| ApplyError::NotFound(id.to_string()))?;
                    n.props = props.clone();
                    // CONN-D：消费 pending_turn_into_flavour → 真改权威 kind
                    //（TS provisional wire 路径；标记保留审计；UI 须以 kind 为准）
                    if let Some(kind) = pending_turn_into_kind(&n.props) {
                        n.kind = kind;
                    }
                    upserts.push(block_to_upsert(n));
                }
                Op::TurnInto { id, kind } => {
                    // CONN-D：真 structure turn_into Op 子集
                    let n = self
                        .tree
                        .nodes
                        .get_mut(id)
                        .ok_or_else(|| ApplyError::NotFound(id.to_string()))?;
                    n.kind = kind.clone();
                    upserts.push(block_to_upsert(n));
                }
                Op::Move {
                    id,
                    new_parent,
                    order,
                } => {
                    self.apply_move(*id, *new_parent, order)?;
                    if let Some(n) = self.tree.nodes.get(id) {
                        upserts.push(block_to_upsert(n));
                    }
                }
                Op::Delete { id } => {
                    let removed = self.apply_delete(*id)?;
                    for rid in &removed {
                        // A-INV-09c：同步释放文本引擎
                        self.text_engine.release_block(*rid);
                    }
                    removes.extend(removed);
                }
                Op::TextEdit {
                    id,
                    start,
                    end,
                    insert,
                } => {
                    // char 偏移 → TextEngine（yrs）；失败路径不应走到此处（已 validate）
                    let new_text = self
                        .text_engine
                        .apply_edit(*id, *start, *end, insert)
                        .map_err(ApplyError::from)?;
                    let n = self
                        .tree
                        .nodes
                        .get_mut(id)
                        .ok_or_else(|| ApplyError::NotFound(id.to_string()))?;
                    n.text_snapshot = Some(new_text);
                    text_touches.push(*id);
                    upserts.push(block_to_upsert(n));
                    // CommitBatch / last_commit_text_updates：yrs encode 字节（无类型外泄）
                    if let Some(bytes) = self.text_engine.encode_state_update(*id) {
                        text_payloads.push(TextUpdatePayload {
                            block_id: *id,
                            bytes,
                        });
                    }
                }
            }
        }

        // M2 / A-HUGE-02：同事务尾部对超阈文本叶自动分段；失败 → 外层 P-H2 整批回滚
        // （原子域 = 用户 Op + 自动 split + on_committed，18 P-H2）
        let mut split_candidates: Vec<BlockId> = text_touches.clone();
        split_candidates.sort_by_key(|id| id.as_uuid());
        split_candidates.dedup();
        for cid in split_candidates {
            self.maybe_split_huge_in_tx(cid, &mut upserts, &mut text_touches, &mut text_payloads)?;
        }

        self.rev += 1;
        let rev = self.rev;

        // 无论是否挂 persistence，都记录同源 tx + 文本 update（A-INV-09b / W1-F）
        // 若随后 on_committed 失败，外层 restore 会抹掉这些观测字段
        self.last_tx_id = Some(tx_id);
        self.last_text_updates = text_payloads.clone();

        // G-HYD-1：结构 bytes = 整树可逆 CDCS snapshot（非 rev LE 占位）
        // P-H2：此处 Err → 外层回滚树/文本/rev
        // CT-01：期望 = increment 前 rev（rev - 1）；陈旧写 → Conflict → 外层整批回滚
        self.emit_commit(origin, tx_id, rev, Some(rev - 1), &text_payloads)?;

        Ok(DocEvent::Projection {
            diff: ProjectionDiff {
                doc_id: self.doc_id.clone(),
                rev,
                upserts,
                removes,
                text_touches,
                full_rebuild: false,
            },
        })
    }
    fn apply_move(
        &mut self,
        id: BlockId,
        new_parent: Option<BlockId>,
        order: &str,
    ) -> Result<(), ApplyError> {
        // 目标节点必须存在
        if !self.tree.nodes.contains_key(&id) {
            return Err(ApplyError::NotFound(id.to_string()));
        }
        // 新父必须存在（delete vs move：被删后到此应 NotFound）
        if let Some(np) = new_parent {
            if !self.tree.nodes.contains_key(&np) {
                return Err(ApplyError::NotFound(np.to_string()));
            }
        }
        // 防环（MV-02/MV-04）
        if self.would_create_cycle(id, new_parent) {
            return Err(ApplyError::Invariant("move cycle".into()));
        }

        let old_parent = self.tree.nodes.get(&id).unwrap().parent;

        // 从旧父移除
        if let Some(op) = old_parent {
            if let Some(p) = self.tree.nodes.get_mut(&op) {
                p.children.retain(|c| *c != id);
            }
        } else {
            self.tree.root_children.retain(|c| *c != id);
        }

        // 挂新父
        if let Some(np) = new_parent {
            // 上文已确认存在
            if let Some(p) = self.tree.nodes.get_mut(&np) {
                p.children.push(id);
            }
        } else {
            self.tree.root_children.push(id);
        }

        let n = self.tree.nodes.get_mut(&id).unwrap();
        n.parent = new_parent;
        n.order = order.to_string();

        // 按 order 字典序重排新父兄弟（MV-01 全序稳定）
        self.tree.resort_children_of(new_parent);
        Ok(())
    }
    /// 删除节点及子树；返回被删 id 列表（含根）。
    fn apply_delete(&mut self, id: BlockId) -> Result<Vec<BlockId>, ApplyError> {
        let mut stack = vec![id];
        let mut to_rm = Vec::new();
        while let Some(cur) = stack.pop() {
            if let Some(n) = self.tree.nodes.get(&cur) {
                stack.extend(n.children.iter().copied());
            }
            to_rm.push(cur);
        }
        for rid in &to_rm {
            if let Some(n) = self.tree.nodes.get(rid) {
                if let Some(pid) = n.parent {
                    if let Some(p) = self.tree.nodes.get_mut(&pid) {
                        p.children.retain(|c| c != rid);
                    }
                } else {
                    self.tree.root_children.retain(|c| c != rid);
                }
            }
            self.tree.nodes.remove(rid);
        }
        Ok(to_rm)
    }
    /// 同事务内：若 `id` 文本 UTF-8 字节 ≥ `T_HUGE`，拆为多段叶子（A-HUGE-02 主路径）。
    ///
    /// 最小结构：首段即 anchor（id 不变），后续兄弟 `props.split_of = anchor`，order 紧邻。
    fn maybe_split_huge_in_tx(
        &mut self,
        id: BlockId,
        upserts: &mut Vec<BlockUpsert>,
        text_touches: &mut Vec<BlockId>,
        text_payloads: &mut Vec<TextUpdatePayload>,
    ) -> Result<(), ApplyError> {
        if !self.tree.nodes.contains_key(&id) {
            return Ok(());
        }
        // 已被同批删除则跳过
        let text = self.read_text(&id);
        // A-HUGE-01：亚阈保持单叶
        if text.len() < self.huge_threshold {
            return Ok(());
        }
        let segs = partition_utf8(&text, self.segment_target());
        if segs.len() <= 1 {
            return Ok(());
        }

        let (parent, base_order, kind) = {
            let n = self
                .tree
                .nodes
                .get(&id)
                .ok_or_else(|| ApplyError::NotFound(id.to_string()))?;
            (n.parent, n.order.clone(), n.kind.clone())
        };
        let anchor = id;

        // 首段：原地改写文本
        self.set_block_text_and_record(id, &segs[0], upserts, text_touches, text_payloads)?;

        // 后续段：Insert 兄弟 + 写文本
        for (i, seg) in segs.iter().enumerate().skip(1) {
            let seg_id = BlockId::new();
            let mut props = BlockProps::default();
            props.attrs.insert(
                ATTR_SPLIT_OF.into(),
                serde_json::Value::String(anchor.to_string()),
            );
            let order = segment_order(&base_order, i);
            let node = BlockNode {
                id: seg_id,
                parent,
                order: order.clone(),
                kind: kind.clone(),
                props: props.clone(),
                text_snapshot: Some(String::new()),
                children: vec![],
            };
            if let Some(pid) = parent {
                if let Some(p) = self.tree.nodes.get_mut(&pid) {
                    p.children.push(seg_id);
                } else {
                    return Err(ApplyError::NotFound(pid.to_string()));
                }
            } else {
                self.tree.root_children.push(seg_id);
            }
            self.tree.nodes.insert(seg_id, node);
            self.text_engine.init_block(seg_id);
            self.tree.resort_children_of(parent);

            self.set_block_text_and_record(seg_id, seg, upserts, text_touches, text_payloads)?;
            if let Some(n) = self.tree.nodes.get(&seg_id) {
                upserts.push(block_to_upsert(n));
            }
        }

        // 刷新 anchor upsert（order/children 侧可能未变，文本已变）
        if let Some(n) = self.tree.nodes.get(&id) {
            upserts.push(block_to_upsert(n));
        }
        Ok(())
    }
    /// 整叶替换文本并同步 tree 快照 / touches / encode。
    fn set_block_text_and_record(
        &mut self,
        id: BlockId,
        text: &str,
        upserts: &mut Vec<BlockUpsert>,
        text_touches: &mut Vec<BlockId>,
        text_payloads: &mut Vec<TextUpdatePayload>,
    ) -> Result<(), ApplyError> {
        let current = self.text_engine.read_text(id);
        let char_len = current.chars().count() as u32;
        let new_text = self
            .text_engine
            .apply_edit(id, 0, char_len, text)
            .map_err(ApplyError::from)?;
        if let Some(n) = self.tree.nodes.get_mut(&id) {
            n.text_snapshot = Some(new_text);
            upserts.push(block_to_upsert(n));
        }
        text_touches.push(id);
        if let Some(bytes) = self.text_engine.encode_state_update(id) {
            // 同一块多次写：保留最后一次 encode
            text_payloads.retain(|p| p.block_id != id);
            text_payloads.push(TextUpdatePayload {
                block_id: id,
                bytes,
            });
        }
        Ok(())
    }
}

/// 段叶子 order：在 anchor `base` 之后、通常仍小于下一字典兄弟（`base` < `base~s0001` < …）。
fn segment_order(base: &str, segment_index: usize) -> String {
    format!("{base}~s{segment_index:04}")
}
