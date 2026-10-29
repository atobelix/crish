//! 链接、图片与本地路径按钮。

use super::*;
use crate::url_safety::{
    file_url_to_path, is_local_path_ref, is_safe_href, is_safe_img_src, link_destination_url,
    sanitize_url_candidate,
};

impl Renderer {
    pub(super) fn start_link(&mut self, dest: &str) {
        // 图片 alt 内的链接只收文本，不输出标签。
        if !self.image_stack.is_empty() {
            self.link_stack.push(LinkKind::Suppressed);
            return;
        }

        let url = link_destination_url(dest);

        if let Some(path) = file_url_to_path(&url) {
            self.start_path_button(&path);
            self.link_stack.push(LinkKind::PathLink);
            return;
        }

        if is_local_path_ref(&url) {
            let path = sanitize_url_candidate(&url);
            self.start_path_button(&path);
            self.link_stack.push(LinkKind::PathLink);
            return;
        }

        if !is_safe_href(&url) {
            self.push_str("<span class=\"md-a-unsafe\">");
            self.link_stack.push(LinkKind::Unsafe);
            return;
        }

        let safe = sanitize_url_candidate(&url);
        self.push_str("<a class=\"md-a\" href=\"");
        self.push_escaped_attr(&safe);
        self.push_str("\"");
        if is_external_href(&safe) {
            self.push_str(" target=\"_blank\" rel=\"noreferrer\"");
        }
        self.push_str(">");
        self.link_stack.push(LinkKind::Anchor);
    }

    pub(super) fn end_link(&mut self) {
        match self.link_stack.pop() {
            Some(LinkKind::Anchor) => self.push_str("</a>"),
            Some(LinkKind::PathLink) => self.push_str("</button>"),
            Some(LinkKind::Unsafe) => self.push_str("</span>"),
            Some(LinkKind::Suppressed) | None => {}
        }
    }

    pub(super) fn start_image(&mut self, dest: &str, title: &str) {
        let url = link_destination_url(dest);
        let safe_url = if is_safe_img_src(&url) {
            Some(sanitize_url_candidate(&url))
        } else {
            None
        };
        self.image_stack.push(ImageState {
            safe_url,
            title: title.to_string(),
            alt: String::new(),
        });
    }

    pub(super) fn end_image(&mut self) {
        let Some(image) = self.image_stack.pop() else {
            return;
        };
        let alt = image.alt;

        if let Some(url) = image.safe_url {
            if is_remote_http_url(&url) {
                // 远程图片默认不直接加载（CSP 亦不允许 https:），渲染为可点击链接，
                // 由用户显式决定是否交给系统浏览器打开。
                self.push_str(
                    "<a class=\"md-image-remote\" href=\"",
                );
                self.push_escaped_attr(&url);
                self.push_str("\" target=\"_blank\" rel=\"noreferrer\">");
                if alt.is_empty() {
                    self.push_escaped(&url);
                } else {
                    self.push_escaped(&alt);
                }
                self.push_str("</a>");
            } else {
                self.push_str("<img class=\"md-img\" src=\"");
                self.push_escaped_attr(&url);
                self.push_str("\" alt=\"");
                self.push_escaped_attr(&alt);
                self.push_str("\"");
                if !image.title.is_empty() {
                    self.push_str(" title=\"");
                    self.push_escaped_attr(&image.title);
                    self.push_str("\"");
                }
                self.push_str(" loading=\"lazy\">");
            }
        } else {
            // 不安全图片降级为 alt 文本（绝不输出 src）。
            self.push_escaped(&alt);
        }

        // 标题里的图片把 alt 计入 slug 纯文本。
        self.push_plain(&alt);
    }

    pub(super) fn push_path_button(&mut self, path: &str) {
        self.start_path_button(path);
        self.push_escaped(path);
        self.push_str("</button>");
    }

    /// 打开路径按钮标签；链接标签文本随后由正常 inline 事件写入，`end_link` 闭合。
    fn start_path_button(&mut self, path: &str) {
        self.push_str("<button type=\"button\" class=\"md-path-link\" data-path=\"");
        self.push_escaped_attr(path);
        self.push_str("\">");
    }
}

fn is_external_href(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
}

fn is_remote_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(text: &str) -> String {
        render_markdown(text, RenderOptions::chat()).html
    }

    #[test]
    fn external_links_get_target_blank() {
        let html = render("[ex](https://example.com)");
        assert!(html.contains("target=\"_blank\""));
        assert!(html.contains("rel=\"noreferrer\""));
    }

    #[test]
    fn anchors_do_not_get_target_blank() {
        let html = render("[local](#section)");
        assert!(html.contains("href=\"#section\""));
        assert!(!html.contains("target=\"_blank\""));
    }

    #[test]
    fn file_urls_become_path_buttons() {
        let html = render("[doc](file:///C:/Workspace/docs/a.md)");
        assert!(html.contains("md-path-link"));
        assert!(html.contains("data-path=\"C:/Workspace/docs/a.md\""));
        assert!(html.contains(">doc</button>"));
        assert!(!html.contains("<a class=\"md-a\""));
    }

    #[test]
    fn local_path_link_uses_label_not_duplicate_path() {
        let html = render("[Local path](src/loop/loop_exec.rs:22)");
        assert!(html.contains("data-path=\"src/loop/loop_exec.rs:22\""));
        assert!(html.contains(">Local path</button>"));
        assert!(!html.contains("</button>Local path"));
    }

    #[test]
    fn link_labels_do_not_nest_path_buttons() {
        let html = render("[src/main.ts](https://example.com)");
        assert!(html.contains("href=\"https://example.com\""));
        assert!(!html.contains("md-path-link"));
        assert!(html.contains(">src/main.ts</a>"));
    }

    #[test]
    fn unsafe_links_become_spans() {
        let html = render("[x](javascript:alert(1))");
        assert!(html.contains("md-a-unsafe"));
        assert!(!html.contains("href=\"javascript"));
    }

    #[test]
    fn unsafe_images_fall_back_to_alt_text() {
        let html = render("![alt](data:image/svg+xml;base64,AAA)");
        assert!(html.contains("alt"));
        assert!(!html.contains("<img"));
    }

    #[test]
    fn image_alt_is_plain_text_even_with_emphasis() {
        let html = render("![**bold** alt](data:image/png;base64,AAA)");
        assert!(html.contains("alt=\"bold alt\""));
        assert!(!html.contains("<em>bold</em>"));
    }

    #[test]
    fn remote_images_become_links_not_embedded_images() {
        let html = render("![remote](https://example.com/a.png)");
        assert!(html.contains("md-image-remote"));
        assert!(!html.contains("<img"));
        assert!(html.contains("href=\"https://example.com/a.png\""));
    }
}
