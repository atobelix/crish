//! 步骤 4 索引分配（含合成索引避碰撞）与 selector_map 收集。

use super::state::BuildState;
use super::{NodeRef, SimplifiedNode};
use crate::snapshot::budget::TruncationKind;
use std::collections::{HashMap, HashSet};

/// 索引分配（步骤 4）：可交互且可见、非盲区/不可操作/iframe 占位 → 模型索引。
pub(super) fn assign_indices(node: &mut SimplifiedNode, state: &mut BuildState) {
    let indexable = node.is_interactive
        && !node.covered
        && node.blind_zone.is_none()
        && node.frame_marker.is_none();
    if node.tag.is_some() && indexable {
        if state.selectors_left > 0 {
            state.selectors_left -= 1;
            state.selector_count += 1;
            node.selector_index = Some(next_index(node.backend_node_id, state));
        } else {
            // 预算 4：超出部分元素仍入树（无 [N] 前缀，仅文本可读）
            state.selector_truncated += 1;
            state.note_truncation(TruncationKind::Selectors);
        }
    }
    for child in &mut node.children {
        assign_indices(child, state);
    }
}

/// 索引合成（§3.3）：默认 = backendNodeId（u32 可表示且无碰撞）；
/// 否则从树中全部 id 的 max+1 起递增，避开已有 id。
fn next_index(backend_id: i64, state: &mut BuildState) -> u32 {
    if let Ok(id) = u32::try_from(backend_id) {
        if !state.assigned.contains(&id) {
            state.assigned.insert(id);
            return id;
        }
    }
    // 合成索引：从 max+1 起递增，避开全部已出现 id
    loop {
        let candidate = state.synthetic_next;
        state.synthetic_next = state.synthetic_next.saturating_add(1);
        if !state.assigned.contains(&candidate) {
            state.assigned.insert(candidate);
            return candidate;
        }
    }
}

/// 收集树中全部 backendNodeId（合成索引避碰撞）。
pub(super) fn collect_ids(node: &SimplifiedNode, ids: &mut HashSet<i64>) {
    ids.insert(node.backend_node_id);
    for child in &node.children {
        collect_ids(child, ids);
    }
}

/// 收集 selector_map（模型索引 → NodeRef 绑定）。
pub(super) fn collect_selector_map(
    roots: &[SimplifiedNode],
    session_id: &str,
) -> HashMap<u32, NodeRef> {
    let mut map = HashMap::new();
    for root in roots {
        collect_map_node(root, session_id, &mut map);
    }
    map
}

fn collect_map_node(node: &SimplifiedNode, session_id: &str, map: &mut HashMap<u32, NodeRef>) {
    if let Some(idx) = node.selector_index {
        map.insert(
            idx,
            NodeRef {
                backend_node_id: node.backend_node_id,
                session_id: session_id.to_string(),
                frame_target_id: None,
            },
        );
    }
    for child in &node.children {
        collect_map_node(child, session_id, map);
    }
}
