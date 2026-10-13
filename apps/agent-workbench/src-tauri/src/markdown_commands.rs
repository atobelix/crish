//! Stream A: Tauri 命令层 —— Rust Markdown 渲染入口
//!
//! 本模块提供 2 个 `#[tauri::command]`，包装 `conex_markdown` 的渲染 API，
//! 替代 JS 主线程同步渲染（长会话首屏 4-15s 卡顿的根因）。
//! CPU 密集操作统一走 `tokio::task::spawn_blocking`，参考 `core_commands.rs` 模式。
//!
//! 命令错误统一为 `CoreError`（serde tagged enum），JS 侧可按 `error.kind` 分类处理。
//!
//! 对应 JS wrapper: `crish-desktop/src/api/rustCore.ts` 中的
//! `renderMarkdown` / `renderMarkdownBatch`。

use conex_types::CoreError;

/// 渲染单条 markdown 为 HTML。
///
/// - 输入超长（>5MB，`conex_markdown::MAX_MARKDOWN_INPUT`）由 crate 内部按 UTF-8 字符边界安全截断，不返回错误
/// - CPU 密集（pulldown-cmark 解析 + syntect 高亮 + ammonia sanitize），走 spawn_blocking
/// - 结果自带 LRU 缓存（moka），重复输入 O(1) 命中
///
/// wire 名 = `core_md_render`（T03.4 更名 core_md_*，并入 core 族；与
/// command_manifest.rs / 前端 BUILTIN_COMMAND_MANIFEST 保持一致）。
#[tauri::command(rename = "core_md_render")]
pub async fn md_render(text: String) -> Result<String, CoreError> {
    tokio::task::spawn_blocking(move || conex_markdown::render_markdown(&text))
        .await
        .map_err(|e| CoreError::Internal(format!("md_render join: {e}")))
}

/// 批量渲染 markdown 为 HTML。
///
/// 用于首屏一次性渲染整个会话的多条消息，避免 N 次 IPC 往返。
/// 每条独立享受 moka LRU 缓存命中。
///
/// wire 名 = `core_md_render_batch`（T03.4 更名 core_md_*）。
#[tauri::command(rename = "core_md_render_batch")]
pub async fn md_render_batch(texts: Vec<String>) -> Result<Vec<String>, CoreError> {
    tokio::task::spawn_blocking(move || conex_markdown::render_markdown_batch(texts))
        .await
        .map_err(|e| CoreError::Internal(format!("md_render_batch join: {e}")))
}
