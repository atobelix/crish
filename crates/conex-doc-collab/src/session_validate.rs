//! 整批预校验 + 环检测（SR-06g · 拆分 · ≠ EL）：结构 + 文本偏移顺序模拟（A-INV-09a）。
//!
//! - [`DocSession::validate_batch`]：预校验主路径（失败零改状态）
//! - 删胜闭包展开 / 父存活 / 环检测子例程（`would_create_cycle` 供 apply 域复用）
//!
//! 由父模 [`crate::session`] 以私有 `mod` 接线（无孤儿）；`pub(super)` 方法供
//! [`super::session_apply`] 跨模调用。拆分只切不修，语义零改动。
use super::*;
use crate::op::Op;
use crate::text_engine::simulate_char_edit;
use std::collections::{HashMap, HashSet};

impl DocSession {
    /// 整批预校验：结构 + 文本偏移顺序模拟；失败零改状态（A-INV-09a）。
    pub(super) fn validate_batch(&self, ops: &[Op]) -> Result<(), ApplyError> {
        let deleted = self.expand_deletes(ops);
        // 同批内先前 Insert 的 id，允许后续 Op 引用
        let mut inserted: HashSet<BlockId> = HashSet::new();
        // 同批文本模拟（含新插入的空串）
        let mut sim_text: HashMap<BlockId, String> = HashMap::new();

        for op in ops {
            match op {
                Op::Insert { id, parent, .. } => {
                    if let Some(pid) = parent {
                        self.ensure_parent_alive(*pid, &deleted, &inserted)?;
                    }
                    inserted.insert(*id);
                    sim_text.insert(*id, String::new());
                }
                Op::Move { id, new_parent, .. } => {
                    // 被删节点不可再 move；目标父被删 → 删胜，NotFound 整批失败
                    if deleted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                    if !self.tree.nodes.contains_key(id) && !inserted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                    if let Some(np) = new_parent {
                        self.ensure_parent_alive(*np, &deleted, &inserted)?;
                        if self.would_create_cycle(*id, Some(*np)) {
                            return Err(ApplyError::Invariant("move cycle".into()));
                        }
                    }
                }
                Op::UpdateProps { id, .. } => {
                    if deleted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                    if !self.tree.nodes.contains_key(id) && !inserted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                }
                Op::TurnInto { id, .. } => {
                    if deleted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                    if !self.tree.nodes.contains_key(id) && !inserted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                }
                Op::TextEdit {
                    id,
                    start,
                    end,
                    insert,
                } => {
                    if deleted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                    if !self.tree.nodes.contains_key(id) && !inserted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                    let current = if let Some(t) = sim_text.get(id) {
                        t.clone()
                    } else if self.text_engine.is_registered(*id) {
                        self.text_engine.read_text(*id)
                    } else if let Some(n) = self.tree.nodes.get(id) {
                        n.text_snapshot.clone().unwrap_or_default()
                    } else {
                        String::new()
                    };
                    let next = simulate_char_edit(&current, *start, *end, insert)
                        .map_err(ApplyError::from)?;
                    sim_text.insert(*id, next);
                }
                Op::Delete { id } => {
                    if !self.tree.nodes.contains_key(id) && !inserted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                }
            }
        }
        Ok(())
    }
    /// 父节点须存活：已在树或同批已插入，且不在同批删除闭包内。
    fn ensure_parent_alive(
        &self,
        pid: BlockId,
        deleted: &HashSet<BlockId>,
        inserted: &HashSet<BlockId>,
    ) -> Result<(), ApplyError> {
        if deleted.contains(&pid) {
            return Err(ApplyError::NotFound(pid.to_string()));
        }
        if self.tree.nodes.contains_key(&pid) || inserted.contains(&pid) {
            Ok(())
        } else {
            Err(ApplyError::NotFound(pid.to_string()))
        }
    }
    /// 同批 Delete 展开为子树闭包（删胜：整棵子树视为不可再作 move 目标）。
    fn expand_deletes(&self, ops: &[Op]) -> HashSet<BlockId> {
        let mut deleted = HashSet::new();
        for op in ops {
            if let Op::Delete { id } = op {
                let mut stack = vec![*id];
                while let Some(cur) = stack.pop() {
                    if deleted.insert(cur) {
                        if let Some(n) = self.tree.nodes.get(&cur) {
                            stack.extend(n.children.iter().copied());
                        }
                    }
                }
            }
        }
        deleted
    }
    /// MV-02 / MV-04：若把 `id` 挂到 `new_parent` 下会使 `id` 成为自身祖先则成环。
    pub(super) fn would_create_cycle(&self, id: BlockId, new_parent: Option<BlockId>) -> bool {
        let Some(mut cur) = new_parent else {
            return false;
        };
        // 沿 parent 链上溯：碰到 id 即环（含 new_parent == id）
        loop {
            if cur == id {
                return true;
            }
            match self.tree.nodes.get(&cur) {
                Some(n) => match n.parent {
                    Some(p) => cur = p,
                    None => return false,
                },
                // 父不存在另由 NotFound 处理
                None => return false,
            }
        }
    }
}
