# 原生多 Webview 浏览器 IPC 通信契约与事件流转模型

> **战役工作区**：`docs/native-browser-overhaul/`  
> **文档定位**：分析与契约设计（Analysis & Contract Specification）  
> **编制依据**：Tauri 2 多 Webview 原生架构、`command_manifest.rs` 命令面契约、`tauriInvoke.ts` 错误模型与 `usePreviewNavigation` 交互范式。  
> **状态**：方案已锁定（Contract Frozen）

---

## 一、概述与核心背景

### 1.1 从“伪装投屏”到“原生子 Webview”的架构跃迁

在桌面端生产力软件中，内嵌浏览器是应用预览、外部文档查阅与 AI 协同操作的关键基础设施。旧版本架构存在两大根本性瓶颈：

1. **旧版受管浏览器的过度设计与高昂开销**：
   - 历史方案在后台独立启动无头 Chrome 实例，通过 Chrome DevTools Protocol (CDP) 监听画面，再通过 Tauri Channel 以 JPEG 帧流推送到前端 `<FrameCanvas>` 进行实时绘制；
   - 采用全透明 `<InputLayer>` 伪装拦截鼠标与滚轮、结合 1px 动态挪动隐藏输入框桥接系统 IME；
   - **代价极其沉重**：高频传输下 CPU 持续占用达 15%~35%、画面存在不可避免的编码重影与缩放模糊、无法原生划词复制与唤出原生右键菜单、IME 候选框频发漂移甚至吞字。
2. **前端纯 Iframe 模式的生态死穴**：
   - 受限于浏览器同源策略（SOP）、`X-Frame-Options: SAMEORIGIN / DENY` 以及现代网站严苛的 `Content-Security-Policy (CSP)`，大部分主流互联网网站（如 GitHub、Google、主流论坛与企业 SaaS）均拒绝在 Iframe 中内嵌渲染，呈现白屏或网络拒绝错误；
   - 历史前端预览难以承担“真实 Web 浏览器”的重任，使得用户体验大打折扣。

**重构决议**：全面废弃 CDP 帧流伪装层与受限 Iframe 方案，下沉至 **Tauri 2 原生子 Webview（Native Child Webview）** 架构。每个浏览标签（Tab）直接由 Tauri 宿主创建原生子 Webview 控件，以绝对坐标贴合挂载在主窗口的 DOM 容器视口中。

### 1.2 为什么需要专属的 IPC 契约与事件流转模型

原生子 Webview 带来了极致的 60/120fps 原生硬件加速、全套 W3C 标准 DOM 支持、原生右键菜单、精确的操作系统级 IME 交互以及与宿主并行的沙箱隔离。但由于原生 Webview 处于操作系统原生视窗层级，与基于 Web 技术的前端 React 视图处于不同坐标系与进程空间，必须建立一套**纳秒级响应、类型强安全、零事件丢失、支持高频节流**的双向通信中枢：

- **上行命令管道（Frontend -> Rust）**：包括 Webview 的按需创建、绝对坐标尺寸同步（Bounds）、显示/隐藏切换、地址导航、历史前进后退、强制刷新与平合销毁。
- **下行事件管道（Rust -> Frontend）**：包括加载状态流转（URL 变更、Title、Favicon、加载进度、前进/后退可用性）、网络与渲染崩溃告警、新窗口拦截路由等。
- **布局防穿帮与节流**：在分栏拖拽（Splitter Dragging）、窗口缩放（Window Resizing）以及面板折叠时，前端每秒可能产生多达 120 次尺寸变化，通信契约必须从协议层保障不造成 IPC 管道积压与原生窗口撕裂。

---

## 二、通信架构拓扑与全景数据流

### 2.1 双向分层交互拓扑

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Frontend (crish-desktop / React)                      │
│                                                                             │
│  ┌─────────────────────────┐             ┌───────────────────────────────┐  │
│  │   UI 层 (PreviewCard)   │             │   useNativeBrowserInstance    │  │
│  └───────────┬─────────────┘             └───────────────▲───────────────┘  │
│              │ 挂载 DOM 容器节点                          │ 响应式状态更新  │
│              ▼                                           │ (URL, Title,  │
│  ┌─────────────────────────┐                             │  Loading...)  │
│  │  NativeBrowserContainer │                             │               │
│  └───────────┬─────────────┘                             │               │
│              │ ResizeObserver / rAF                      │               │
│              ▼                                           │               │
│  ┌───────────────────────────────────────────────────────┴───────────────┐  │
│  │                  NativeBrowserManager (客户端单例)                    │  │
│  │  • 统一管理全局 TabId <-> WebviewInstance 映射                         │  │
│  │  • Bounds 节流合并队列 (rAF 聚合 + 亚像素防抖)                          │  │
│  │  • 事件中心 (Tauri Event 订阅分发至对应 Tab 实例)                      │  │
│  └───────────┬───────────────────────────────────────────▲───────────────┘  │
│              │ invokeTyped                               │ listen            │
└──────────────┼───────────────────────────────────────────┼──────────────────┘
               │ IPC 命令 (Upstream)                       │ 下行事件 (Downstream)
               │ (JSON via IPC transport)                  │ (Tauri Event Bus)
┌──────────────┼───────────────────────────────────────────┼──────────────────┐
│              ▼                                           │                  │
│  ┌─────────────────────────┐             ┌───────────────┴───────────────┐  │
│  │ Command Handlers        │             │ Tauri Emitter Bridge          │  │
│  │ • browser_webview_create│             │ • browser://navigation-state  │  │
│  │ • browser_webview_bounds│             │ • browser://load-error        │  │
│  │ • browser_webview_close │             │ • browser://new-window        │  │
│  └───────────┬─────────────┘             └───────────────▲───────────────┘  │
│              │                                           │                  │
│              ▼                                           │                  │
│  ┌───────────────────────────────────────────────────────┴───────────────┐  │
│  │               NativeWebviewRegistry (Rust 内核状态单例)                │  │
│  │  • `Arc<RwLock<HashMap<TabId, WebviewController>>>`                    │  │
│  │  • 物理像素 DPI 换算 (Logical Rect * ScaleFactor -> Physical Rect)     │  │
│  │  • 平台级 SetWindowPos (SWP_NOZORDER | SWP_NOACTIVATE)                │  │
│  │  • 崩溃与孤儿进程回收器 (Drop Guard + Reaper Guard)                   │  │
│  └───────────┬───────────────────────────────────────────────────────────┘  │
│              │ Tauri 2 Webview API                                          │
│              ▼                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │    Platform Webview Instances (Windows: WebView2 / macOS: WKWebView)   │  │
│  │    [Tab-1 Webview]       [Tab-2 Webview]       [Tab-3 Webview]        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│                           Rust 内核 (src-tauri)                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 坐标系与尺寸映射原理

1. **逻辑像素（Logical CSS Pixels）**：前端 React 通过 `containerRef.current.getBoundingClientRect()` 测算得到的是相对于浏览器视口（即主窗口客户区）的 CSS 逻辑像素坐标。
2. **物理像素（Physical Device Pixels）**：操作系统底层窗口管理器（如 Windows Win32 API `SetWindowPos`、macOS `NSView setFrame:`）接受的是乘上系统缩放因子的物理像素整数。
3. **换算契约（Rust 侧负责）**：前端永远上报 **CSS 逻辑像素浮点数**；Rust 侧通过当前主窗口的 `scale_factor` 实时换算为 `PhysicalRect`，并采用四边各自四舍五入算法防止缝隙，保证跨平台、跨高分屏渲染绝对贴合。

---

## 三、命令面契约详案（IPC Commands）

所有命令均遵循 `command_manifest.rs` 与 `commandManifest.ts` 登记规范，挂载于 `workbench` 家族，契约面定义为 `gui`。

### 3.1 命令面总览与元数据登记

| 命令标识符 | 分组 (Family) | 契约面 (Surface) | 说明 |
| :--- | :--- | :--- | :--- |
| `browser_webview_create` | `workbench` | `gui` | 创建并初始化指定 Tab 的原生子 Webview 实例 |
| `browser_webview_set_bounds` | `workbench` | `gui` | 高频更新指定 Tab 的位置与视口尺寸（带节流保护） |
| `browser_webview_set_visible`| `workbench` | `gui` | 控制 Webview 的可见性（挂起与激活切换） |
| `browser_webview_navigate` | `workbench` | `gui` | 驱动 Webview 导航至目标有效 URL |
| `browser_webview_action` | `workbench` | `gui` | 触发前进、后退、刷新、停止等浏览器标准动作 |
| `browser_webview_close` | `workbench` | `gui` | 安全销毁子 Webview 实例并释放原生系统句柄 |
| `browser_webview_eval` | `workbench` | `gui` | （受限）向目标页面注入执行只读安全脚本 |

---

### 3.2 `browser_webview_create`：子 Webview 创建与参数协商

#### 功能语义
在主窗口内动态构建一个独立的子 Webview 控件，绑定到唯一的 `tab_id`。如果该 `tab_id` 已存在有效实例，则触发幂等校验并更新初始参数，禁止创建重名幽灵控件。

#### Rust 入参及返回类型
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewCreateArgs {
    /// 前端生成的唯一标签页 ID（UUIDv4 或 leaf_id）
    pub tab_id: String,
    /// 初始导航地址（为空则默认 "about:blank"）
    pub initial_url: Option<String>,
    /// 初始逻辑矩形（CSS 像素）
    pub bounds: LogicalRect,
    /// 初始是否可见（通常新建激活 Tab 为 true，后台预热为 false）
    #[serde(default = "default_true")]
    pub visible: bool,
    /// 可选的专用会话分区（隔离 Cookie / Storage；None 为共享默认环境）
    pub data_directory: Option<String>,
    /// 是否开启无头/静音模式（如防止后台标签突然外放音频）
    #[serde(default)]
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewCreateResult {
    pub tab_id: String,
    /// 平台底层分配的子 Webview 原生标识符（便于日志与排查）
    pub native_id: String,
    /// 初始 URL 是否已启动加载
    pub loaded: bool,
}
```

#### TypeScript 契约
```typescript
export interface BrowserWebviewCreateArgs {
  tabId: string;
  initialUrl?: string;
  bounds: LogicalRect;
  visible?: boolean;
  dataDirectory?: string;
  muted?: boolean;
}

export interface BrowserWebviewCreateResult {
  tabId: string;
  nativeId: string;
  loaded: boolean;
}
```

---

### 3.3 `browser_webview_set_bounds`：坐标同步与高频节流管道

#### 功能语义
当主窗口尺寸变化、侧边栏拖动折叠、分屏比例调整时，前端通过该命令将最新的 CSS 逻辑矩形同步给 Rust 内核。

#### 快速连续调用防抖与节流设计
- **前端微任务合并（rAF Throttling）**：前端 `NativeBrowserManager` 挂载 `ResizeObserver`，所有变动被收集入帧队列，在 `requestAnimationFrame` 阶段仅发出最后一帧坐标；
- **亚像素冗余过滤**：若位移与尺寸变动量均小于 0.5px，前端直接丢弃，不发起 IPC 调用；
- **Rust 内核物理去重**：内核计算出物理像素 `(left, top, width, height)` 后，对比当前真实缓存。若物理坐标完全一致，跳过昂贵的底层 `SetWindowPos` 调用；
- **拖拽遮罩策略（Drag Shielding）**：在用户拖拽分栏（Splitter）期间，前端在 DOM 顶层动态铺上全透明遮罩层（`pointer-events: auto`），避免高频鼠标事件穿透到 WebView2 内部造成光标滞后或误选。

#### Rust 类型声明
```rust
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewSetBoundsArgs {
    pub tab_id: String,
    pub bounds: LogicalRect,
}
```

---

### 3.4 `browser_webview_set_visible`：可见性与多 Tab 瞬切状态机

#### 功能语义
当用户在不同 Tab 之间切换，或者折叠右侧协同面板时，控制底层原生 Webview 的可见性。

#### 性能与省电考量
- 当 `visible = false` 时，底层通过 `SetWindowPos(..., SWP_HIDEWINDOW)` 隐藏原生窗口，或将 bounds 设置为 `(0, 0, 0, 0)` 并暂停定时器；
- 避免未激活的后台 Tab 持续争抢 GPU 光栅化资源与渲染引擎管线，将空闲 CPU/GPU 占用降至绝对零；
- 切换回当前 Tab 时，`visible = true` 配合精确 bounds 唤醒，由于内存 DOM 树常驻，呈现 **0 毫秒即时呈现**（无白屏回流）。

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewSetVisibleArgs {
    pub tab_id: String,
    pub visible: bool,
}
```

---

### 3.5 `browser_webview_navigate`：地址导航与协议安全清洗

#### 功能语义
驱动指定 Tab 载入目标 URL。内核严格履行安全基线（Security Baseline）防线，杜绝协议注入漏洞。

#### 安全校验规则（强制）
1. **白名单协议**：仅放行 `http://`、`https://` 与 `about:blank`；
2. **内网与特权协议拦截**：严禁加载 `file://`、`javascript:`、`data:text/html`（防 XSS 逃逸）、`conex://` 或系统级私有协议；
3. **安全清洗**：去除两端控制字符与多余空格，格式不合法时直接在 IPC 层返回 `CoreError::InvalidInput`，不进入底层 Webview。

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewNavigateArgs {
    pub tab_id: String,
    pub url: String,
}
```

---

### 3.6 `browser_webview_action`：标准浏览动作分派

#### 功能语义
向 Webview 发送前进、后退、刷新、停止加载等指令。

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserWebviewActionKind {
    Back,
    Forward,
    Reload,
    ReloadIgnoringCache,
    Stop,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewActionArgs {
    pub tab_id: String,
    pub action: BrowserWebviewActionKind,
}
```

---

### 3.7 `browser_webview_close`：资源释放与句柄安全清理

#### 功能语义
销毁指定 Tab 对应的子 Webview，立刻从宿主窗口剥离、释放系统 HWND/NSView 句柄，并清理 Rust 侧 `NativeWebviewRegistry` 映射表中的所有状态与回调引用。

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewCloseArgs {
    pub tab_id: String,
}
```

---

## 四、事件面下行流详案（Tauri Events 下行管道）

Tauri 下行事件统一通过 `tauri::Emitter` 向主窗口广播。前端通过 `listen<T>` 订阅，并由 `NativeBrowserManager` 按照 `tab_id` 路由分发给具体的 Hook 或卡片组件。

### 4.1 事件通道清单

| 事件通道名 (Channel) | 触发时机 | 负载契约 (Payload) |
| :--- | :--- | :--- |
| `browser://navigation-state` | 页面发生加载、重定向、标题更新、Favicon 发现、历史记录栈变更时 | `BrowserNavigationStatePayload` |
| `browser://load-error` | DNS 解析失败、TLS 证书异常、HTTP 4xx/5xx 严重错误、网络超时等 | `BrowserLoadErrorPayload` |
| `browser://new-window` | 网页点击 `target="_blank"` 或执行 `window.open` 时触发拦截 | `BrowserNewWindowPayload` |
| `browser://crashed` | 底层渲染进程（Render Process）崩溃或被系统 OOM 终止时 | `BrowserCrashedPayload` |

---

### 4.2 `browser://navigation-state`：细粒度导航状态广播

#### 设计目标
前端工具栏的后退/前进按钮激活状态、刷新状态图标动画、地址栏反显当前真实 URL、Tab 标签的标题与 Favicon 均由此单一状态载荷驱动（SSOT 保证），杜绝前端与底层 Webview 出现状态不同步。

#### Rust Payload 结构
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationStatePayload {
    /// 标签页唯一标识
    pub tab_id: String,
    /// 当前所处的真实绝对 URL
    pub url: String,
    /// 网页当前文档标题 (<title>)
    pub title: String,
    /// 历史记录是否可后退
    pub can_go_back: bool,
    /// 历史记录是否可前进
    pub can_go_forward: bool,
    /// 是否正处于网络加载或 DOM 解析状态
    pub is_loading: bool,
    /// 页面 Favicon 图标 URL（可能为 data: URI 或 http/https 地址）
    pub favicon_url: Option<String>,
    /// HTTP 状态码（若已知，例如 200, 404, 500）
    pub http_status: Option<u16>,
}
```

---

### 4.3 `browser://load-error`：网络与渲染加载失败拦截

#### 设计目标
当页面因断网、域名不存在（ERR_NAME_NOT_RESOLVED）、SSL 握手失败等原因无法渲染时，通知前端展示优雅的原生错误占位卡，而非浏览器灰底默认报错，提升产品品质。

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLoadErrorPayload {
    pub tab_id: String,
    pub url: String,
    /// 平台错误码（如 Chromium net error code: -105）
    pub error_code: i32,
    /// 人类可读错误描述（如 "ERR_INTERNET_DISCONNECTED"）
    pub error_message: String,
    /// 是否为主框架（Main Frame）错误；子 iframe 失败通常不应中断主界面
    pub is_main_frame: bool,
}
```

---

### 4.4 `browser://new-window`：弹窗拦截与新标签路由策略

#### 设计目标
当网页内部触发 `window.open` 或 `<a target="_blank">` 时，默认若不加干预会弹出操作系统独立无边框窗口，破坏 Conex 的多 Tab 协同工作流。通过该事件将弹窗行为转变为在前端新建 Tab 或在当前 Tab 导航。

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NewWindowDisposition {
    /// 在新前台 Tab 中打开（默认）
    NewForegroundTab,
    /// 在新后台 Tab 中静默打开
    NewBackgroundTab,
    /// 在当前 Tab 直接接管打开
    CurrentTab,
    /// 丢弃或被策略拦截
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNewWindowPayload {
    pub source_tab_id: String,
    pub target_url: String,
    pub disposition: NewWindowDisposition,
    /// 是否由直接用户手势（如点击鼠标）触发
    pub user_gesture: bool,
}
```

---

### 4.5 `browser://crashed`：内核异常与崩溃可观测性

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCrashedPayload {
    pub tab_id: String,
    /// 崩溃原因（如 "OOM" / "GpuProcessLost" / "RenderProcessKilled" / "Unknown"）
    pub reason: String,
    pub exit_code: Option<i32>,
}
```

---

## 五、完整代码定义（Rust & TypeScript Code Artifacts）

### 5.1 Rust 侧完整数据契约（`src-tauri/src/browser_ipc.rs`）

```rust
//! 原生多 Webview 浏览器 IPC 数据契约与命令面实现
//!
//! 统一提供类型安全的请求入参、事件 Payload 与错误映射。

use conex_run::core_error::CoreError;
use serde::{Deserialize, Serialize};

/// 逻辑尺寸（CSS 像素，相对视口）
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl LogicalRect {
    pub const ZERO: Self = Self {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    };

    /// 校验数值合法性，防止 NaN 或无穷大进入系统调用
    pub fn is_valid(&self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width >= 0.0
            && self.height >= 0.0
    }
}

// ==========================================
// 1. 命令入参与出参定义
// ==========================================

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewCreateResult {
    pub tab_id: String,
    pub native_id: String,
    pub loaded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewSetBoundsArgs {
    pub tab_id: String,
    pub bounds: LogicalRect,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewSetVisibleArgs {
    pub tab_id: String,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewNavigateArgs {
    pub tab_id: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserWebviewActionKind {
    Back,
    Forward,
    Reload,
    ReloadIgnoringCache,
    Stop,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewActionArgs {
    pub tab_id: String,
    pub action: BrowserWebviewActionKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewCloseArgs {
    pub tab_id: String,
}

// ==========================================
// 2. 下行事件 Payload 定义
// ==========================================

pub const EVENT_BROWSER_NAVIGATION_STATE: &str = "browser://navigation-state";
pub const EVENT_BROWSER_LOAD_ERROR: &str = "browser://load-error";
pub const EVENT_BROWSER_NEW_WINDOW: &str = "browser://new-window";
pub const EVENT_BROWSER_CRASHED: &str = "browser://crashed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationStatePayload {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub is_loading: bool,
    pub favicon_url: Option<String>,
    pub http_status: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLoadErrorPayload {
    pub tab_id: String,
    pub url: String,
    pub error_code: i32,
    pub error_message: String,
    pub is_main_frame: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NewWindowDisposition {
    NewForegroundTab,
    NewBackgroundTab,
    CurrentTab,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNewWindowPayload {
    pub source_tab_id: String,
    pub target_url: String,
    pub disposition: NewWindowDisposition,
    pub user_gesture: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCrashedPayload {
    pub tab_id: String,
    pub reason: String,
    pub exit_code: Option<i32>,
}
```

---

### 5.2 TypeScript 声明契约（`apps/crish-desktop/src/api/nativeBrowserContract.ts`）

```typescript
/**
 * 原生多 Webview 浏览器 IPC 契约定义。
 * 双端镜像对齐 Rust `src-tauri/src/browser_ipc.rs`。
 */

export interface LogicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserWebviewCreateArgs {
  tabId: string;
  initialUrl?: string;
  bounds: LogicalRect;
  visible?: boolean;
  dataDirectory?: string;
  muted?: boolean;
}

export interface BrowserWebviewCreateResult {
  tabId: string;
  nativeId: string;
  loaded: boolean;
}

export interface BrowserWebviewSetBoundsArgs {
  tabId: string;
  bounds: LogicalRect;
}

export interface BrowserWebviewSetVisibleArgs {
  tabId: string;
  visible: boolean;
}

export interface BrowserWebviewNavigateArgs {
  tabId: string;
  url: string;
}

export type BrowserWebviewActionKind =
  | 'back'
  | 'forward'
  | 'reload'
  | 'reload_ignoring_cache'
  | 'stop';

export interface BrowserWebviewActionArgs {
  tabId: string;
  action: BrowserWebviewActionKind;
}

export interface BrowserWebviewCloseArgs {
  tabId: string;
}

// ──────────────────────────────────────────
// 下行事件载荷（Downstream Event Payloads）
// ──────────────────────────────────────────

export const BROWSER_NAVIGATION_STATE_EVENT = 'browser://navigation-state';
export const BROWSER_LOAD_ERROR_EVENT = 'browser://load-error';
export const BROWSER_NEW_WINDOW_EVENT = 'browser://new-window';
export const BROWSER_CRASHED_EVENT = 'browser://crashed';

export interface BrowserNavigationStatePayload {
  tabId: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  faviconUrl?: string;
  httpStatus?: number;
}

export interface BrowserLoadErrorPayload {
  tabId: string;
  url: string;
  errorCode: number;
  errorMessage: string;
  isMainFrame: boolean;
}

export type NewWindowDisposition =
  | 'new_foreground_tab'
  | 'new_background_tab'
  | 'current_tab'
  | 'blocked';

export interface BrowserNewWindowPayload {
  sourceTabId: string;
  targetUrl: string;
  disposition: NewWindowDisposition;
  userGesture: boolean;
}

export interface BrowserCrashedPayload {
  tabId: string;
  reason: string;
  exitCode?: number;
}
```

---

## 六、高性能坐标同步与渲染层防穿帮策略

### 6.1 坐标同步瓶颈剖析

在现代多分屏与响应式 IDE 桌面端中，引起 Webview 坐标变动的场景极其频繁：
1. **分屏 Splitter 持续拖拽**：鼠标移动事件每秒触发 60~120 次；
2. **窗口整体 Resize**：操作系统触发密集 WM_SIZE / NSWindowDidResizeNotification；
3. **右侧协同面板折叠/展开**：CSS 过渡动画持续 200ms~300ms，每帧都在变动。

若每次 DOM 变化均直接序列化 JSON 并发起 IPC `browser_webview_set_bounds`，会导致：
- IPC 管道高频排队堵塞；
- Windows 底层 `SetWindowPos` 造成 WebView2 渲染宿主句柄反复重绘，界面严重掉帧、产生黑边与白边拉扯。

### 6.2 综合优化策略三部曲

```
┌────────────────────────────────────────────────────────────────────────┐
│                        前端高性能 Bounds 过滤管线                        │
├────────────────────────────────────────────────────────────────────────┤
│ 1. ResizeObserver 监听 DOM 容器变化                                    │
│       │                                                                │
│       ▼                                                                │
│ 2. 亚像素防抖校验：|Δx| < 0.5 && |Δy| < 0.5 && |Δw| < 0.5 && |Δh| < 0.5 │
│    ├── 是 ──> 丢弃本轮上报                                              │
│    └── 否 ──> 标记 dirty，记录最新 targetBounds                        │
│       │                                                                │
│       ▼                                                                │
│ 3. rAF (requestAnimationFrame) 聚合                                    │
│    在当前屏幕刷新垂直同步信号时，仅抽取队列中最后一份有效 Rect                │
│       │                                                                │
│       ▼                                                                │
│ 4. 发起一次 invokeTyped('browser_webview_set_bounds', ...)              │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Rust 内核原子过滤管线                            │
├────────────────────────────────────────────────────────────────────────┤
│ 1. 读取当前主窗口 scale_factor (如 1.25 / 1.5 / 2.0)                   │
│ 2. 四边四舍五入换算物理坐标：left = round(x * s), width = round(w * s)   │
│ 3. 对比上一帧 PhysicalRect：                                           │
│    ├── 物理坐标完全相同 ──> Ok(()) 立即返回，不调系统 API                 │
│    └── 物理坐标改变 ──> 调原生 API:                                     │
│         SetWindowPos(hwnd, NULL, left, top, width, height,             │
│                      SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)│
└────────────────────────────────────────────────────────────────────────┘
```

### 6.3 拖拽遮罩机制（Splitter Drag Shield）

当用户用鼠标拖拽分屏调节手柄（Splitter）经过原生 Webview 上方时，原生控件的 Win32 HWND 默认会截获全局鼠标命中测试（`WM_NCHITTEST`），导致主窗口的前端 DOM 失去 `mousemove` 事件跟踪，出现“拖拽丢帧、卡死停滞”。

**解决方案**：
在用户按下 Splitter 开始拖拽（`onPointerDown`）时，前端全局广播激活一个全屏透明遮罩 `<div className="split-drag-shield" />`（`z-index: 99999; pointer-events: auto;`）。
- 遮罩层在 DOM 上捕获全局鼠标移动，保证拖拽流畅稳定；
- 拖拽松手（`onPointerUp`）后移除遮罩，最后同步一次 Webview 的终态精确 Bounds。

---

## 七、TypeScript 客户端封装与 React Hook 适配

### 7.1 底层 API 调用包装（`apps/crish-desktop/src/api/nativeBrowserApi.ts`）

```typescript
import { invokeTyped } from './tauriInvoke';
import type { InvokeTypedResult } from './tauriInvoke';
import type {
  BrowserWebviewCreateArgs,
  BrowserWebviewCreateResult,
  BrowserWebviewSetBoundsArgs,
  BrowserWebviewSetVisibleArgs,
  BrowserWebviewNavigateArgs,
  BrowserWebviewActionArgs,
  BrowserWebviewCloseArgs,
  BrowserWebviewActionKind,
  LogicalRect,
} from './nativeBrowserContract';

export async function nativeWebviewCreate(
  args: BrowserWebviewCreateArgs
): Promise<InvokeTypedResult<BrowserWebviewCreateResult>> {
  return invokeTyped<BrowserWebviewCreateResult>('browser_webview_create', args as unknown as Record<string, unknown>);
}

export async function nativeWebviewSetBounds(
  tabId: string,
  bounds: LogicalRect
): Promise<InvokeTypedResult<void>> {
  const args: BrowserWebviewSetBoundsArgs = { tabId, bounds };
  return invokeTyped<void>('browser_webview_set_bounds', args as unknown as Record<string, unknown>);
}

export async function nativeWebviewSetVisible(
  tabId: string,
  visible: boolean
): Promise<InvokeTypedResult<void>> {
  const args: BrowserWebviewSetVisibleArgs = { tabId, visible };
  return invokeTyped<void>('browser_webview_set_visible', args as unknown as Record<string, unknown>);
}

export async function nativeWebviewNavigate(
  tabId: string,
  url: string
): Promise<InvokeTypedResult<void>> {
  const args: BrowserWebviewNavigateArgs = { tabId, url };
  return invokeTyped<void>('browser_webview_navigate', args as unknown as Record<string, unknown>);
}

export async function nativeWebviewAction(
  tabId: string,
  action: BrowserWebviewActionKind
): Promise<InvokeTypedResult<void>> {
  const args: BrowserWebviewActionArgs = { tabId, action };
  return invokeTyped<void>('browser_webview_action', args as unknown as Record<string, unknown>);
}

export async function nativeWebviewClose(
  tabId: string
): Promise<InvokeTypedResult<void>> {
  const args: BrowserWebviewCloseArgs = { tabId };
  return invokeTyped<void>('browser_webview_close', args as unknown as Record<string, unknown>);
}
```

---

### 7.2 前端单例管理器（`NativeBrowserManager.ts`）

```typescript
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  BROWSER_NAVIGATION_STATE_EVENT,
  BROWSER_LOAD_ERROR_EVENT,
  BROWSER_NEW_WINDOW_EVENT,
  BROWSER_CRASHED_EVENT,
  type BrowserNavigationStatePayload,
  type BrowserLoadErrorPayload,
  type BrowserNewWindowPayload,
  type BrowserCrashedPayload,
  type LogicalRect,
} from './nativeBrowserContract';
import { nativeWebviewSetBounds } from './nativeBrowserApi';

type NavListener = (payload: BrowserNavigationStatePayload) => void;
type ErrorListener = (payload: BrowserLoadErrorPayload) => void;
type NewWindowListener = (payload: BrowserNewWindowPayload) => void;
type CrashListener = (payload: BrowserCrashedPayload) => void;

class NativeBrowserManager {
  private static instance: NativeBrowserManager;
  private navListeners = new Map<string, Set<NavListener>>();
  private errorListeners = new Map<string, Set<ErrorListener>>();
  private newWindowListeners = new Map<string, Set<NewWindowListener>>();
  private crashListeners = new Map<string, Set<CrashListener>>();

  private boundsQueue = new Map<string, LogicalRect>();
  private lastReportedBounds = new Map<string, LogicalRect>();
  private rafId: number | null = null;
  private unlisteners: UnlistenFn[] = [];
  private initialized = false;

  public static get(): NativeBrowserManager {
    if (!NativeBrowserManager.instance) {
      NativeBrowserManager.instance = new NativeBrowserManager();
    }
    return NativeBrowserManager.instance;
  }

  public async init(): Promise<void> {
    if (this.initialized || typeof window === 'undefined') return;
    this.initialized = true;

    this.unlisteners.push(
      await listen<BrowserNavigationStatePayload>(
        BROWSER_NAVIGATION_STATE_EVENT,
        (ev) => {
          const listeners = this.navListeners.get(ev.payload.tabId);
          listeners?.forEach((fn) => fn(ev.payload));
        }
      )
    );

    this.unlisteners.push(
      await listen<BrowserLoadErrorPayload>(
        BROWSER_LOAD_ERROR_EVENT,
        (ev) => {
          const listeners = this.errorListeners.get(ev.payload.tabId);
          listeners?.forEach((fn) => fn(ev.payload));
        }
      )
    );

    this.unlisteners.push(
      await listen<BrowserNewWindowPayload>(
        BROWSER_NEW_WINDOW_EVENT,
        (ev) => {
          const listeners = this.newWindowListeners.get(ev.payload.sourceTabId);
          listeners?.forEach((fn) => fn(ev.payload));
        }
      )
    );

    this.unlisteners.push(
      await listen<BrowserCrashedPayload>(
        BROWSER_CRASHED_EVENT,
        (ev) => {
          const listeners = this.crashListeners.get(ev.payload.tabId);
          listeners?.forEach((fn) => fn(ev.payload));
        }
      )
    );
  }

  public updateBounds(tabId: string, bounds: LogicalRect): void {
    const prev = this.lastReportedBounds.get(tabId);
    if (
      prev &&
      Math.abs(prev.x - bounds.x) < 0.5 &&
      Math.abs(prev.y - bounds.y) < 0.5 &&
      Math.abs(prev.width - bounds.width) < 0.5 &&
      Math.abs(prev.height - bounds.height) < 0.5
    ) {
      return;
    }

    this.boundsQueue.set(tabId, bounds);
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => this.flushBounds());
    }
  }

  private flushBounds(): void {
    this.rafId = null;
    for (const [tabId, bounds] of this.boundsQueue.entries()) {
      this.lastReportedBounds.set(tabId, bounds);
      nativeWebviewSetBounds(tabId, bounds).catch(() => {});
    }
    this.boundsQueue.clear();
  }

  public subscribeNavigation(tabId: string, fn: NavListener): () => void {
    if (!this.navListeners.has(tabId)) {
      this.navListeners.set(tabId, new Set());
    }
    this.navListeners.get(tabId)!.add(fn);
    return () => this.navListeners.get(tabId)?.delete(fn);
  }

  public subscribeError(tabId: string, fn: ErrorListener): () => void {
    if (!this.errorListeners.has(tabId)) {
      this.errorListeners.set(tabId, new Set());
    }
    this.errorListeners.get(tabId)!.add(fn);
    return () => this.errorListeners.get(tabId)?.delete(fn);
  }

  public subscribeCrash(tabId: string, fn: CrashListener): () => void {
    if (!this.crashListeners.has(tabId)) {
      this.crashListeners.set(tabId, new Set());
    }
    this.crashListeners.get(tabId)!.add(fn);
    return () => this.crashListeners.get(tabId)?.delete(fn);
  }

  public unregisterTab(tabId: string): void {
    this.navListeners.delete(tabId);
    this.errorListeners.delete(tabId);
    this.newWindowListeners.delete(tabId);
    this.crashListeners.delete(tabId);
    this.boundsQueue.delete(tabId);
    this.lastReportedBounds.delete(tabId);
  }
}

export const nativeBrowserManager = NativeBrowserManager.get();
```

---

### 7.3 React Hook：`useNativeBrowserInstance(tabId, options)`

该 Hook 封装了原生 Webview 的完整生命周期管理，提供与现有 `usePreviewNavigation` 高度一致的 API 界面，使得老代码无需改动 UI 层逻辑即可平滑迁移。

```typescript
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  nativeWebviewCreate,
  nativeWebviewSetVisible,
  nativeWebviewNavigate,
  nativeWebviewAction,
  nativeWebviewClose,
} from './nativeBrowserApi';
import { nativeBrowserManager } from './NativeBrowserManager';
import type { LogicalRect } from './nativeBrowserContract';

export interface UseNativeBrowserOptions {
  tabId: string;
  initialUrl?: string;
  active?: boolean;
}

export interface UseNativeBrowserResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  urlInput: string;
  setUrlInput: (v: string) => void;
  activeUrl: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  faviconUrl?: string;
  loadError: string | null;
  isCrashed: boolean;
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
}

export function useNativeBrowserInstance(
  opts: UseNativeBrowserOptions
): UseNativeBrowserResult {
  const { tabId, initialUrl = 'about:blank', active = true } = opts;
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [urlInput, setUrlInput] = useState(initialUrl);
  const [activeUrl, setActiveUrl] = useState(initialUrl);
  const [title, setTitle] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [faviconUrl, setFaviconUrl] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isCrashed, setIsCrashed] = useState(false);

  // 1. 初始化 NativeBrowserManager 全局事件
  useEffect(() => {
    nativeBrowserManager.init().catch(console.error);
  }, []);

  // 2. 挂载子 Webview 实例
  useEffect(() => {
    let unmounted = false;
    const dom = containerRef.current;
    const initialBounds: LogicalRect = dom
      ? {
          x: dom.getBoundingClientRect().left,
          y: dom.getBoundingClientRect().top,
          width: dom.getBoundingClientRect().width,
          height: dom.getBoundingClientRect().height,
        }
      : { x: 0, y: 0, width: 0, height: 0 };

    nativeWebviewCreate({
      tabId,
      initialUrl,
      bounds: initialBounds,
      visible: active,
    }).catch((err) => {
      if (!unmounted) console.error(`[NativeBrowser] Create failed:`, err);
    });

    return () => {
      unmounted = true;
      nativeWebviewClose(tabId).catch(() => {});
      nativeBrowserManager.unregisterTab(tabId);
    };
  }, [tabId]);

  // 3. 动态同步可见性
  useEffect(() => {
    nativeWebviewSetVisible(tabId, active).catch(() => {});
  }, [tabId, active]);

  // 4. 监听 DOM 容器 Bounds 变化并推入节流管道
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !active) return;

    const observer = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      nativeBrowserManager.updateBounds(tabId, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [tabId, active]);

  // 5. 订阅下行状态事件
  useEffect(() => {
    const unsubNav = nativeBrowserManager.subscribeNavigation(tabId, (state) => {
      setActiveUrl(state.url);
      setUrlInput(state.url);
      setTitle(state.title);
      setCanGoBack(state.canGoBack);
      setCanGoForward(state.canGoForward);
      setIsLoading(state.isLoading);
      setFaviconUrl(state.faviconUrl);
      setLoadError(null);
    });

    const unsubErr = nativeBrowserManager.subscribeError(tabId, (err) => {
      setIsLoading(false);
      setLoadError(`${err.errorMessage} (${err.errorCode})`);
    });

    const unsubCrash = nativeBrowserManager.subscribeCrash(tabId, (crash) => {
      setIsCrashed(true);
      setIsLoading(false);
      setLoadError(`渲染进程已崩溃: ${crash.reason}`);
    });

    return () => {
      unsubNav();
      unsubErr();
      unsubCrash();
    };
  }, [tabId]);

  // 6. 操作动作封装
  const navigate = useCallback(
    (url: string) => {
      setLoadError(null);
      setIsCrashed(false);
      nativeWebviewNavigate(tabId, url).catch((e) => {
        setLoadError(e.message || '导航失败');
      });
    },
    [tabId]
  );

  const goBack = useCallback(() => {
    nativeWebviewAction(tabId, 'back').catch(() => {});
  }, [tabId]);

  const goForward = useCallback(() => {
    nativeWebviewAction(tabId, 'forward').catch(() => {});
  }, [tabId]);

  const reload = useCallback(() => {
    setLoadError(null);
    setIsCrashed(false);
    nativeWebviewAction(tabId, 'reload').catch(() => {});
  }, [tabId]);

  const stop = useCallback(() => {
    nativeWebviewAction(tabId, 'stop').catch(() => {});
  }, [tabId]);

  return {
    containerRef,
    urlInput,
    setUrlInput,
    activeUrl,
    title,
    isLoading,
    canGoBack,
    canGoForward,
    faviconUrl,
    loadError,
    isCrashed,
    navigate,
    goBack,
    goForward,
    reload,
    stop,
  };
}
```

---

## 八、异常边界与生命周期安全

### 8.1 Webview 崩溃（Crash）与健康自愈机制

在 Windows 平台，WebView2 底层的 `msedgewebview2.exe` 是独立渲染进程。若因宿主系统内存吃紧（OOM）、显卡驱动崩溃（GPU Process Hang）或恶意网页执行非法指令，可能发生 `CoreWebView2ProcessFailed` 事件。

#### 恢复协议设计
1. **Rust 事件捕获**：Rust 监听 WebView2 的 `ProcessFailed` 事件；
2. **广播下行通知**：向前端广播 `browser://crashed`，负载包含 `reason`（如 `ExitCode`、`ProcessFailedKind`）；
3. **前端呈现就绪态**：前端在页面上展示“渲染进程意外终止”提示卡片，提供【原地重新载入】按钮；
4. **自愈热重载（Auto Recovery）**：当用户点击重新载入，前端先调用 `browser_webview_create`（复用原 `tab_id` 与最后的 `activeUrl`），在底层重新唤醒渲染管线，实现原地无损恢复。

### 8.2 宿主窗口关闭与叶子标签销毁的防泄漏保证（RAII 铁律）

多 Webview 最易产生的系统隐患是**句柄泄漏（Handle Leak）与僵尸 Webview（Zombie Webview）**：
- 用户在前端关闭了一个分屏预览 Tab，如果只清理了 React DOM，原生 Webview 依然隐藏在背后持续消耗内存与网络；
- 用户直接关闭主窗口退出软件，后台子 Webview 未能正常析构。

#### 严密保障措施
1. **React 组件卸载绑定析构**：`useNativeBrowserInstance` 的 `useEffect` cleanup 钩子强制调用 `nativeWebviewClose(tabId)`，做到前端组件离场、原生实例即刻消亡；
2. **Rust RAII Drop Guard**：
   ```rust
   pub struct WebviewController {
       pub tab_id: String,
       pub webview: tauri::Webview,
   }

   impl Drop for WebviewController {
       fn drop(&mut self) {
           tracing::info!(tab_id = %self.tab_id, "释放原生子 Webview 实例与系统资源");
           let _ = self.webview.close();
       }
   }
   ```
3. **主窗口关闭事件联动（Window Destroyed Hook）**：
   在 `main.rs` 的 `on_window_event` 中监听 `WindowEvent::Destroyed`，一旦主窗口被关闭，遍历清理 `NativeWebviewRegistry` 中的全量子 Webview，从系统层面 100% 阻断僵尸句柄残留。

---

## 九、验证方案与全量质量门禁

为确保重构后的原生通信契约零漂移、零退化，设计以下立体化验证防护网：

### 9.1 双端契约一致性测试（Contract Drift Test）
- 在 `command_manifest.rs` 中登记 6 个 `browser_webview_*` 命令；
- 前端 `commandManifest.test.ts` 进行双向镜像对照断言，校验名称、家族与契约面一致；
- Rust 侧运行 `cargo test --test manifest_tests`，防止幽灵命令或遗漏注册。

### 9.2 高频 Bounds 压力测试
- 模拟 Splitter 拖拽：以 120Hz 频率在 5 秒内连续派发 600 次 Bounds 变更；
- 断言：前端 `flushBounds` 聚合后发出的 IPC 调用次数应严格控制在刷新率内（约 60 次以内），CPU 占用稳定低于 2%，无未捕获异常。

### 9.3 验收执行命令集

```bash
# 1. 严格 TypeScript 类型检查（验证新增 Contract 与 Hook 类型定义）
npm run typecheck

# 2. 前端行数门禁扫描（确保新加文件符合行数规范）
node scripts/check-line-counts.mjs --all

# 3. 循环依赖检测（确保无逆向引用）
npx madge --circular --extensions ts,tsx apps/crish-desktop/src

# 4. 双端命令清单一致性与单元测试
npm run test:coverage -- --project=unit
```

---

## 十、总结与结论

本契约设计彻底告别了旧式 Canvas 截图投屏的过度设计，基于 Tauri 2 多 Webview 原生能力，制定了严格类型安全、纳秒级响应、防抖合并与健全容灾的 IPC 通信规范：
1. **命令面**：提供统一语义的 6 大核心命令，覆盖生命周期、高频 Bounds、可见性及标准浏览控制；
2. **事件面**：建立状态单一真源（SSOT）的下行事件流，精准驱动 UI 响应；
3. **前端封装**：提供与现有 `usePreviewNavigation` 无缝适配的 `useNativeBrowserInstance` Hook，保障平滑重构。
该规范作为后续 Rust 引擎实现与前端组件接线的强制遵循基线。
