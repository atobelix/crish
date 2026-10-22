//! 步骤 5 序列化：紧凑文本树逐行渲染（预算 3/4 与 32KB 输出预算在此扣减）。

use super::attrs::{render_attr_kv, truncate_text};
use super::state::BuildState;
use super::{BlindZoneKind, SimplifiedNode, VOID_TAGS};
use crate::snapshot::collect::FrameMarker;

/// 序列化单节点（步骤 5）；逐行预算/输出预算在渲染过程中扣减。
#[allow(clippy::too_many_arguments)]
pub(super) fn render_node(
    node: &SimplifiedNode,
    depth: usize,
    out: &mut String,
    state: &mut BuildState,
    max_text_len: usize,
) {
    let indent = "  ".repeat(depth);

    // 折叠/截断提示行（预算 1/2/视口外）
    if let Some(hint) = node.hidden_hint.as_deref() {
        push_line(out, &format!("{indent}{hint}"), state);
        return;
    }

    // 文本节点裸文本行
    if node.tag.is_none() {
        if let Some(t) = node.text.as_deref() {
            push_line(
                out,
                &format!("{indent}{}", truncate_text(t, max_text_len, state)),
                state,
            );
        }
        return;
    }

    let tag = node.tag.as_deref().unwrap_or("");

    // 盲区占位/不可操作（无索引；占位行保留白名单描述属性——上下文检测
    // 呈现 aria-label/title/role/src 等，D4 不误伤，与 |IMG| 对齐，T-16 补齐）
    match node.blind_zone {
        Some(BlindZoneKind::Canvas) => {
            let attrs = render_attr_list(node, max_text_len, state);
            push_line(out, &format!("{indent}|CANVAS|<{tag}{attrs}>"), state);
            return;
        }
        Some(BlindZoneKind::Video) => {
            let attrs = render_attr_list(node, max_text_len, state);
            push_line(out, &format!("{indent}|VIDEO|<{tag}{attrs}>"), state);
            return;
        }
        Some(BlindZoneKind::Image) => {
            let attrs = render_attr_list(node, max_text_len, state);
            push_line(out, &format!("{indent}|IMG|<{tag}{attrs}>"), state);
            return;
        }
        Some(BlindZoneKind::ShadowClosedUnoperable) => {
            let attrs = render_attr_list(node, max_text_len, state);
            let text = node.text.as_deref().unwrap_or("");
            let line = if text.is_empty() {
                format!("{indent}|UNOPERABLE|<{tag}{attrs} />")
            } else {
                let text_part = truncate_text(text, max_text_len, state);
                format!("{indent}|UNOPERABLE|<{tag}{attrs}>{text_part}</{tag}>")
            };
            push_line(out, &line, state);
            return;
        }
        None => {}
    }

    // shadow 标记（开放/封闭 shadow root 行 + Shadow End）
    match node.frame_marker {
        Some(FrameMarker::ShadowOpen) => {
            push_line(out, &format!("{indent}|SHADOW(open)|"), state);
            for child in &node.children {
                render_node(child, depth + 1, out, state, max_text_len);
            }
            push_line(out, &format!("{}Shadow End", "  ".repeat(depth + 1)), state);
            return;
        }
        Some(FrameMarker::ShadowClosed) => {
            push_line(out, &format!("{indent}|SHADOW(closed)|"), state);
            for child in &node.children {
                render_node(child, depth + 1, out, state, max_text_len);
            }
            push_line(out, &format!("{}Shadow End", "  ".repeat(depth + 1)), state);
            return;
        }
        _ => {}
    }

    // 常规元素行
    let star = if node.is_new { "*" } else { "" };
    let idx = match node.selector_index {
        Some(i) => format!("[{i}]"),
        None => String::new(),
    };
    let iframe = if node.frame_marker == Some(FrameMarker::Iframe) {
        "|IFRAME|"
    } else {
        ""
    };
    let scroll = if node.is_scrollable { "|scroll|" } else { "" };
    let attrs = render_attr_list(node, max_text_len, state);
    let text = node.text.as_deref().unwrap_or("");

    let line = if !text.is_empty() {
        let text_part = truncate_text(text, max_text_len, state);
        if VOID_TAGS.contains(&tag) {
            format!("{indent}{iframe}{star}{idx}<{tag}{attrs} />{scroll}")
        } else {
            format!("{indent}{iframe}{star}{idx}<{tag}{attrs}>{text_part}</{tag}>{scroll}")
        }
    } else {
        format!("{indent}{iframe}{star}{idx}<{tag}{attrs} />{scroll}")
    };
    push_line(out, &line, state);

    for child in &node.children {
        render_node(child, depth + 1, out, state, max_text_len);
    }
}

/// 属性列表渲染（白名单顺序输出；`key=value`，值含空白加引号）。
fn render_attr_list(node: &SimplifiedNode, max_len: usize, state: &mut BuildState) -> String {
    let mut parts = Vec::new();
    for (k, v) in &node.attributes {
        parts.push(render_attr_kv(k, v, max_len, state));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" {}", parts.join(" "))
    }
}

/// 行输出（带 32KB 输出预算扣减；预算耗尽即停）。
fn push_line(out: &mut String, line: &str, state: &mut BuildState) {
    if state.output_left == 0 {
        return;
    }
    let bytes = line.len();
    if bytes > state.output_left {
        state.output_left = 0;
        return;
    }
    state.output_left -= bytes;
    out.push_str(line);
    out.push('\n');
}
