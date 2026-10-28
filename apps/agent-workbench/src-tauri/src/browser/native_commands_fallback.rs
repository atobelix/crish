//! 非 Windows 平台命令占位：原生子 Webview 依赖 WebView2，仅 Windows 提供。
//!
//! 保持与 Windows 命令面相同的命令名/参数/返回类型，使 main.rs 的
//! `generate_handler!` 注册跨平台一致；调用统一返回结构化不支持错误。

#![allow(dead_code)]
#![allow(unused_variables)]

use tauri::{AppHandle, State};

use super::native_manager::NativeWebviewManager;
use super::native_types::*;

const UNSUPPORTED: &str = "Native sub-webview browser is only available on Windows (WebView2).";

fn unsupported<T>() -> Result<T, String> {
    Err(UNSUPPORTED.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_webview_create(
    app: AppHandle,
    state: State<'_, NativeWebviewManager>,
    args: Option<CreateWebviewArgs>,
    tab_id: Option<String>,
    initial_url: Option<String>,
    bounds: Option<WebviewBounds>,
    visible: Option<bool>,
    storage_mode: Option<BrowserStorageMode>,
    muted: Option<bool>,
) -> Result<String, String> {
    unsupported()
}

#[tauri::command]
pub async fn browser_webview_set_bounds(
    app: AppHandle,
    state: State<'_, NativeWebviewManager>,
    args: Option<SetBoundsArgs>,
    tab_id: Option<String>,
    bounds: Option<WebviewBounds>,
) -> Result<(), String> {
    unsupported()
}

#[tauri::command]
pub async fn browser_webview_set_visible(
    state: State<'_, NativeWebviewManager>,
    args: Option<SetVisibleArgs>,
    tab_id: Option<String>,
    visible: Option<bool>,
) -> Result<(), String> {
    unsupported()
}

#[tauri::command]
pub async fn browser_webview_navigate(
    state: State<'_, NativeWebviewManager>,
    args: Option<NavigateArgs>,
    tab_id: Option<String>,
    url: Option<String>,
) -> Result<(), String> {
    unsupported()
}

#[tauri::command]
pub async fn browser_webview_action(
    state: State<'_, NativeWebviewManager>,
    args: Option<ActionArgs>,
    tab_id: Option<String>,
    action: Option<BrowserActionKind>,
) -> Result<(), String> {
    unsupported()
}

#[tauri::command]
pub async fn browser_webview_close(
    state: State<'_, NativeWebviewManager>,
    args: Option<CloseArgs>,
    tab_id: Option<String>,
) -> Result<(), String> {
    unsupported()
}

#[tauri::command]
pub async fn browser_webview_set_muted(
    state: State<'_, NativeWebviewManager>,
    args: Option<SetMutedArgs>,
    tab_id: Option<String>,
    muted: Option<bool>,
) -> Result<(), String> {
    unsupported()
}

#[tauri::command]
pub async fn browser_webview_set_hit_test(
    state: State<'_, NativeWebviewManager>,
    args: Option<SetHitTestArgs>,
    tab_id: Option<String>,
    hit_test: Option<bool>,
) -> Result<SetHitTestResult, String> {
    unsupported()
}

#[tauri::command]
pub async fn browser_webview_set_inspector(
    state: State<'_, NativeWebviewManager>,
    args: Option<SetInspectorArgs>,
    tab_id: Option<String>,
    enabled: Option<bool>,
) -> Result<(), String> {
    unsupported()
}
