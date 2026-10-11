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
            let tint = if is_dark { ACRYLIC_TINT_DARK } else { ACRYLIC_TINT_LIGHT };
            let _ = window_vibrancy::apply_acrylic(window, Some(tint));
        }
        WindowBackdropKind::None => {}
    }
    #[cfg(not(target_os = "windows"))]
    let _ = is_dark;
    // 每次收到前端事件都重新写属性：整页刷新 / 首个文档晚于 setup eval 时也能恢复分层
    sync_backdrop_to_webview(window, kind);
}

/// 将生效的材质类型同步至前端 DOM 属性与全局变量。
pub fn sync_backdrop_to_webview(window: &WebviewWindow, kind: WindowBackdropKind) {
    let script = format!(
        "try {{ document.documentElement.setAttribute('data-backdrop', '{}'); window.__CRISH_BACKDROP__ = '{}'; if (typeof window.dispatchEvent === 'function') {{ window.dispatchEvent(new Event('resize')); }} }} catch (_) {{}}",
        kind.as_str(),
        kind.as_str()
    );
    let _ = window.eval(&script);
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
    fn test_backdrop_kind_str() {
        assert_eq!(WindowBackdropKind::Mica.as_str(), "mica");
        assert_eq!(WindowBackdropKind::Acrylic.as_str(), "acrylic");
        assert_eq!(WindowBackdropKind::None.as_str(), "none");
    }
}
