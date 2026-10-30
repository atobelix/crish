//! 原生子 Webview 管理器：平台分派门面。
//!
//! 原生子 Webview 依赖 WebView2，仅 Windows 提供真实实现：
//! - Windows → `windows`（进程级单例 `NativeWebviewManager` 与 WebView2 装配；
//!   其私有子模块 `native_inspector` / `native_observers` / `tests` 随实现同域放置，
//!   目录树即模块树）；
//! - 其余平台 → `fallback`（无状态占位，保持与管理器同形的构造/关闭 API）。
//!
//! 调用方路径 `browser::native_manager::<符号>` 跨平台恒定（含 `native_types`
//! 对 `BrowserNavigationStatePayload` 的重导出）。

#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
mod fallback;

#[cfg(windows)]
pub use windows::*;

#[cfg(not(windows))]
pub use fallback::*;
