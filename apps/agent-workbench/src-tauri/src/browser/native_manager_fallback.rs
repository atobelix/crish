//! 非 Windows 平台占位管理器：原生子 Webview 依赖 WebView2，仅 Windows 提供。
//!
//! 保持与 Windows 实现相同的托管状态构造/关闭 API，使 main.rs 的装配与退出
//! 清理路径跨平台编译；命令面统一返回不支持错误（`native_commands_fallback`）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 导航状态事件负载（与 Windows 实现同 wire 契约；仅被 native_types 重导出）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationStatePayload {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_go_back: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_go_forward: Option<bool>,
    pub is_loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(default)]
    pub is_muted: bool,
}

/// 非 Windows 平台占位（无状态）。
#[derive(Debug, Default)]
pub struct NativeWebviewManager;

impl NativeWebviewManager {
    pub fn new(_app_dir: PathBuf) -> Self {
        Self
    }

    /// 与 Windows 实现对齐的退出清理入口（占位无资源可释放）。
    pub async fn close_all(&self) {}
}
