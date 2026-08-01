//! Stream A: Tauri 命令层 —— Rust Markdown 渲染入口
//!
//! 本模块提供 5 个 `#[tauri::command]`，包装 `conex_markdown` 的渲染 API，
//! 替代 JS 主线程同步渲染（长会话首屏 4-15s 卡顿的根因）。
//! CPU 密集操作统一走 `tokio::task::spawn_blocking`，参考 `core_commands.rs` 模式。
//!
//! 命令错误统一为 `CoreError`（serde tagged enum），JS 侧可按 `error.kind` 分类处理。
//!
//! 对应 JS wrapper: `crish-desktop/src/api/rustCore.ts` 中的
//! `renderMarkdown` / `renderMarkdownBatch` / `renderMarkdownStream` / `highlightCode` / `clearMarkdownCache`。

use conex_types::CoreError;

/// 渲染单条 markdown 为 HTML。
///
/// - 输入超长（>100KB）由 crate 内部截断，不返回错误
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
/// 内部串行调用 `render_markdown`（每条独立缓存命中）。
///
/// wire 名 = `core_md_render_batch`（T03.4 更名 core_md_*）。
#[tauri::command(rename = "core_md_render_batch")]
pub async fn md_render_batch(texts: Vec<String>) -> Result<Vec<String>, CoreError> {
    tokio::task::spawn_blocking(move || conex_markdown::render_markdown_batch(texts))
        .await
        .map_err(|e| CoreError::Internal(format!("md_render_batch join: {e}")))
}

/// 流式渲染 markdown 为 HTML。
///
/// - `stream_mode = true`：跳过 syntect 高亮（Rust 侧快速路径），用于完成态渲染的
///   流式 fallback 或 Rust 侧测试。流式期主路径是 JS IncrementalMarkdownParser（零 IPC）。
/// - `stream_mode = false`：等价于 `md_render`（完整渲染 + 缓存）。
///
/// CPU 密集（pulldown-cmark 解析 + 可选 syntect 高亮 + ammonia sanitize），走 spawn_blocking。
///
/// wire 名 = `core_md_render_stream`（T03.4 更名 core_md_*）。
#[tauri::command(rename = "core_md_render_stream")]
pub async fn md_render_stream(text: String, stream_mode: bool) -> Result<String, CoreError> {
    tokio::task::spawn_blocking(move || {
        conex_markdown::render_markdown_stream(&text, stream_mode)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("md_render_stream join: {e}")))
}

/// 代码高亮（不包 `<code>` 标签，仅返回内部 HTML 片段）。
///
/// - 已知语言：syntect class style 输出 `<span class="...">`
/// - 未知/无语言：HTML escape
/// - 结果自带 LRU 缓存
///
/// wire 名 = `core_highlight_code`（T03.4 更名 core_*）。
#[tauri::command(rename = "core_highlight_code")]
pub async fn highlight_code(code: String, lang: Option<String>) -> Result<String, CoreError> {
    tokio::task::spawn_blocking(move || {
        conex_markdown::highlight_code(&code, lang.as_deref())
    })
    .await
    .map_err(|e| CoreError::Internal(format!("highlight_code join: {e}")))
}

/// 清空 markdown 渲染缓存与代码高亮缓存。
///
/// 用于内存压力场景或测试隔离。正常运行时无需调用（moka 自动 LRU 淘汰）。
///
/// wire 名 = `core_md_clear_cache`（T03.4 更名 core_md_*）。
#[tauri::command(rename = "core_md_clear_cache")]
pub async fn md_clear_cache() -> Result<(), CoreError> {
    tokio::task::spawn_blocking(|| conex_markdown::clear_cache())
        .await
        .map_err(|e| CoreError::Internal(format!("md_clear_cache join: {e}")))
}
