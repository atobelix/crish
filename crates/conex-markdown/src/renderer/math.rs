//! 数学公式：Rust 只产出 Island 占位，KaTeX 由前端按需注水。

use super::*;
use crate::html::{escape_html, escape_html_attr};

impl Renderer {
    pub(super) fn handle_inline_math(&mut self, tex: &str) {
        if let Some(image) = self.image_stack.last_mut() {
            image.alt.push_str(tex);
            return;
        }
        let html = format!(
            "<span class=\"md-math md-math-inline\" data-md-island=\"math\" data-tex=\"{}\">${}$</span>",
            escape_html_attr(tex),
            escape_html(tex)
        );
        self.push_str(&html);
        self.push_plain(tex);
    }

    pub(super) fn handle_display_math(&mut self, tex: &str) {
        if !self.image_stack.is_empty() {
            return;
        }

        // DisplayMath 若发生在段落内，先闭合段落，避免 <div> 嵌进 <p>。
        let reopen_paragraph = self.paragraph_open && !self.paragraph_in_list_item;
        if reopen_paragraph {
            self.push_str("</p>");
            self.paragraph_open = false;
        }

        let html = format!(
            "<div class=\"md-math md-math-block\" data-md-island=\"math\" data-tex=\"{}\">$${}$$</div>",
            escape_html_attr(tex),
            escape_html(tex)
        );
        self.push_str(&html);

        if reopen_paragraph {
            self.paragraph_open = true;
            self.push_str("<p class=\"md-p\">");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_math_becomes_island() {
        let html = render_markdown("$E=mc^2$", RenderOptions::chat()).html;
        assert!(html.contains("data-md-island=\"math\""));
        assert!(html.contains("data-tex=\"E=mc^2\""));
    }

    #[test]
    fn display_math_is_not_nested_inside_paragraph() {
        let html = render_markdown("$$\nx^2\n$$", RenderOptions::chat()).html;
        assert!(html.contains("md-math-block"));
        assert!(!html.contains("<p class=\"md-p\"><div"));
    }
}
