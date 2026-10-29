//! Stream A: Tauri 命令层 —— Rust Markdown 渲染入口。
//!
//! 包装 `conex_markdown` 的渲染 API：
//! - `core_md_render`：单条渲染（带缓存）
//! - `core_md_render_batch`：批量渲染（每条独立缓存）
//! - `core_md_render_stream`：流式渲染（跳过 syntect 高亮，不写缓存）
//!
//! CPU 密集操作统一走 `tokio::task::spawn_blocking`。命令返回
//! `{ html, truncated }`：输入超过 5MB 时按 UTF-8 边界截断，`truncated=true`
//! 由前端提示，不再静默丢数据。
//!
//! 对应 JS wrapper：`crish-desktop/src/api/rustCore.ts`。

use conex_types::CoreError;
use serde::Serialize;

use conex_markdown::{MarkdownVariant, RenderOptions, RenderResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderResultDto {
    pub html: String,
    pub truncated: bool,
}

impl From<RenderResult> for RenderResultDto {
    fn from(result: RenderResult) -> Self {
        Self {
            html: result.html,
            truncated: result.truncated,
        }
    }
}

fn parse_options(variant: &str) -> Result<RenderOptions, CoreError> {
    let variant = MarkdownVariant::parse(variant).ok_or_else(|| {
        CoreError::InvalidInput(format!(
            "unknown markdown variant: {variant} (expected chat|document)"
        ))
    })?;
    Ok(RenderOptions::new(variant))
}

/// 渲染单条 markdown 为 HTML。
///
/// wire 名 = `core_md_render`。结果自带 LRU 缓存（按 variant 隔离）。
#[tauri::command(rename = "core_md_render")]
pub async fn md_render(text: String, variant: String) -> Result<RenderResultDto, CoreError> {
    let options = parse_options(&variant)?;
    tokio::task::spawn_blocking(move || {
        RenderResultDto::from(conex_markdown::render_markdown(&text, options))
    })
    .await
    .map_err(|e| CoreError::Internal(format!("md_render join: {e}")))
}

/// 批量渲染 markdown 为 HTML。
///
/// wire 名 = `core_md_render_batch`。首屏/历史消息应走这里，避免 N 次 IPC。
#[tauri::command(rename = "core_md_render_batch")]
pub async fn md_render_batch(
    texts: Vec<String>,
    variant: String,
) -> Result<Vec<RenderResultDto>, CoreError> {
    let options = parse_options(&variant)?;
    tokio::task::spawn_blocking(move || {
        conex_markdown::render_markdown_batch(texts, options)
            .into_iter()
            .map(RenderResultDto::from)
            .collect()
    })
    .await
    .map_err(|e| CoreError::Internal(format!("md_render_batch join: {e}")))
}

/// 流式渲染 markdown 为 HTML。
///
/// wire 名 = `core_md_render_stream`。`stream_mode=true` 跳过 syntect 高亮，
/// 输出与完成态一致的行 span 外壳；不写缓存（流式片段唯一，缓存无收益）。
#[tauri::command(rename = "core_md_render_stream")]
pub async fn md_render_stream(text: String, variant: String) -> Result<RenderResultDto, CoreError> {
    let options = parse_options(&variant)?;
    tokio::task::spawn_blocking(move || {
        RenderResultDto::from(conex_markdown::render_markdown_stream(&text, options))
    })
    .await
    .map_err(|e| CoreError::Internal(format!("md_render_stream join: {e}")))
}
