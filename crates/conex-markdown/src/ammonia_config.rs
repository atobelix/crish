//! ammonia 白名单配置: 渲染产出的 HTML 标签/属性/scheme 全部显式放行。
//!
//! 与 pulldown-cmark 渲染器协作: pulldown-cmark 不启用 ENABLE_HTML,
//! 所有 raw HTML 默认 escape;仅 `<img ...>` 单独透传给 ammonia 兜底
//! (用于 strip onerror 等危险事件处理器)。
//!
//! 一次到位 sanitize,移除组件层 DOMPurify (Stream C 工作)。

use ammonia::{Builder, UrlRelative};
use once_cell::sync::Lazy;

/// 全局 ammonia 清理器(配置后只读,可复用)。
pub static AMMONIA_BUILDER: Lazy<Builder<'static>> = Lazy::new(build_ammonia);

fn build_ammonia() -> Builder<'static> {
    let mut b = Builder::default();

    // 允许的标签(覆盖 markdown 全部输出 + 高亮 span + 表格)
    b.add_tags([
        "a", "abbr", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4",
        "h5", "h6", "hr", "i", "img", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "small",
        "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
        "u", "ul", "wbr", "button",
    ]);

    // 全局允许 class — 我们生成的 class 都是已知安全的(md-*, hljs-*, language-*)
    b.add_generic_attributes(["class"]);

    // 各标签的额外属性
    b.add_tag_attributes("a", ["href", "target", "rel", "title"]);
    b.add_tag_attributes("img", ["src", "alt", "loading", "width", "height", "title"]);
    b.add_tag_attributes("button", ["type", "data-path", "title", "aria-label", "disabled"]);
    b.add_tag_attributes("span", ["data-lang", "aria-label", "title"]);
    b.add_tag_attributes("div", ["data-lang", "role", "aria-label", "title"]);
    b.add_tag_attributes("ol", ["start", "reversed"]);
    b.add_tag_attributes("th", ["scope", "style", "colspan", "rowspan"]);
    b.add_tag_attributes("td", ["style", "colspan", "rowspan"]);
    b.add_tag_attributes("h1", ["id"]);
    b.add_tag_attributes("h2", ["id"]);
    b.add_tag_attributes("h3", ["id"]);
    b.add_tag_attributes("h4", ["id"]);
    b.add_tag_attributes("h5", ["id"]);
    b.add_tag_attributes("h6", ["id"]);
    b.add_tag_attributes("abbr", ["title"]);
    b.add_tag_attributes("q", ["cite"]);

    // 允许的 URL scheme (http/https/mailto/data:image*)
    // data: 限定到 image/(png|jpeg|gif|webp|avif|bmp) 通过 link_attributes filter 完成,
    // 但 ammonia 的 allowed_schemes 是 scheme 级别;data: 整体放行后由渲染器侧 is_safe_img_src 守门。
    b.add_url_schemes(["http", "https", "mailto", "data"]);

    // 相对 URL 不做改写(本地路径由前端处理)
    b.url_relative(UrlRelative::PassThrough);

    // 不额外加 rel=noreferrer(target=_blank 已由渲染器写 rel="noreferrer")
    b.link_rel(None);

    b
}

/// 用 ammonia 清理 HTML,白名单外标签/属性一律丢弃。
pub fn sanitize(html: &str) -> String {
    AMMONIA_BUILDER.clean(html).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_onerror_from_img() {
        let cleaned = sanitize("<img src=\"x\" onerror=\"alert(1)\" alt=\"a\">");
        assert!(cleaned.contains("<img"));
        assert!(cleaned.contains("src=\"x\""));
        assert!(!cleaned.contains("onerror"));
    }

    #[test]
    fn sanitize_keeps_md_classes() {
        let cleaned = sanitize("<p class=\"md-p\">hi</p>");
        assert!(cleaned.contains("class=\"md-p\""));
    }

    #[test]
    fn sanitize_drops_script_tag() {
        // 注意: 渲染器已 escape <script>;ammonia 是兜底,会删除未 escape 的 script
        let cleaned = sanitize("<p>hi</p><script>alert(1)</script>");
        assert!(!cleaned.contains("<script"));
    }

    #[test]
    fn sanitize_keeps_table_alignment_style() {
        // th 必须在 table 上下文中,否则 html5ever 会 foster-parent 并丢弃 th 标签
        let cleaned = sanitize(
            "<table><thead><tr><th class=\"md-th\" style=\"text-align:right\">x</th></tr></thead></table>",
        );
        assert!(
            cleaned.contains("text-align:right"),
            "expected style attr preserved, got: {cleaned}"
        );
    }
}
