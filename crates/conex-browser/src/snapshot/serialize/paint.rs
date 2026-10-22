//! 步骤 3 绘制序过滤：维护不相交矩形并集，标记被完全覆盖的节点。

use super::{SimplifiedNode, RECT_UNION_CAP};
use crate::snapshot::collect::Bounds;
use std::collections::HashSet;

/// 绘制序过滤（步骤 3）：被完全覆盖的节点标记 covered（保留文本不给索引）。
pub(super) fn mark_covered(roots: &mut [SimplifiedNode], paint_orders: &[(i64, Bounds)]) {
    // paint_orders 按绘制序升序（先画的在前）；从后向前维护不相交矩形并集
    let mut union: Vec<Bounds> = Vec::new();
    let mut covered_ids: HashSet<i64> = HashSet::new();
    for (id, b) in paint_orders.iter().rev() {
        if union.len() >= RECT_UNION_CAP {
            break; // 超限保守放行
        }
        if rect_covered(*b, &union) {
            covered_ids.insert(*id);
        }
        add_to_union(&mut union, *b);
    }
    apply_covered(roots, &covered_ids);
}

/// 矩形是否完全被并集覆盖。
fn rect_covered(b: Bounds, union: &[Bounds]) -> bool {
    union.iter().any(|u| {
        u.x <= b.x
            && u.y <= b.y
            && u.x + u.width >= b.x + b.width
            && u.y + u.height >= b.y + b.height
    })
}

/// 不相交矩形并集（相交合并）。
fn add_to_union(union: &mut Vec<Bounds>, b: Bounds) {
    if b.width <= 0.0 || b.height <= 0.0 {
        return;
    }
    if let Some(existing) = union.iter_mut().find(|u| rects_intersect(**u, b)) {
        existing.x = existing.x.min(b.x);
        existing.y = existing.y.min(b.y);
        existing.width = (existing.x + existing.width).max(b.x + b.width) - existing.x;
        existing.height = (existing.y + existing.height).max(b.y + b.height) - existing.y;
    } else {
        union.push(b);
    }
}

fn rects_intersect(a: Bounds, b: Bounds) -> bool {
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

fn apply_covered(roots: &mut [SimplifiedNode], covered: &HashSet<i64>) {
    for root in roots {
        apply_covered_node(root, covered);
    }
}

fn apply_covered_node(node: &mut SimplifiedNode, covered: &HashSet<i64>) {
    if covered.contains(&node.backend_node_id) && node.tag.is_some() && !is_form_control(node) {
        // 文本节点与表单控件不因遮盖而删除（弹窗/下拉遮罩下保留原文，不给索引）
        node.covered = true;
    }
    for child in &mut node.children {
        apply_covered_node(child, covered);
    }
}

/// 表单控件（遮盖过滤豁免：仅保留文本，不给交互索引）。
fn is_form_control(node: &SimplifiedNode) -> bool {
    matches!(
        node.tag.as_deref(),
        Some("input") | Some("select") | Some("textarea")
    )
}
