//! 原生子 Webview 浏览器 IPC 数据契约与事件类型定义
//!
//! 依据 `docs/native-browser-overhaul/00-总方案-原生浏览器彻底改造与子Webview架构方案.md` 与
//! `docs/native-browser-overhaul/05-ipc-and-event-streaming-contract.md` 编制。
//!
//! 核心数据结构遵循与前端的 camelCase 序列化契约，作为跨端通信的单一真源 (SSOT)。

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

pub use super::native_manager::BrowserNavigationStatePayload;
pub type NavigationStatePayload = BrowserNavigationStatePayload;

/// 前端上报的 CSS 逻辑像素矩形边界（相对于主窗口客户区左上角）
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WebviewBounds {
    pub const ZERO: Self = Self {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    };

    /// 校验边界数值合法性，拦截 NaN、无穷大或负尺寸
    #[inline]
    pub fn is_valid(&self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width >= 0.0
            && self.height >= 0.0
    }

    /// 根据 DPI 缩放比转换为物理像素矩形，四边独立取整消除像素裂缝
    #[inline]
    pub fn to_physical(self, scale_factor: f64) -> PhysicalBounds {
        let left = (self.x * scale_factor).round() as i32;
        let top = (self.y * scale_factor).round() as i32;
        let right = ((self.x + self.width) * scale_factor).round() as i32;
        let bottom = ((self.y + self.height) * scale_factor).round() as i32;
        PhysicalBounds {
            x: left,
            y: top,
            width: (right - left).max(1),
            height: (bottom - top).max(1),
        }
    }
}

/// 物理像素矩形
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 浏览器存储分区隔离模式（统一自 security.rs）
pub use super::security::BrowserStorageMode;

/// 创建原生 Webview 参数载荷
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWebviewArgs {
    pub tab_id: String,
    pub initial_url: String,
    pub bounds: WebviewBounds,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(default)]
    pub storage_mode: Option<BrowserStorageMode>,
    #[serde(default)]
    pub muted: Option<bool>,
    /// 自定义存储子目录（03-分维 §3.4：相对 browser-storage 根解析，如
    /// Agent 无痕沙箱的 `ephemeral-{tabId}`；缺省时由 storage_mode 推导）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_directory: Option<String>,
    /// 本地文件导航约束根（03-分维 §7.3：`file:` 仅限工作区内；
    /// None = 公网上下文，`file:` 一律拒绝）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
}

/// 下载进度广播事件载荷（对应事件 channel: `browser://download-progress`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressPayload {
    pub tab_id: String,
    pub url: String,
    pub filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    pub received_bytes: u64,
    pub state: String,
}

/// 浏览器标准动作枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserActionKind {
    Back,
    Forward,
    Reload,
    ReloadIgnoringCache,
    Stop,
}

// ──────────────────────────────────────────
// 其它命令辅助参数结构（支持打包或展平传参）
// ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBoundsArgs {
    pub tab_id: String,
    pub bounds: WebviewBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetVisibleArgs {
    pub tab_id: String,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigateArgs {
    pub tab_id: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionArgs {
    pub tab_id: String,
    pub action: BrowserActionKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseArgs {
    pub tab_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMutedArgs {
    pub tab_id: String,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetHitTestArgs {
    pub tab_id: String,
    pub hit_test: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetInspectorArgs {
    pub tab_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SetHitTestStatus {
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetHitTestResult {
    pub status: SetHitTestStatus,
    pub reason: String,
}

impl SetHitTestResult {
    pub fn unsupported(reason: impl Into<String>) -> Self {
        Self {
            status: SetHitTestStatus::Unsupported,
            reason: reason.into(),
        }
    }
}

// ──────────────────────────────────────────
// 事件通道常量
// ──────────────────────────────────────────

pub const EVENT_BROWSER_NAVIGATION_STATE: &str = "browser://navigation-state";
pub const EVENT_BROWSER_DOWNLOAD_PROGRESS: &str = "browser://download-progress";
pub const EVENT_BROWSER_INSPECTOR: &str = "browser://inspector-event";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_physical_rounding() {
        let bounds = WebviewBounds {
            x: 100.2,
            y: 50.4,
            width: 300.5,
            height: 200.7,
        };
        // 1.0 scale
        let p1 = bounds.to_physical(1.0);
        assert_eq!(p1.x, 100);
        assert_eq!(p1.y, 50);
        assert_eq!(p1.width, 301);
        assert_eq!(p1.height, 201);

        // 1.5 scale (High DPI)
        let p15 = bounds.to_physical(1.5);
        assert_eq!(p15.x, 150);
        assert_eq!(p15.y, 76);
        assert_eq!(p15.width, 451);
        assert_eq!(p15.height, 301);
    }

    #[test]
    fn test_bounds_validity() {
        assert!(WebviewBounds {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0
        }
        .is_valid());
        assert!(!WebviewBounds {
            x: f64::NAN,
            y: 0.0,
            width: 100.0,
            height: 100.0
        }
        .is_valid());
        assert!(!WebviewBounds {
            x: 0.0,
            y: 0.0,
            width: -1.0,
            height: 100.0
        }
        .is_valid());
    }

    #[test]
    fn create_webview_args_keep_legacy_visibility_default_and_explicit_false() {
        let legacy: CreateWebviewArgs = serde_json::from_str(
            r#"{"tabId":"tab-1","initialUrl":"about:blank","bounds":{"x":0.0,"y":0.0,"width":640.0,"height":480.0}}"#,
        )
        .unwrap();
        assert_eq!(legacy.visible, None);

        let hidden: CreateWebviewArgs = serde_json::from_str(
            r#"{"tabId":"tab-1","initialUrl":"about:blank","bounds":{"x":0.0,"y":0.0,"width":640.0,"height":480.0},"visible":false}"#,
        )
        .unwrap();
        assert_eq!(hidden.visible, Some(false));
        assert_eq!(
            serde_json::to_value(hidden)
                .unwrap()
                .get("visible")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn hit_test_unsupported_result_keeps_the_ipc_status_contract() {
        let value = serde_json::to_value(SetHitTestResult::unsupported("reason")).unwrap();
        assert_eq!(value["status"], "unsupported");
        assert_eq!(value["reason"], "reason");
    }

    #[test]
    fn hit_test_args_use_the_frontend_camel_case_contract() {
        let args: SetHitTestArgs =
            serde_json::from_str(r#"{"tabId":"tab-1","hitTest":false}"#).unwrap();
        assert_eq!(args.tab_id, "tab-1");
        assert!(!args.hit_test);
    }

    #[test]
    fn inspector_toggle_args_use_the_frontend_camel_case_contract() {
        let args: SetInspectorArgs =
            serde_json::from_str(r#"{"tabId":"tab-1","enabled":true}"#).unwrap();
        assert_eq!(args.tab_id, "tab-1");
        assert!(args.enabled);
    }
}
