//! 原生窗口背景材质管理与阶梯回退（Win11 Mica / Win10 Acrylic / Solid）。
//!
//! # 阶梯回退策略
//! 1. **Win11 22H2+ / 21H2**：原生系统级 Mica（云母）材质，采样壁纸，零 GPU 掉帧。
//! 2. **Win10 (1809+)**：Acrylic（亚克力）模糊背景。
//! 3. **低版本 / 非 Windows / 异常**：Solid（纯实色），零白闪，零崩溃，优雅降级。
//!
//! 适配完成后，通过向 Webview 注入 `data-backdrop` 属性，
//! 驱动前端 DOM 透明度分层与微透光效果的精准协同。

use tauri::WebviewWindow;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowBackdropKind {
    Mica,
    Acrylic,
    None,
}

impl WindowBackdropKind {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Mica => "mica",
            Self::Acrylic => "acrylic",
            Self::None => "none",
        }
    }
}

/// 对主窗口应用自适应系统材质，遵循阶梯降级策略。
pub fn apply_adaptive_backdrop(window: &WebviewWindow) -> WindowBackdropKind {
    #[cfg(target_os = "windows")]
    {
        // 阶梯 1：Windows 11 Mica Alt (Tabbed 云母变体，专为多面板/侧栏桌面应用设计，壁纸采样对比度显著)
        if let Ok(()) = window_vibrancy::apply_tabbed(window, None) {
            tracing::info!(target: "window", "原生窗口已成功应用 Windows 11 Mica Alt (Tabbed 云母) 材质");
            sync_backdrop_to_webview(window, WindowBackdropKind::Mica);
            return WindowBackdropKind::Mica;
        }

        // 阶梯 2：Windows 11 标准 Mica (云母)
        if let Ok(()) = window_vibrancy::apply_mica(window, None) {
            tracing::info!(target: "window", "原生窗口已应用 Windows 11 标准 Mica (云母) 材质");
            sync_backdrop_to_webview(window, WindowBackdropKind::Mica);
            return WindowBackdropKind::Mica;
        }

        // 阶梯 3：Windows 10 Acrylic (亚克力)
        if let Ok(()) = window_vibrancy::apply_acrylic(window, Some((24, 24, 27, 180))) {
            tracing::info!(target: "window", "原生窗口已降级应用 Windows 10 Acrylic (亚克力) 材质");
            sync_backdrop_to_webview(window, WindowBackdropKind::Acrylic);
            return WindowBackdropKind::Acrylic;
        }

        tracing::info!(target: "window", "当前环境不支持 Mica/Acrylic，安全降级至纯实色 (Solid)");
    }

    #[cfg(not(target_os = "windows"))]
    {
        tracing::debug!(target: "window", "非 Windows 平台，窗口材质保持默认纯色");
    }

    sync_backdrop_to_webview(window, WindowBackdropKind::None);
    WindowBackdropKind::None
}

/// 前端主题事件（payload = JSON bool，true 表示应用当前为深色）。
/// 前端在启动和每次切换主题时发送（bootstrap/backdropThemeSync.ts）。
pub const THEME_EVENT: &str = "crish://backdrop-theme";

/// 前端云母效果切换事件（payload = JSON {"enabled": bool, "isDark": bool} 或 bool）。
pub const MICA_EVENT: &str = "crish://backdrop-mica";

/// 判断当前操作系统是否为 Windows 11（Build >= 22000）。
/// 通过 Win32 注册表 CurrentBuildNumber 判断，不受应用程序兼容性垫片影响。
pub fn is_windows_11() -> bool {
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("reg")
            .args([
                "query",
                "HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion",
                "/v",
                "CurrentBuildNumber",
            ])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    if line.contains("CurrentBuildNumber") {
                        if let Some(val) = line.split_whitespace().last() {
                            if let Ok(build) = val.parse::<u32>() {
                                return build >= 22000;
                            }
                        }
                    }
                }
            }
        }
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[derive(serde::Deserialize)]
struct MicaPayload {
    enabled: bool,
    #[serde(rename = "isDark", default)]
    is_dark: Option<bool>,
}

/// 解析云母事件 payload，返回 (enabled, is_dark)。
pub fn parse_mica_payload(payload: &str) -> Option<(bool, bool)> {
    if let Ok(parsed) = serde_json::from_str::<MicaPayload>(payload) {
        return Some((parsed.enabled, parsed.is_dark.unwrap_or(false)));
    }
    match payload.trim() {
        "true" => Some((true, false)),
        "false" => Some((false, false)),
        _ => None,
    }
}

/// Acrylic 底色分浅、深两套（RGBA）：浅色取外层色 #f2f1f0，深色沿用原值。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const ACRYLIC_TINT_LIGHT: (u8, u8, u8, u8) = (242, 241, 240, 180);
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const ACRYLIC_TINT_DARK: (u8, u8, u8, u8) = (24, 24, 27, 180);

/// 解析主题事件 payload（只认 JSON 的 true / false）。
pub fn parse_theme_payload(payload: &str) -> Option<bool> {
    match payload.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// 清除窗口当前背景材质，恢复为纯实色 (Solid)。
pub fn clear_backdrop(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        let _ = window_vibrancy::clear_mica(window);
        let _ = window_vibrancy::clear_acrylic(window);
    }
    sync_backdrop_to_webview(window, WindowBackdropKind::None);
}

/// 按**应用**主题（不跟随系统明暗）重设材质，并重新同步 data-backdrop。
/// 修复：apply_mica/apply_tabbed(None) 跟随系统明暗，浅色应用 + 深色系统时，
/// 外层 68% 着色叠在深色云母上会变成脏灰。
pub fn reapply_for_app_theme(window: &WebviewWindow, kind: WindowBackdropKind, is_dark: bool) {
    #[cfg(target_os = "windows")]
    match kind {
        WindowBackdropKind::Mica => {
            if window_vibrancy::apply_tabbed(window, Some(is_dark)).is_err() {
                let _ = window_vibrancy::apply_mica(window, Some(is_dark));
            }
        }
        WindowBackdropKind::Acrylic => {
            let tint = if is_dark {
                ACRYLIC_TINT_DARK
            } else {
                ACRYLIC_TINT_LIGHT
            };
            let _ = window_vibrancy::apply_acrylic(window, Some(tint));
        }
        WindowBackdropKind::None => {
            clear_backdrop(window);
            return;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = is_dark;
    // 每次收到前端事件都重新写属性：整页刷新 / 首个文档晚于 setup eval 时也能恢复分层
    sync_backdrop_to_webview(window, kind);
}

/// 将生效的材质类型同步至前端 DOM 属性与全局变量。
pub fn sync_backdrop_to_webview(window: &WebviewWindow, kind: WindowBackdropKind) {
    let is_win11 = is_windows_11();
    let script = format!(
        "try {{ document.documentElement.setAttribute('data-backdrop', '{}'); window.__CRISH_BACKDROP__ = '{}'; window.__CRISH_MICA_SUPPORTED__ = {}; if (typeof window.dispatchEvent === 'function') {{ window.dispatchEvent(new Event('resize')); }} }} catch (_) {{}}",
        kind.as_str(),
        kind.as_str(),
        if is_win11 { "true" } else { "false" }
    );
    let _ = window.eval(&script);
}

/// 初始化窗口材质管理与事件监听（默认纯实色，仅在用户显式开启时动态生效云母材质）
pub fn setup_window_backdrop(
    app: &tauri::App,
    main_window: &WebviewWindow,
    diagnostics: &std::sync::Arc<crate::status_diagnostics::StatusDiagnostics>,
) {
    let backdrop = WindowBackdropKind::None;
    sync_backdrop_to_webview(main_window, backdrop);
    diagnostics.record("window_backdrop", true, Some("none".into()));

    let mica_state = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let dark_state = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    // 材质跟随应用主题（而非系统明暗）：前端启动和切主题时发 THEME_EVENT
    let theme_window = main_window.clone();
    let theme_mica = std::sync::Arc::clone(&mica_state);
    let theme_dark = std::sync::Arc::clone(&dark_state);
    tauri::Listener::listen_any(app, THEME_EVENT, move |event| {
        if let Some(is_dark) = parse_theme_payload(event.payload()) {
            theme_dark.store(is_dark, std::sync::atomic::Ordering::Relaxed);
            if theme_mica.load(std::sync::atomic::Ordering::Relaxed) {
                let w = theme_window.clone();
                let _ = theme_window.run_on_main_thread(move || {
                    reapply_for_app_theme(&w, WindowBackdropKind::Mica, is_dark);
                });
            }
        }
    });

    // 监听云母效果开关切换事件（crish://backdrop-mica）
    let mica_window = main_window.clone();
    let toggle_mica = std::sync::Arc::clone(&mica_state);
    let toggle_dark = std::sync::Arc::clone(&dark_state);
    tauri::Listener::listen_any(app, MICA_EVENT, move |event| {
        if let Some((enabled, is_dark)) = parse_mica_payload(event.payload()) {
            toggle_mica.store(enabled, std::sync::atomic::Ordering::Relaxed);
            toggle_dark.store(is_dark, std::sync::atomic::Ordering::Relaxed);
            let w = mica_window.clone();
            let _ = mica_window.run_on_main_thread(move || {
                if enabled {
                    reapply_for_app_theme(&w, WindowBackdropKind::Mica, is_dark);
                } else {
                    clear_backdrop(&w);
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_theme_payload() {
        assert_eq!(parse_theme_payload("true"), Some(true));
        assert_eq!(parse_theme_payload(" false "), Some(false));
        assert_eq!(parse_theme_payload("\"dark\""), None);
        assert_eq!(parse_theme_payload(""), None);
    }

    #[test]
    fn test_parse_mica_payload() {
        assert_eq!(parse_mica_payload("true"), Some((true, false)));
        assert_eq!(parse_mica_payload("false"), Some((false, false)));
        assert_eq!(
            parse_mica_payload(r#"{"enabled": true, "isDark": true}"#),
            Some((true, true))
        );
        assert_eq!(
            parse_mica_payload(r#"{"enabled": false}"#),
            Some((false, false))
        );
    }

    #[test]
    fn test_is_windows_11_does_not_panic() {
        let _ = is_windows_11();
    }

    #[test]
    fn test_backdrop_kind_str() {
        assert_eq!(WindowBackdropKind::Mica.as_str(), "mica");
        assert_eq!(WindowBackdropKind::Acrylic.as_str(), "acrylic");
        assert_eq!(WindowBackdropKind::None.as_str(), "none");
    }
}
