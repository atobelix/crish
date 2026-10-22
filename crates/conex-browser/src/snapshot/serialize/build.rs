//! 步骤 1 建树（含预算 1/2、视口外折叠、盲区登记、可交互判定）与步骤 2 容器折叠。

use super::attrs::render_attrs;
use super::probe::{count_interactive_subtree, subtree_size, wrapped_control_probe};
use super::state::BuildState;
use super::{BlindZoneKind, SerializeOptions, SimplifiedNode, FOLD_CONTAINMENT, SKIP_TAGS};
use crate::snapshot::budget::TruncationKind;
use crate::snapshot::collect::{Bounds, EnhancedNode, FrameMarker};
use crate::snapshot::interactive::{decide, DecideCtx, Decision, DecisionCache};

/// 空简化节点（hint/跳过占位；不参与索引与渲染）。
fn hint_node(backend_id: i64, hidden_hint: Option<String>) -> SimplifiedNode {
    SimplifiedNode {
        backend_node_id: backend_id,
        tag: None,
        attributes: Vec::new(),
        text: None,
        selector_index: None,
        is_interactive: false,
        is_new: false,
        is_scrollable: false,
        scroll_info: None,
        frame_marker: None,
        blind_zone: None,
        children: Vec::new(),
        hidden_hint,
        covered: false,
        bounds: None,
    }
}

/// 简化树构建（步骤 1）；返回 (简化节点, 子树内是否含可交互元素)。
///
/// `ancestors_hidden`：祖先隐藏沿链传播（P3）；`closed_shadow`：closed shadow 内
/// （子元素若 AX 检出但无 backendNodeId → `|UNOPERABLE|` 降级，T-5）；
/// `in_scrollable`：祖先链可滚动（视口外折叠提示保留滚动可达元素）。
#[allow(clippy::too_many_arguments)]
pub(super) fn build_subtree(
    node: &EnhancedNode,
    depth: usize,
    ancestors_hidden: bool,
    closed_shadow: bool,
    in_scrollable: bool,
    opts: &SerializeOptions,
    state: &mut BuildState,
    cache: &mut DecisionCache,
) -> (SimplifiedNode, bool) {
    // —— 预算 1：深度截断（保留被截可交互元素计数提示行）——
    if depth >= opts.budgets.max_depth && !node.is_text() {
        let interactive = count_interactive_subtree(node, opts, cache);
        state.dropped_nodes += subtree_size(node);
        state.dropped_interactive += interactive;
        state.note_truncation(TruncationKind::Depth);
        let hint = hint_node(
            node.backend_node_id,
            Some(format!("... ({interactive} more interactive elements)")),
        );
        if state.nodes_left > 0 {
            state.nodes_left -= 1;
        }
        state.element_count += 1;
        return (hint, interactive > 0);
    }

    // —— 视口外折叠（可滚动容器内元素保留，滚动可达，§2.3）——
    if !node.is_text() && !in_scrollable {
        if let Some(vp) = opts.viewport {
            let outside = node.bounds.is_some_and(|b| {
                b.y > vp.y + vp.height + crate::snapshot::collect::VIEWPORT_THRESHOLD
            });
            if outside {
                let n = subtree_size(node);
                let hint = hint_node(
                    node.backend_node_id,
                    Some(format!("... ({n} more elements - scroll to reveal)")),
                );
                return (hint, false);
            }
        }
    }

    // —— 文本节点：仅保留可见且 >1 字符文本（§3.4 入树阈值）——
    if node.is_text() {
        let text = node.text.as_deref().unwrap_or("").trim();
        if text.chars().count() <= crate::snapshot::budget::TEXT_NODE_MIN_CHARS {
            return (hint_node(node.backend_node_id, None), false);
        }
        state.element_count += 1;
        return (
            SimplifiedNode {
                backend_node_id: node.backend_node_id,
                tag: None,
                attributes: Vec::new(),
                text: Some(text.to_string()),
                selector_index: None,
                is_interactive: false,
                is_new: false,
                is_scrollable: false,
                scroll_info: None,
                frame_marker: None,
                blind_zone: None,
                children: Vec::new(),
                hidden_hint: None,
                covered: false,
                bounds: None,
            },
            false,
        );
    }

    let tag = node.tag.as_deref().unwrap_or("");
    // —— 跳过装饰标签（head/script/style/meta/link/title）——
    if SKIP_TAGS.contains(&tag) {
        return (hint_node(node.backend_node_id, None), false);
    }

    // —— 预算 2：元素数截断（达到上限停止收纳子节点）——
    if state.nodes_left == 0 {
        let interactive = count_interactive_subtree(node, opts, cache);
        state.dropped_nodes += subtree_size(node);
        state.dropped_interactive += interactive;
        state.note_truncation(TruncationKind::Elements);
        return (
            hint_node(
                node.backend_node_id,
                Some(format!("... ({interactive} more interactive elements)")),
            ),
            false,
        );
    }
    state.nodes_left -= 1;
    state.element_count += 1;

    // —— 盲区登记（T-16：占位呈现、不分配索引、头部统计；检出通道 = DOM 标签，
    // 13 §3.6）——
    // canvas/WebGL：canvas 标签承载 2D 与 WebGL 渲染上下文——DOM 快照面不可观测
    // JS getContext 调用，2D/WebGL 统一按 canvas 标签检出（无独立 WebGL 元素）；
    // video：video 标签（画面内容不可读）；img：纯图片内容（img 无可操作文本，
    // void 元素）。「上下文检测」在占位行呈现面落地：白名单描述属性
    // （aria-label/title/role/src 等）随占位行呈现，模型可识别盲区元素用途，
    // 统计口径不变（canvas/video/image 计数 = 进入简化树的盲区占位元素数）。
    let blind_zone = match tag {
        "canvas" => {
            state.canvas += 1;
            Some(BlindZoneKind::Canvas)
        }
        "video" => {
            state.video += 1;
            Some(BlindZoneKind::Video)
        }
        "img" => {
            state.image += 1;
            Some(BlindZoneKind::Image)
        }
        _ => None,
    };

    // closed shadow 内 AX 检出但无 backendNodeId 的元素 → 不可操作（T-5）
    let unoperable = closed_shadow && node.backend_node_id < 0 && !node.is_text();
    if unoperable {
        state.unoperable += 1;
    }

    // —— 隐藏链/滚动链传播 ——
    let self_hidden = node.styles.is_hidden();
    let child_hidden = ancestors_hidden || self_hidden;
    let child_scrollable = in_scrollable || node.scrollable || node.styles.scroll_candidate();

    // —— 子节点构建（后序：先子后父，父判定需要子树信息）——
    // 仅含文本子节点 → 文本并入元素行；混排 → 文本子节点以裸文本行呈现
    let leaf_text_only = !node.children.iter().any(|c| !c.is_text());
    let mut children = Vec::new();
    let mut subtree_has_interactive = false;
    for (ci, child) in node.children.iter().enumerate() {
        if child.is_text() {
            continue; // 直接文本子节点由父行吸收或裸行呈现
        }
        // select 的 option 子节点不单独成行（已由 `options=` 合成属性呈现，§3.2）
        if tag == "select" && child.tag.as_deref() == Some("option") {
            continue;
        }
        // —— 预算 2：元素数上限 ——
        if state.nodes_left == 0 {
            // 本节点及后续兄弟整批折叠（保留被截可交互元素计数提示行，§3.4）
            let mut dropped = 0usize;
            let mut dropped_interactive = 0usize;
            for rest in node.children[ci..].iter().filter(|c| !c.is_text()) {
                dropped += subtree_size(rest);
                dropped_interactive += count_interactive_subtree(rest, opts, cache);
            }
            state.dropped_nodes += dropped;
            state.dropped_interactive += dropped_interactive;
            state.note_truncation(TruncationKind::Elements);
            children.push(hint_node(
                child.backend_node_id,
                Some(format!(
                    "... ({dropped_interactive} more interactive elements)"
                )),
            ));
            break;
        }
        let (child_node, child_interactive) = build_subtree(
            child,
            depth + 1,
            child_hidden,
            closed_shadow || node.frame_marker == Some(FrameMarker::ShadowClosed),
            child_scrollable,
            opts,
            state,
            cache,
        );
        subtree_has_interactive |= child_interactive;
        if child_node.tag.is_none() {
            // hint/跳过节点：无渲染文本时丢弃，有提示行时挂载
            if child_node.hidden_hint.is_some() {
                children.push(child_node);
            }
        } else {
            children.push(child_node);
        }
    }

    // —— 直接子文本拼接（仅纯文本容器内联，§3.2 示例）——
    let inline_text: String = if leaf_text_only {
        node.children
            .iter()
            .filter(|c| c.is_text())
            .filter_map(|c| c.text.as_deref())
            .collect::<String>()
            .trim()
            .to_string()
    } else {
        // 混排：文本子节点作为裸文本行挂入 children
        for child in &node.children {
            if child.is_text() {
                let t = child.text.as_deref().unwrap_or("").trim();
                if t.chars().count() > crate::snapshot::budget::TEXT_NODE_MIN_CHARS {
                    children.push(SimplifiedNode {
                        backend_node_id: child.backend_node_id,
                        tag: None,
                        attributes: Vec::new(),
                        text: Some(t.to_string()),
                        selector_index: None,
                        is_interactive: false,
                        is_new: false,
                        is_scrollable: false,
                        scroll_info: None,
                        frame_marker: None,
                        blind_zone: None,
                        children: Vec::new(),
                        hidden_hint: None,
                        covered: false,
                        bounds: None,
                    });
                }
            }
        }
        String::new()
    };

    // —— 可交互判定（四层短路；M1/W2 探测子树信息）——
    let wrapped = wrapped_control_probe(node);
    let ctx = DecideCtx {
        tag,
        attributes: &node.attributes,
        ax: &node.ax,
        styles: &node.styles,
        bounds: node.bounds,
        has_click_listener: node.has_click_listener,
        listener_channel_enabled: opts.listener_channel,
        is_scrollable: node.scrollable || node.styles.scroll_candidate(),
        in_svg: node.in_svg,
        ancestor_hidden: ancestors_hidden,
        subtree_has_interactive,
        wrapped_control: wrapped.0,
        wrapped_by_label_for: wrapped.1,
    };
    let decision = if node.backend_node_id >= 0 {
        cache.get_or_else(opts.session_id, node.backend_node_id, || decide(&ctx))
    } else {
        // 合成负 id（closed shadow 内部）不入缓存（同 id 复用碰撞防护）
        decide(&ctx)
    };
    let is_interactive = matches!(decision, Decision::Interactive(_));

    // 属性裁剪（白名单）+ 脱敏（D1/D2）+ 合成属性（format/options）
    let attributes = render_attrs(node, tag);

    // 复合组件恒标记新增（select/日期/文件等虚拟子组件，§3.5）
    let composite = tag == "select"
        || node.get_attr("type").is_some_and(|t| {
            ["date", "time", "datetime-local", "month", "week", "file"].contains(&t)
        });
    // 盲区/iframe 占位不参与增量标记（不可索引元素无「变化聚焦」价值，防每拍噪音）
    let is_new = opts.incremental
        && blind_zone.is_none()
        && node.frame_marker != Some(FrameMarker::Iframe)
        && ((is_interactive && !opts.previous_selector_ids.contains(&node.backend_node_id))
            || composite);

    let is_scrollable = node.scrollable || node.styles.scroll_candidate();
    let mut s = SimplifiedNode {
        backend_node_id: node.backend_node_id,
        tag: Some(tag.to_string()),
        attributes,
        text: if inline_text.is_empty() {
            None
        } else {
            Some(inline_text)
        },
        selector_index: None,
        is_interactive,
        is_new,
        is_scrollable,
        scroll_info: None,
        frame_marker: node.frame_marker,
        blind_zone,
        children,
        hidden_hint: None,
        covered: false,
        bounds: node.bounds,
    };
    if unoperable {
        s.blind_zone = Some(BlindZoneKind::ShadowClosedUnoperable);
    }
    let is_interactive_final = is_interactive;

    // —— 步骤 2（构建期执行）：容器折叠 ——
    let container = is_propagation_container(tag, &node.attributes);
    if container && s.children.iter().any(|c| c.tag.is_some()) {
        let cb = s.bounds;
        let mut kept = Vec::with_capacity(s.children.len());
        for child in s.children.drain(..) {
            let foldable = child.is_interactive
                && child.blind_zone.is_none()
                && !child.covered
                && containment_ok(cb, child.bounds)
                && !has_explicit_signal(&child);
            if foldable {
                // 折叠：文本合并进容器行（后代不单独分配索引）
                if let Some(t) = child.text.clone() {
                    let merged = match s.text.take() {
                        Some(existing) => format!("{existing} {t}"),
                        None => t,
                    };
                    s.text = Some(merged);
                }
            } else {
                kept.push(child);
            }
        }
        s.children = kept;
    }

    (s, subtree_has_interactive || is_interactive_final)
}

/// 传播型容器判定（§3.1 步骤 2：a/button 无条件；div/span 需 role=button|combobox）。
fn is_propagation_container(tag: &str, attributes: &[(String, String)]) -> bool {
    if tag == "a" || tag == "button" {
        return true;
    }
    let role_match = attributes
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("role") && (v == "button" || v == "combobox"));
    (tag == "div" || tag == "span") && role_match
}

/// 包含比例判定（containment ≥ 99%）。
fn containment_ok(container: Option<Bounds>, child: Option<Bounds>) -> bool {
    match (container, child) {
        (Some(c), Some(ch)) => c.containment(&ch) >= FOLD_CONTAINMENT,
        _ => false,
    }
}

/// 显式信号防折叠（§3.1：含 onclick/有效 aria-label/独立交互 role 的后代不折叠）。
fn has_explicit_signal(node: &SimplifiedNode) -> bool {
    node.attributes.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("onclick")
            || (k.eq_ignore_ascii_case("aria-label") && !v.is_empty())
            || (k.eq_ignore_ascii_case("role") && !v.is_empty())
    })
}
