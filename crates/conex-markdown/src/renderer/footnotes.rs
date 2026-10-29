//! 脚注：定义捕获、引用上标与文末脚注区。

use super::*;

impl FootnoteStore {
    /// 首次引用/定义时分配 1-based 编号。
    pub(super) fn ensure_number(&mut self, name: &str) -> usize {
        if let Some(number) = self.numbers.get(name).copied() {
            return number;
        }
        let number = self.order.len() + 1;
        self.order.push(name.to_string());
        self.numbers.insert(name.to_string(), number);
        number
    }
}

impl Renderer {
    pub(super) fn start_footnote_definition(&mut self, name: &str) {
        self.capture_stack.push(Capture::Footnote(FootnoteCapture {
            name: name.to_string(),
            html: String::new(),
        }));
    }

    pub(super) fn end_footnote_definition(&mut self) {
        match self.capture_stack.pop() {
            Some(Capture::Footnote(cap)) => {
                self.footnotes.ensure_number(&cap.name);
                self.footnotes.definitions.insert(cap.name, cap.html);
            }
            Some(other) => self.capture_stack.push(other),
            None => {}
        }
    }

    pub(super) fn handle_footnote_reference(&mut self, name: &str) {
        if !self.image_stack.is_empty() {
            return;
        }
        let number = self.footnotes.ensure_number(name);
        let reference_index = {
            let count = self
                .footnotes
                .reference_counts
                .entry(name.to_string())
                .or_insert(0);
            *count += 1;
            *count
        };
        let id = if reference_index == 1 {
            format!("fnref-{number}")
        } else {
            format!("fnref-{number}-{reference_index}")
        };
        let html = format!(
            "<sup class=\"md-footnote-ref\" id=\"{id}\"><a href=\"#fn-{number}\">{number}</a></sup>"
        );
        self.push_str(&html);
        self.push_plain(&number.to_string());
    }

    pub(super) fn render_footnotes_section(&mut self) {
        if self.footnotes.order.is_empty() {
            return;
        }

        let mut html = String::from(
            "<section class=\"md-footnotes\" role=\"doc-endnotes\"><ol class=\"md-footnote-list\">",
        );
        for name in self.footnotes.order.clone() {
            let Some(number) = self.footnotes.numbers.get(&name).copied() else {
                continue;
            };
            let Some(body) = self.footnotes.definitions.get(&name) else {
                continue;
            };
            html.push_str(&format!(
                "<li class=\"md-footnote-item\" id=\"fn-{number}\">{body}<a class=\"md-footnote-backref\" data-footnote-backref=\"true\" href=\"#fnref-{number}\">↩</a></li>"
            ));
        }
        html.push_str("</ol></section>");
        self.push_str(&html);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(text: &str) -> String {
        render_markdown(text, RenderOptions::chat()).html
    }

    #[test]
    fn footnote_reference_and_definition_are_linked() {
        let html = render("正文[^a]\n\n[^a]: 定义");
        assert!(html.contains("id=\"fnref-1\""));
        assert!(html.contains("href=\"#fn-1\""));
        assert!(html.contains("id=\"fn-1\""));
        assert!(html.contains("href=\"#fnref-1\""));
    }

    #[test]
    fn multiple_references_get_unique_ids() {
        let html = render("a[^x] b[^x]\n\n[^x]: 定义");
        assert!(html.contains("id=\"fnref-1\""));
        assert!(html.contains("id=\"fnref-1-2\""));
    }
}
