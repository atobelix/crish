//! conex-markdown: Rust markdown 渲染 crate
//!
//! 用 pulldown-cmark + syntect + ammonia + moka 实现,替代 JS 主线程同步渲染。
//!
//! 公共 API:
//! - [`render_markdown`] — 渲染单条 markdown 为 HTML
//! - [`render_markdown_batch`] — 批量渲染
//! - [`render_markdown_stream`] — 流式渲染（stream_mode=true 跳过 syntect 高亮）
//! - [`highlight_code`] — 代码块高亮
//! - [`clear_cache`] — 清空缓存
//!
//! 设计契约: HTML 输出 byte-for-byte 兼容现有 CSS 选择器
//! (`md-rendered` / `code-fence` / `md-tr-alt` / `md-task-item` 等)。

pub mod ammonia_config;
pub mod cache;
pub mod highlight;
pub mod renderer;
pub mod sanitizer;
pub mod table;

pub use highlight::{clear_cache, highlight_code};
pub use renderer::{
    lookup_gfm_emoji, render_markdown, render_markdown_batch, render_markdown_stream,
    strip_thought_placeholders, translate_gfm_emoji, translate_gfm_emoji_with,
    GFM_EMOJI_SHORTCODES_DEFAULT,
};

/// 输入长度上限:超过截断(5MB),避免恶意长输入拖垮渲染线程,杜绝100KB~256KB文件静默截断。
pub const MAX_MARKDOWN_INPUT: usize = 5 * 1024 * 1024;

/// 渲染过程中产生的错误类型。
#[derive(Debug, thiserror::Error)]
pub enum MarkdownError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("internal: {0}")]
    Internal(String),
}
