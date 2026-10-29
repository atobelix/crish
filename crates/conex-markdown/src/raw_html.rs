//! 不可信 raw HTML 片段清洗。
//!
//! # 两个 HTML 人口
//!
//! - **可信生成 HTML**：渲染器自己拼出的 `md-*` 结构、代码块、表格、Callout、
//!   Island 占位。它们不经过 ammonia，避免清洗器误杀自有结构与属性。
//! - **不可信 raw HTML**：Markdown 中的 `Event::Html` / `Event::InlineHtml`。
//!   在这里逐片段清洗，只放行语义化安全标签与最小属性集。
//!
//! 这样既恢复了 `<details>/<kbd>/<mark>/<sub>/<sup>` 等正常排版能力，又不会
//! 让用户 raw HTML 伪造应用内部 class、`data-*` 或交互按钮。

use ammonia::{Builder, UrlRelative};
use once_cell::sync::Lazy;
use std::borrow::Cow;

use crate::url_safety::{is_safe_href, is_safe_img_src};

/// 全局只读 ammonia 配置（配置一次，永久复用）。
pub static RAW_HTML_BUILDER: Lazy<Builder<'static>> = Lazy::new(build_raw_html_builder);

fn build_raw_html_builder() -> Builder<'static> {
    let mut b = Builder::default();

    // 语义化排版标签。刻意不含 button/input/script/style/iframe/form 等
    // 可执行或可伪造交互的标签；任务列表 checkbox 由渲染器自己生成，不走这里。
    b.add_tags([
        "a", "abbr", "b", "blockquote", "br", "caption", "code", "dd", "del", "details", "div",
        "dl", "dt", "em", "figcaption", "figure", "hr", "i", "img", "kbd", "li", "mark", "ol",
        "p", "pre", "q", "s", "section", "small", "span", "strong", "sub", "summary", "sup",
        "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
    ]);

    b.add_tag_attributes("a", ["href", "title"]);
    b.add_tag_attributes("img", ["src", "alt", "title", "width", "height", "loading"]);
    b.add_tag_attributes("details", ["open"]);
    b.add_tag_attributes("ol", ["start", "reversed"]);
    b.add_tag_attributes("th", ["colspan", "rowspan", "align"]);
    b.add_tag_attributes("td", ["colspan", "rowspan", "align"]);
    b.add_tag_attributes("div", ["align"]);
    b.add_tag_attributes("p", ["align"]);
    b.add_tag_attributes("abbr", ["title"]);
    b.add_tag_attributes("q", ["cite"]);

    // 只允许 http/https/mailto/data；data 的细粒度限制在 attribute_filter 中
    // 按标签区分（a[href] 拒绝 data，img[src] 仅允许光栅 data:image）。
    b.add_url_schemes(["http", "https", "mailto", "data"]);
    b.url_relative(UrlRelative::PassThrough);
    b.link_rel(Some("noopener noreferrer"));

    b.attribute_filter(|element, attribute, value| {
        match (element, attribute) {
            ("a", "href") => {
                if is_safe_href(value) {
                    Some(Cow::Borrowed(value))
                } else {
                    None
                }
            }
            ("img", "src") => {
                if is_safe_img_src(value) {
                    Some(Cow::Borrowed(value))
                } else {
                    None
                }
            }
            _ => Some(Cow::Borrowed(value)),
        }
    });

    b
}

/// 清洗一个不可信 raw HTML 片段。白名单外标签/属性一律丢弃。
pub fn sanitize_fragment(html: &str) -> String {
    RAW_HTML_BUILDER.clean(html).to_string()
}

/// 计算片段内未闭合 HTML 标签的净深度（开标签 - 闭标签）。
///
/// 用于跨事件拼接 raw HTML：pulldown-cmark 会把 `<kbd>Ctrl</kbd>` 拆成
/// 开标签 / 文本 / 闭标签三个事件，逐片段清洗会让文本落到标签外。
pub fn html_tag_delta(html: &str) -> i32 {
    let bytes = html.as_bytes();
    let mut depth = 0i32;
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }

        // 注释 / doctype / CDATA / 处理指令：整体跳过。
        if html[i..].starts_with("<!--") {
            match html[i + 4..].find("-->") {
                Some(end) => i += 4 + end + 3,
                None => break,
            }
            continue;
        }
        let next = bytes.get(i + 1).copied().unwrap_or(0);
        if next == b'!' || next == b'?' {
            match html[i..].find('>') {
                Some(end) => i += end + 1,
                None => break,
            }
            continue;
        }

        let mut j = i + 1;
        let closing = bytes.get(j).copied() == Some(b'/');
        if closing {
            j += 1;
        }
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        let name_start = j;
        while j < bytes.len()
            && (bytes[j].is_ascii_alphanumeric()
                || bytes[j] == b'-'
                || bytes[j] == b':')
        {
            j += 1;
        }
        if j == name_start {
            i += 1;
            continue;
        }
        let name = html[name_start..j].to_ascii_lowercase();

        // 找到标签结束 `>`，跳过引号内的内容。
        let mut quote: Option<u8> = None;
        let mut end = None;
        while j < bytes.len() {
            let ch = bytes[j];
            match quote {
                Some(q) if ch == q => quote = None,
                Some(_) => {}
                None if ch == b'\'' || ch == b'"' => quote = Some(ch),
                None if ch == b'>' => {
                    end = Some(j);
                    break;
                }
                None => {}
            }
            j += 1;
        }
        let Some(end) = end else {
            break;
        };

        let self_closing = bytes
            .get(end.saturating_sub(1))
            .copied()
            .map(|b| b == b'/')
            .unwrap_or(false);
        let void = matches!(
            name.as_str(),
            "area"
                | "base"
                | "br"
                | "col"
                | "embed"
                | "hr"
                | "img"
                | "input"
                | "link"
                | "meta"
                | "param"
                | "source"
                | "track"
                | "wbr"
        );

        if !void && !self_closing {
            depth += if closing { -1 } else { 1 };
        }
        i = end + 1;
    }

    depth
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_semantic_tags_users_need() {
        let html = sanitize_fragment(
            "<details open><summary>日志</summary><kbd>Ctrl</kbd> <mark>高亮</mark> H<sub>2</sub>O O(N<sup>2</sup>) <u>下划线</u> <abbr title=\"HyperText\">HTML</abbr></details>",
        );
        assert!(html.contains("<details"));
        assert!(html.contains("<summary>"));
        assert!(html.contains("<kbd>"));
        assert!(html.contains("<mark>"));
        assert!(html.contains("<sub>"));
        assert!(html.contains("<sup>"));
        assert!(html.contains("<u>"));
        assert!(html.contains("<abbr"));
    }

    #[test]
    fn strips_scripts_events_and_classes() {
        let html = sanitize_fragment(
            "<script>alert(1)</script><p class=\"md-code-copy\" onclick=\"alert(1)\">x</p>",
        );
        assert!(!html.contains("<script"));
        assert!(!html.contains("onclick"));
        assert!(!html.contains("md-code-copy"));
    }

    #[test]
    fn rejects_unsafe_link_and_image_schemes() {
        let html = sanitize_fragment(
            "<a href=\"javascript:alert(1)\">x</a><img src=\"data:image/svg+xml;base64,AAA\">",
        );
        assert!(!html.contains("javascript:"));
        assert!(!html.contains("data:image/svg"));
    }

    #[test]
    fn keeps_safe_links_and_raster_data_images() {
        let html = sanitize_fragment(
            "<a href=\"https://example.com\">ok</a><img src=\"data:image/png;base64,AAA\" alt=\"a\">",
        );
        assert!(html.contains("https://example.com"));
        assert!(html.contains("data:image/png"));
    }

    #[test]
    fn strips_user_data_attributes_and_style() {
        let html = sanitize_fragment(
            "<div data-md-island=\"mermaid\" style=\"color:red\" id=\"x\">x</div>",
        );
        assert!(!html.contains("data-md-island"));
        assert!(!html.contains("style="));
        assert!(!html.contains("id="));
    }

    #[test]
    fn keeps_common_table_attributes() {
        let html = sanitize_fragment(
            "<table><thead><tr><th colspan=\"2\" align=\"center\">X</th></tr></thead><tbody><tr><td rowspan=\"2\">a</td></tr></tbody></table>",
        );
        assert!(html.contains("colspan=\"2\""));
        assert!(html.contains("rowspan=\"2\""));
        assert!(html.contains("align=\"center\""));
    }

    #[test]
    fn html_tag_delta_tracks_open_and_close_tags() {
        assert_eq!(html_tag_delta("<kbd>"), 1);
        assert_eq!(html_tag_delta("</kbd>"), -1);
        assert_eq!(html_tag_delta("<kbd>Ctrl</kbd>"), 0);
        assert_eq!(html_tag_delta("<details><summary>More</summary>"), 1);
        assert_eq!(html_tag_delta("<br><img src=\"x\">"), 0);
        assert_eq!(html_tag_delta("<div class=\"a>b\">"), 1);
        assert_eq!(html_tag_delta("<!-- <div> -->"), 0);
        assert_eq!(html_tag_delta("<!DOCTYPE html>"), 0);
        assert_eq!(html_tag_delta("<details>"), 1);
        assert_eq!(html_tag_delta("</details>"), -1);
    }
}
