//! conex-markdown: Markdown 渲染内核（面 A 唯一渲染器）。
//!
//! 用 `pulldown-cmark` + `syntect`/`two-face` + `ammonia` + `moka` 实现：
//! - 标准/GFM 语法：表格、任务列表、删除线、脚注、数学、GFM Alerts（Callout）；
//! - 语义化 HTML 契约（`md-*`），代码块逐行输出、行号由 CSS counter 生成；
//! - raw HTML 逐片段白名单清洗；渲染器生成的 HTML 不经过 ammonia；
//! - chat/document 两种 softbreak 行为；
//! - 渲染结果缓存按 variant 隔离，流式渲染不写缓存。
//!
//! 公共 API：
//! - [`render_markdown`] / [`render_markdown_batch`] / [`render_markdown_stream`]
//! - [`highlight_code`] / [`highlight_code_lines`]
//! - [`clear_cache`]
//!
//! 本 crate 不承担「文档协作 IR」的解析/序列化；那是 `conex-md-ast` 的独立面。

pub mod cache;
pub mod highlight;
pub mod html;
pub mod raw_html;
pub mod renderer;
pub mod table;
pub mod types;
pub mod url_safety;

pub use highlight::{clear_cache, highlight_code, highlight_code_lines};
pub use html::{
    escape_html, escape_html_attr, escape_html_attr_into, escape_html_into,
};
pub use renderer::{
    lookup_gfm_emoji, render_markdown, render_markdown_batch, render_markdown_stream,
    translate_gfm_emoji, translate_gfm_emoji_cow, translate_gfm_emoji_with,
    translate_gfm_emoji_with_cow, GFM_EMOJI_SHORTCODES_DEFAULT,
};
pub use types::{MarkdownVariant, RenderOptions, RenderResult};

/// 输入长度上限：超过按 UTF-8 字符边界截断（5MB）。
pub const MAX_MARKDOWN_INPUT: usize = 5 * 1024 * 1024;
