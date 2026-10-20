//! 块级 diff 提案（**SD-37** · 自 `mirror_import` 再抽）。
//!
//! - 共有 ID 文本不同 → `TextEdit`（全量替换）
//! - mirror 有、权威无 → `Insert`（先父后子）
//! - 权威有、mirror 无 → 仅 `DropUnacked` 时 `Delete`；RetainLocal 保留本地独有块
//!
//! 本模块 **只提案**，从不 `apply`。
//! **≠ EL-03** · **≠ inotify** · **≠** 默认 fullRemount。
//! **≠** 重做 SD-26 / 抹 X-05（X-05 门禁仍在父模 `import_mirror_proposal`）。

use super::ThreeWayStrategy;
use conex_doc_collab::{BlockId, BlockTree, Op};

/// 块级 diff 提案（**非** fullRemount）。
///
/// - 共有 ID 文本不同 → `TextEdit`（全量替换）
/// - mirror 有、权威无 → `Insert`（先父后子）
/// - 权威有、mirror 无 → 仅 `DropUnacked` 时 `Delete`；RetainLocal 保留本地独有块
pub(super) fn propose_block_level_ops(
    authority: &BlockTree,
    mirror: &BlockTree,
    strategy: ThreeWayStrategy,
) -> Vec<Op> {
    let mut ops = Vec::new();

    // 1) 文本更新（共有 ID）
    for (id, mnode) in &mirror.nodes {
        if let Some(anode) = authority.get(id) {
            let at = anode.text_snapshot.clone().unwrap_or_default();
            let mt = mnode.text_snapshot.clone().unwrap_or_default();
            if at != mt {
                let end = at.chars().count() as u32;
                ops.push(Op::TextEdit {
                    id: *id,
                    start: 0,
                    end,
                    insert: mt,
                });
            }
            // kind 变化：本波次仅文本 + 结构 Insert/Delete（kind 迁移属后续加厚）
        }
    }

    // 2) Insert：mirror 有、权威无（父须已在权威或本批将 Insert）
    // 拓扑：多次扫描直到不动（块数小，O(n²) 可接受）
    let mut pending: Vec<BlockId> = mirror
        .nodes
        .keys()
        .filter(|id| !authority.nodes.contains_key(id))
        .copied()
        .collect();
    pending.sort_by_key(|id| id.to_string());

    let mut inserted = std::collections::HashSet::new();
    // 有限轮拓扑插入；环或父永不存在时跳过剩余（不强制 fullRemount）
    for _ in 0..=pending.len() {
        if pending.is_empty() {
            break;
        }
        let mut progress = false;
        let mut rest = Vec::new();
        for id in pending.drain(..) {
            let node = match mirror.get(&id) {
                Some(n) => n,
                None => continue,
            };
            let parent_ok = match node.parent {
                None => true,
                Some(pid) => authority.nodes.contains_key(&pid) || inserted.contains(&pid),
            };
            if !parent_ok {
                rest.push(id);
                continue;
            }
            ops.push(Op::Insert {
                id: node.id,
                parent: node.parent,
                order: node.order.clone(),
                kind: node.kind.clone(),
                props: node.props.clone(),
            });
            let text = node.text_snapshot.clone().unwrap_or_default();
            if !text.is_empty() {
                ops.push(Op::TextEdit {
                    id: node.id,
                    start: 0,
                    end: 0,
                    insert: text,
                });
            }
            inserted.insert(id);
            progress = true;
        }
        pending = rest;
        if !progress {
            break;
        }
    }

    // 3) Delete：仅 DropUnacked
    if strategy == ThreeWayStrategy::DropUnacked {
        let mut to_delete: Vec<BlockId> = authority
            .nodes
            .keys()
            .filter(|id| !mirror.nodes.contains_key(id))
            .copied()
            .collect();
        // 后序：先删子（按 children 深度粗排：子节点 id 先）
        to_delete.sort_by_key(|id| {
            // 深度越大越先删
            let mut d = 0u32;
            let mut cur = *id;
            while let Some(n) = authority.get(&cur) {
                if let Some(p) = n.parent {
                    d += 1;
                    cur = p;
                } else {
                    break;
                }
            }
            std::cmp::Reverse(d)
        });
        for id in to_delete {
            ops.push(Op::Delete { id });
        }
    }

    ops
}
