# Tauri 2 原生子 Webview 管理器与 Rust 内核实现分维详案

> **文档标识**：`docs/native-browser-overhaul/01-分维-Tauri2原生子Webview管理器与Rust内核实现.md`  
> **所属战役**：`docs/native-browser-overhaul/`（原生浏览器彻底改造与子 Webview 架构战役）  
> **责任领域**：Rust 后端内核架构、Tauri 2 多 Webview 原生集成、Win32 窗口子系统与 WebView2 COM 控制器  
> **权威依据**：`AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`docs/native-browser-overhaul/00-总方案-原生浏览器彻底改造与子Webview架构方案.md`  
> **状态**：方案已锁定（Contract & Architecture Frozen），准备实施

---

## 一、模块定位与非妥协重构原则

### 1.1 模块职责与定位
本模块是 Conex / Crish 桌面端“原生浏览器彻底重构”的核心基础设施，坐落在 `apps/agent-workbench/src-tauri/src/browser/` 目录。
它负责在 Rust 宿主内核中以单例形式管理所有原生子 Webview（Native Child Webview）的完整生命周期，包括：
1. **多 Webview 实例调度**：支持多标签页（Tab）原生视口的按需异步创建、挂载、显示/隐藏、导航与安全销毁；
2. **高频几何变换引擎**：处理来自前端 React 容器的高频 CSS 逻辑像素坐标，结合当前显示器 DPI 缩放比（DPI Scale Factor），纳秒级换算为 Win32 物理坐标并调用底层 `SetWindowPos` 实施无缝平铺；
3. **安全隔离沙箱**：为外网公网页面建立独立的 UserDataFolder 存储分区（Cookies / LocalStorage / Cache），并且**坚决不向子 Webview 注入任何 Tauri 特权 IPC Handler**；
4. **Win32 平台硬核适配**：根治多 Webview 在 Windows 平台下特有的 COM STA 消息死锁、快捷键吞噬、窗口拖拽错位与窗口 Resize 闪烁白边等深水区顽疾。

### 1.2 非妥协重构原则（零打补丁、零双轨兼容）
根据用户最新明确指示：
> *“非必要不兼容。不允许打补丁，不允许硬编码，有合理的抽象，适合未来的功能需求，代码尽量简洁，具有优秀的可维护性。需要删除的代码就删除，需要系统性的重构。”*

本方案坚决贯彻以下设计红线：
1. **彻底废除双轨兼容**：绝不在代码中保留“如果是旧 CDP 截图就走 FrameCanvas，如果是原生就走 ChildWebview”的双轨分支。所有旧式 `frame_stream.rs`、`panel_input.rs`、`frames.rs` 与前端 `iframe` 代理逻辑全量标记为物理废除，统一收敛至 Tauri 2 原生 Multi-Webview 单一真理路径（SSOT）；
2. **拒绝魔术数字补偿**：坐标定位必须基于严格的数学映射（Logical -> Physical 四舍五入对齐），严禁硬编码 `x + 12px`、`y - 4px` 等脆弱的手工偏移补偿；
3. **架构优雅自洽**：以单例模式 `NativeWebviewManager` 统一封装所有底层的复杂性，对外仅暴露清晰、强类型、异步非阻塞的 Tauri Command 接口。

---

## 二、构建基座配置与特性开启 (Cargo Dependencies & Features)

### 2.1 Tauri 2 `unstable` 特性开启
在 Tauri 2.11 中，解耦顶层操作系统窗口（`Window`）与渲染表面（`Webview`）的 Multi-Webview 能力（特别是 `WebviewBuilder` 与 `Window::add_child` API）受到编译器特性门禁 `#[cfg(feature = "unstable")]` 的保护。

#### `apps/agent-workbench/src-tauri/Cargo.toml` 变更：
```toml
[dependencies]
# 开启 unstable 特性以导出 WebviewBuilder 与 Window::add_child
tauri = { workspace = true, features = ["protocol-asset", "unstable", "test"] }
tauri-build = { workspace = true }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-persisted-scope = { version = "2", features = ["protocol-asset"] }
tauri-plugin-single-instance = "2"
tauri-plugin-updater = "2"
tauri-plugin-mcp = { git = "https://github.com/P3GLEG/tauri-plugin-mcp" }

# Windows 平台专用底层依赖（用于 Win32 消息循环介入与 WebView2 COM 接口控制）
[target.'cfg(windows)'.dependencies]
webview2-com = "0.38.2"
windows-sys = { workspace = true, features = [
    "Win32_Foundation",
    "Win32_UI_WindowsAndMessaging",
    "Win32_UI_Input_KeyboardAndMouse",
    "Win32_UI_HiDpi",
    "Win32_Graphics_Gdi",
] }
windows-core = "0.61"
```

### 2.2 根目录 `Cargo.toml` 工作区对齐
确认根目录 `Cargo.toml` 中的 `tauri` workspace 依赖与 `windows-sys` 依赖版本一致，确保全工作区单版本收敛，杜绝符号重定义与构建膨胀。

---

## 三、数据结构与核心领域模型

所有类型严格遵循与前端的驼峰（camelCase）序列化协议，位于 `apps/agent-workbench/src-tauri/src/browser/types.rs`。

### 3.1 几何与坐标模型
```rust
use serde::{Deserialize, Serialize};

/// 前端上报的 CSS 逻辑像素矩形
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 内核计算所得的 Win32 物理像素矩形（用于去重与底层 Win32 调用）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl LogicalRect {
    /// 依据系统 DPI 缩放比换算为物理像素，采用四边独立四舍五入消除 1px 缝隙
    #[inline]
    pub fn to_physical(&self, scale_factor: f64) -> PhysicalBounds {
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
```

### 3.2 IPC 请求与响应载荷模型
```rust
/// 创建原生子 Webview 参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewCreateArgs {
    pub tab_id: String,
    pub initial_url: Option<String>,
    pub bounds: LogicalRect,
    #[serde(default = "default_true")]
    pub visible: bool,
    pub data_directory: Option<String>,
    #[serde(default)]
    pub muted: bool,
}

fn default_true() -> bool {
    true
}

/// 创建成功返回值
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewCreateResult {
    pub tab_id: String,
    pub native_id: String,
    pub loaded: bool,
}

/// 调整 Bounds 参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewSetBoundsArgs {
    pub tab_id: String,
    pub bounds: LogicalRect,
}

/// 显隐切换参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewSetVisibleArgs {
    pub tab_id: String,
    pub visible: bool,
}

/// 导航参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewNavigateArgs {
    pub tab_id: String,
    pub url: String,
}

/// 动作枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserWebviewActionKind {
    Back,
    Forward,
    Reload,
    ReloadIgnoringCache,
    Stop,
}

/// 动作执行参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewActionArgs {
    pub tab_id: String,
    pub action: BrowserWebviewActionKind,
}

/// 关闭参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewCloseArgs {
    pub tab_id: String,
}

/// 脚本求值参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewEvalArgs {
    pub tab_id: String,
    pub script: String,
}
```

### 3.3 事件下行广播载荷模型
```rust
/// 导航状态广播（对应事件 channel: `browser://navigation-state`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationStatePayload {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub is_loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub favicon: Option<String>,
}

/// 加载错误广播（对应事件 channel: `browser://load-error`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLoadErrorPayload {
    pub tab_id: String,
    pub url: String,
    pub error_code: i32,
    pub error_message: String,
}

/// 新窗口弹出拦截广播（对应事件 channel: `browser://new-window`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNewWindowPayload {
    pub source_tab_id: String,
    pub target_url: String,
    pub disposition: String, // "new-tab" | "new-window" | "foreground-tab"
}
```

---

## 四、内核单例管理器架构设计 (`NativeWebviewManager`)

管理器位于 `apps/agent-workbench/src-tauri/src/browser/native_manager.rs`，是持有子视口唯一真源的线程安全单例。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       NativeWebviewManager (Rust 单例)                      │
│                                                                             │
│  • default_storage_dir: PathBuf (%LOCALAPPDATA%/.../browser-storage/)       │
│  • instances: Arc<RwLock<HashMap<TabId, WebviewController>>>                │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    WebviewController (实例封装)                       │  │
│  │  • tab_id: String                                                     │  │
│  │  • label: String ("browser-child-<tab_id>")                           │  │
│  │  • webview: tauri::Webview (原生句柄)                                 │  │
│  │  • last_bounds: Arc<Mutex<Option<PhysicalBounds>>> (物理去重缓存)    │  │
│  │  • is_visible: Arc<AtomicBool>                                        │  │
│  │  • current_state: Arc<RwLock<BrowserNavigationStatePayload>>          │  │
│  │  • accelerator_token: Arc<Mutex<Option<i64>>> (快捷键拦截 Token)      │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 结构体定义与构造
```rust
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Manager, Rect, Webview};

use super::types::*;

pub struct WebviewController {
    pub tab_id: String,
    pub label: String,
    pub webview: Webview<tauri::Wry>,
    pub last_bounds: Arc<Mutex<Option<PhysicalBounds>>>,
    pub is_visible: Arc<AtomicBool>,
    pub current_state: Arc<RwLock<BrowserNavigationStatePayload>>,
    #[cfg(windows)]
    pub accelerator_token: Arc<Mutex<Option<i64>>>,
}

#[derive(Clone)]
pub struct NativeWebviewManager {
    instances: Arc<RwLock<HashMap<String, WebviewController>>>,
    storage_root: PathBuf,
}

impl NativeWebviewManager {
    pub fn new(app_dir: PathBuf) -> Self {
        let storage_root = app_dir.join("browser-storage");
        // 确保存储目录物理存在
        let _ = std::fs::create_dir_all(&storage_root);
        Self {
            instances: Arc::new(RwLock::new(HashMap::new())),
            storage_root,
        }
    }
}
```

---

## 五、关键内核逻辑与核心实现 (Kernel Implementations)

### 5.1 异步非死锁创建流程 (`create_webview`)

#### 核心流程
1. **防止重复创建**：若传入的 `tab_id` 已存在，直接将其唤醒、更新坐标并返回已存在实例；
2. **安全隔离数据目录**：每个 Tab 默认共享 `%LOCALAPPDATA%/.../browser-storage/default`，保障登录态共享与 Cookie 留存；若指定 `data_directory` 则隔离；
3. **零特权配置**：子 Webview **绝不注册任何 Tauri IPC Handler**，使其处于安全沙箱中；
4. **STA 异步非阻塞执行**：函数声明为 `async fn`，在 Tokio 线程中运行，通过 Tauri 内部通道安全调用主线程 `add_child`；
5. **事件通道装配**：装配 `on_navigation`、`on_page_load`、`on_document_title_changed` 事件，通过 `app.emit(...)` 下行广播给前端。

#### 实现源码：
```rust
impl NativeWebviewManager {
    pub async fn create_webview(
        &self,
        app: &AppHandle,
        args: BrowserWebviewCreateArgs,
    ) -> Result<BrowserWebviewCreateResult, String> {
        let tab_id = args.tab_id.clone();
        let label = format!("native-browser-{}", tab_id);

        // 1. 幂等性检查
        {
            let instances = self.instances.read().map_err(|e| e.to_string())?;
            if let Some(ctrl) = instances.get(&tab_id) {
                // 已存在则同步最新 bounds 并唤醒
                let main_window = app.get_window("main").ok_or("Main window not found")?;
                let scale_factor = main_window.scale_factor().map_err(|e| e.to_string())?;
                let physical = args.bounds.to_physical(scale_factor);
                ctrl.update_bounds_physical(physical)?;
                if args.visible {
                    ctrl.set_visible(true)?;
                }
                return Ok(BrowserWebviewCreateResult {
                    tab_id: tab_id.clone(),
                    native_id: label,
                    loaded: true,
                });
            }
        }

        let main_window = app.get_window("main").ok_or("Main window not found")?;
        let scale_factor = main_window.scale_factor().map_err(|e| e.to_string())?;
        let initial_physical = args.bounds.to_physical(scale_factor);

        // 2. URL 解析与安全白名单清洗
        let target_url_str = args
            .initial_url
            .as_deref()
            .unwrap_or("about:blank")
            .trim();
        let validated_url = Self::validate_and_sanitize_url(target_url_str)?;
        let parsed_url: url::Url = validated_url
            .parse()
            .map_err(|e| format!("Invalid URL: {e}"))?;

        // 3. 构建 WebviewBuilder
        let mut builder = tauri::webview::WebviewBuilder::new(
            &label,
            tauri::WebviewUrl::External(parsed_url.clone()),
        );

        // 物理存储分区隔离 (UserDataFolder)
        let profile_dir = if let Some(custom_dir) = args.data_directory {
            self.storage_root.join(custom_dir)
        } else {
            self.storage_root.join("default")
        };
        let _ = std::fs::create_dir_all(&profile_dir);
        builder = builder.data_directory(profile_dir);

        // 核心属性装配
        builder = builder
            .accept_first_mouse(true)
            .devtools(cfg!(debug_assertions))
            .background_color(tauri::image::Color(24, 24, 27, 255)) // #18181b 主题色对齐
            .auto_resize(); // 注意：此处仍需调用以初始化 bounds 槽位，但随后立即覆盖

        // 4. 事件回调与下行广播绑定
        let app_handle_for_events = app.clone();
        let tab_id_for_nav = tab_id.clone();
        builder = builder.on_navigation(move |url| {
            // 白名单协议放行判断
            let scheme = url.scheme();
            if scheme == "http" || scheme == "https" || scheme == "about" {
                true
            } else {
                log::warn!("[NativeBrowser] Blocked navigation to unsafe scheme: {}", scheme);
                false
            }
        });

        let app_handle_for_title = app.clone();
        let tab_id_for_title = tab_id.clone();
        builder = builder.on_document_title_changed(move |webview, title| {
            let url_str = webview.url().map(|u| u.to_string()).unwrap_or_default();
            let payload = BrowserNavigationStatePayload {
                tab_id: tab_id_for_title.clone(),
                url: url_str,
                title: title.clone(),
                is_loading: false,
                can_go_back: false, // 下文通过 COM 直调补偿
                can_go_forward: false,
                favicon: None,
            };
            let _ = app_handle_for_title.emit("browser://navigation-state", payload);
        });

        let pos = tauri::LogicalPosition::new(args.bounds.x.round(), args.bounds.y.round());
        let size = tauri::LogicalSize::new(
            args.bounds.width.round().max(1.0),
            args.bounds.height.round().max(1.0),
        );

        // 5. 挂载到主窗口 (Window::add_child)
        let webview = main_window
            .add_child(builder, pos, size)
            .map_err(|e| format!("Window::add_child failed: {e}"))?;

        // 6. Win32 平台级加固装配
        #[cfg(windows)]
        let token = Self::setup_windows_hardening(&webview, app.clone(), tab_id.clone())?;

        let controller = WebviewController {
            tab_id: tab_id.clone(),
            label: label.clone(),
            webview,
            last_bounds: Arc::new(Mutex::new(Some(initial_physical))),
            is_visible: Arc::new(AtomicBool::new(args.visible)),
            current_state: Arc::new(RwLock::new(BrowserNavigationStatePayload {
                tab_id: tab_id.clone(),
                url: parsed_url.to_string(),
                title: String::new(),
                is_loading: true,
                can_go_back: false,
                can_go_forward: false,
                favicon: None,
            })),
            #[cfg(windows)]
            accelerator_token: Arc::new(Mutex::new(token)),
        };

        // 如果初始不可见，显式调用隐藏
        if !args.visible {
            controller.set_visible(false)?;
        }

        // 7. 写入单例实例表
        {
            let mut instances = self.instances.write().map_err(|e| e.to_string())?;
            instances.insert(tab_id.clone(), controller);
        }

        Ok(BrowserWebviewCreateResult {
            tab_id,
            native_id: label,
            loaded: true,
        })
    }

    /// URL 安全校验与清洗白名单
    fn validate_and_sanitize_url(raw: &str) -> Result<String, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed == "about:blank" {
            return Ok("about:blank".to_string());
        }
        let parsed = url::Url::parse(trimmed)
            .or_else(|_| url::Url::parse(&format!("https://{}", trimmed)))
            .map_err(|e| format!("Invalid URL format: {e}"))?;

        let scheme = parsed.scheme();
        if scheme != "http" && scheme != "https" {
            return Err(format!("Forbidden URL scheme: {scheme}. Only HTTP/HTTPS is allowed."));
        }
        Ok(parsed.to_string())
    }
}
```

---

### 5.2 几何变换与 DPI 精确换算 (`set_bounds`)

#### 核心防抖与去重逻辑
1. 前端通过 `ResizeObserver` + `requestAnimationFrame` 发起调用；
2. Rust 端使用当前窗口的 `scale_factor` 进行转换，采用 `to_physical` 计算物理边界；
3. **物理去重（Physical Deduplication）**：与 `last_bounds` 缓存比对，若物理整数坐标（像素）未发生任何变化，立即返回 `Ok(())`，不发起昂贵的 OS 系统调用；
4. **Win32 优化**：使用 `SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS` 确保不夺取宿主激活态、不重新排序 Z 轴。

```rust
impl WebviewController {
    pub fn update_bounds(&self, bounds: LogicalRect, scale_factor: f64) -> Result<(), String> {
        let physical = bounds.to_physical(scale_factor);
        self.update_bounds_physical(physical)
    }

    pub fn update_bounds_physical(&self, physical: PhysicalBounds) -> Result<(), String> {
        // 1. 物理坐标去重
        {
            let mut last = self.last_bounds.lock().map_err(|e| e.to_string())?;
            if let Some(cached) = *last {
                if cached == physical {
                    return Ok(()); // 物理像素无变动，直接短路
                }
            }
            *last = Some(physical);
        }

        // 2. 调用 Tauri 核心 set_bounds
        let rect = tauri::Rect {
            position: tauri::PhysicalPosition::new(physical.x, physical.y).into(),
            size: tauri::PhysicalSize::new(physical.width as u32, physical.height as u32).into(),
        };

        self.webview.set_bounds(rect).map_err(|e| e.to_string())?;
        Ok(())
    }
}
```

---

### 5.3 视口显隐与 GPU 资源挂起 (`set_visible`)

```rust
impl WebviewController {
    pub fn set_visible(&self, visible: bool) -> Result<(), String> {
        self.is_visible.store(visible, Ordering::SeqCst);
        if visible {
            self.webview.show().map_err(|e| e.to_string())?;
            // 唤醒后重新刷新一次物理 bounds，防止隐身期间父窗口 resize 导致的错位
            if let Ok(guard) = self.last_bounds.lock() {
                if let Some(physical) = *guard {
                    let rect = tauri::Rect {
                        position: tauri::PhysicalPosition::new(physical.x, physical.y).into(),
                        size: tauri::PhysicalSize::new(physical.width as u32, physical.height as u32).into(),
                    };
                    let _ = self.webview.set_bounds(rect);
                }
            }
        } else {
            self.webview.hide().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
```

---

### 5.4 页面导航与原生 COM 抢占式动作执行 (`action`)

对于后退、前进、刷新、停止等浏览器标准动作，若仅使用 `webview.eval("history.back()")`，在页面死循环或渲染卡死时无法响应。
通过 `webview.with_webview` 穿透获取底层 `ICoreWebView2Controller` 与 `ICoreWebView2` 原生 COM 接口，进行强行抢占式调度：

```rust
#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Controller};

impl WebviewController {
    pub fn execute_action(&self, action: BrowserWebviewActionKind) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.webview.with_webview(move |platform_webview| {
                unsafe {
                    let controller = platform_webview.controller();
                    let mut core: Option<ICoreWebView2> = None;
                    if controller.CoreWebView2(&mut core).is_ok() {
                        if let Some(core) = core {
                            match action {
                                BrowserWebviewActionKind::Back => {
                                    let mut can = false.into();
                                    if core.CanGoBack(&mut can).is_ok() && can.as_bool() {
                                        let _ = core.GoBack();
                                    }
                                }
                                BrowserWebviewActionKind::Forward => {
                                    let mut can = false.into();
                                    if core.CanGoForward(&mut can).is_ok() && can.as_bool() {
                                        let _ = core.GoForward();
                                    }
                                }
                                BrowserWebviewActionKind::Reload => {
                                    let _ = core.Reload();
                                }
                                BrowserWebviewActionKind::ReloadIgnoringCache => {
                                    // WebView2 Reload 默认刷新，也可通过 executeScript 辅助
                                    let _ = core.Reload();
                                }
                                BrowserWebviewActionKind::Stop => {
                                    let _ = core.Stop();
                                }
                            }
                        }
                    }
                }
            }).map_err(|e| e.to_string())?;
            return Ok(());
        }

        #[cfg(not(windows))]
        {
            match action {
                BrowserWebviewActionKind::Back => self.webview.eval("window.history.back()")?,
                BrowserWebviewActionKind::Forward => self.webview.eval("window.history.forward()")?,
                BrowserWebviewActionKind::Reload => self.webview.reload()?,
                BrowserWebviewActionKind::ReloadIgnoringCache => self.webview.reload()?,
                BrowserWebviewActionKind::Stop => self.webview.eval("window.stop()")?,
            }
            Ok(())
        }
    }
}
```

---

### 5.5 安全销毁与资源收敛 (`close_webview`)

```rust
impl NativeWebviewManager {
    pub fn close_webview(&self, tab_id: &str) -> Result<(), String> {
        let mut instances = self.instances.write().map_err(|e| e.to_string())?;
        if let Some(ctrl) = instances.remove(tab_id) {
            // 1. 显式隐藏以释放 DirectComposition 图层
            let _ = ctrl.webview.hide();
            // 2. 调用 close 销毁原生子窗口与清理 AppManager 映射
            ctrl.webview.close().map_err(|e| e.to_string())?;
            log::info!("[NativeBrowser] Sub-webview closed and destroyed for tab: {}", tab_id);
        }
        Ok(())
    }
}
```

---

## 六、Win32 平台级深水区硬核防护实现

在 Windows (WebView2) 平台下，原生嵌入视口存在三大系统级缺陷，本方案在内核层予以刚性根治。

### 6.1 全局快捷键拦截与防吞噬 (`AcceleratorKeyPressed`)

#### 痛点
当用户在网页内容区域点击后，子 HWND 获得焦点，所有的 Windows 按键消息（`WM_KEYDOWN`）被直接路由进 Chromium 内核并消费，导致主应用所有的全局快捷键（如 `Ctrl+B`、`Ctrl+P`、`Ctrl+Shift+I` 等）全部失灵。

#### 根治方案
在子 Webview 创建后，立即通过 COM 注册 `AcceleratorKeyPressedEventHandler`。当检测到 Control 组合键或功能键时，调用 `args.SetHandled(TRUE)` 拦截网页消费，并通过 Tauri 事件桥转发宿主：

```rust
#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2AcceleratorKeyPressedEventArgs,
    COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
};

impl NativeWebviewManager {
    #[cfg(windows)]
    fn setup_windows_hardening(
        webview: &Webview<tauri::Wry>,
        app: AppHandle,
        tab_id: String,
    ) -> Result<Option<i64>, String> {
        use windows_core::Interface;

        let mut out_token = None;
        webview.with_webview(move |platform_webview| {
            unsafe {
                let controller = platform_webview.controller();

                let app_for_shortcut = app.clone();
                let handler = webview2_com::AcceleratorKeyPressedEventHandler::create(Box::new(
                    move |_sender, args: Option<&ICoreWebView2AcceleratorKeyPressedEventArgs>| {
                        if let Some(args) = args {
                            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                            let mut vk = 0u32;
                            let _ = args.KeyEventKind(&mut kind);
                            let _ = args.VirtualKey(&mut vk);

                            // 判断 Ctrl 键状态
                            let is_ctrl = (windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyState(0x11) as u16 & 0x8000) != 0;

                            // 拦截 Ctrl+B (0x42), Ctrl+P (0x50), Ctrl+W (0x57), F12 (0x7B)
                            if is_ctrl && (vk == 0x42 || vk == 0x50 || vk == 0x57) || vk == 0x7B {
                                let _ = args.SetHandled(true);
                                let _ = app_for_shortcut.emit("workbench://shortcut-forwarded", vk);
                            }
                        }
                        Ok(())
                    },
                ));

                let mut token = 0;
                if controller.add_AcceleratorKeyPressed(&handler, &mut token).is_ok() {
                    out_token = Some(token);
                }
            }
        }).map_err(|e| e.to_string())?;

        Ok(out_token)
    }
}
```

### 6.2 宿主窗口移动补偿 (`NotifyParentWindowPositionChanged`)

#### 痛点
在 `wry` 内部，当作为子 Webview 创建时（`is_child = true`），Wry 显式跳过了宿主窗口子类化挂载。当用户拖拽主窗口在屏幕上移动或跨屏移动后，由于子 Webview 的 `NotifyParentWindowPositionChanged` 未被调用，子 Webview 内的 HTML `<select>` 下拉菜单、日期选择器以及系统 IME 输入法候选词窗口，**依然会错误地显示在移动前的屏幕旧坐标处**！

#### 根治方案
在 `apps/agent-workbench/src-tauri/src/main.rs` 的主窗口事件监听中显式捕获 `WindowEvent::Moved`，通知所有已存活的子 Webview：

```rust
// 注册于 main.rs setup 钩子或窗口事件回调中：
pub fn register_window_move_sync(app: &tauri::AppHandle, manager: NativeWebviewManager) {
    let app_handle = app.clone();
    app.on_window_event(move |_window, event| {
        if let tauri::WindowEvent::Moved(_) = event {
            #[cfg(windows)]
            {
                if let Ok(instances) = manager.instances.read() {
                    for ctrl in instances.values() {
                        let _ = ctrl.webview.with_webview(|platform_webview| unsafe {
                            let _ = platform_webview.controller().NotifyParentWindowPositionChanged();
                        });
                    }
                }
            }
        }
    });
}
```

### 6.3 缩放白边与画面闪烁消除策略
1. **背景底色物理注入**：在 `WebviewBuilder` 初始化时，必须显式调用 `.background_color(Color(24, 24, 27, 255))`，与宿主暗黑主题色完全一致；
2. **Win32 物理异步窗口定位**：`SetWindowPos` 使用 `SWP_NOACTIVATE | SWP_NOZORDER | SWP_ASYNCWINDOWPOS`，避免重绘阻塞。

---

## 七、Tauri IPC 命令面完整实现 (`native_commands.rs`)

位于 `apps/agent-workbench/src-tauri/src/browser/native_commands.rs`：

```rust
use tauri::{AppHandle, State};
use super::native_manager::NativeWebviewManager;
use super::types::*;

#[tauri::command]
pub async fn browser_webview_create(
    app: AppHandle,
    state: State<'_, NativeWebviewManager>,
    args: BrowserWebviewCreateArgs,
) -> Result<BrowserWebviewCreateResult, String> {
    state.create_webview(&app, args).await
}

#[tauri::command]
pub async fn browser_webview_set_bounds(
    app: AppHandle,
    state: State<'_, NativeWebviewManager>,
    args: BrowserWebviewSetBoundsArgs,
) -> Result<(), String> {
    let main_window = app.get_window("main").ok_or("Main window not found")?;
    let scale_factor = main_window.scale_factor().map_err(|e| e.to_string())?;

    let instances = state.instances.read().map_err(|e| e.to_string())?;
    let ctrl = instances
        .get(&args.tab_id)
        .ok_or_else(|| format!("Webview instance not found: {}", args.tab_id))?;

    ctrl.update_bounds(args.bounds, scale_factor)
}

#[tauri::command]
pub async fn browser_webview_set_visible(
    state: State<'_, NativeWebviewManager>,
    args: BrowserWebviewSetVisibleArgs,
) -> Result<(), String> {
    let instances = state.instances.read().map_err(|e| e.to_string())?;
    let ctrl = instances
        .get(&args.tab_id)
        .ok_or_else(|| format!("Webview instance not found: {}", args.tab_id))?;

    ctrl.set_visible(args.visible)
}

#[tauri::command]
pub async fn browser_webview_navigate(
    state: State<'_, NativeWebviewManager>,
    args: BrowserWebviewNavigateArgs,
) -> Result<(), String> {
    let validated = NativeWebviewManager::validate_and_sanitize_url(&args.url)?;
    let parsed: url::Url = validated.parse().map_err(|e| format!("Invalid URL: {e}"))?;

    let instances = state.instances.read().map_err(|e| e.to_string())?;
    let ctrl = instances
        .get(&args.tab_id)
        .ok_or_else(|| format!("Webview instance not found: {}", args.tab_id))?;

    ctrl.webview.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_webview_action(
    state: State<'_, NativeWebviewManager>,
    args: BrowserWebviewActionArgs,
) -> Result<(), String> {
    let instances = state.instances.read().map_err(|e| e.to_string())?;
    let ctrl = instances
        .get(&args.tab_id)
        .ok_or_else(|| format!("Webview instance not found: {}", args.tab_id))?;

    ctrl.execute_action(args.action)
}

#[tauri::command]
pub async fn browser_webview_close(
    state: State<'_, NativeWebviewManager>,
    args: BrowserWebviewCloseArgs,
) -> Result<(), String> {
    state.close_webview(&args.tab_id)
}

#[tauri::command]
pub async fn browser_webview_eval(
    state: State<'_, NativeWebviewManager>,
    args: BrowserWebviewEvalArgs,
) -> Result<(), String> {
    let instances = state.instances.read().map_err(|e| e.to_string())?;
    let ctrl = instances
        .get(&args.tab_id)
        .ok_or_else(|| format!("Webview instance not found: {}", args.tab_id))?;

    ctrl.webview.eval(&args.script).map_err(|e| e.to_string())
}
```

---

## 八、命令清单注册与系统级装配 (Manifest Registration & System Wiring)

### 8.1 `command_manifest.rs` 唯一真源登记
根据仓库纪律（PE-03 T03.1），所有对外暴露的 Tauri 命令必须在 `apps/agent-workbench/src-tauri/src/command_manifest.rs` 中完整登记，归属于 `workbench` 分组，契约面标记为 `gui`：

```rust
// apps/agent-workbench/src-tauri/src/command_manifest.rs
pub const COMMAND_REGISTRY: &[CommandManifestEntry] = &[
    // ... 原有核心命令 ...

    // ── 原生多 Webview 浏览器重构命令（01-分维详案）──
    entry("browser_webview_create", "workbench", "gui", true),
    entry("browser_webview_set_bounds", "workbench", "gui", true),
    entry("browser_webview_set_visible", "workbench", "gui", true),
    entry("browser_webview_navigate", "workbench", "gui", true),
    entry("browser_webview_action", "workbench", "gui", true),
    entry("browser_webview_close", "workbench", "gui", true),
    entry("browser_webview_eval", "workbench", "gui", true),
];
```

### 8.2 `main.rs` 中的装配与单例注入
在 `apps/agent-workbench/src-tauri/src/main.rs` 中：
1. 模块声明：
   ```rust
   mod browser;
   ```
2. 单例管理：
   ```rust
   let native_browser_manager = browser::NativeWebviewManager::new(app_dir.clone());
   app.manage(native_browser_manager.clone());
   browser::register_window_move_sync(&app.handle(), native_browser_manager);
   ```
3. `command_registry!` 宏追加：
   ```rust
   command_registry!(
       // ...
       ("browser_webview_create", crate::browser::native_commands::browser_webview_create),
       ("browser_webview_set_bounds", crate::browser::native_commands::browser_webview_set_bounds),
       ("browser_webview_set_visible", crate::browser::native_commands::browser_webview_set_visible),
       ("browser_webview_navigate", crate::browser::native_commands::browser_webview_navigate),
       ("browser_webview_action", crate::browser::native_commands::browser_webview_action),
       ("browser_webview_close", crate::browser::native_commands::browser_webview_close),
       ("browser_webview_eval", crate::browser::native_commands::browser_webview_eval),
   );
   ```

---

## 九、历史死代码物理清退计划 (Decommission Plan)

重构完成后，严禁保留旧的 CDP 伪装代码与开发反向代理，执行净收敛物理清理：

### 9.1 Rust 后端物理删除清单
| 废弃文件路径 | 废弃原因 | 替代者 |
| :--- | :--- | :--- |
| `apps/agent-workbench/src-tauri/src/browser/frame_stream.rs` | 废弃：CDP 逐帧 JPEG 截屏与推流通道 | 原生硬件加速，直显直绘 |
| `apps/agent-workbench/src-tauri/src/browser/panel_input.rs` | 废弃：旧式键盘/鼠标伪装事件注入 | 原生操作系统级键鼠与 IME 消息路由 |
| `apps/agent-workbench/src-tauri/src/browser_commands/frames.rs` | 废弃：`browser_start_frames` 等帧控制命令 | 下线，不再需要任何帧控制 |
| `apps/agent-workbench/src-tauri/src/browser_commands/lifecycle.rs` | 废弃：启动后台无头 Chrome 实例的旧进程管理 | 收敛至 `NativeWebviewManager` |

### 9.2 前端工程物理删除清单
| 废弃文件路径 | 废弃原因 | 替代者 |
| :--- | :--- | :--- |
| `apps/crish-desktop/vite.config.ts` 中的 `crishPreviewProxyPlugin` | 废弃：篡改 CSP 与 X-Frame-Options 的 Vite 代理 | 彻底删除代理中间件 |
| `apps/crish-desktop/dev-server/previewBridgeScript.ts` | 废弃：代理向 iframe 强行注入的通信脚本 | 移除 |
| `apps/crish-desktop/dev-server/sameOriginRequest.ts` | 废弃：反向代理请求重写逻辑 | 移除 |
| `apps/crish-desktop/src/components/panels/preview/FrameCanvas.tsx` | 废弃：旧式软解压与 Canvas 2D 绘制表面 | `NativeBrowserSurface.tsx` |
| `apps/crish-desktop/src/components/panels/preview/InputLayer.tsx` | 废弃：伪装 IME 与输入层 | 移除 |

---

## 十、验证方案与验收测试门禁

### 10.1 单元测试（Rust 侧断言）
在 `apps/agent-workbench/src-tauri/src/browser/tests/native_manager_tests.rs` 编写纯逻辑单测：
1. **DPI 物理像素换算测试**：
   - 验证 `1.0`, `1.25`, `1.5`, `2.0` 缩放比下，`LogicalRect` 的四边取整运算绝对不出现负数尺寸或 1px 缝隙；
2. **URL 安全白名单测试**：
   - 输入 `file:///C:/Windows/win.ini` -> 必须断言返回 `Err`；
   - 输入 `javascript:alert(1)` -> 必须断言返回 `Err`；
   - 输入 `https://google.com` -> 必须断言通过；
   - 输入 `github.com` -> 必须断言自动补全为 `https://github.com` 并通过。
3. **物理 Bounds 去重测试**：
   - 连续传入两次微小变动但物理像素取整后相同的坐标，断言内部缓存命中，底层调用次数严格为 1。

### 10.2 物理环境端到端刚性验收门禁
1. **[门禁 1 · 编译与清单锁定]**：
   运行 `cargo test --bin agent-workbench -- manifest_` 通过，确保 7 大新命令已全量注册且双端无漂移；
2. **[门禁 2 · 真实 Google 搜索验证]**：
   在 Crish 桌面端打开应用预览，在地址栏输入 `https://google.com`，在搜索框输入关键词并回车：
   - 页面流畅展现搜索结果；
   - **绝对不出现 `ERR_BLOCKED_BY_RESPONSE` 或“已阻止此内容”红白拦截页**；
3. **[门禁 3 · 登录态跨会话持久化]**：
   登录 GitHub 账号后，完全退出 Crish 桌面应用并重新启动；再次打开应用预览，用户处于已登录状态；
4. **[门禁 4 · 缩放与拖拽性能]**：
   高频拖拽二叉树分栏滑块（Splitter），子视口平滑跟随，无画面撕裂、无严重白边闪烁；
5. **[门禁 5 · 全局快捷键不被吞噬]**：
   鼠标聚焦于子 Webview 网页内部的输入框中，按下 `Ctrl+B`，侧边栏能够立即响应并正常折叠/展开。
