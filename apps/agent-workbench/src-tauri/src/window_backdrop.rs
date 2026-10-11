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
    fn test_backdrop_kind_str() {
        assert_eq!(WindowBackdropKind::Mica.as_str(), "mica");
        assert_eq!(WindowBackdropKind::Acrylic.as_str(), "acrylic");
        assert_eq!(WindowBackdropKind::None.as_str(), "none");
    }
}
