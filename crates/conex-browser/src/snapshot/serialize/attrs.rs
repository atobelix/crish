//! 属性渲染：白名单裁剪 + 脱敏 + 合成属性，以及文本/属性值截断（预算 3）。

use super::state::BuildState;
use super::{ATTR_WHITELIST, DATE_FORMAT_HINTS, SELECT_OPTIONS_PREVIEW};
use crate::snapshot::collect::EnhancedNode;
use crate::snapshot::redact;

/// 属性渲染：白名单裁剪（按白名单序稳定输出）+ 脱敏 + 合成属性（format/options）。
pub(super) fn render_attrs(node: &EnhancedNode, tag: &str) -> Vec<(String, String)> {
    let redacted = redact::redact_attributes(&node.attributes);
    let mut out: Vec<(String, String)> = redacted
        .into_iter()
        .filter(|(k, _)| ATTR_WHITELIST.iter().any(|w| w.eq_ignore_ascii_case(k)))
        .collect();
    // 白名单顺序稳定输出（golden 确定性）
    out.sort_by_key(|(k, _)| {
        ATTR_WHITELIST
            .iter()
            .position(|w| w.eq_ignore_ascii_case(k))
            .unwrap_or(usize::MAX)
    });
    // 合成属性：日期/时间 format 提示
    if tag == "input" {
        if let Some(t) = node.get_attr("type") {
            if let Some((_, fmt)) = DATE_FORMAT_HINTS.iter().find(|(f, _)| *f == t) {
                out.push(("format".to_string(), fmt.to_string()));
            }
        }
    }
    // 合成属性：select options 展开（前 4 项 + 省略计数）
    if tag == "select" {
        let options: Vec<String> = node
            .children
            .iter()
            .filter(|c| c.tag.as_deref() == Some("option"))
            .map(|o| o.inline_text().trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        if !options.is_empty() {
            let preview: Vec<&str> = options
                .iter()
                .take(SELECT_OPTIONS_PREVIEW)
                .map(String::as_str)
                .collect();
            let mut s = preview.join("|");
            if options.len() > SELECT_OPTIONS_PREVIEW {
                s.push_str(&format!(
                    "|...({} more)",
                    options.len() - SELECT_OPTIONS_PREVIEW
                ));
            }
            out.push(("options".to_string(), s));
        }
    }
    out
}

/// 文本/属性值截断（预算 3：超限追加 `…`）。
pub(super) fn truncate_text(s: &str, max_len: usize, state: &mut BuildState) -> String {
    if s.chars().count() <= max_len {
        return s.to_string();
    }
    state.text_truncated += 1;
    let cut: String = s.chars().take(max_len).collect();
    format!("{cut}…")
}

/// 属性行渲染：`key=value`（值含空白加引号）。
pub(super) fn render_attr_kv(k: &str, v: &str, max_len: usize, state: &mut BuildState) -> String {
    let v = truncate_text(v, max_len, state);
    if v.is_empty() {
        return k.to_string();
    }
    if v.chars().any(|c| c.is_whitespace()) {
        format!("{k}=\"{v}\"")
    } else {
        format!("{k}={v}")
    }
}
