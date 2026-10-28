//! 原生子 Webview 浏览器 Tauri 命令面实现
//!
//! 依据 `docs/native-browser-overhaul/00-总方案-原生浏览器彻底改造与子Webview架构方案.md` 与
//! `docs/native-browser-overhaul/01-分维-Tauri2原生子Webview管理器与Rust内核实现.md` 编制。
//! 结合 `docs/native-browser-overhaul/audits/05-systemic-refactoring-and-anti-slacking-audit.md` 规范。
//!
//! 提供 9 大核心异步命令：
//! - `browser_webview_create`
//! - `browser_webview_set_bounds`
//! - `browser_webview_set_visible`
//! - `browser_webview_navigate`
//! - `browser_webview_action`
//! - `browser_webview_close`
//! - `browser_webview_set_muted`
//! - `browser_webview_set_hit_test`
//! - `browser_webview_set_inspector`

#![allow(dead_code)]

use tauri::{AppHandle, Manager, State};

use super::native_manager::NativeWebviewManager;
use super::native_types::*;

/// 创建并初始化指定 Tab 的原生子 Webview
// 参数面由前端 wire 兼容层（flat args + args 对象双形态）决定，保持单入口。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
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
    let effective = if let Some(a) = args {
        a
    } else {
        let id =
            tab_id.ok_or_else(|| "Missing required parameter 'tabId' or 'args'".to_string())?;
        let b =
            bounds.ok_or_else(|| "Missing required parameter 'bounds' or 'args'".to_string())?;
        CreateWebviewArgs {
            tab_id: id,
            initial_url: initial_url.unwrap_or_else(|| "about:blank".to_string()),
            bounds: b,
            visible,
            storage_mode,
            muted,
            data_directory: None,
            workspace_root: None,
        }
    };

    // 存储子目录：显式 data_directory 优先（03-分维 §3.4 的隔离面）；
    // Ephemeral 模式按设计回退为 browser-storage/ephemeral-{tabId}
    let data_directory = effective.data_directory.or_else(|| {
        match effective.storage_mode {
            Some(BrowserStorageMode::Ephemeral) => Some(format!("ephemeral-{}", effective.tab_id)),
            _ => None,
        }
    });

    let label = state
        .create_webview(
            &app,
            effective.tab_id.clone(),
            Some(effective.initial_url),
            effective.bounds,
            resolve_create_visibility(effective.visible),
            effective.storage_mode,
            data_directory,
            effective.workspace_root,
        )
        .await?;

    if let Some(true) = effective.muted {
        let _ = state.set_muted(&effective.tab_id, true);
    }

    Ok(label)
}

/// 高频同步指定 Tab 的 CSS 逻辑位置与视口尺寸
#[tauri::command]
pub async fn browser_webview_set_bounds(
    app: AppHandle,
    state: State<'_, NativeWebviewManager>,
    args: Option<SetBoundsArgs>,
    tab_id: Option<String>,
    bounds: Option<WebviewBounds>,
) -> Result<(), String> {
    let (id, b) = if let Some(a) = args {
        (a.tab_id, a.bounds)
    } else {
        let id =
            tab_id.ok_or_else(|| "Missing required parameter 'tabId' or 'args'".to_string())?;
        let b =
            bounds.ok_or_else(|| "Missing required parameter 'bounds' or 'args'".to_string())?;
        (id, b)
    };

    let main_window = app
        .get_window("main")
        .ok_or_else(|| "Main window 'main' not found".to_string())?;
    let scale_factor = main_window.scale_factor().map_err(|e| e.to_string())?;

    state.set_bounds(&id, b, scale_factor)
}

/// 切换指定 Tab 的显隐状态（隐藏时挂起渲染管线以节约 GPU 与能耗）
#[tauri::command]
pub async fn browser_webview_set_visible(
    state: State<'_, NativeWebviewManager>,
    args: Option<SetVisibleArgs>,
    tab_id: Option<String>,
    visible: Option<bool>,
) -> Result<(), String> {
    let (id, vis) = if let Some(a) = args {
        (a.tab_id, a.visible)
    } else {
        let id =
            tab_id.ok_or_else(|| "Missing required parameter 'tabId' or 'args'".to_string())?;
        let vis =
            visible.ok_or_else(|| "Missing required parameter 'visible' or 'args'".to_string())?;
        (id, vis)
    };

    state.set_visible(&id, vis)
}

/// 导航指定 Tab 至目标 URL（经过严格的白名单清洗）
#[tauri::command]
pub async fn browser_webview_navigate(
    state: State<'_, NativeWebviewManager>,
    args: Option<NavigateArgs>,
    tab_id: Option<String>,
    url: Option<String>,
) -> Result<(), String> {
    let (id, target_url) = if let Some(a) = args {
        (a.tab_id, a.url)
    } else {
        let id =
            tab_id.ok_or_else(|| "Missing required parameter 'tabId' or 'args'".to_string())?;
        let u = url.ok_or_else(|| "Missing required parameter 'url' or 'args'".to_string())?;
        (id, u)
    };

    state.navigate(&id, &target_url)
}

/// 执行前进、后退、刷新、停止等浏览器标准动作
#[tauri::command]
pub async fn browser_webview_action(
    state: State<'_, NativeWebviewManager>,
    args: Option<ActionArgs>,
    tab_id: Option<String>,
    action: Option<BrowserActionKind>,
) -> Result<(), String> {
    let (id, act) = if let Some(a) = args {
        (a.tab_id, a.action)
    } else {
        let id =
            tab_id.ok_or_else(|| "Missing required parameter 'tabId' or 'args'".to_string())?;
        let act =
            action.ok_or_else(|| "Missing required parameter 'action' or 'args'".to_string())?;
        (id, act)
    };

    state.action(&id, act).await
}

/// 安全销毁子 Webview 并释放原生系统句柄
#[tauri::command]
pub async fn browser_webview_close(
    state: State<'_, NativeWebviewManager>,
    args: Option<CloseArgs>,
    tab_id: Option<String>,
) -> Result<(), String> {
    let id = if let Some(a) = args {
        a.tab_id
    } else {
        tab_id.ok_or_else(|| "Missing required parameter 'tabId' or 'args'".to_string())?
    };

    state.close(&id).await
}

/// 设置指定 Tab 的静音状态
#[tauri::command]
pub async fn browser_webview_set_muted(
    state: State<'_, NativeWebviewManager>,
    args: Option<SetMutedArgs>,
    tab_id: Option<String>,
    muted: Option<bool>,
) -> Result<(), String> {
    let (id, m) = if let Some(a) = args {
        (a.tab_id, a.muted)
    } else {
        let id =
            tab_id.ok_or_else(|| "Missing required parameter 'tabId' or 'args'".to_string())?;
        let m = muted.ok_or_else(|| "Missing required parameter 'muted' or 'args'".to_string())?;
        (id, m)
    };

    state.set_muted(&id, m)
}

/// 查询指定 Tab 的原生鼠标命中测试能力；不支持时返回明确的 capability payload。
#[tauri::command]
pub async fn browser_webview_set_hit_test(
    state: State<'_, NativeWebviewManager>,
    args: Option<SetHitTestArgs>,
    tab_id: Option<String>,
    hit_test: Option<bool>,
) -> Result<SetHitTestResult, String> {
    let (id, enabled) = if let Some(a) = args {
        (a.tab_id, a.hit_test)
    } else {
        let id =
            tab_id.ok_or_else(|| "Missing required parameter 'tabId' or 'args'".to_string())?;
        let enabled =
            hit_test.ok_or_else(|| "Missing required parameter 'hitTest' or 'args'".to_string())?;
        (id, enabled)
    };

    state.set_hit_test(&id, enabled)
}

/// 启用或关闭指定 Tab 的受限原生 DOM Inspector。
#[tauri::command]
pub async fn browser_webview_set_inspector(
    state: State<'_, NativeWebviewManager>,
    args: Option<SetInspectorArgs>,
    tab_id: Option<String>,
    enabled: Option<bool>,
) -> Result<(), String> {
    let (id, is_enabled) = if let Some(a) = args {
        (a.tab_id, a.enabled)
    } else {
        let id =
            tab_id.ok_or_else(|| "Missing required parameter 'tabId' or 'args'".to_string())?;
        let is_enabled =
            enabled.ok_or_else(|| "Missing required parameter 'enabled' or 'args'".to_string())?;
        (id, is_enabled)
    };

    state.set_inspector(&id, is_enabled)
}

fn resolve_create_visibility(visible: Option<bool>) -> bool {
    visible.unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::resolve_create_visibility;

    #[test]
    fn create_visibility_defaults_to_visible_and_preserves_explicit_false() {
        assert!(resolve_create_visibility(None));
        assert!(resolve_create_visibility(Some(true)));
        assert!(!resolve_create_visibility(Some(false)));
    }
}
