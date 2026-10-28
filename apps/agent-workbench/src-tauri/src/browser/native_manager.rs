//! 原生子 Webview 管理器（Native Child Webview Manager）
//!
//! 依据 `docs/native-browser-overhaul/00-总方案-原生浏览器彻底改造与子Webview架构方案.md` 与
//! `docs/native-browser-overhaul/01-分维-Tauri2原生子Webview管理器与Rust内核实现.md` 编制。
//! 结合 `docs/native-browser-overhaul/audits/05-systemic-refactoring-and-anti-slacking-audit.md` 深度重构。
//!
//! 核心职责：
//! 1. 作为进程级单例 [NativeWebviewManager]，管理主窗口下所有原生子 Webview 实例；
//! 2. 调度异步非死锁创建（STA 消息循环隔离）、挂载到主窗口 `Window::add_child`；
//! 3. 几何位置同步（带 <0.5px 差分去重与精确物理像素对齐）；
//! 4. 显隐控制（`show` / `hide` 与渲染资源挂起）；
//! 5. 导航与抢占式动作执行（后退/前进/刷新/停止）；
//! 6. 存储分区（UserDataFolder）与安全门禁并轨：接入 `security::resolve_browser_udf_path` 与 `security::validate_navigation_url`；
//! 7. 闭环析构与句柄释放：接入 `native_tokens.rs` 注销所有 COM Token，在销毁时清理 Ephemeral 磁盘目录；
//! 8. 双重幂等防线：创建前既检查内部映射，又检查 Tauri 全局注册表；挂载异常时具备重聚接管兜底，彻底杜绝 already exists 冲突异常。

#![allow(dead_code)]
#![allow(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::webview::Color;
use tauri::{AppHandle, Emitter, Manager, Webview};

#[cfg(windows)]
use super::inspector_bridge::{
    inspector_control_message, inspector_ready_may_mark_available, inspector_runtime_script,
    parse_inspector_message, InspectorMessage, INSPECTOR_EVENT, MAX_INSPECTOR_MESSAGE_BYTES,
};
use super::native_tokens::EventTokenRegistry;
use super::native_types::{
    BrowserActionKind, BrowserStorageMode, DownloadProgressPayload, SetHitTestResult,
    WebviewBounds, EVENT_BROWSER_DOWNLOAD_PROGRESS,
};
use super::security;

#[cfg(windows)]
use webview2_com::{
    AddScriptToExecuteOnDocumentCreatedCompletedHandler, BytesReceivedChangedEventHandler,
    DownloadStartingEventHandler, ExecuteScriptCompletedHandler, HistoryChangedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_4, ICoreWebView2DownloadOperation,
        COREWEBVIEW2_DOWNLOAD_STATE, COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED,
        COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS, COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED,
    },
    NavigationCompletedEventHandler, NavigationStartingEventHandler, StateChangedEventHandler,
    WebMessageReceivedEventHandler,
};

#[cfg(windows)]
use windows::Win32::System::Com::CoTaskMemFree;
use windows_core::{Interface, HSTRING, PWSTR};

pub type LogicalRect = WebviewBounds;
pub type BrowserAction = BrowserActionKind;

fn explicit_takeover_navigation_target(initial_url: Option<&str>) -> Option<&str> {
    initial_url.filter(|target| *target != "about:blank")
}

fn apply_inspector_request_state(
    inspector_enabled: &AtomicBool,
    is_available: bool,
    requested_enabled: bool,
) -> Result<bool, &'static str> {
    if requested_enabled && !is_available {
        return Err(
            "Inspector is unavailable until the current document is refreshed or navigated",
        );
    }

    Ok(inspector_enabled.swap(requested_enabled, Ordering::AcqRel))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InspectorMessageAdmission {
    Rejected,
    ReadyHandshake,
    Active,
}

fn inspector_message_admission(
    available: bool,
    enabled: bool,
    ready_pending: &AtomicBool,
) -> InspectorMessageAdmission {
    let handshake_pending = ready_pending.swap(false, Ordering::AcqRel);
    if available && enabled {
        InspectorMessageAdmission::Active
    } else if handshake_pending {
        InspectorMessageAdmission::ReadyHandshake
    } else {
        InspectorMessageAdmission::Rejected
    }
}

fn inspector_message_admission_allows(
    admission: InspectorMessageAdmission,
    is_ready: bool,
) -> bool {
    match admission {
        InspectorMessageAdmission::Rejected => false,
        InspectorMessageAdmission::ReadyHandshake => is_ready,
        InspectorMessageAdmission::Active => true,
    }
}

fn post_inspector_control_for_document(
    ready_pending: &AtomicBool,
    is_current_document: impl FnOnce() -> bool,
    post: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    ready_pending.store(true, Ordering::Release);
    if !is_current_document() {
        ready_pending.store(false, Ordering::Release);
        return Ok(());
    }
    let result = post();
    if result.is_err() {
        ready_pending.store(false, Ordering::Release);
    }
    result
}

/// 导航状态事件负载（对应 `browser://navigation-state`）
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

impl BrowserNavigationStatePayload {
    /// 构造基础导航状态
    pub fn new(tab_id: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            tab_id: tab_id.into(),
            url: url.into(),
            title: String::new(),
            can_go_back: None,
            can_go_forward: None,
            is_loading: false,
            favicon_url: None,
            http_status: None,
            is_muted: false,
        }
    }

    /// 设置网页标题
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = title.into();
        self
    }

    /// 设置加载中状态
    pub fn with_loading(mut self, is_loading: bool) -> Self {
        self.is_loading = is_loading;
        self
    }

    /// 设置历史记录前进后退能力
    pub fn with_history_caps(
        mut self,
        can_go_back: Option<bool>,
        can_go_forward: Option<bool>,
    ) -> Self {
        self.can_go_back = can_go_back;
        self.can_go_forward = can_go_forward;
        self
    }

    /// 设置 Favicon 图标地址
    pub fn with_favicon(mut self, favicon_url: Option<String>) -> Self {
        self.favicon_url = favicon_url;
        self
    }
}

/// 单个受管子 Webview 实例容器
pub struct ManagedWebview {
    pub tab_id: String,
    pub label: String,
    pub webview: Webview<tauri::Wry>,
    pub last_bounds: Option<WebviewBounds>,
    pub is_visible: bool,
    pub current_state: Arc<Mutex<BrowserNavigationStatePayload>>,
    pub storage_mode: BrowserStorageMode,
    pub udf_path: PathBuf,
    /// 本 Tab 的本地文件导航约束根（03-分维 §7.3：`file:` 仅限工作区内；
    /// None = 公网上下文，`file:` 一律拒绝）
    pub workspace_root: Option<PathBuf>,
    pub tokens: EventTokenRegistry,
    pub inspector_enabled: Arc<AtomicBool>,
    pub inspector_available: Arc<AtomicBool>,
    pub inspector_challenge: Option<String>,
    pub inspector_generation: Arc<AtomicU64>,
    pub inspector_navigation_id: Arc<AtomicU64>,
    pub inspector_navigation_pending: Arc<AtomicBool>,
    pub inspector_ready_pending: Arc<AtomicBool>,
}

/// 原生多 Webview 单例管理器
#[derive(Clone)]
pub struct NativeWebviewManager {
    webviews: Arc<Mutex<HashMap<String, ManagedWebview>>>,
    storage_root: PathBuf,
}

/// 启动期 GC：清除上次进程强杀/崩溃遗留的 Ephemeral UDF 目录。
///
/// 正常关闭路径由 [NativeWebviewManager::close] / [NativeWebviewManager::close_all]
/// 逐 Tab 删除；进程被强杀时该路径不会执行，只能由下一次启动兜底——此时本进程尚未
/// 创建任何 Webview，目录不会被 WebView2 占用，删除是可靠的。
/// 解析自定义存储子目录：只允许 `browser-storage` 下的单一目录名。
///
/// `data_directory` 来自 IPC 入参（含按 tabId 派生的 `ephemeral-{tabId}`）；
/// 带分隔符、`..`、绝对路径的取值会让 UDF 目录逃逸存储根，必须在拼接前拒绝。
fn resolve_custom_storage_dir(storage_root: &Path, custom_dir: &str) -> Option<PathBuf> {
    let mut components = Path::new(custom_dir).components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(name)), None) => Some(storage_root.join(name)),
        _ => None,
    }
}

/// Ephemeral 模式在 Tab 关闭时销毁其 UDF 目录；Persistent 模式保留数据。
// 浏览器运行期临时 profile 目录清理（非会话数据；G2 仅约束会话历史清理）。
#[allow(clippy::disallowed_methods)]
fn remove_ephemeral_udf_if_needed(mode: BrowserStorageMode, udf_path: &Path) {
    if mode == BrowserStorageMode::Ephemeral && udf_path.exists() {
        let _ = std::fs::remove_dir_all(udf_path);
        tracing::info!("[NativeWebview] Cleaned ephemeral UDF directory: {udf_path:?}");
    }
}

#[allow(clippy::disallowed_methods)]
fn purge_stale_ephemeral_dirs(storage_root: &Path) {
    let Ok(entries) = std::fs::read_dir(storage_root) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !name.starts_with("ephemeral-") {
            continue;
        }
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => {
                tracing::info!("[NativeWebview] Purged stale ephemeral UDF directory: {name}");
            }
            Err(error) => {
                tracing::warn!(
                    "[NativeWebview] Could not purge stale ephemeral UDF directory {name}: {error}"
                );
            }
        }
    }
}

impl NativeWebviewManager {
    /// 构造原生管理器单例
    pub fn new(app_dir: PathBuf) -> Self {
        let storage_root = app_dir.join("browser-storage");
        let _ = std::fs::create_dir_all(&storage_root);
        purge_stale_ephemeral_dirs(&storage_root);
        Self {
            webviews: Arc::new(Mutex::new(HashMap::new())),
            storage_root,
        }
    }

    /// 差分去重算法：若位移与尺寸变动量均小于 0.5px，判定为视觉无意义变动
    #[inline]
    pub fn is_similar_bounds(a: &WebviewBounds, b: &WebviewBounds) -> bool {
        (a.x - b.x).abs() < 0.5
            && (a.y - b.y).abs() < 0.5
            && (a.width - b.width).abs() < 0.5
            && (a.height - b.height).abs() < 0.5
    }

    /// 安全检验与标准化 URL（接入 security.rs 核心门禁；03-分维 §7.3）
    ///
    /// `workspace_root` 为 `Some` 时，`file:` 协议允许访问工作区内文件；
    /// 为 `None` 时 `file:` 一律拒绝（公网上下文缺省安全面）。
    pub fn sanitize_and_validate_url_with_root(
        raw: &str,
        workspace_root: Option<&std::path::Path>,
    ) -> Result<String, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed == "about:blank" {
            return Ok("about:blank".to_string());
        }
        let url_to_check = if trimmed.starts_with("http://")
            || trimmed.starts_with("https://")
            || trimmed.starts_with("about:")
            || trimmed.starts_with("file:")
        {
            trimmed.to_string()
        } else {
            format!("https://{}", trimmed)
        };

        security::validate_navigation_url(&url_to_check, workspace_root)
            .map_err(|e| format!("Security validation rejected URL: {e}"))?;

        Ok(url_to_check)
    }

    /// 异步创建并挂载原生子 Webview 到主窗口
    ///
    /// 关键保障：
    /// 1. 运行在异步线程上下文，防范 Windows COM STA 消息循环阻塞死锁；
    /// 2. 独立存储目录（UserDataFolder）接入 `security::resolve_browser_udf_path` 物理隔离 Cookie 与 LocalStorage；
    /// 3. 设置底色 (24, 24, 27, 255) 对齐暗黑主题，规避缩放白边；
    /// 4. 零特权暴露：作为公网 Webview，不注入特权 IPC 桥；
    /// 5. 双重幂等防线：创建前既检查内存映射，又检查 Tauri 全局注册表；挂载异常时具备重聚接管兜底，彻底杜绝 already exists 冲突异常。
    #[allow(clippy::too_many_arguments)]
    pub async fn create_webview(
        &self,
        app: &AppHandle,
        tab_id: String,
        initial_url: Option<String>,
        bounds: WebviewBounds,
        visible: bool,
        storage_mode: Option<BrowserStorageMode>,
        data_directory: Option<String>,
        workspace_root: Option<String>,
    ) -> Result<String, String> {
        let label = format!("native-browser-{}", tab_id);
        let workspace_root_path = workspace_root.map(PathBuf::from);
        let root_for_validation = workspace_root_path.as_deref();

        let main_window = app
            .get_window("main")
            .ok_or_else(|| "Main window 'main' not found".to_string())?;
        let scale_factor = main_window.scale_factor().map_err(|e| e.to_string())?;

        // 1. 幂等性第一重守卫：若内存映射中已存在，则重聚接管实例、更新 bounds 与显隐并返回成功
        {
            let mut guard = self.webviews.lock().map_err(|e| e.to_string())?;
            if let Some(managed) = guard.get_mut(&tab_id) {
                Self::apply_bounds_to_managed(managed, bounds, scale_factor)?;
                if visible != managed.is_visible {
                    if visible {
                        let _ = managed.webview.show();
                    } else {
                        let _ = managed.webview.hide();
                    }
                    managed.is_visible = visible;
                }
                if let Some(ref target) = initial_url {
                    if target != "about:blank" {
                        if let Ok(sanitized) =
                            Self::sanitize_and_validate_url_with_root(target, root_for_validation)
                        {
                            if let Ok(parsed) = sanitized.parse::<url::Url>() {
                                let _ = managed.webview.navigate(parsed);
                                if let Ok(mut state) = managed.current_state.lock() {
                                    state.url = sanitized;
                                    state.is_loading = true;
                                    let _ = app.emit("browser://navigation-state", state.clone());
                                }
                            }
                        }
                    }
                }
                return Ok(label);
            }
        }

        // 2. 幂等性第二重守卫：检查 Tauri 全局注册表中是否已有同 label 的 Webview（如热重载留存）
        // 若已存在，重聚接管实例、更新 bounds 与显隐并返回成功，绝不抛出冲突异常
        if let Some(existing_webview) = app.get_webview(&label) {
            let existing_url = existing_webview
                .url()
                .map(|u| u.to_string())
                .unwrap_or_else(|_| "about:blank".to_string());
            let navigation_target = explicit_takeover_navigation_target(initial_url.as_deref())
                .map(|target| {
                    let sanitized =
                        Self::sanitize_and_validate_url_with_root(target, root_for_validation)?;
                    let parsed = sanitized
                        .parse::<url::Url>()
                        .map_err(|error| format!("Invalid takeover URL parsed: {error}"))?;
                    Ok::<_, String>((sanitized, parsed))
                })
                .transpose()?;
            let current_state = Arc::new(Mutex::new(
                BrowserNavigationStatePayload::new(tab_id.clone(), existing_url)
                    .with_loading(false),
            ));

            let effective_mode = storage_mode.unwrap_or(BrowserStorageMode::Persistent);
            let udf_path = match data_directory.as_deref() {
                Some(custom_dir) => {
                    let path = resolve_custom_storage_dir(&self.storage_root, custom_dir)
                        .ok_or_else(|| {
                            format!(
                                "Invalid browser data directory '{custom_dir}': must be a single directory name under browser-storage"
                            )
                        })?;
                    let _ = std::fs::create_dir_all(&path);
                    path
                }
                None => security::resolve_browser_udf_path(effective_mode)
                    .map_err(|e| format!("Failed to resolve browser UDF path: {e}"))?,
            };

            #[cfg(windows)]
            let inspector_challenge = Some(generate_inspector_challenge()?);
            #[cfg(not(windows))]
            let inspector_challenge = None;
            let inspector_available = Arc::new(AtomicBool::new(false));
            let inspector_generation = Arc::new(AtomicU64::new(0));
            let inspector_navigation_id = Arc::new(AtomicU64::new(0));
            let inspector_navigation_pending = Arc::new(AtomicBool::new(false));
            let inspector_ready_pending = Arc::new(AtomicBool::new(false));

            let mut managed = ManagedWebview {
                tab_id: tab_id.clone(),
                label: label.clone(),
                webview: existing_webview,
                last_bounds: Some(bounds),
                is_visible: visible,
                current_state: Arc::clone(&current_state),
                storage_mode: effective_mode,
                udf_path,
                workspace_root: workspace_root_path,
                tokens: EventTokenRegistry::new(),
                inspector_enabled: Arc::new(AtomicBool::new(false)),
                inspector_available,
                inspector_challenge,
                inspector_generation,
                inspector_navigation_id,
                inspector_navigation_pending,
                inspector_ready_pending,
            };

            Self::apply_bounds_to_managed(&mut managed, bounds, scale_factor)?;
            if visible {
                let _ = managed.webview.show();
            } else {
                let _ = managed.webview.hide();
            }

            #[cfg(windows)]
            match register_history_changed_listener(
                &managed.webview,
                app.clone(),
                tab_id.clone(),
                Arc::clone(&current_state),
            )
            .await
            {
                Ok(token) => managed.tokens.register_history_changed(token),
                Err(error) => tracing::warn!(
                    "[NativeWebview] Could not monitor WebView2 history for tab {tab_id}: {error}"
                ),
            }

            #[cfg(windows)]
            match register_inspector_listener(
                &managed.webview,
                app.clone(),
                tab_id.clone(),
                Arc::clone(&managed.inspector_enabled),
                Arc::clone(&managed.inspector_available),
                Arc::clone(&managed.inspector_generation),
                Arc::clone(&managed.inspector_navigation_id),
                Arc::clone(&managed.inspector_navigation_pending),
                Arc::clone(&managed.inspector_ready_pending),
                managed
                    .inspector_challenge
                    .clone()
                    .expect("Windows Inspector challenge is initialized"),
            )
            .await
            {
                Ok((message_token, navigation_token, navigation_completed_token)) => {
                    managed.tokens.register_web_message_received(message_token);
                    managed
                        .tokens
                        .register_navigation_starting(navigation_token);
                    managed
                        .tokens
                        .register_navigation_completed(navigation_completed_token);
                    match register_inspector_runtime_for_future_documents(
                        &managed.webview,
                        managed
                            .inspector_challenge
                            .as_deref()
                            .expect("Windows Inspector challenge is initialized"),
                    )
                    .await
                    {
                        Ok(()) => {}
                        Err(error) => {
                            tracing::warn!(
                                "[NativeWebview] Could not register Inspector for future documents in tab {tab_id}: {error}"
                            );
                        }
                    }
                }
                Err(error) => tracing::warn!(
                    "[NativeWebview] Could not register Inspector messages for tab {tab_id}: {error}"
                ),
            }

            if let Some((sanitized_url, parsed_url)) = navigation_target {
                managed
                    .webview
                    .navigate(parsed_url)
                    .map_err(|error| format!("Could not navigate takeover WebView: {error}"))?;
                if let Ok(mut state) = managed.current_state.lock() {
                    state.url = sanitized_url;
                    state.is_loading = true;
                    state.can_go_back = None;
                    state.can_go_forward = None;
                    let _ = app.emit("browser://navigation-state", state.clone());
                }
            }

            if let Ok(state) = current_state.lock() {
                let _ = app.emit("browser://navigation-state", state.clone());
            }

            let mut guard = self.webviews.lock().map_err(|e| e.to_string())?;
            guard.insert(tab_id, managed);
            return Ok(label);
        }

        // 3. URL 验证与过滤（通过 security 门禁；file: 受 workspace_root 约束）
        let target_url_str = initial_url.as_deref().unwrap_or("about:blank");
        let validated_url =
            Self::sanitize_and_validate_url_with_root(target_url_str, root_for_validation)?;
        let parsed_url: url::Url = validated_url
            .parse()
            .map_err(|e| format!("Invalid URL parsed: {e}"))?;

        #[cfg(windows)]
        let inspector_challenge = Some(generate_inspector_challenge()?);
        #[cfg(not(windows))]
        let inspector_challenge = None;

        // 4. 构建 WebviewBuilder
        let mut builder = tauri::webview::WebviewBuilder::new(
            &label,
            tauri::WebviewUrl::External(parsed_url.clone()),
        );

        #[cfg(windows)]
        {
            let runtime = inspector_runtime_script(
                inspector_challenge
                    .as_deref()
                    .expect("Windows Inspector challenge is initialized"),
            )
            .map_err(|error| format!("Could not configure Inspector runtime: {error}"))?;
            builder = builder.initialization_script(runtime);
        }

        // 独立存储分区（UserDataFolder）接入 security::resolve_browser_udf_path
        let effective_mode = storage_mode.unwrap_or(BrowserStorageMode::Persistent);
        let udf_path = match data_directory.as_deref() {
            Some(custom_dir) => {
                let path = resolve_custom_storage_dir(&self.storage_root, custom_dir)
                    .ok_or_else(|| {
                        format!(
                            "Invalid browser data directory '{custom_dir}': must be a single directory name under browser-storage"
                        )
                    })?;
                let _ = std::fs::create_dir_all(&path);
                path
            }
            None => security::resolve_browser_udf_path(effective_mode)
                .map_err(|e| format!("Failed to resolve browser UDF path: {e}"))?,
        };
        builder = builder.data_directory(udf_path.clone());

        // 样式与特性配置：深色底色 (24, 24, 27, 255)，绝无特权 IPC 注入
        builder = builder
            .accept_first_mouse(true)
            .background_color(Color(24, 24, 27, 255))
            .devtools(cfg!(debug_assertions));

        // 导航协议安全守卫（接入 security::validate_navigation_url；file: 按
        // 03-分维 §7.3 限定在本 Tab 的 workspace_root 内，未提供则一律拒绝）
        let nav_gate_root = workspace_root_path.clone();
        builder = builder.on_navigation(move |url| {
            let url_str = url.as_str();
            match security::validate_navigation_url(url_str, nav_gate_root.as_deref()) {
                Ok(_) => true,
                Err(e) => {
                    tracing::warn!(
                        "[NativeWebview] Security gate blocked navigation to: {url_str} ({e})"
                    );
                    false
                }
            }
        });

        // 共享强类型导航状态
        let current_state = Arc::new(Mutex::new(
            BrowserNavigationStatePayload::new(tab_id.clone(), validated_url.clone())
                .with_loading(true),
        ));
        let inspector_enabled = Arc::new(AtomicBool::new(false));
        let inspector_available = Arc::new(AtomicBool::new(false));
        let inspector_generation = Arc::new(AtomicU64::new(0));
        let inspector_navigation_id = Arc::new(AtomicU64::new(0));
        let inspector_navigation_pending = Arc::new(AtomicBool::new(false));
        let inspector_ready_pending = Arc::new(AtomicBool::new(false));

        // 页面标题变化与状态广播
        let app_handle_title = app.clone();
        let current_state_title = Arc::clone(&current_state);
        let tab_id_title = tab_id.clone();
        builder = builder.on_document_title_changed(move |webview, title| {
            let current_url = webview.url().map(|u| u.to_string()).unwrap_or_default();
            let payload = {
                if let Ok(mut state) = current_state_title.lock() {
                    state.title = title.clone();
                    if !current_url.is_empty() {
                        state.url = current_url;
                    }
                    state.clone()
                } else {
                    BrowserNavigationStatePayload::new(tab_id_title.clone(), current_url)
                        .with_title(title)
                }
            };
            let _ = app_handle_title.emit("browser://navigation-state", payload);
        });

        // 页面加载生命周期事件与状态广播
        let app_handle_load = app.clone();
        let current_state_load = Arc::clone(&current_state);
        let inspector_available_load = Arc::clone(&inspector_available);
        let inspector_generation_load = Arc::clone(&inspector_generation);
        let inspector_navigation_pending_load = Arc::clone(&inspector_navigation_pending);
        let inspector_ready_pending_load = Arc::clone(&inspector_ready_pending);
        let inspector_navigation_id_load = Arc::clone(&inspector_navigation_id);
        let inspector_enabled_load = Arc::clone(&inspector_enabled);
        let tab_id_load = tab_id.clone();
        builder = builder.on_page_load(move |webview, payload| {
            let current_url = webview.url().map(|u| u.to_string()).unwrap_or_default();
            let is_loading = match payload.event() {
                tauri::webview::PageLoadEvent::Started => true,
                tauri::webview::PageLoadEvent::Finished => false,
            };
            if is_loading {
                inspector_generation_load.fetch_add(1, Ordering::AcqRel);
                inspector_navigation_pending_load.store(true, Ordering::Release);
                inspector_available_load.store(false, Ordering::Release);
                inspector_ready_pending_load.store(false, Ordering::Release);
            }
            let state_to_emit = {
                if let Ok(mut state) = current_state_load.lock() {
                    state.is_loading = is_loading;
                    if !current_url.is_empty() {
                        state.url = current_url;
                    }
                    if is_loading {
                        state.can_go_back = None;
                        state.can_go_forward = None;
                    }
                    state.clone()
                } else {
                    BrowserNavigationStatePayload::new(tab_id_load.clone(), current_url)
                        .with_loading(is_loading)
                }
            };
            let _ = app_handle_load.emit("browser://navigation-state", state_to_emit);
            #[cfg(windows)]
            if !is_loading {
                if inspector_navigation_id_load.load(Ordering::Acquire) == 0 {
                    inspector_navigation_pending_load.store(false, Ordering::Release);
                    schedule_inspector_control_after_page_load(
                        &webview,
                        Arc::clone(&inspector_generation_load),
                        Arc::clone(&inspector_navigation_pending_load),
                        Arc::clone(&inspector_enabled_load),
                        Arc::clone(&inspector_ready_pending_load),
                    );
                }
                request_history_state(
                    webview.clone(),
                    app_handle_load.clone(),
                    tab_id_load.clone(),
                    Arc::clone(&current_state_load),
                );
            }
        });

        // 初始物理位置换算
        let physical = bounds.to_physical(scale_factor);
        let pos = tauri::PhysicalPosition::new(physical.x, physical.y);
        let size = tauri::PhysicalSize::new(physical.width as u32, physical.height as u32);

        // 5. 原生挂载（带并发冲突终极兜底）
        let (webview, was_existing) = match main_window.add_child(builder, pos, size) {
            Ok(wv) => (wv, false),
            Err(e) => {
                // 若底层出现竞态并报错 already exists，直接尝试从全局重新拉取已存在的 webview 实例接管
                if let Some(existing) = app.get_webview(&label) {
                    tracing::warn!(
                        "[NativeWebview] add_child encountered '{}', taking over existing webview '{}'",
                        e,
                        label
                    );
                    (existing, true)
                } else {
                    return Err(format!("Window::add_child failed: {e}"));
                }
            }
        };

        let takeover_navigation_target = (was_existing
            && explicit_takeover_navigation_target(initial_url.as_deref()).is_some())
        .then(|| (validated_url.clone(), parsed_url.clone()));
        if was_existing {
            let current_url = webview
                .url()
                .map(|url| url.to_string())
                .unwrap_or_else(|_| "about:blank".to_string());
            if let Ok(mut state) = current_state.lock() {
                state.url = current_url;
                state.is_loading = false;
            }
        }

        let mut tokens = EventTokenRegistry::new();
        #[cfg(windows)]
        match register_history_changed_listener(
            &webview,
            app.clone(),
            tab_id.clone(),
            Arc::clone(&current_state),
        )
        .await
        {
            Ok(token) => tokens.register_history_changed(token),
            Err(error) => tracing::warn!(
                "[NativeWebview] Could not monitor WebView2 history for tab {tab_id}: {error}"
            ),
        }

        #[cfg(windows)]
        match register_download_listener(&webview, app.clone(), tab_id.clone()).await {
            Ok(token) => tokens.register_download_starting(token),
            Err(error) => tracing::warn!(
                "[NativeWebview] Could not monitor WebView2 downloads for tab {tab_id}: {error}"
            ),
        }

        #[cfg(windows)]
        match register_inspector_listener(
            &webview,
            app.clone(),
            tab_id.clone(),
            Arc::clone(&inspector_enabled),
            Arc::clone(&inspector_available),
            Arc::clone(&inspector_generation),
            Arc::clone(&inspector_navigation_id),
            Arc::clone(&inspector_navigation_pending),
            Arc::clone(&inspector_ready_pending),
            inspector_challenge
                .clone()
                .expect("Windows Inspector challenge is initialized"),
        )
        .await
        {
            Ok((message_token, navigation_token, navigation_completed_token)) => {
                tokens.register_web_message_received(message_token);
                tokens.register_navigation_starting(navigation_token);
                tokens.register_navigation_completed(navigation_completed_token);
                if was_existing {
                    if let Err(error) = register_inspector_runtime_for_future_documents(
                        &webview,
                        inspector_challenge
                            .as_deref()
                            .expect("Windows Inspector challenge is initialized"),
                    )
                    .await
                    {
                        tracing::warn!(
                            "[NativeWebview] Could not register Inspector for future documents in tab {tab_id}: {error}"
                        );
                    }
                } else {
                    match current_document_is_complete(&webview).await {
                        Ok(true) => {
                            if let Err(error) = post_inspector_control_to_webview(
                                &webview,
                                Arc::clone(&inspector_generation),
                                Arc::clone(&inspector_navigation_pending),
                                Arc::clone(&inspector_enabled),
                                Arc::clone(&inspector_ready_pending),
                            )
                            .await
                            {
                                tracing::warn!(
                                    "[NativeWebview] Could not activate Inspector for tab {tab_id}: {error}"
                                );
                            }
                        }
                        Ok(false) => {}
                        Err(error) => tracing::warn!(
                            "[NativeWebview] Could not query initial document readiness for tab {tab_id}: {error}"
                        ),
                    }
                }
            }
            Err(error) => {
                tracing::warn!(
                    "[NativeWebview] Could not register Inspector messages for tab {tab_id}: {error}"
                );
            }
        };

        if let Some((target_url, parsed_url)) = takeover_navigation_target {
            webview
                .navigate(parsed_url)
                .map_err(|error| format!("Could not navigate takeover WebView: {error}"))?;
            if let Ok(mut state) = current_state.lock() {
                state.url = target_url;
                state.is_loading = true;
                state.can_go_back = None;
                state.can_go_forward = None;
            }
        }

        #[cfg(not(windows))]
        let _ = was_existing;

        let managed = ManagedWebview {
            tab_id: tab_id.clone(),
            label: label.clone(),
            webview,
            last_bounds: Some(bounds),
            is_visible: visible,
            current_state: Arc::clone(&current_state),
            storage_mode: effective_mode,
            udf_path,
            workspace_root: workspace_root_path,
            tokens,
            inspector_enabled,
            inspector_available,
            inspector_challenge,
            inspector_generation,
            inspector_navigation_id,
            inspector_navigation_pending,
            inspector_ready_pending,
        };

        // 初始显隐处理
        if !visible {
            let _ = managed.webview.hide();
        }

        // 初始状态广播
        if let Ok(state) = current_state.lock() {
            let _ = app.emit("browser://navigation-state", state.clone());
        }

        // 6. 注册到管理器
        {
            let mut guard = self.webviews.lock().map_err(|e| e.to_string())?;
            guard.insert(tab_id, managed);
        }

        Ok(label)
    }

    /// 内部 Bounds 应用辅助方法（基于 WebviewBounds::to_physical 网格对齐）
    fn apply_bounds_to_managed(
        managed: &mut ManagedWebview,
        bounds: WebviewBounds,
        scale_factor: f64,
    ) -> Result<(), String> {
        let physical = bounds.to_physical(scale_factor);
        let rect = tauri::Rect {
            position: tauri::PhysicalPosition::new(physical.x, physical.y).into(),
            size: tauri::PhysicalSize::new(physical.width as u32, physical.height as u32).into(),
        };

        managed
            .webview
            .set_bounds(rect)
            .map_err(|e| e.to_string())?;
        managed.last_bounds = Some(bounds);
        Ok(())
    }

    /// 高频几何同步（带 <0.5px 差分去重）
    pub fn set_bounds(
        &self,
        tab_id: &str,
        bounds: WebviewBounds,
        scale_factor: f64,
    ) -> Result<(), String> {
        if !bounds.is_valid() {
            return Err(
                "Invalid bounds: coordinates and size must be finite and non-negative".to_string(),
            );
        }
        let mut guard = self.webviews.lock().map_err(|e| e.to_string())?;
        let managed = guard
            .get_mut(tab_id)
            .ok_or_else(|| format!("Webview not found: {tab_id}"))?;

        // 差分去重检查：变动小于 0.5px 直接跳过，不发起物理系统调用
        if let Some(ref last) = managed.last_bounds {
            if Self::is_similar_bounds(last, &bounds) {
                return Ok(());
            }
        }

        Self::apply_bounds_to_managed(managed, bounds, scale_factor)
    }

    /// 显隐状态切换（隐藏时挂起渲染以节约 GPU 与功耗）
    pub fn set_visible(&self, tab_id: &str, visible: bool) -> Result<(), String> {
        let mut guard = self.webviews.lock().map_err(|e| e.to_string())?;
        let managed = guard
            .get_mut(tab_id)
            .ok_or_else(|| format!("Webview not found: {tab_id}"))?;

        if managed.is_visible == visible {
            return Ok(());
        }

        if visible {
            managed.webview.show().map_err(|e| e.to_string())?;
        } else {
            managed.webview.hide().map_err(|e| e.to_string())?;
        }
        managed.is_visible = visible;
        Ok(())
    }

    /// 地址导航（严格校验 URL 协议白名单，接入 security::validate_navigation_url；
    /// `file:` 按 03-分维 §7.3 限定在本 Tab 的 workspace_root 内）
    pub fn navigate(&self, tab_id: &str, raw_url: &str) -> Result<(), String> {
        let guard = self.webviews.lock().map_err(|e| e.to_string())?;
        let managed = guard
            .get(tab_id)
            .ok_or_else(|| format!("Webview not found: {tab_id}"))?;

        let validated_url =
            Self::sanitize_and_validate_url_with_root(raw_url, managed.workspace_root.as_deref())?;
        let parsed: url::Url = validated_url
            .parse()
            .map_err(|e| format!("Invalid URL format: {e}"))?;

        if let Ok(mut state) = managed.current_state.lock() {
            state.url = validated_url;
            state.is_loading = true;
        }

        managed.webview.navigate(parsed).map_err(|e| e.to_string())
    }

    /// 浏览器动作执行（Windows 直接调用 WebView2 历史 API）。
    pub async fn action(&self, tab_id: &str, action: BrowserActionKind) -> Result<(), String> {
        let (webview, current_state) = {
            let guard = self.webviews.lock().map_err(|e| e.to_string())?;
            let managed = guard
                .get(tab_id)
                .ok_or_else(|| format!("Webview not found: {tab_id}"))?;
            (managed.webview.clone(), Arc::clone(&managed.current_state))
        };

        #[cfg(windows)]
        perform_native_browser_action(webview.clone(), action).await?;

        #[cfg(not(windows))]
        match action {
            BrowserActionKind::Back => webview
                .eval("window.history.back()")
                .map_err(|e| e.to_string())?,
            BrowserActionKind::Forward => webview
                .eval("window.history.forward()")
                .map_err(|e| e.to_string())?,
            BrowserActionKind::Reload => webview.reload().map_err(|e| e.to_string())?,
            BrowserActionKind::ReloadIgnoringCache => {
                return Err("Reload ignoring cache is not supported on this platform".to_string());
            }
            BrowserActionKind::Stop => webview.eval("window.stop()").map_err(|e| e.to_string())?,
        }

        if let Ok(mut state) = current_state.lock() {
            match action {
                BrowserActionKind::Back | BrowserActionKind::Forward => {}
                BrowserActionKind::Reload | BrowserActionKind::ReloadIgnoringCache => {
                    state.is_loading = true;
                }
                BrowserActionKind::Stop => {
                    state.is_loading = false;
                }
            }
        }

        Ok(())
    }

    /// 执行 JavaScript 脚本
    pub fn eval(&self, tab_id: &str, script: &str) -> Result<(), String> {
        let guard = self.webviews.lock().map_err(|e| e.to_string())?;
        let managed = guard
            .get(tab_id)
            .ok_or_else(|| format!("Webview not found: {tab_id}"))?;

        managed.webview.eval(script).map_err(|e| e.to_string())
    }

    /// 安全关闭并释放子 Webview（注销 COM Token，清理 Ephemeral 磁盘目录）
    pub async fn close(&self, tab_id: &str) -> Result<(), String> {
        let managed = self
            .webviews
            .lock()
            .map_err(|e| e.to_string())?
            .remove(tab_id);
        if let Some(managed) = managed {
            let webview = managed.webview.clone();
            let cleanup_result = unregister_event_tokens(webview.clone(), managed.tokens).await;

            let _ = webview.hide();
            let close_result = webview.close().map_err(|e| e.to_string());

            remove_ephemeral_udf_if_needed(managed.storage_mode, &managed.udf_path);

            tracing::info!(
                "[NativeWebview] Successfully closed webview for tab: {}",
                tab_id
            );
            cleanup_result?;
            return close_result;
        }
        Ok(())
    }

    /// 设置静音状态
    pub fn set_muted(&self, tab_id: &str, muted: bool) -> Result<(), String> {
        let guard = self.webviews.lock().map_err(|e| e.to_string())?;
        let managed = guard
            .get(tab_id)
            .ok_or_else(|| format!("Webview not found: {tab_id}"))?;

        if let Ok(mut state) = managed.current_state.lock() {
            state.is_muted = muted;
        }

        let js = format!(
            "document.querySelectorAll('audio, video').forEach(el => el.muted = {});",
            muted
        );
        managed.webview.eval(&js).map_err(|e| e.to_string())
    }

    /// 返回当前原生后端是否支持指定 Tab 的鼠标命中测试切换。
    pub fn set_hit_test(&self, tab_id: &str, _hit_test: bool) -> Result<SetHitTestResult, String> {
        let guard = self.webviews.lock().map_err(|e| e.to_string())?;
        if !guard.contains_key(tab_id) {
            return Err(format!("Webview not found: {tab_id}"));
        }

        // Wry 暴露的 controller parent HWND 只是 WRY_WEBVIEW 容器；实际 WebView2
        // 输入子窗口不属于可由管理器安全子类化的同线程窗口。不得把无法应用的状态报成功。
        Ok(SetHitTestResult::unsupported(
            "The current WebView2 host does not expose a safe per-tab mouse hit-test control.",
        ))
    }

    /// 设置指定 Tab 的 DOM Inspector 开关。
    pub fn set_inspector(&self, tab_id: &str, enabled: bool) -> Result<(), String> {
        let guard = self.webviews.lock().map_err(|e| e.to_string())?;
        let managed = guard
            .get(tab_id)
            .ok_or_else(|| format!("Webview not found: {tab_id}"))?;

        #[cfg(not(windows))]
        {
            let _ = enabled;
            Err("Native Inspector WebMessage transport is unsupported on this platform".to_string())
        }

        #[cfg(windows)]
        {
            let available = managed.inspector_available.load(Ordering::Acquire);
            let previous = apply_inspector_request_state(
                &managed.inspector_enabled,
                available,
                enabled,
            )
            .map_err(|reason| {
                format!("{reason} for tab {tab_id}; refresh or navigate the current page before enabling it")
            })?;
            if !available {
                return Ok(());
            }

            if let Err(error) = schedule_inspector_control(
                &managed.webview,
                managed.inspector_generation.load(Ordering::Acquire),
                enabled,
                Arc::clone(&managed.inspector_enabled),
                previous,
            ) {
                managed.inspector_enabled.store(previous, Ordering::Release);
                return Err(format!("Could not update Inspector state: {error}"));
            }
            Ok(())
        }
    }

    /// 关闭管理器下的全部子 Webview 实例
    pub async fn close_all(&self) {
        let managed_webviews = match self.webviews.lock() {
            Ok(mut guard) => guard.drain().collect::<Vec<_>>(),
            Err(error) => {
                tracing::warn!("[NativeWebview] Could not lock webview manager: {error}");
                return;
            }
        };

        for (tab_id, managed) in managed_webviews {
            let webview = managed.webview.clone();
            if let Err(error) = unregister_event_tokens(webview.clone(), managed.tokens).await {
                tracing::warn!(
                    "[NativeWebview] Could not unregister events for tab {tab_id}: {error}"
                );
            }
            let _ = webview.hide();
            if let Err(error) = webview.close() {
                tracing::warn!("[NativeWebview] Could not close webview for {tab_id}: {error}");
            }
            remove_ephemeral_udf_if_needed(managed.storage_mode, &managed.udf_path);
            tracing::info!("[NativeWebview] Closed webview for tab: {tab_id}");
        }
    }
}

#[cfg(windows)]
fn query_history_capabilities(core: &ICoreWebView2) -> (Option<bool>, Option<bool>) {
    let can_go_back = {
        let mut value = std::mem::MaybeUninit::uninit();
        unsafe { core.CanGoBack(value.as_mut_ptr()) }
            .ok()
            .map(|()| unsafe { value.assume_init().as_bool() })
    };
    let can_go_forward = {
        let mut value = std::mem::MaybeUninit::uninit();
        unsafe { core.CanGoForward(value.as_mut_ptr()) }
            .ok()
            .map(|()| unsafe { value.assume_init().as_bool() })
    };
    (can_go_back, can_go_forward)
}

#[cfg(windows)]
fn publish_history_state(
    app: &AppHandle,
    tab_id: &str,
    state: &Arc<Mutex<BrowserNavigationStatePayload>>,
    core: &ICoreWebView2,
) {
    let (can_go_back, can_go_forward) = query_history_capabilities(core);
    let current_url = {
        let mut source = std::mem::MaybeUninit::uninit();
        unsafe { core.Source(source.as_mut_ptr()) }
            .ok()
            .map(|()| webview2_com::take_pwstr(unsafe { source.assume_init() }))
    };

    let payload = {
        let Ok(mut current) = state.lock() else {
            return;
        };
        current.can_go_back = can_go_back;
        current.can_go_forward = can_go_forward;
        if let Some(url) = current_url.filter(|url| !url.is_empty()) {
            current.url = url;
        }
        if current.tab_id.is_empty() {
            current.tab_id = tab_id.to_string();
        }
        current.clone()
    };
    let _ = app.emit("browser://navigation-state", payload);
}

#[cfg(windows)]
async fn register_history_changed_listener(
    webview: &Webview<tauri::Wry>,
    app: AppHandle,
    tab_id: String,
    state: Arc<Mutex<BrowserNavigationStatePayload>>,
) -> Result<i64, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<i64, String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    let callback_app = app.clone();
                    let callback_tab_id = tab_id.clone();
                    let callback_state = Arc::clone(&state);
                    let handler =
                        HistoryChangedEventHandler::create(Box::new(move |sender, _args| {
                            if let Some(core) = sender.as_ref() {
                                publish_history_state(
                                    &callback_app,
                                    &callback_tab_id,
                                    &callback_state,
                                    core,
                                );
                            }
                            Ok(())
                        }));
                    let mut token = 0_i64;
                    core.add_HistoryChanged(&handler, &mut token)
                        .map_err(|error| format!("Could not register HistoryChanged: {error}"))?;
                    publish_history_state(&app, &tab_id, &state, &core);
                    Ok(token)
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule HistoryChanged registration: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("HistoryChanged registration callback was dropped: {error}"))?
}

/// 读取下载操作的当前快照并映射为事件载荷。
///
/// `state` 取值对齐前端契约：`progress` / `completed` / `interrupted`
/// （进行中态统一映射为 progress）。
#[cfg(windows)]
fn download_state_label(state: COREWEBVIEW2_DOWNLOAD_STATE) -> &'static str {
    if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
        "completed"
    } else if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
        "interrupted"
    } else {
        "progress"
    }
}

#[cfg(windows)]
fn download_progress_payload(
    tab_id: &str,
    operation: &ICoreWebView2DownloadOperation,
) -> Option<DownloadProgressPayload> {
    unsafe {
        let mut uri = std::mem::MaybeUninit::uninit();
        operation.Uri(uri.as_mut_ptr()).ok()?;
        let url = webview2_com::take_pwstr(uri.assume_init());

        let mut raw_path = std::mem::MaybeUninit::uninit();
        let filename = if operation.ResultFilePath(raw_path.as_mut_ptr()).is_ok() {
            let path = webview2_com::take_pwstr(raw_path.assume_init());
            let name = Path::new(&path)
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string);
            name.unwrap_or(path)
        } else {
            String::new()
        };

        let mut total_bytes = -1_i64;
        let _ = operation.TotalBytesToReceive(&mut total_bytes);
        let mut received_bytes = 0_i64;
        let _ = operation.BytesReceived(&mut received_bytes);
        let mut state = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
        operation.State(&mut state).ok()?;

        Some(DownloadProgressPayload {
            tab_id: tab_id.to_string(),
            url,
            filename,
            total_bytes: (total_bytes >= 0).then_some(total_bytes as u64),
            received_bytes: received_bytes.max(0) as u64,
            state: download_state_label(state).to_string(),
        })
    }
}

/// 为单次下载挂字节进度与状态变更监听。
///
/// 两个操作级 Token 在回调内共享，终态（completed / interrupted）时自注销；
/// 若 Tab 先关闭，WebView2 释放下载操作对象时回调随之释放。操作对象刻意
/// 不进 [EventTokenRegistry]——注册表只持有 Webview2 级 Token，下载操作
/// 的生命周期由 WebView2 管理。
#[cfg(windows)]
fn attach_download_progress_handlers(
    app: &AppHandle,
    tab_id: &str,
    operation: &ICoreWebView2DownloadOperation,
) {
    let tokens = Arc::new(Mutex::new((0_i64, 0_i64)));

    let bytes_app = app.clone();
    let bytes_tab_id = tab_id.to_string();
    let bytes_handler = BytesReceivedChangedEventHandler::create(Box::new(move |sender, _args| {
        if let Some(operation) = sender.as_ref() {
            if let Some(payload) = download_progress_payload(&bytes_tab_id, operation) {
                let _ = bytes_app.emit(EVENT_BROWSER_DOWNLOAD_PROGRESS, payload);
            }
        }
        Ok(())
    }));
    let mut bytes_token = 0_i64;
    if unsafe { operation.add_BytesReceivedChanged(&bytes_handler, &mut bytes_token) }.is_err() {
        return;
    }

    let state_app = app.clone();
    let state_tab_id = tab_id.to_string();
    let state_tokens = Arc::clone(&tokens);
    let state_handler = StateChangedEventHandler::create(Box::new(move |sender, _args| {
        let Some(operation) = sender.as_ref() else {
            return Ok(());
        };
        let Some(payload) = download_progress_payload(&state_tab_id, operation) else {
            return Ok(());
        };
        let terminal = payload.state != "progress";
        let _ = state_app.emit(EVENT_BROWSER_DOWNLOAD_PROGRESS, payload);
        if terminal {
            let (bytes_token, state_token) = *state_tokens
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            unsafe {
                let _ = operation.remove_BytesReceivedChanged(bytes_token);
                let _ = operation.remove_StateChanged(state_token);
            }
        }
        Ok(())
    }));
    let mut state_token = 0_i64;
    if unsafe { operation.add_StateChanged(&state_handler, &mut state_token) }.is_err() {
        unsafe {
            let _ = operation.remove_BytesReceivedChanged(bytes_token);
        }
        return;
    }

    *tokens.lock().unwrap_or_else(|error| error.into_inner()) = (bytes_token, state_token);
}

/// 注册下载发起监听：每次下载建档并向 `browser://download-progress` 广播。
#[cfg(windows)]
async fn register_download_listener(
    webview: &Webview<tauri::Wry>,
    app: AppHandle,
    tab_id: String,
) -> Result<i64, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<i64, String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    let callback_app = app.clone();
                    let callback_tab_id = tab_id.clone();
                    let handler =
                        DownloadStartingEventHandler::create(Box::new(move |_sender, args| {
                            let Some(args) = args.as_ref() else {
                                return Ok(());
                            };
                            let operation = args.DownloadOperation();
                            let Ok(operation) = operation else {
                                return Ok(());
                            };
                            if let Some(payload) =
                                download_progress_payload(&callback_tab_id, &operation)
                            {
                                let _ =
                                    callback_app.emit(EVENT_BROWSER_DOWNLOAD_PROGRESS, payload);
                            }
                            attach_download_progress_handlers(
                                &callback_app,
                                &callback_tab_id,
                                &operation,
                            );
                            Ok(())
                        }));
                    // 下载事件自 ICoreWebView2_4 起提供，基础接口无此 vtable。
                    let core_download: ICoreWebView2_4 = core.cast().map_err(|error| {
                        format!("CoreWebView2 does not expose download support: {error}")
                    })?;
                    let mut token = 0_i64;
                    core_download
                        .add_DownloadStarting(&handler, &mut token)
                        .map_err(|error| {
                            format!("Could not register DownloadStarting: {error}")
                        })?;
                    Ok(token)
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule DownloadStarting registration: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("DownloadStarting registration callback was dropped: {error}"))?
}

#[cfg(windows)]
fn generate_inspector_challenge() -> Result<String, String> {
    let mut entropy = [0_u8; 32];
    getrandom::getrandom(&mut entropy)
        .map_err(|error| format!("Could not generate Inspector challenge: {error}"))?;
    Ok(hex::encode(entropy))
}

#[cfg(windows)]
unsafe fn take_bounded_inspector_message(message: PWSTR) -> Result<String, &'static str> {
    let pointer = message.0;
    if pointer.is_null() {
        return Err("WebView2 returned a null message buffer");
    }

    let mut units = 0_usize;
    let mut utf8_bytes = 0_usize;
    loop {
        let unit = unsafe { *pointer.add(units) };
        if unit == 0 {
            break;
        }

        let unit_bytes = if (0xD800..=0xDBFF).contains(&unit) {
            let next = unsafe { *pointer.add(units + 1) };
            if (0xDC00..=0xDFFF).contains(&next) {
                units += 1;
                4
            } else {
                3
            }
        } else if (0xDC00..=0xDFFF).contains(&unit) || unit > 0x07FF {
            3
        } else if unit > 0x007F {
            2
        } else {
            1
        };
        utf8_bytes += unit_bytes;
        if utf8_bytes > MAX_INSPECTOR_MESSAGE_BYTES {
            unsafe { CoTaskMemFree(Some(pointer.cast())) };
            return Err("message exceeds size limit");
        }
        units += 1;
    }

    let text = unsafe { std::slice::from_raw_parts(pointer, units) };
    let decoded = String::from_utf16_lossy(text);
    unsafe { CoTaskMemFree(Some(pointer.cast())) };
    Ok(decoded)
}

#[cfg(windows)]
unsafe fn release_inspector_message(message: PWSTR) {
    if !message.0.is_null() {
        unsafe { CoTaskMemFree(Some(message.0.cast())) };
    }
}

#[allow(clippy::too_many_arguments)]
#[cfg(windows)]
async fn register_inspector_listener(
    webview: &Webview<tauri::Wry>,
    app: AppHandle,
    tab_id: String,
    inspector_enabled: Arc<AtomicBool>,
    inspector_available: Arc<AtomicBool>,
    inspector_generation: Arc<AtomicU64>,
    navigation_id: Arc<AtomicU64>,
    navigation_pending: Arc<AtomicBool>,
    ready_pending: Arc<AtomicBool>,
    inspector_challenge: String,
) -> Result<(i64, i64, i64), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<(i64, i64, i64), String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    let callback_app = app.clone();
                    let callback_tab_id = tab_id.clone();
                    let callback_enabled = Arc::clone(&inspector_enabled);
                    let callback_available = Arc::clone(&inspector_available);
                    let callback_generation = Arc::clone(&inspector_generation);
                    let callback_navigation_pending = Arc::clone(&navigation_pending);
                    let callback_ready_pending = Arc::clone(&ready_pending);
                    let callback_challenge = inspector_challenge.clone();
                    let navigation_available = Arc::clone(&inspector_available);
                    let navigation_generation = Arc::clone(&inspector_generation);
                    let navigation_pending_state = Arc::clone(&navigation_pending);
                    let navigation_ready_pending = Arc::clone(&ready_pending);
                    let navigation_id_state = Arc::clone(&navigation_id);
                    let navigation_handler = NavigationStartingEventHandler::create(Box::new(
                        move |_, args| {
                            navigation_ready_pending.store(false, Ordering::Release);
                            let mut id = u64::MAX;
                            if let Some(args) = args.as_ref() {
                                let mut value = 0_u64;
                                if args.NavigationId(&mut value).is_ok() && value != 0 {
                                    id = value;
                                }
                            }
                            navigation_id_state.store(id, Ordering::Release);
                            navigation_pending_state.store(true, Ordering::Release);
                            navigation_generation.fetch_add(1, Ordering::AcqRel);
                            navigation_available.store(false, Ordering::Release);
                            Ok(())
                        },
                    ));
                    let mut navigation_token = 0_i64;
                    core.add_NavigationStarting(&navigation_handler, &mut navigation_token)
                        .map_err(|error| {
                            format!("Could not register Inspector NavigationStarting: {error}")
                        })?;
                    let completed_generation = Arc::clone(&inspector_generation);
                    let completed_enabled = Arc::clone(&inspector_enabled);
                    let completed_navigation_id = Arc::clone(&navigation_id);
                    let completed_navigation_pending = Arc::clone(&navigation_pending);
                    let completed_ready_pending = Arc::clone(&ready_pending);
                    let completed_tab_id = tab_id.clone();
                    let completed_handler = NavigationCompletedEventHandler::create(Box::new(
                        move |sender, args| {
                            let (Some(core), Some(args)) = (sender.as_ref(), args.as_ref()) else {
                                return Ok(());
                            };
                            let mut completed_id = 0_u64;
                            if args.NavigationId(&mut completed_id).is_err()
                                || completed_id == 0
                            {
                                return Ok(());
                            }
                            let started_id = completed_navigation_id.load(Ordering::Acquire);
                            if started_id == u64::MAX
                                || (started_id != 0 && started_id != completed_id)
                            {
                                return Ok(());
                            }
                            completed_navigation_id.store(completed_id, Ordering::Release);
                            completed_navigation_pending.store(false, Ordering::Release);
                            let generation = completed_generation.load(Ordering::Acquire);
                            let enabled = completed_enabled.load(Ordering::Acquire);
                            let current_navigation_id = Arc::clone(&completed_navigation_id);
                            let current_navigation_pending =
                                Arc::clone(&completed_navigation_pending);
                            let current_generation = Arc::clone(&completed_generation);
                            if let Err(error) = post_inspector_control_for_document(
                                &completed_ready_pending,
                                || {
                                    !current_navigation_pending.load(Ordering::Acquire)
                                        && current_navigation_id.load(Ordering::Acquire)
                                            == completed_id
                                        && current_generation.load(Ordering::Acquire) == generation
                                },
                                || post_inspector_control(core, generation, enabled),
                            ) {
                                tracing::warn!(
                                    "[NativeWebview] Could not activate Inspector after navigation for tab {}: {}",
                                    completed_tab_id,
                                    error
                                );
                            }
                            Ok(())
                        },
                    ));
                    let mut navigation_completed_token = 0_i64;
                    if let Err(error) = core.add_NavigationCompleted(
                        &completed_handler,
                        &mut navigation_completed_token,
                    ) {
                        let _ = core.remove_NavigationStarting(navigation_token);
                        return Err(format!(
                            "Could not register Inspector NavigationCompleted: {error}"
                        ));
                    }
                    let handler = WebMessageReceivedEventHandler::create(Box::new(
                        move |sender, args| {
                            let (Some(_core), Some(args)) = (sender.as_ref(), args.as_ref()) else {
                                return Ok(());
                            };
                            let admission = inspector_message_admission(
                                callback_available.load(Ordering::Acquire),
                                callback_enabled.load(Ordering::Acquire),
                                &callback_ready_pending,
                            );
                            if admission == InspectorMessageAdmission::Rejected {
                                return Ok(());
                            }
                            let mut message = PWSTR::null();
                            if args.TryGetWebMessageAsString(&mut message).is_err() {
                                release_inspector_message(message);
                                return Ok(());
                            }
                            let raw = match take_bounded_inspector_message(message) {
                                Ok(raw) => raw,
                                Err(reason) => {
                                    tracing::debug!(
                                        "[NativeWebview] Dropped Inspector message for tab {}: {}",
                                        callback_tab_id,
                                        reason
                                    );
                                    return Ok(());
                                }
                            };
                            let expected_generation =
                                callback_generation.load(Ordering::Acquire).to_string();
                            let message = match parse_inspector_message(
                                &raw,
                                &callback_challenge,
                                &expected_generation,
                            ) {
                                Ok(message) => message,
                                Err(reason) => {
                                    tracing::debug!(
                                        "[NativeWebview] Dropped invalid Inspector message for tab {}: {}",
                                        callback_tab_id,
                                        reason
                                    );
                                    return Ok(());
                                }
                            };

                            if !inspector_message_admission_allows(
                                admission,
                                matches!(&message, InspectorMessage::Ready),
                            ) {
                                return Ok(());
                            }

                            let ready_is_current = inspector_ready_may_mark_available(
                                &message,
                                callback_generation.load(Ordering::Acquire).to_string()
                                    == expected_generation,
                                callback_navigation_pending.load(Ordering::Acquire),
                            );
                            if matches!(&message, InspectorMessage::Ready) && !ready_is_current {
                                return Ok(());
                            }
                            if ready_is_current {
                                callback_available.store(true, Ordering::Release);
                                if callback_navigation_pending.load(Ordering::Acquire)
                                    || callback_generation.load(Ordering::Acquire).to_string()
                                        != expected_generation
                                {
                                    callback_available.store(false, Ordering::Release);
                                    return Ok(());
                                }
                            }
                            if message.requires_enabled_inspector()
                                && !callback_enabled.load(Ordering::Acquire)
                            {
                                return Ok(());
                            }
                            if matches!(&message, InspectorMessage::ToggleOff) {
                                callback_enabled.store(false, Ordering::Release);
                            }

                            let _ = callback_app.emit(
                                INSPECTOR_EVENT,
                                message.envelope(callback_tab_id.clone()),
                            );
                            Ok(())
                        },
                    ));
                    let mut token = 0_i64;
                    if let Err(error) = core.add_WebMessageReceived(&handler, &mut token) {
                        let _ = core.remove_NavigationCompleted(navigation_completed_token);
                        let _ = core.remove_NavigationStarting(navigation_token);
                        return Err(format!("Could not register WebMessageReceived: {error}"));
                    }
                    Ok((token, navigation_token, navigation_completed_token))
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule Inspector registration: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("Inspector registration callback was dropped: {error}"))?
}

#[cfg(windows)]
fn post_inspector_control(
    core: &ICoreWebView2,
    generation: u64,
    enabled: bool,
) -> Result<(), String> {
    let message = HSTRING::from(inspector_control_message(generation, enabled));
    unsafe { core.PostWebMessageAsString(&message) }
        .map_err(|error| format!("Could not send Inspector control: {error}"))
}

#[cfg(windows)]
fn schedule_inspector_control_after_page_load(
    webview: &Webview<tauri::Wry>,
    generation: Arc<AtomicU64>,
    navigation_pending: Arc<AtomicBool>,
    inspector_enabled: Arc<AtomicBool>,
    ready_pending: Arc<AtomicBool>,
) {
    let scheduled = webview.with_webview(move |platform_webview| {
        let ready_pending_for_post = Arc::clone(&ready_pending);
        let result = unsafe {
            (|| -> Result<(), String> {
                let core = platform_webview
                    .controller()
                    .CoreWebView2()
                    .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                if navigation_pending.load(Ordering::Acquire) {
                    return Ok(());
                }
                let current_generation = Arc::clone(&generation);
                let generation = generation.load(Ordering::Acquire);
                let enabled = inspector_enabled.load(Ordering::Acquire);
                let current_navigation_pending = Arc::clone(&navigation_pending);
                post_inspector_control_for_document(
                    &ready_pending_for_post,
                    || {
                        !current_navigation_pending.load(Ordering::Acquire)
                            && current_generation.load(Ordering::Acquire) == generation
                    },
                    || post_inspector_control(&core, generation, enabled),
                )
            })()
        };
        if let Err(error) = result {
            tracing::warn!(
                "[NativeWebview] Could not send Inspector control after page load: {error}"
            );
        }
    });
    if let Err(error) = scheduled {
        tracing::warn!(
            "[NativeWebview] Could not schedule Inspector control after page load: {error}"
        );
    }
}

#[cfg(windows)]
fn schedule_inspector_control(
    webview: &Webview<tauri::Wry>,
    generation: u64,
    enabled: bool,
    inspector_enabled: Arc<AtomicBool>,
    previous: bool,
) -> Result<(), String> {
    let message = HSTRING::from(inspector_control_message(generation, enabled));
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<(), String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    core.PostWebMessageAsString(&message)
                        .map_err(|error| format!("Could not send Inspector control: {error}"))
                })()
            };
            if let Err(error) = result {
                let _ = inspector_enabled.compare_exchange(
                    enabled,
                    previous,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                tracing::warn!("[NativeWebview] Could not send Inspector control: {error}");
            }
        })
        .map_err(|error| format!("Could not schedule Inspector control: {error}"))
}

#[cfg(windows)]
async fn register_inspector_runtime_for_future_documents(
    webview: &Webview<tauri::Wry>,
    challenge: &str,
) -> Result<(), String> {
    let runtime = inspector_runtime_script(challenge)
        .map_err(|error| format!("Could not configure Inspector runtime: {error}"))?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<(), String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    let script = runtime.clone();
                    let registration_core = core.clone();
                    AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation(
                        Box::new(move |handler| {
                            let script = HSTRING::from(script);
                            registration_core
                                .AddScriptToExecuteOnDocumentCreated(&script, &handler)
                                .map_err(Into::into)
                        }),
                        Box::new(|error, _| error),
                    )
                    .map_err(|error| {
                        format!("Could not register Inspector document script: {error}")
                    })?;

                    Ok(())
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule Inspector runtime install: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("Inspector runtime callback was dropped: {error}"))?
}

#[cfg(windows)]
async fn current_document_is_complete(webview: &Webview<tauri::Wry>) -> Result<bool, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<bool, String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    let current_document_core = core.clone();
                    let (status_sender, status_receiver) = std::sync::mpsc::sync_channel(1);
                    ExecuteScriptCompletedHandler::wait_for_async_operation(
                        Box::new(move |handler| {
                            let script = HSTRING::from("document.readyState === 'complete'");
                            current_document_core
                                .ExecuteScript(&script, &handler)
                                .map_err(Into::into)
                        }),
                        Box::new(move |error, result| {
                            let result = error
                                .map(|()| result)
                                .map_err(|error| error.to_string())
                                .and_then(|result| {
                                    serde_json::from_str::<bool>(&result)
                                        .map_err(|error| error.to_string())
                                });
                            let _ = status_sender.send(result);
                            Ok(())
                        }),
                    )
                    .map_err(|error| {
                        format!("Could not query current document readiness: {error}")
                    })?;
                    status_receiver
                        .recv()
                        .map_err(|error| {
                            format!("Document readiness callback was dropped: {error}")
                        })?
                        .map_err(|error| format!("Could not read document readiness: {error}"))
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule document readiness query: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("Document readiness callback was dropped: {error}"))?
}

#[cfg(windows)]
async fn post_inspector_control_to_webview(
    webview: &Webview<tauri::Wry>,
    generation: Arc<AtomicU64>,
    navigation_pending: Arc<AtomicBool>,
    inspector_enabled: Arc<AtomicBool>,
    ready_pending: Arc<AtomicBool>,
) -> Result<(), String> {
    if navigation_pending.load(Ordering::Acquire) {
        return Ok(());
    }
    let current_generation = Arc::clone(&generation);
    let generation = generation.load(Ordering::Acquire);
    let enabled = inspector_enabled.load(Ordering::Acquire);
    let message = HSTRING::from(inspector_control_message(generation, enabled));
    let navigation_pending_for_post = Arc::clone(&navigation_pending);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<(), String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    if navigation_pending_for_post.load(Ordering::Acquire)
                        || current_generation.load(Ordering::Acquire) != generation
                    {
                        return Ok(());
                    }
                    post_inspector_control_for_document(
                        &ready_pending,
                        || {
                            !navigation_pending_for_post.load(Ordering::Acquire)
                                && current_generation.load(Ordering::Acquire) == generation
                        },
                        || {
                            core.PostWebMessageAsString(&message).map_err(|error| {
                                format!("Could not send Inspector control: {error}")
                            })
                        },
                    )
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule Inspector control: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("Inspector control callback was dropped: {error}"))?
}

#[cfg(windows)]
fn request_history_state(
    webview: Webview<tauri::Wry>,
    app: AppHandle,
    tab_id: String,
    state: Arc<Mutex<BrowserNavigationStatePayload>>,
) {
    let error_tab_id = tab_id.clone();
    if let Err(error) = webview.with_webview(move |platform_webview| unsafe {
        match platform_webview.controller().CoreWebView2() {
            Ok(core) => publish_history_state(&app, &tab_id, &state, &core),
            Err(error) => tracing::warn!(
                "[NativeWebview] Could not query WebView2 history for tab {tab_id}: {error}"
            ),
        }
    }) {
        tracing::warn!(
            "[NativeWebview] Could not schedule WebView2 history query for tab {error_tab_id}: {error}"
        );
    }
}

#[cfg(windows)]
async fn perform_native_browser_action(
    webview: Webview<tauri::Wry>,
    action: BrowserActionKind,
) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<(), String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    match action {
                        BrowserActionKind::Back => core.GoBack(),
                        BrowserActionKind::Forward => core.GoForward(),
                        BrowserActionKind::Reload | BrowserActionKind::ReloadIgnoringCache => {
                            core.Reload()
                        }
                        BrowserActionKind::Stop => core.Stop(),
                    }
                    .map_err(|error| format!("Could not execute native browser action: {error}"))
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule native browser action: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("Native browser action callback was dropped: {error}"))?
}

async fn unregister_event_tokens(
    webview: Webview<tauri::Wry>,
    mut tokens: EventTokenRegistry,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        webview
            .with_webview(move |platform_webview| {
                let controller = platform_webview.controller();
                let core = unsafe { controller.CoreWebView2().ok() };
                let errors = tokens
                    .unregister_all(&controller, core.as_ref())
                    .into_iter()
                    .filter_map(Result::err)
                    .collect::<Vec<_>>();
                let _ = sender.send(errors);
            })
            .map_err(|error| format!("Could not schedule WebView2 token cleanup: {error}"))?;
        let errors = receiver
            .await
            .map_err(|error| format!("WebView2 token cleanup callback was dropped: {error}"))?;
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    #[cfg(not(windows))]
    {
        let _ = webview;
        let errors = tokens
            .unregister_all()
            .into_iter()
            .filter_map(Result::err)
            .collect::<Vec<_>>();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takeover_navigation_requires_an_explicit_nonblank_url() {
        assert_eq!(explicit_takeover_navigation_target(None), None);
        assert_eq!(
            explicit_takeover_navigation_target(Some("about:blank")),
            None
        );
        assert_eq!(
            explicit_takeover_navigation_target(Some("https://example.com")),
            Some("https://example.com")
        );
    }

    #[test]
    fn takeover_probe_registration_only_targets_future_documents() {
        let source = include_str!("native_manager.rs");
        let registration_start = source
            .find("async fn register_inspector_runtime_for_future_documents")
            .expect("future-document registration helper is present");
        let registration_tail = &source[registration_start..];
        let registration_end = registration_tail
            .find("\n#[cfg(windows)]\nasync fn current_document_is_complete")
            .expect("future-document registration helper has a following boundary");
        let registration = &registration_tail[..registration_end];
        assert!(registration.contains("AddScriptToExecuteOnDocumentCreated"));
        assert!(!registration.contains("ExecuteScript"));
    }

    #[test]
    fn unavailable_inspector_rejects_enable_without_mutating_the_desired_state() {
        let enabled = AtomicBool::new(false);
        let result = apply_inspector_request_state(&enabled, false, true);

        assert!(result.is_err());
        assert!(!enabled.load(Ordering::Acquire));
    }

    #[test]
    fn unavailable_inspector_can_be_closed_successfully() {
        let enabled = AtomicBool::new(true);
        let previous = apply_inspector_request_state(&enabled, false, false).unwrap();

        assert!(previous);
        assert!(!enabled.load(Ordering::Acquire));
    }

    #[test]
    fn idle_inspector_messages_are_rejected_before_webview_message_read() {
        let pending = AtomicBool::new(false);
        assert_eq!(
            inspector_message_admission(false, false, &pending),
            InspectorMessageAdmission::Rejected
        );

        let source = include_str!("native_manager.rs");
        let handler_start = source
            .find("let handler = WebMessageReceivedEventHandler::create(Box::new(")
            .expect("Inspector WebMessageReceived handler is present");
        let handler = &source[handler_start..];
        let admission = handler
            .find("let admission = inspector_message_admission(")
            .expect("message admission check is present");
        let rejected = handler
            .find("if admission == InspectorMessageAdmission::Rejected")
            .expect("rejected messages return before reading WebView2 data");
        let getter = handler
            .find("args.TryGetWebMessageAsString(&mut message)")
            .expect("WebView2 string getter is present");
        assert!(admission < rejected && rejected < getter);
    }

    #[test]
    fn inspector_ready_handshake_admits_only_one_ready_message() {
        let pending = AtomicBool::new(true);
        let first = inspector_message_admission(false, false, &pending);

        assert_eq!(first, InspectorMessageAdmission::ReadyHandshake);
        assert!(inspector_message_admission_allows(first, true));
        assert!(!inspector_message_admission_allows(first, false));
        assert_eq!(
            inspector_message_admission(false, false, &pending),
            InspectorMessageAdmission::Rejected
        );
    }

    #[test]
    fn invalid_handshake_message_consumes_window_without_enabling_inspector() {
        let pending = AtomicBool::new(true);
        let available = AtomicBool::new(false);
        let admission = inspector_message_admission(false, false, &pending);

        assert!(!inspector_message_admission_allows(admission, false));
        assert!(!pending.load(Ordering::Acquire));
        assert!(!available.load(Ordering::Acquire));
        assert_eq!(
            inspector_message_admission(false, false, &pending),
            InspectorMessageAdmission::Rejected
        );
    }

    #[test]
    fn document_control_opens_handshake_before_post_and_closes_it_on_failure() {
        let pending = AtomicBool::new(false);
        let failure = post_inspector_control_for_document(
            &pending,
            || true,
            || {
                assert!(pending.load(Ordering::Acquire));
                Err("post failed".to_string())
            },
        );

        assert!(failure.is_err());
        assert!(!pending.load(Ordering::Acquire));

        post_inspector_control_for_document(
            &pending,
            || true,
            || {
                assert!(pending.load(Ordering::Acquire));
                Ok(())
            },
        )
        .unwrap();
        assert!(pending.load(Ordering::Acquire));

        let stale_post = post_inspector_control_for_document(
            &pending,
            || false,
            || panic!("stale document control must not be posted"),
        );
        assert!(stale_post.is_ok());
        assert!(!pending.load(Ordering::Acquire));
    }

    #[test]
    fn only_new_document_control_paths_open_the_ready_handshake() {
        let source = include_str!("native_manager.rs");
        let registration_start = source
            .find("async fn register_inspector_listener(")
            .expect("Inspector navigation listener is present");
        let registration_end = source[registration_start..]
            .find("\n#[cfg(windows)]\nfn post_inspector_control(")
            .expect("Inspector navigation listener has a following boundary")
            + registration_start;
        assert!(source[registration_start..registration_end]
            .contains("post_inspector_control_for_document("));

        let page_load_start = source
            .find("fn schedule_inspector_control_after_page_load(")
            .expect("page-load control path is present");
        let page_load_end = source[page_load_start..]
            .find("\n#[cfg(windows)]\nfn schedule_inspector_control(")
            .expect("page-load control path has a following boundary")
            + page_load_start;
        assert!(
            source[page_load_start..page_load_end].contains("post_inspector_control_for_document(")
        );

        let current_document_start = source
            .find("async fn post_inspector_control_to_webview(")
            .expect("current-document control path is present");
        let current_document_end = source[current_document_start..]
            .find("\n#[cfg(windows)]\nfn request_history_state(")
            .expect("current-document control path has a following boundary")
            + current_document_start;
        assert!(source[current_document_start..current_document_end]
            .contains("post_inspector_control_for_document("));

        let toggle_start = source
            .find("fn schedule_inspector_control(")
            .expect("ordinary Inspector toggle path is present");
        let toggle_end = source[toggle_start..]
            .find("\n#[cfg(windows)]\nasync fn register_inspector_runtime_for_future_documents(")
            .expect("ordinary toggle path has a following boundary")
            + toggle_start;
        assert!(!source[toggle_start..toggle_end].contains("post_inspector_control_for_document("));
    }

    #[test]
    fn test_sanitize_and_validate_url() {
        // 放行标准协议（无 workspace_root：file: 一律拒绝）
        assert_eq!(
            NativeWebviewManager::sanitize_and_validate_url_with_root("https://example.com", None)
                .unwrap(),
            "https://example.com"
        );
        assert_eq!(
            NativeWebviewManager::sanitize_and_validate_url_with_root(
                "http://example.com/test?q=1",
                None
            )
            .unwrap(),
            "http://example.com/test?q=1"
        );
        assert_eq!(
            NativeWebviewManager::sanitize_and_validate_url_with_root("about:blank", None).unwrap(),
            "about:blank"
        );
        assert_eq!(
            NativeWebviewManager::sanitize_and_validate_url_with_root("   ", None).unwrap(),
            "about:blank"
        );
        assert_eq!(
            NativeWebviewManager::sanitize_and_validate_url_with_root("", None).unwrap(),
            "about:blank"
        );
        // 无协议自动补全 https
        assert_eq!(
            NativeWebviewManager::sanitize_and_validate_url_with_root("github.com", None).unwrap(),
            "https://github.com"
        );

        // 严格拦截非法协议
        assert!(
            NativeWebviewManager::sanitize_and_validate_url_with_root("javascript:alert(1)", None)
                .is_err()
        );
        assert!(NativeWebviewManager::sanitize_and_validate_url_with_root(
            "file:///C:/Windows/win.ini",
            None
        )
        .is_err());
        assert!(NativeWebviewManager::sanitize_and_validate_url_with_root(
            "data:text/html,<h1>test</h1>",
            None
        )
        .is_err());
        assert!(
            NativeWebviewManager::sanitize_and_validate_url_with_root("about:config", None)
                .is_err()
        );
        assert!(
            NativeWebviewManager::sanitize_and_validate_url_with_root("about:flags", None)
                .is_err()
        );
    }

    #[test]
    #[allow(clippy::disallowed_methods)] // 测试临时目录清理
    fn test_sanitize_with_workspace_root_gates_file_protocol() {
        // 03-分维 §7.3：提供 workspace_root 后，工作区内 file: 放行、越界仍拒绝
        let temp_root = std::env::temp_dir().join("conex-manager-root-gate-test");
        std::fs::create_dir_all(&temp_root).unwrap();
        let inside = temp_root.join("page.html");
        std::fs::write(&inside, "<html></html>").unwrap();
        let inside_url = url::Url::from_file_path(&inside).unwrap().to_string();

        assert!(NativeWebviewManager::sanitize_and_validate_url_with_root(
            &inside_url,
            Some(&temp_root)
        )
        .is_ok());

        let outside_url = if cfg!(windows) {
            "file:///C:/Windows/System32/drivers/etc/hosts"
        } else {
            "file:///etc/hosts"
        };
        assert!(NativeWebviewManager::sanitize_and_validate_url_with_root(
            outside_url,
            Some(&temp_root)
        )
        .is_err());

        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn test_is_similar_bounds() {
        let b1 = WebviewBounds {
            x: 100.0,
            y: 50.0,
            width: 800.0,
            height: 600.0,
        };
        let b2 = WebviewBounds {
            x: 100.3,
            y: 49.8,
            width: 800.2,
            height: 599.9,
        };
        assert!(NativeWebviewManager::is_similar_bounds(&b1, &b2));

        let b3 = WebviewBounds {
            x: 100.6,
            y: 50.0,
            width: 800.0,
            height: 600.0,
        };
        assert!(!NativeWebviewManager::is_similar_bounds(&b1, &b3));
    }

    #[test]
    fn test_navigation_state_payload_serde() {
        let payload = BrowserNavigationStatePayload::new("tab-1", "https://example.com")
            .with_title("Example Page")
            .with_loading(false)
            .with_history_caps(Some(true), Some(false))
            .with_favicon(Some("https://example.com/favicon.ico".to_string()));

        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"tabId\":\"tab-1\""));
        assert!(json.contains("\"url\":\"https://example.com\""));
        assert!(json.contains("\"title\":\"Example Page\""));
        assert!(json.contains("\"canGoBack\":true"));
        assert!(json.contains("\"canGoForward\":false"));
        assert!(json.contains("\"isLoading\":false"));
        assert!(json.contains("\"faviconUrl\":\"https://example.com/favicon.ico\""));

        let deserialized: BrowserNavigationStatePayload = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.tab_id, "tab-1");
        assert_eq!(deserialized.url, "https://example.com");
        assert_eq!(deserialized.can_go_back, Some(true));
        assert_eq!(deserialized.can_go_forward, Some(false));
        assert_eq!(
            deserialized.favicon_url.as_deref(),
            Some("https://example.com/favicon.ico")
        );
    }

    #[cfg(windows)]
    #[test]
    fn download_state_label_matches_frontend_contract() {
        assert_eq!(
            download_state_label(COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS),
            "progress"
        );
        assert_eq!(
            download_state_label(COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED),
            "completed"
        );
        assert_eq!(
            download_state_label(COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED),
            "interrupted"
        );
    }

    #[test]
    fn download_progress_payload_wire_shape_matches_frontend_contract() {
        let payload = DownloadProgressPayload {
            tab_id: "tab-1".to_string(),
            url: "https://example.com/a.zip".to_string(),
            filename: "a.zip".to_string(),
            total_bytes: None,
            received_bytes: 10,
            state: "progress".to_string(),
        };

        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["tabId"], "tab-1");
        assert_eq!(json["receivedBytes"], 10);
        assert!(
            json.get("totalBytes").is_none(),
            "未知总量必须省略字段而非下发 null"
        );
        assert!(json.get("downloadId").is_none(), "载荷不得包含 downloadId");
    }

    #[test]
    fn custom_storage_dir_must_be_a_single_component() {
        let root = Path::new("app-root/browser-storage");
        assert_eq!(
            resolve_custom_storage_dir(root, "ephemeral-tab-1"),
            Some(root.join("ephemeral-tab-1"))
        );
        for escaped in ["", ".", "..", "../evil", "a/b", "/abs"] {
            assert!(
                resolve_custom_storage_dir(root, escaped).is_none(),
                "必须拒绝越界存储目录：{escaped:?}"
            );
        }
    }

    #[test]
    fn close_path_removes_ephemeral_udf_but_keeps_persistent_udf() {
        let root = tempfile::tempdir().expect("临时存储根");
        let ephemeral = root.path().join("ephemeral-tab-close");
        let persistent = root.path().join("persistent-tab-close");
        std::fs::create_dir_all(&ephemeral).unwrap();
        std::fs::create_dir_all(&persistent).unwrap();

        remove_ephemeral_udf_if_needed(BrowserStorageMode::Ephemeral, &ephemeral);
        remove_ephemeral_udf_if_needed(BrowserStorageMode::Persistent, &persistent);

        assert!(!ephemeral.exists(), "Ephemeral Tab 关闭后 UDF 目录必须销毁");
        assert!(persistent.exists(), "Persistent 模式关闭不得删除 UDF 目录");
    }

    #[test]
    fn purge_stale_ephemeral_dirs_removes_only_ephemeral_directories() {
        let root = tempfile::tempdir().expect("临时存储根");
        let ephemeral = root.path().join("ephemeral-tab-1");
        let persistent = root.path().join("persistent-tab");
        std::fs::create_dir_all(ephemeral.join("EBWebView")).unwrap();
        std::fs::create_dir_all(&persistent).unwrap();
        std::fs::write(root.path().join("ephemeral-file"), b"not a dir").unwrap();

        purge_stale_ephemeral_dirs(root.path());

        assert!(!ephemeral.exists(), "ephemeral 目录应被清除");
        assert!(persistent.exists(), "非 ephemeral 目录不得误删");
        assert!(
            root.path().join("ephemeral-file").exists(),
            "同名文件不在清理范围（只处理目录）"
        );
    }

    #[test]
    fn native_manager_new_purges_stale_ephemeral_dirs_on_startup() {
        let app_dir = tempfile::tempdir().expect("临时应用根");
        let storage_root = app_dir.path().join("browser-storage");
        let stale = storage_root.join("ephemeral-crashed-tab");
        std::fs::create_dir_all(&stale).unwrap();

        let manager = NativeWebviewManager::new(app_dir.path().to_path_buf());

        assert!(storage_root.is_dir(), "构造函数仍应创建存储根");
        assert!(!stale.exists(), "启动 GC 应清除上次崩溃遗留的 ephemeral 目录");
        assert!(manager.webviews.lock().unwrap().is_empty());
    }

    #[test]
    fn navigation_state_history_capabilities_can_be_unknown() {
        let payload = BrowserNavigationStatePayload::new("tab-unknown", "about:blank");
        let json = serde_json::to_string(&payload).unwrap();
        assert!(!json.contains("canGoBack"));
        assert!(!json.contains("canGoForward"));

        let legacy_json =
            r#"{"tabId":"tab-legacy","url":"about:blank","title":"","isLoading":false}"#;
        let legacy: BrowserNavigationStatePayload =
            serde_json::from_str(legacy_json).expect("missing history fields mean unknown");
        assert_eq!(legacy.can_go_back, None);
        assert_eq!(legacy.can_go_forward, None);
    }
}
