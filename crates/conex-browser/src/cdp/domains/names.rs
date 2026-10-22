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
// U-3 静态帧降级（screencast 不可用 → 1fps captureScreenshot 轮询）；
// 参数/结果类型见 CaptureScreenshotParams/CaptureScreenshotResult（本文件）
pub const PAGE_CAPTURE_SCREENSHOT: &str = "Page.captureScreenshot";
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
