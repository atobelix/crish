//! 域子集类型化命令/事件包装（维度 11 §3.3 清单，R-3 补齐后 13 域；
//! 维度 16 storage_state 注入/导出聚合增补 DOMStorage 域）
//!
//! 覆盖清单：Browser / Target / Page / Runtime / DOM / DOMSnapshot /
//! Accessibility / Network / Input / Emulation / Storage / DOMStorage /
//! SystemInfo / Log。
//! Console 无独立域：控制台面由 Runtime.consoleAPICalled / exceptionThrown /
//! Page.pageError 组合承载（§3.3 Console 能力说明）。
//!
//! 约定：
//! - 命令参数结构实现 `Serialize`，结果结构实现 `Deserialize`，camelCase 字段名；
//! - 事件结构实现 `Deserialize`，由 bus.rs 分类 router 消费；
//! - `names` 模块集中登记本 crate 内部使用的 method 常量（enable 序列/恢复流程）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 内部使用的方法名常量（恢复流程/探测/对话框应答/心跳探针）。
pub mod names {
    pub const BROWSER_GET_VERSION: &str = "Browser.getVersion";
    pub const BROWSER_CLOSE: &str = "Browser.close";
    pub const TARGET_SET_DISCOVER_TARGETS: &str = "Target.setDiscoverTargets";
    pub const TARGET_GET_TARGETS: &str = "Target.getTargets";
    pub const TARGET_ATTACH_TO_TARGET: &str = "Target.attachToTarget";
    pub const TARGET_DETACH_FROM_TARGET: &str = "Target.detachFromTarget";
    pub const TARGET_CREATE_TARGET: &str = "Target.createTarget";
    pub const TARGET_ACTIVATE_TARGET: &str = "Target.activateTarget";
    pub const TARGET_SET_AUTO_ATTACH: &str = "Target.setAutoAttach";
    pub const PAGE_ENABLE: &str = "Page.enable";
    pub const PAGE_SET_LIFECYCLE_EVENTS_ENABLED: &str = "Page.setLifecycleEventsEnabled";
    pub const PAGE_SET_WINDOW_OPEN_HANDLER: &str = "Page.setWindowOpenHandler";
    pub const PAGE_HANDLE_JAVASCRIPT_DIALOG: &str = "Page.handleJavaScriptDialog";
    pub const PAGE_START_SCREENCAST: &str = "Page.startScreencast";
    pub const PAGE_STOP_SCREENCAST: &str = "Page.stopScreencast";
    pub const PAGE_SCREENCAST_FRAME_ACK: &str = "Page.screencastFrameAck";
    pub const PAGE_GET_LAYOUT_METRICS: &str = "Page.getLayoutMetrics";
    // Chrome 151 已移除 Runtime.createIsolatedWorld（-32601 not found）；
    // 隔离世界创建改走 Page 域：getFrameTree 取主 frameId + createIsolatedWorld
    //（缺陷 A 修复，K7 e2e 实测面）
    pub const PAGE_GET_FRAME_TREE: &str = "Page.getFrameTree";
    pub const PAGE_CREATE_ISOLATED_WORLD: &str = "Page.createIsolatedWorld";
    pub const RUNTIME_ENABLE: &str = "Runtime.enable";
    pub const RUNTIME_RUN_IF_WAITING_FOR_DEBUGGER: &str = "Runtime.runIfWaitingForDebugger";
    pub const RUNTIME_EVALUATE: &str = "Runtime.evaluate";
    pub const DOM_ENABLE: &str = "DOM.enable";
    pub const DOM_GET_DOCUMENT: &str = "DOM.getDocument";
    pub const DOM_GET_FRAME_OWNER: &str = "DOM.getFrameOwner";
    pub const NETWORK_ENABLE: &str = "Network.enable";
    pub const NETWORK_SET_BLOCKED_URLS: &str = "Network.setBlockedURLs";
    pub const SYSTEM_INFO_GET_INFO: &str = "SystemInfo.getInfo";
    pub const ACCESSIBILITY_GET_FULL_AX_TREE: &str = "Accessibility.getFullAXTree";
    pub const DOM_SNAPSHOT_CAPTURE_SNAPSHOT: &str = "DOMSnapshot.captureSnapshot";
    pub const LOG_ENABLE: &str = "Log.enable";
    pub const DOM_STORAGE_ENABLE: &str = "DOMStorage.enable";
    pub const DOM_STORAGE_GET_DOM_STORAGE_ITEMS: &str = "DOMStorage.getDOMStorageItems";
    pub const DOM_STORAGE_SET_DOM_STORAGE_ITEM: &str = "DOMStorage.setDOMStorageItem";
    pub const DOM_STORAGE_REMOVE_DOM_STORAGE_ITEM: &str = "DOMStorage.removeDOMStorageItem";
    pub const PAGE_ADD_SCRIPT_TO_EVALUATE_ON_NEW_DOCUMENT: &str =
        "Page.addScriptToEvaluateOnNewDocument";
}

// ---------------------------------------------------------------------------
// Browser 域（browser 级，无 session_id）
// ---------------------------------------------------------------------------

/// Browser.getVersion 结果（身份校验 + 能力探测输入）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVersionResult {
    pub protocol_version: Option<String>,
    pub product: Option<String>,
    pub revision: Option<String>,
    pub user_agent: Option<String>,
    pub js_version: Option<String>,
    pub web_kit_version: Option<String>,
}

impl BrowserVersionResult {
    /// 产品名（如 "Chrome/131.0.6778.204"）→ 主版本号（如 131），解析失败返回 0。
    pub fn major_version(&self) -> u64 {
        self.product
            .as_deref()
            .and_then(|p| p.split('/').nth(1))
            .and_then(|v| v.split('.').next())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// Target 域（browser 级）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
    pub target_id: String,
    #[serde(rename = "type")]
    pub target_type: String,
    pub title: String,
    pub url: String,
    pub attached: Option<bool>,
    pub browser_context_id: Option<String>,
    pub opener_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTargetsResult {
    pub target_infos: Vec<TargetInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachToTargetParams {
    pub target_id: String,
    pub flatten: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachToTargetResult {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDiscoverTargetsParams {
    pub discover: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAutoAttachParams {
    pub auto_attach: bool,
    pub wait_for_debugger_on_start: bool,
    pub flatten: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTargetParams {
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTargetResult {
    pub target_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseTargetParams {
    pub target_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseTargetResult {
    pub success: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateTargetParams {
    pub target_id: String,
}

/// Target.targetCreated / targetInfoChanged 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetCreatedEvent {
    pub target_info: TargetInfo,
}

/// Target.attachedToTarget 事件参数（双层路由建立点）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedToTargetEvent {
    pub session_id: String,
    pub target_info: TargetInfo,
    pub waiting_for_debugger: Option<bool>,
}

/// Target.targetDestroyed 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDestroyedEvent {
    pub target_id: String,
}

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

// ---------------------------------------------------------------------------
// Runtime 域（会话级）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateParams {
    pub expression: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_by_value: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub await_promise: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_gesture: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateResult {
    pub result: RemoteObject,
    pub exception_details: Option<ExceptionDetails>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIsolatedWorldResult {
    pub execution_context_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteObject {
    #[serde(rename = "type")]
    pub object_type: String,
    pub subtype: Option<String>,
    pub value: Option<Value>,
    pub description: Option<String>,
    pub object_id: Option<String>,
    pub class_name: Option<String>,
    pub unserializable_value: Option<String>,
    pub preview: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionDetails {
    pub text: String,
    pub exception: Option<RemoteObject>,
    pub line_number: Option<i64>,
    pub column_number: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallFunctionOnParams {
    pub function_declaration: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<CallArgument>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_by_value: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub await_promise: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallArgument {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPropertiesParams {
    pub object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub own_properties: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generate_preview: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPropertiesResult {
    pub result: Vec<PropertyDescriptor>,
    pub internal_properties: Option<Vec<PropertyDescriptor>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDescriptor {
    pub name: String,
    pub value: Option<RemoteObject>,
    pub writable: Option<bool>,
    pub get: Option<RemoteObject>,
    pub set: Option<RemoteObject>,
    pub configurable: Option<bool>,
    pub enumerable: Option<bool>,
    pub is_own: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseObjectParams {
    pub object_id: String,
}

// Runtime 事件

/// Runtime.executionContextCreated 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContextCreatedEvent {
    pub context: ExecutionContextDescription,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContextDescription {
    pub id: i64,
    pub origin: Option<String>,
    pub name: Option<String>,
    pub aux_data: Option<Value>,
}

/// Runtime.consoleAPICalled 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleApiCalledEvent {
    #[serde(rename = "type")]
    pub call_type: String,
    pub args: Vec<RemoteObject>,
    pub timestamp: Option<f64>,
    pub execution_context_id: Option<i64>,
}

/// Runtime.exceptionThrown 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionThrownEvent {
    pub timestamp: f64,
    pub exception_details: ExceptionDetails,
}

// ---------------------------------------------------------------------------
// DOM 域（会话级）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetDocumentParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pierce: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetDocumentResult {
    pub root: DomNode,
}

/// DOM.getFrameOwner 结果（维度 13 §1.5 跨域 iframe 递归：frameId →
/// 父文档中的 iframe owner 元素 backendNodeId，作尺寸门限与 `|IFRAME|`
/// 标记定位；`backendNodeId` 在 Chrome 151 实测中存在）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFrameOwnerResult {
    pub backend_node_id: Option<i64>,
    pub node_id: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomNode {
    pub node_id: i64,
    pub backend_node_id: Option<i64>,
    pub node_type: Option<i64>,
    pub node_name: Option<String>,
    pub local_name: Option<String>,
    pub node_value: Option<String>,
    pub attributes: Option<Vec<String>>,
    pub children: Option<Vec<DomNode>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRefParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveNodeResult {
    pub object: RemoteObject,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescribeNodeResult {
    pub node: DomNode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetBoxModelResult {
    pub model: BoxModel,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxModel {
    pub content: Vec<f64>,
    pub padding: Vec<f64>,
    pub border: Vec<f64>,
    pub margin: Vec<f64>,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetContentQuadsResult {
    pub quads: Vec<Vec<f64>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushNodesByBackendIdsToFrontendParams {
    pub backend_node_ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushNodesByBackendIdsToFrontendResult {
    pub node_ids: Vec<i64>,
}

/// DOM.scrollIntoViewIfNeeded 参数（R-3 补齐）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollIntoViewIfNeededParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rect: Option<Value>,
}

/// DOM.focus 参数（R-3 补齐）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySelectorParams {
    pub node_id: i64,
    pub selector: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySelectorResult {
    pub node_id: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySelectorAllParams {
    pub node_id: i64,
    pub selector: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySelectorAllResult {
    pub node_ids: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFileInputFilesParams {
    pub files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_node_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<i64>,
}

// DOM 事件

/// DOM.childNodeInserted 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildNodeInsertedEvent {
    pub parent_node_id: i64,
    pub previous_node_id: i64,
    pub node: DomNode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildNodeRemovedEvent {
    pub parent_node_id: i64,
    pub node_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterDataModifiedEvent {
    pub node_id: i64,
    pub character_data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeModifiedEvent {
    pub node_id: i64,
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeRemovedEvent {
    pub node_id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetChildNodesEvent {
    pub parent_id: i64,
    pub nodes: Vec<DomNode>,
}

// ---------------------------------------------------------------------------
// DOMSnapshot 域（会话级，R-3 补齐，维度 13 主采集通道）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSnapshotParams {
    pub computed_styles: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_paint_order: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_dom_rects: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSnapshotResult {
    pub strings: Vec<String>,
    pub documents: Vec<SnapshotDocument>,
}

/// DOMSnapshot 稀疏数据形态（RareStringData / RareBooleanData / RareIntegerData）：
/// `index` 命中节点索引 + `value` 对应值；真实响应为单对象映射（协议文档旧版为
/// 等长扁平数组，Chrome 151 实测已迁移为映射；`value` 全空时字段可能整体省略，
/// 故 value 声明 `#[serde(default)]`）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RareStringData {
    pub index: Vec<i64>,
    #[serde(default)]
    pub value: Vec<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RareBooleanData {
    pub index: Vec<i64>,
    #[serde(default)]
    pub value: Vec<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RareIntegerData {
    pub index: Vec<i64>,
    #[serde(default)]
    pub value: Vec<i64>,
}

/// DOMSnapshot 文档字段（documentURL/title）双形态：Chrome 151 实测为**字符串池
/// 下标**（协议文档旧版为直出字符串）；untagged 双形态兼容 + 池解析入口。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum SnapshotString {
    /// 字符串池下标（Chrome 151+ 实测形态）。
    Index(i64),
    /// 直出字符串（旧版/宽容形态）。
    Literal(String),
}

impl SnapshotString {
    /// 解析为实际字符串（Index 形态经字符串池解析；越界/负值回退空串）。
    pub fn resolve(&self, strings: &[String]) -> String {
        match self {
            SnapshotString::Literal(s) => s.clone(),
            SnapshotString::Index(i) => {
                if *i >= 0 {
                    strings.get(*i as usize).cloned().unwrap_or_default()
                } else {
                    String::new()
                }
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDocument {
    /// 双形态：字符串池下标（Chrome 151+）或直出字符串（旧版）。
    /// 显式 rename：协议键为 `documentURL`（URL 全大写，非 camelCase 规则产物）。
    #[serde(rename = "documentURL")]
    pub document_url: Option<SnapshotString>,
    pub title: Option<SnapshotString>,
    /// 文档所属 frameId（Chrome 151 实测为**字符串池下标**形态，与 documentURL/
    /// title 同漂移——双形态兼容 + 池解析入口；跨域帧不在主会话 DOMSnapshot
    /// 文档集内——文档集的 frameId 集合 = 已 pierce 帧集合，维度 13 §1.5
    /// 跨域递归据此筛选未覆盖帧）。
    #[serde(rename = "frameId")]
    pub frame_id: Option<SnapshotString>,
    /// Chrome 151 实测不发送该字段（协议文档要求但响应省略），缺失按 0。
    #[serde(default)]
    pub node_count: i64,
    pub nodes: SnapshotNode,
    pub layout: SnapshotLayout,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotNode {
    pub parent_index: Vec<i64>,
    pub node_type: Vec<i64>,
    pub node_name: Vec<i64>,
    pub node_value: Vec<i64>,
    /// Chrome 151 实测字段名为 `backendNodeId`（协议文档旧名 `backendDOMNodeId`
    /// 经 alias 兼容）；缺失按无 backend 绑定。
    #[serde(rename = "backendNodeId", alias = "backendDOMNodeId")]
    pub backend_dom_node_id: Option<Vec<i64>>,
    pub attributes: Option<Vec<Vec<i64>>>,
    /// 稀疏字符串数据（RareStringData 映射形态，非旧文档扁平数组）。
    pub input_value: Option<RareStringData>,
    /// 稀疏布尔数据（RareBooleanData 映射形态）。
    pub option_selected: Option<RareBooleanData>,
    /// Chrome 151 实测不发送该字段（全 -1 时省略），缺失按空集。
    #[serde(default)]
    pub child_node_indexes: Vec<i64>,
    /// 稀疏整数数据（RareIntegerData 映射形态，非旧文档扁平数组）。
    pub shadow_root_type: Option<RareIntegerData>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotLayout {
    pub node_index: Vec<i64>,
    pub bounds: Vec<Value>,
}

// ---------------------------------------------------------------------------
// Accessibility 域（会话级）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFullAXTreeParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFullAXTreeResult {
    pub nodes: Vec<AXNode>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AXNode {
    #[serde(deserialize_with = "crate::cdp::types::string_or_int")]
    pub node_id: String,
    pub ignored: Option<bool>,
    pub role: Option<AXValue>,
    pub name: Option<AXValue>,
    pub description: Option<AXValue>,
    pub value: Option<AXValue>,
    pub properties: Option<Vec<AXProperty>>,
    #[serde(default, deserialize_with = "crate::cdp::types::opt_vec_string_or_int")]
    pub child_ids: Option<Vec<String>>,
    pub backend_d_o_m_node_id: Option<i64>,
    pub frame_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AXValue {
    #[serde(rename = "type")]
    pub value_type: String,
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AXProperty {
    pub name: String,
    pub value: AXValue,
}

// ---------------------------------------------------------------------------
// Network 域（会话级）
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAllCookiesResult {
    pub cookies: Vec<Cookie>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub expires: f64,
    pub size: i64,
    pub http_only: bool,
    pub secure: bool,
    pub session: bool,
    pub same_site: Option<String>,
    pub priority: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCookiesParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub urls: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCookiesResult {
    pub cookies: Vec<Cookie>,
}

/// `Network.setCookies` / `Storage.setCookies` 的 cookie 参数（CDP CookieParam）：
/// 协议面除 name/value 外全部可选——可选字段 `None` 时**必须省略而非输出 null**
/// （Chrome 151 实测拒绝 null 字段，N2 缺陷：`url:null` 等导致命令失败；
/// 对照实验证实 null 字段需省略）。`expires` 省略即会话 cookie 语义
/// （协议不要求显式发 0/负数）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCookieParam {
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCookiesParams {
    pub cookies: Vec<SetCookieParam>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetResponseBodyParams {
    pub request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetResponseBodyResult {
    pub body: String,
    pub base64_encoded: bool,
}

/// Network.setBlockedURLs 参数（维度 17 门禁三检查点之传输层）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBlockedURLsParams {
    pub urls: Vec<String>,
}

// Network 事件

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestWillBeSentEvent {
    pub request_id: String,
    pub request: NetworkRequest,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkRequest {
    pub url: String,
    pub method: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadingFinishedEvent {
    pub request_id: String,
    pub encoded_data_length: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadingFailedEvent {
    pub request_id: String,
    pub canceled: Option<bool>,
    pub error_text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestFailedEvent {
    pub request_id: String,
}

// ---------------------------------------------------------------------------
// Input 域（会话级，统一注入管线，维度 12/14 共用）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchMouseEventParams {
    #[serde(rename = "type")]
    pub event_type: String,
    pub x: f64,
    pub y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub button: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buttons: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub click_count: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pointer_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchKeyEventParams {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unmodified_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows_virtual_key_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_virtual_key_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<i32>,
}

/// Input.insertText 参数（IME 安全兜底 / 纯文本粘贴路径，M-7/U-8）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertTextParams {
    pub text: String,
}

// ---------------------------------------------------------------------------
// Emulation 域（会话级）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDeviceMetricsOverrideParams {
    pub width: i32,
    pub height: i32,
    pub device_scale_factor: f64,
    pub mobile: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_height: Option<i32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetUserAgentOverrideParams {
    pub user_agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accept_language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGeolocationOverrideParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accuracy: Option<f64>,
}

// ---------------------------------------------------------------------------
// Storage 域（会话级，维度 16 登录态/配额）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearDataForOriginParams {
    pub origin: String,
    pub storage_types: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetUsageAndQuotaParams {
    pub origin: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetUsageAndQuotaResult {
    pub usage: f64,
    pub quota: f64,
    pub usage_breakdown: Option<Vec<StorageUsageForType>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsageForType {
    pub storage_type: String,
    pub usage: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageGetCookiesParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_context_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageGetCookiesResult {
    pub cookies: Vec<Cookie>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSetCookiesParams {
    pub cookies: Vec<SetCookieParam>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_context_id: Option<String>,
}

// ---------------------------------------------------------------------------
// DOMStorage 域（会话级，维度 16 storage_state localStorage 注入/导出聚合）
// ---------------------------------------------------------------------------

/// DOMStorage 存储区标识（storageId：securityOrigin + 存储类型；
/// `isLocalStorage=true` 即 localStorage，false 为 sessionStorage）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageId {
    pub security_origin: String,
    pub is_local_storage: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetDOMStorageItemsParams {
    pub storage_id: StorageId,
}

/// getDOMStorageItems 结果：entries 为 `[name, value]` 字符串对
/// （畸形单元素对由消费方跳过）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetDOMStorageItemsResult {
    pub entries: Vec<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDOMStorageItemParams {
    pub storage_id: StorageId,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDOMStorageItemParams {
    pub storage_id: StorageId,
    pub key: String,
}

// ---------------------------------------------------------------------------
// SystemInfo 域（browser 级，能力探测与诊断）
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetInfoResult {
    pub gpu: Value,
    pub model_name: String,
    pub model_version: String,
    pub command_line: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetProcessInfoResult {
    pub process_info: Vec<ProcessInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    #[serde(rename = "type")]
    pub process_type: String,
    pub id: i64,
    pub cpu_time: f64,
}

// ---------------------------------------------------------------------------
// Log 域（调试场景可选启用，默认不启用）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub source: String,
    pub level: String,
    pub text: String,
    pub timestamp: f64,
    pub url: Option<String>,
    pub line_number: Option<i64>,
}

/// Log.entryAdded 事件参数（默认不订阅，调试场景开）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryAddedEvent {
    pub entry: LogEntry,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 类型面冒烟：关键命令参数序列化字段名 camelCase 正确。
    #[test]
    fn domains_serialize_camel_case() {
        let p = AttachToTargetParams {
            target_id: "T1".to_string(),
            flatten: true,
        };
        let v = serde_json::to_value(&p).expect("序列化失败");
        assert_eq!(v["targetId"], "T1");
        assert_eq!(v["flatten"], true);

        let p = HandleJavaScriptDialogParams {
            accept: false,
            prompt_text: None,
        };
        let v = serde_json::to_value(&p).expect("序列化失败");
        assert_eq!(v["accept"], false);
        assert!(v.get("promptText").is_none());

        let p = SetBlockedURLsParams {
            urls: vec!["http://10.0.0.0/8".to_string()],
        };
        let v = serde_json::to_value(&p).expect("序列化失败");
        assert_eq!(v["urls"][0], "http://10.0.0.0/8");

        // 帧泵 ack 参数（维度 12 §2.1：sessionId 为 screencast 帧会话标识；
        // Value 形态无损透传——数字（Chrome 151 实测）与字符串均可）
        let p = ScreencastFrameAckParams {
            session_id: Value::String("S1".to_string()),
        };
        let v = serde_json::to_value(&p).expect("序列化失败");
        assert_eq!(v["sessionId"], "S1");
        assert_eq!(v.as_object().unwrap().len(), 1, "只含 sessionId 一个字段");
        // Chrome 151 数字形态：保持数字（类型敏感，字符串化被 Chrome 拒绝）
        let p = ScreencastFrameAckParams {
            session_id: Value::from(1),
        };
        let v = serde_json::to_value(&p).expect("序列化失败");
        assert_eq!(v["sessionId"], Value::from(1), "数字形态保持数字（Chrome 151 校验类型）");
    }

    /// SetCookieParam wire 序列化回归（N2 缺陷：可选字段 None 曾输出 null，
    /// 被 Chrome 151 拒绝）：None 字段必须省略（逐字段断言），
    /// Some 字段正常输出；SetCookiesParams / StorageSetCookiesParams 外层
    /// 容器同样不得携带 null 键。
    #[test]
    fn set_cookie_param_omits_none_fields() {
        // 全部可选字段 None：wire 只含 name/value 两键
        let p = SetCookieParam {
            name: "n".to_string(),
            value: "v".to_string(),
            domain: None,
            url: None,
            path: None,
            expires: None,
            http_only: None,
            secure: None,
            same_site: None,
        };
        let v = serde_json::to_value(&p).expect("序列化失败");
        let obj = v.as_object().expect("应为对象");
        for key in [
            "domain", "url", "path", "expires", "httpOnly", "secure", "sameSite",
        ] {
            assert!(
                !obj.contains_key(key),
                "可选字段 `{key}` 为 None 时必须省略而非输出 null（Chrome 151 拒绝）"
            );
        }
        assert_eq!(obj.len(), 2, "仅 name/value 两键");
        assert_eq!(v["name"], "n");
        assert_eq!(v["value"], "v");

        // 部分可选字段 Some：对应键存在且值正确，其余仍省略
        let p = SetCookieParam {
            name: "sid".to_string(),
            value: "abc".to_string(),
            domain: Some(".example.com".to_string()),
            url: None,
            path: Some("/".to_string()),
            expires: Some(1_750_000_000.0),
            http_only: Some(true),
            secure: Some(false),
            same_site: Some("Lax".to_string()),
        };
        let v = serde_json::to_value(&p).expect("序列化失败");
        assert_eq!(v["domain"], ".example.com");
        assert_eq!(v["path"], "/");
        assert_eq!(v["expires"], 1_750_000_000.0);
        assert_eq!(v["httpOnly"], true);
        assert_eq!(v["secure"], false);
        assert_eq!(v["sameSite"], "Lax");
        assert!(v.get("url").is_none(), "None 的 url 必须省略");

        // url 形态（domain 为 None）：url 键存在，domain 省略
        let p = SetCookieParam {
            name: "sid".to_string(),
            value: "abc".to_string(),
            domain: None,
            url: Some("https://example.com/".to_string()),
            path: None,
            expires: None,
            http_only: None,
            secure: None,
            same_site: None,
        };
        let v = serde_json::to_value(&p).expect("序列化失败");
        assert_eq!(v["url"], "https://example.com/");
        assert_eq!(v.as_object().unwrap().len(), 3, "name/value/url 三键");
        assert!(v.get("domain").is_none());

        // 外层容器：SetCookiesParams / StorageSetCookiesParams 的 cookies 数组
        // 内不得出现 null 键（N2 缺陷的完整 wire 面）
        let cookie = SetCookieParam {
            name: "sid".to_string(),
            value: "abc".to_string(),
            domain: Some("example.com".to_string()),
            url: None,
            path: None,
            expires: None,
            http_only: None,
            secure: None,
            same_site: None,
        };
        let set = SetCookiesParams {
            cookies: vec![cookie.clone()],
        };
        let v = serde_json::to_value(&set).expect("序列化失败");
        let wire = serde_json::to_string(&set).expect("序列化失败");
        assert!(
            !wire.contains("null"),
            "Network.setCookies wire 不得含 null：{wire}"
        );
        assert_eq!(v["cookies"][0]["domain"], "example.com");
        assert_eq!(v["cookies"][0].as_object().unwrap().len(), 3);

        let storage = StorageSetCookiesParams {
            cookies: vec![cookie],
            browser_context_id: None,
        };
        let wire = serde_json::to_string(&storage).expect("序列化失败");
        assert!(
            !wire.contains("null"),
            "Storage.setCookies wire 不得含 null：{wire}"
        );
        let v = serde_json::to_value(&storage).expect("序列化失败");
        assert_eq!(v["cookies"][0]["domain"], "example.com");
        assert!(v.get("browserContextId").is_none());
    }

    /// 结果反序列化冒烟（含容错字段）。
    #[test]
    fn domains_deserialize_results() {
        let v: BrowserVersionResult = serde_json::from_str(
            r#"{"protocolVersion":"1.3","product":"Chrome/131.0.6778.204",
                "revision":"@abc","userAgent":"ua","jsVersion":"13.1.71","WebKit-Version":"537.36"}"#,
        )
        .expect("版本信息解析失败");
        assert_eq!(v.major_version(), 131);

        let t: TargetInfo = serde_json::from_str(
            r#"{"targetId":"T1","type":"page","title":"t","url":"https://e.com"}"#,
        )
        .expect("目标信息解析失败");
        assert_eq!(t.target_type, "page");

        let ax: AXNode = serde_json::from_str(r#"{"nodeId":7,"childIds":[1,"2"]}"#).unwrap();
        assert_eq!(ax.node_id, "7");
        assert_eq!(ax.child_ids.unwrap(), vec!["1", "2"]);
    }

    /// DOM.getFrameOwner / SnapshotDocument.frameId 类型面（维度 13 §1.5
    /// 跨域递归依赖：owner 定位 + pierce 帧集合筛选）。
    #[test]
    fn frame_owner_and_document_frame_id_parse() {
        let owner: GetFrameOwnerResult = serde_json::from_str(
            r#"{"backendNodeId":101,"nodeId":3}"#,
        )
        .expect("getFrameOwner 结果解析失败");
        assert_eq!(owner.backend_node_id, Some(101));
        assert_eq!(owner.node_id, 3);
        // backendNodeId 缺失形态（协议宽松面）
        let owner: GetFrameOwnerResult =
            serde_json::from_str(r#"{"nodeId":3}"#).expect("缺 backendNodeId 应可解析");
        assert!(owner.backend_node_id.is_none());

        // frameId 字段：池下标（Chrome 151 实测形态）/直出字符串/缺失
        let nodes_json = r#"{"parentIndex":[-1],"nodeType":[9],"nodeName":[0],"nodeValue":[-1]}"#;
        let doc: SnapshotDocument = serde_json::from_str(
            &format!(r#"{{"documentURL":0,"title":1,"frameId":2,"nodes":{nodes_json},"layout":{{"nodeIndex":[],"bounds":[]}}}}"#),
        )
        .expect("含 frameId 文档解析失败");
        let strings = vec!["".to_string(), "".to_string(), "F1".to_string()];
        assert_eq!(
            doc.frame_id.as_ref().unwrap().resolve(&strings),
            "F1",
            "frameId 池下标应经字符串池解析（Chrome 151 实测形态）"
        );
        // 直出字符串形态（宽容面）
        let doc: SnapshotDocument = serde_json::from_str(
            &format!(r#"{{"documentURL":0,"title":1,"frameId":"F2","nodes":{nodes_json},"layout":{{"nodeIndex":[],"bounds":[]}}}}"#),
        )
        .expect("直出 frameId 文档解析失败");
        assert_eq!(doc.frame_id.as_ref().unwrap().resolve(&strings), "F2");
        // 缺失 frameId（旧协议）→ None（向后兼容）
        let doc: SnapshotDocument = serde_json::from_str(
            &format!(r#"{{"documentURL":0,"title":1,"nodes":{nodes_json},"layout":{{"nodeIndex":[],"bounds":[]}}}}"#),
        )
        .expect("无 frameId 文档解析失败");
        assert!(doc.frame_id.is_none(), "缺失 frameId 按 None（向后兼容）");
    }

    /// DOMStorage 域类型面（维度 16 storage_state 注入/导出聚合）：
    /// storageId 双字段（securityOrigin + isLocalStorage）与
    /// set/get/remove 参数序列化 + get 结果反序列化。
    #[test]
    fn dom_storage_domain_serialization() {
        let storage_id = StorageId {
            security_origin: "https://example.com".to_string(),
            is_local_storage: true,
        };
        let v = serde_json::to_value(&storage_id).expect("序列化失败");
        assert_eq!(v["securityOrigin"], "https://example.com");
        assert_eq!(v["isLocalStorage"], true);
        assert_eq!(v.as_object().unwrap().len(), 2, "storageId 只含两字段");

        let p = SetDOMStorageItemParams {
            storage_id: storage_id.clone(),
            key: "theme".to_string(),
            value: "dark".to_string(),
        };
        let v = serde_json::to_value(&p).expect("序列化失败");
        assert_eq!(v["storageId"]["securityOrigin"], "https://example.com");
        assert_eq!(v["storageId"]["isLocalStorage"], true);
        assert_eq!(v["key"], "theme");
        assert_eq!(v["value"], "dark");

        let p = GetDOMStorageItemsParams {
            storage_id: storage_id.clone(),
        };
        let v = serde_json::to_value(&p).expect("序列化失败");
        assert_eq!(v["storageId"]["securityOrigin"], "https://example.com");
        assert_eq!(v.as_object().unwrap().len(), 1, "只含 storageId 一个字段");

        let p = RemoveDOMStorageItemParams {
            storage_id: storage_id.clone(),
            key: "k".to_string(),
        };
        let v = serde_json::to_value(&p).expect("序列化失败");
        assert_eq!(v["storageId"]["securityOrigin"], "https://example.com");
        assert_eq!(v["key"], "k");

        let r: GetDOMStorageItemsResult = serde_json::from_str(
            r#"{"entries":[["theme","dark"],["k","v1"],["odd"]]}"#,
        )
        .expect("结果解析失败");
        assert_eq!(r.entries.len(), 3);
        assert_eq!(
            r.entries[0],
            vec!["theme".to_string(), "dark".to_string()],
            "entries 为 [name, value] 对"
        );
        // 往返：StorageId 反序列化与序列化一致
        let round: StorageId =
            serde_json::from_value(serde_json::to_value(&storage_id).expect("序列化失败"))
                .expect("反序列化失败");
        assert_eq!(round, storage_id);
    }
}
