//! `conex-markdown` 公共类型：渲染变体、选项与结果。
//!
//! 这些类型不依赖任何渲染实现，供 cache / renderer / Tauri 命令层共享。

/// 渲染面变体。
///
/// - `Chat`：对话流，软换行渲染为 `<br>`，紧凑排版；
/// - `Document`：文档预览，软换行渲染为空格，长文排版。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MarkdownVariant {
    #[default]
    Chat,
    Document,
}

impl MarkdownVariant {
    /// 解析 Tauri/字符串入口的 variant；未知值返回 None。
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "chat" => Some(Self::Chat),
            "document" | "doc" => Some(Self::Document),
            _ => None,
        }
    }

    /// 稳定字符串标识（缓存键/诊断用）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Document => "document",
        }
    }

    /// 软换行是否渲染为硬换行。
    pub fn soft_break_as_br(self) -> bool {
        matches!(self, Self::Chat)
    }
}

/// 渲染选项。保持最小：variant 决定软换行与少量结构差异，
/// 其他能力（GFM/脚注/数学/Callout/raw HTML）一律默认开启，不设 flag 矩阵。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RenderOptions {
    pub variant: MarkdownVariant,
}

impl RenderOptions {
    pub fn new(variant: MarkdownVariant) -> Self {
        Self { variant }
    }

    pub fn chat() -> Self {
        Self::new(MarkdownVariant::Chat)
    }

    pub fn document() -> Self {
        Self::new(MarkdownVariant::Document)
    }
}

/// 单次渲染结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderResult {
    pub html: String,
    /// 输入超过 `MAX_MARKDOWN_INPUT` 时按 UTF-8 边界截断，前端应显示提示。
    pub truncated: bool,
}

impl RenderResult {
    pub fn empty() -> Self {
        Self {
            html: String::new(),
            truncated: false,
        }
    }
}
