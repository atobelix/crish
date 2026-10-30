//! 原生子 Webview 浏览器 Tauri 命令面：平台分派门面。
//!
//! 原生子 Webview 依赖 WebView2，仅 Windows 提供真实实现：
//! - Windows → `windows`（9 大核心命令的 WebView2 实现）；
//! - 其余平台 → `fallback`（同名同参数占位，统一返回结构化不支持错误）。
//!
//! 两条实现共享同一命令名与 wire 参数面，装配方 `command_registry` 只认本模块
//! 导出的命令，故模块路径 `browser::native_commands::<命令>` 跨平台恒定。

#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
mod fallback;

// `#[tauri::command]` 生成的 `__cmd__*` 隐藏宏须随命令同路径可达（main.rs
// `command_registry!` → `generate_handler![browser::native_commands::xxx]`），故用 glob 重导出。
#[cfg(windows)]
pub use windows::*;

#[cfg(not(windows))]
pub use fallback::*;
