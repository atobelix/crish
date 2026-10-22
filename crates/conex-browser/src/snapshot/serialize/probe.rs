//! 增强树子树探测：被截子树可交互计数、子树规模、M1 包裹控件探测、可访问名称。

use super::SerializeOptions;
use crate::snapshot::collect::EnhancedNode;
use crate::snapshot::interactive::{decide, DecideCtx, Decision, DecisionCache};

/// 被截子树的可交互元素计数（预算 1/2 提示行；判定复用四层规则，后序统计）。
pub(super) fn count_interactive_subtree(
    node: &EnhancedNode,
    opts: &SerializeOptions,
    cache: &mut DecisionCache,
) -> usize {
    let mut count = 0;
    count_interactive_rec(node, opts, cache, &mut count);
    count
}

fn count_interactive_rec(
    node: &EnhancedNode,
    opts: &SerializeOptions,
    cache: &mut DecisionCache,
    count: &mut usize,
) {
    if node.is_text() {
        return;
    }
    let sub_has = false;
    for child in &node.children {
        if !child.is_text() {
            count_interactive_rec(child, opts, cache, count);
        }
    }
    // 后序：先统计子树，再以子树结果判定自身（W2 语义）
    if !node.is_element_candidate() {
        return;
    }
    let ctx = DecideCtx {
        tag: node.tag.as_deref().unwrap_or(""),
        attributes: &node.attributes,
        ax: &node.ax,
        styles: &node.styles,
        bounds: node.bounds,
        has_click_listener: node.has_click_listener,
        listener_channel_enabled: opts.listener_channel,
        is_scrollable: node.scrollable || node.styles.scroll_candidate(),
        in_svg: node.in_svg,
        ancestor_hidden: false,
        subtree_has_interactive: sub_has,
        wrapped_control: false,
        wrapped_by_label_for: false,
    };
    let d = if node.backend_node_id >= 0 {
        cache.get_or_else(opts.session_id, node.backend_node_id, || decide(&ctx))
    } else {
        decide(&ctx)
    };
    if matches!(d, Decision::Interactive(_)) {
        *count += 1;
    }
}

/// 子树节点数（预算 1/2 丢弃统计/视口外提示）。
pub(super) fn subtree_size(node: &EnhancedNode) -> usize {
    let mut n = 0;
    node.walk(&mut |_| n += 1);
    n
}

/// M1 探测：label/span 包裹表单控件（≤2 层；label 带 for 时 M0 跳过）。
pub(super) fn wrapped_control_probe(node: &EnhancedNode) -> (bool, bool) {
    let tag = node.tag.as_deref().unwrap_or("");
    if tag != "label" && tag != "span" {
        return (false, false);
    }
    let by_label_for = tag == "label" && node.get_attr("for").is_some();
    let is_control = |n: &EnhancedNode| {
        matches!(
            n.tag.as_deref(),
            Some("input") | Some("select") | Some("textarea")
        )
    };
    // ≤2 层：直接子或孙
    let direct = node.children.iter().any(&is_control);
    let grand = node
        .children
        .iter()
        .any(|c| c.children.iter().any(&is_control));
    ((direct || grand), by_label_for)
}

/// AX 辅助：可访问名称提取优先链（AX name → aria-label → title → placeholder → 文本）。
#[allow(dead_code)]
fn accessible_name(node: &EnhancedNode) -> Option<String> {
    if let Some(name) = node.ax.name.as_deref().filter(|s| !s.is_empty()) {
        return Some(name.to_string());
    }
    for attr in ["aria-label", "title", "placeholder"] {
        if let Some(v) = node.get_attr(attr).filter(|s| !s.is_empty()) {
            return Some(v.to_string());
        }
    }
    let inline = node.inline_text();
    if !inline.trim().is_empty() {
        return Some(inline.trim().to_string());
    }
    None
}
