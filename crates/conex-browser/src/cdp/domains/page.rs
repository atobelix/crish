//! Page 域（会话级）命令、结果与事件类型。

use super::system_log::LogEntry;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Page 域（会话级）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigateParams {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referrer: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigateResult {
    pub frame_id: String,
    pub loader_id: Option<String>,
    pub error_text: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReloadParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ignore_cache: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigateToHistoryEntryParams {
    pub entry_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNavigationHistoryResult {
    pub current_index: i64,
    pub entries: Vec<NavigationEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationEntry {
    pub id: i64,
    pub url: String,
    pub user_typed_url: Option<String>,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameInfo {
    pub id: String,
    pub url: String,
    pub parent_id: Option<String>,
    pub name: Option<String>,
    pub security_origin: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFrameTreeResult {
    pub frame_tree: FrameTree,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameTree {
    pub frame: FrameInfo,
    pub child_frames: Option<Vec<FrameTree>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureScreenshotParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip: Option<Viewport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_beyond_viewport: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureScreenshotResult {
    pub data: String,
}

/// Page.getLayoutMetrics 结果（R-3 补齐，维度 13 视口/滚动尺寸采集）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetLayoutMetricsResult {
    pub layout_viewport: LayoutViewport,
    pub visual_viewport: VisualViewport,
    pub content_size: Option<ContentSize>,
}

/// Page.getLayoutMetrics.layoutViewport。
/// Chrome 151 协议漂移：x/y/width/height 已迁移为 pageX/pageY/clientWidth/clientHeight，
/// 双形态容错（旧字段 default=0，经 `viewport_width/height` 优先新形态解析）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutViewport {
    /// 旧协议形态（Chrome <151）。
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
    /// 新协议形态（Chrome 151+）。
    #[serde(default)]
    pub page_x: f64,
    #[serde(default)]
    pub page_y: f64,
    #[serde(default)]
    pub client_width: f64,
    #[serde(default)]
    pub client_height: f64,
    pub scale: Option<f64>,
}

impl LayoutViewport {
    /// 视口宽（新协议 clientWidth 优先，回退旧协议 width）。
    pub fn viewport_width(&self) -> f64 {
        if self.client_width > 0.0 {
            self.client_width
        } else {
            self.width
        }
    }

    /// 视口高（新协议 clientHeight 优先，回退旧协议 height）。
    pub fn viewport_height(&self) -> f64 {
        if self.client_height > 0.0 {
            self.client_height
        } else {
            self.height
        }
    }

    /// 视口原点 X（新协议 pageX 优先，回退旧协议 x）。
    pub fn viewport_x(&self) -> f64 {
        if self.page_x != 0.0 {
            self.page_x
        } else {
            self.x
        }
    }

    /// 视口原点 Y（新协议 pageY 优先，回退旧协议 y）。
    pub fn viewport_y(&self) -> f64 {
        if self.page_y != 0.0 {
            self.page_y
        } else {
            self.y
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualViewport {
    pub offset_x: f64,
    pub offset_y: f64,
    pub page_x: f64,
    pub page_y: f64,
    pub client_width: f64,
    pub client_height: f64,
    pub scale: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSize {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Page.startScreencast 参数（帧率/质量等参数权威在维度 12，此处提供类型面）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartScreencastParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_height: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub every_nth_frame: Option<i32>,
}

/// Page.screencastFrameAck 参数（帧泵 ack pacing，维度 12 §2.1）。
/// sessionId 为 **Value**：Chrome 151 实测事件内 sessionId 为 JSON 数字
/// （如 `1`），ack 参数须与原始形态一致（类型敏感，字符串化被拒
/// → Invalid parameters → 帧流停滞）；旧协议字符串形态亦可无损透传。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreencastFrameAckParams {
    pub session_id: Value,
}

/// Page.setWindowOpenHandler 参数（走同步 deny/allow 语义，awaitingDebugger 不启用）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWindowOpenHandlerParams {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandleJavaScriptDialogParams {
    pub accept: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_text: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddScriptToEvaluateOnNewDocumentParams {
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_name: Option<String>,
}

// Page 事件

/// Page.frameStartedNavigating / frameNavigated 共用参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameEvent {
    pub frame: FrameInfo,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigatedWithinDocumentEvent {
    pub frame_id: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameAttachedEvent {
    pub frame_id: String,
    pub parent_frame_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDetachedEvent {
    pub frame_id: String,
    pub reason: Option<String>,
}

/// Page.javascriptDialogOpening 事件参数（§7.1 对话框状态机输入）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavascriptDialogOpeningEvent {
    pub url: String,
    pub message: String,
    #[serde(rename = "type")]
    pub dialog_type: String,
    pub default_prompt: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavascriptDialogClosedEvent {
    pub result: bool,
    pub user_gesture: Option<bool>,
}

/// Page.windowOpen 事件参数（window.open 收口，§7.2）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowOpenEvent {
    pub url: String,
    pub window_name: Option<String>,
    pub window_features: Option<Vec<String>>,
    pub user_gesture: Option<bool>,
}

/// Page.pageError 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageErrorEvent {
    pub entry: LogEntry,
}

/// Page.fileChooserOpened 事件参数（R-3 补齐，维度 14 上传触发）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChooserOpenedEvent {
    pub frame_id: String,
    pub mode: Option<String>,
    pub backend_node_id: i64,
}

/// Page.screencastFrame 事件参数（帧流专用通道输入，§5.2）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreencastFrameEvent {
    pub data: String,
    pub metadata: ScreencastFrameMetadata,
    pub session_id: String,
    pub frame_number: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreencastFrameMetadata {
    pub page_scale_factor: Option<f64>,
    pub device_width: Option<f64>,
    pub device_height: Option<f64>,
    pub scroll_offset_x: Option<f64>,
    pub scroll_offset_y: Option<f64>,
    pub timestamp: Option<f64>,
}
