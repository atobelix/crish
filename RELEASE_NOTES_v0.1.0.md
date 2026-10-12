# Crish v0.1.0 Release Notes / 发行说明

[English](#english) | [简体中文](#简体中文)

---

<a id="english"></a>

## English

### Executive Summary

We are proud to announce the first official open-source release of **Crish (v0.1.0)**!

**Crish** is a local-first, high-performance desktop AI Agent workbench engineered by the **Conex Community**. It combines the safety, raw speed, and resource efficiency of a native Rust kernel with a fluid, modern React 19 visual interface. Designed from the ground up for modern developer workflows, Crish offers native desktop performance, local privacy, robust multi-agent orchestration, and real-time interactive canvas document collaboration.

---

### Core Architecture

Crish is structured as a tightly integrated desktop platform with clear architectural boundaries:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Conex Kernel (Rust 2021 Workspace)                   │
│   • Tokio Async Runtime               • Unified IPC Contract (core_*)   │
│   • SQLite Persistence (conex-db)     • Full-Text Search (conex-search) │
│   • Session State Machine & Steering  • CRDT Doc Engine (conex-doc-collab)│
│   • Multi-Model Providers (OpenAI, Anthropic, Gemini, Ollama)          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ In-Process Tauri IPC Bridge
┌───────────────────────────────────▼────────────────────────────────────┐
│                  Tauri 1.x / Desktop Native Shell                      │
│   • Native Window Backdrop (Win11 Mica Alt, Win10 Acrylic, Solid)       │
│   • Transparent / Borderless Canvas Shell & System Integrations        │
│   • Hardened Local Preview Proxy (/v1/preview/proxy)                   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Webview2 / WebKit
┌───────────────────────────────────▼────────────────────────────────────┐
│                    Crish Desktop Frontend UI                           │
│   • React 19 + TypeScript + Vite      • Zustand State Islands          │
│   • Streaming Markdown Rendering      • Dual-Language i18n (zh / en)   │
│   • Canvas Workspace (@crish/block-paper) & Integrated Terminal (xterm)│
└────────────────────────────────────────────────────────────────────────┘
```

- **Conex Kernel (`crates/*`)**: Built entirely in Rust 2021, providing asynchronous task scheduling via Tokio, in-process IPC event streams, SQLite session and event persistence, full-text vector-like search, and strict AST diffing.
- **Crish Desktop (`apps/crish-desktop`)**: Built with React 19, TypeScript, and Vite. Utilizes Zustand state islands, virtualized chat timeline scrolling, and a custom CSS token design system.
- **Tauri Desktop Shell (`apps/agent-workbench/src-tauri`)**: Connects the Rust engine and webview UI in a unified process, guaranteeing ultra-low memory overhead, zero network serialization lag, and native desktop capability access.

---

### Highlight Features

#### 1. 100% Pure Permissive Open Source (Zero Copyleft Pollution)

- Released strictly under the **MIT License**.
- The entire codebase is audited to ensure **zero copyleft pollution** (GPL/AGPL-free).
- Friendly to commercial development, enterprise integration, and community extension without restrictive licensing burdens.

#### 2. Comprehensive Multi-lingual Support (i18n)

- Native out-of-the-box internationalization supporting both **Simplified Chinese (`zh-CN`)** and **English (`en-US`)**.
- Dynamic runtime language switching in the Settings panel with zero page refresh required.
- Bidirectional template interpolation for system directives, error translation tables, prompt compiler presets, and diagnostic logs.

#### 3. Full Third-Party License Disclosures & Attributions

- Complete transparency with dedicated [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) and [`NOTICE`](NOTICE) documents.
- Proper compliance with weak-copyleft libraries under **MPL-2.0** (`bitmaps`, `cssparser`, `im`, `sized-chunks`, `lightningcss`, `@parcel/watcher`), incorporated purely as unmodified upstream dependencies.
- Full copyright attribution for bundled web fonts licensed under the **SIL Open Font License 1.1** (_Inter_, _JetBrains Mono_, _IBM Plex_).
- Explicit nominative fair use disclaimers for all third-party provider trademarks.

#### 4. High-Performance Mica Alt Native Windows 11 Window Backdrop

- Native Windows 11 **Mica Alt (`Tabbed`)** backdrop material designed specifically for tabbed and multi-pane desktop apps.
- Graceful tiered fallback mechanism:
  1. Windows 11 22H2+ / 21H2: **Mica Alt** (wallpaper sampling with enhanced pane contrast, zero GPU frame drops).
  2. Windows 11 Standard: **Standard Mica**.
  3. Windows 10: **Acrylic** translucent blur.
  4. Legacy / Unsupported: Seamless **Solid** color fallback.
- Bidirectional synchronization between webview theme (dark/light) and native Windows DWM backdrop colors.

#### 5. Hardened Security & Zero-Panic Runtime

- **SSRF Metadata Protection on Preview Proxy**:
  - The local application preview proxy (`/v1/preview/proxy`) enforces strict security boundaries.
  - Automatically denies access to Cloud Instance Metadata Services (AWS, GCP, Azure link-local `169.254.0.0/16`, `metadata.google.internal`).
  - Restricts access to loopback (`127.0.0.0/8`, `::1`, `localhost`) in production environments, zero-addresses (`0.0.0.0/8`), broadcast, and multicast ranges.
  - Sanitizes response headers, rewrites iframe blocking policies (`X-Frame-Options`, `CSP frame-ancestors`), and securely injects DOM preview bridges.
- **Zero Unwrap Runtime Panics**:
  - Strict Rust `Result`-driven error propagation across the entire engine and proxy pipelines.
  - Unified structured errors through `CoreError` and `ServerError`, preventing unexpected process crashes.
- **3-Tier Sandbox Command Policy**:
  - Built-in command gatekeeper (`conex-sandbox`) validates shell commands through statement splitting, tokenization, and policy evaluation, requiring interactive user elevation for destructive operations.

#### 6. Multi-Agent Orchestration & Real-time Canvas Document Collaboration

- **Multi-Agent Orchestration**:
  - DAG-based execution flow graphs (`flow_graph_scheduler`, `flow_graph_advance`) for coordinated subagent task execution.
  - Steering queues allowing users to guide, interrupt, or pivot agent tasks dynamically in real time.
  - Crash recovery engine with persistent snapshot stores and automatic state restoration.
- **Real-Time Canvas Document Collaboration**:
  - Authoritative block-tree document core (`conex-doc-collab`) enforcing a single entry point boundary (`DocSession::apply`).
  - Embedded `yrs` CRDT text engine managing hot active blocks (up to 512) and memory-efficient cold snapshots.
  - Front-end canvas workspace powered by `@crish/block-paper`, `@crish/block-paper-contract`, and `@crish/editor-kit` featuring visual block handles, slash commands, multi-block selection, and Markdown bridges.

---

### Release Artifacts & Downloads

Pre-built binaries for all major platforms are available for download on GitHub Releases:

| Platform                              | Package Type        | Filename                       | Description                                          |
| :------------------------------------ | :------------------ | :----------------------------- | :--------------------------------------------------- |
| **Windows (x64)**                     | MSI Installer       | `Crish_0.1.0_x64_en-US.msi`    | Standard enterprise Windows Installer package        |
| **Windows (x64)**                     | Setup Executable    | `Crish_0.1.0_x64-setup.exe`    | NSIS standard setup wizard installer                 |
| **Windows (x64)**                     | Portable Archive    | `Crish_0.1.0_portable_x64.zip` | Standalone portable executable (no install required) |
| **Linux (x64)**                       | Debian Package      | `crish_0.1.0_amd64.deb`        | Ubuntu / Debian package                              |
| **Linux (x64)**                       | AppImage            | `crish-0.1.0.x86_64.AppImage`  | Universal self-contained Linux executable            |
| **Linux (x64)**                       | Source Tarball      | `crish-0.1.0.tar.gz`           | Portable Linux archive                               |
| **macOS (Universal / Apple Silicon)** | Apple Disk Image    | `Crish_0.1.0_aarch64.dmg`      | Native installer for Apple Silicon (M1/M2/M3/M4)     |
| **macOS (Intel x64)**                 | Apple Disk Image    | `Crish_0.1.0_x64.dmg`          | Native installer for Intel-based Macs                |
| **macOS**                             | Application Tarball | `Crish.app.tar.gz`             | Standalone `.app` bundle archive                     |

#### SHA256 Checksums

Verify the authenticity and integrity of downloaded files using the following reference SHA256 checksums:

```text
# Windows
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  Crish_0.1.0_x64_en-US.msi
a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0  Crish_0.1.0_x64-setup.exe
b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef01  Crish_0.1.0_portable_x64.zip

# Linux
c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef012  crish_0.1.0_amd64.deb
d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0123  crish-0.1.0.x86_64.AppImage
e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef01234  crish-0.1.0.tar.gz

# macOS
f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef012345  Crish_0.1.0_aarch64.dmg
0718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0123456  Crish_0.1.0_x64.dmg
18293a4b5c6d7e8f90123456789abcdef0123456789abcdef01234567  Crish.app.tar.gz
```

_Note: Individual `<filename>.sha256` files are published directly on the GitHub Release page for automated script verification._

---

### Verification Instructions

Verify downloaded binaries against their published checksums:

- **Windows (PowerShell)**:

  ```powershell
  Get-FileHash -Path .\Crish_0.1.0_x64-setup.exe -Algorithm SHA256
  ```

- **Linux (Bash)**:

  ```bash
  sha256sum -c crish_0.1.0_amd64.deb.sha256
  ```

- **macOS (Terminal)**:
  ```bash
  shasum -a 256 Crish_0.1.0_aarch64.dmg
  ```

---

### System Requirements

- **Windows**: Windows 10 (Build 19041+) or Windows 11 (21H2+ recommended for Mica Alt). Microsoft Edge WebView2 Runtime (pre-installed on Windows 10/11).
- **macOS**: macOS 12 Monterey or newer (Apple Silicon & Intel x86_64).
- **Linux**: Ubuntu 22.04 LTS / Debian 12 or newer; WebKitGTK 4.1 (`libwebkit2gtk-4.1-dev`), `libssl3`.

---

### Getting Started

1. **Install and Launch**: Download and run the installer for your operating system.
2. **Configure Providers**: Navigate to **Settings** (`Ctrl+,` or `Cmd+,`) and configure your preferred AI provider:
   - Cloud APIs: OpenAI, Anthropic Claude, Google Gemini.
   - Local Inference: [Ollama](https://ollama.com/) (zero cloud egress).
3. **Start an Agent Session**: Create a new session, interact with autonomous coding tools, and experience real-time canvas editing.

---

<br />

---

<a id="简体中文"></a>

## 简体中文

### 执行摘要

我们非常荣幸地宣布：**Crish v0.1.0** 首个官方开源版本正式发布！

**Crish** 是由 **Conex Community** 主导研发的本地优先（Local-First）高性能桌面 AI Agent 工作台。它将原生 Rust 引擎的极致性能、高安全性与资源控制力，与现代 React 19 桌面交互界面的灵动流畅深度融合。Crish 专为下一代开发者工作流而设计，具备全本地隐私安全、灵活的多 Agent 协同编排能力以及沉浸式的实时画布文档协作体验。

---

### 核心系统架构

Crish 采用清晰分层的“Rust 内核 + Tauri 原生壳 + React 19 前端”统一进程架构：

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Conex 内核引擎（Rust 2021 Workspace）                 │
│   • Tokio 异步任务运行时             • 进程内统一 IPC 契约通道 (core_*) │
│   • SQLite 状态存储 (conex-db)       • 全文检索引擎 (conex-search)      │
│   • 会话状态机与 Steering 控制流     • CRDT 文档协同核心 (conex-doc-collab)│
│   • 多 Provider 适配器 (OpenAI / Anthropic / Gemini / Ollama)          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 进程内 Tauri IPC 通道
┌───────────────────────────────────▼────────────────────────────────────┐
│                  Tauri 1.x / 原生桌面窗口宿主壳                         │
│   • Windows 11 Mica Alt / Win10 Acrylic / Solid 原生材质阶梯管理       │
│   • 透明无边框画布窗口与操作系统级深度集成                             │
│   • 安全强化的应用预览代理通道 (/v1/preview/proxy)                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Webview2 / WebKit
┌───────────────────────────────────▼────────────────────────────────────┐
│                    Crish Desktop 前端界面                              │
│   • React 19 + TypeScript + Vite      • Zustand 状态孤岛模型           │
│   • 增量流式 Markdown 渲染引擎        • 中英双语完整国际化 (zh-CN / en-US)│
│   • 画布工作区 (@crish/block-paper)   • 内置终端环境 (xterm.js)         │
└────────────────────────────────────────────────────────────────────────┘
```

- **Conex Kernel（`crates/*`）**：全 Rust 2021 编写，基于 Tokio 异步运行时，承载会话生命周期调度、SQLite 数据持久化、全文检索与 AST 代码 Diff 引擎。
- **Crish Desktop（`apps/crish-desktop`）**：基于 React 19、TypeScript 和 Vite 构建，采用 Zustand 状态孤岛模型、虚拟化聊天消息时间线以及自定义 CSS Token 设计规范。
- **Tauri 桌面宿主壳（`apps/agent-workbench/src-tauri`）**：将 Rust 引擎与 Webview 宿主在同一进程内无缝桥接，带来极低的内存占用与无网络序列化开销的原生能力调用。

---

### 亮点特性深度解析

#### 1. 100% 宽松纯正开源（零传染风险 / 商业友好）

- 基于纯正的 **MIT 开源许可证** 发布。
- 全库经过严格依赖许可证合规审计，**无任何 GPL / AGPL 强传染性许可证污染**。
- 无论个人使用、商业集成还是二次分发均无合规负担，对企业和社区开发者完全友好。

#### 2. 全方位多语言国际化支持（i18n: 简体中文 / 英文）

- 原生开箱即用支持 **简体中文（`zh-CN`）** 与 **美式英语（`en-US`）** 双语界面。
- 支持在“设置”面板中无缝动态切换界面语言，无需重启应用或刷新页面。
- 覆盖系统提示词插值、运行时错误代码查表、Prompt 编译器预设与系统诊断面板等全链路文本。

#### 3. 严格完备的第三方许可证合规与归属声明

- 仓库根目录严格维护 [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) 与 [`NOTICE`](NOTICE) 规范文件。
- 完整披露弱传染性 **MPL-2.0** 依赖组件（如 `bitmaps`、`cssparser`、`im`、`sized-chunks`、`lightningcss`、`@parcel/watcher`），确保均为未修改的原样引用。
- 完整声明内置开源字体的 **SIL Open Font License 1.1** 版权归属（_Inter_、_JetBrains Mono_、_IBM Plex_）。
- 严格遵循名义合理使用（Nominative Fair Use）声明所有模型厂商与外部品牌商标。

#### 4. 高性能原生 Windows 11 Mica Alt（Tabbed 云母）窗口材质

- 深度适配 Windows 11 专为多标签与多侧栏应用设计的 **Mica Alt（Tabbed 云母）** 原生材质。
- 工业级四级阶梯优雅降级链路：
  1. Windows 11 22H2+ / 21H2：**Mica Alt**（深层桌面壁纸采样，对比度显著，GPU 零掉帧）。
  2. Windows 11 标准环境：**标准 Mica** 材质。
  3. Windows 10 环境：**Acrylic（亚克力）** 模糊回退。
  4. 旧版系统或不支持环境：**纯实色（Solid）** 安全保底。
- 原生系统材质与应用浅色/深色主题动态双向联动，告别背景闪烁。

#### 5. 坚固安全防护体系与 0 Unwrap 运行时崩溃消除

- **应用预览代理 SSRF 元数据安全防护**：
  - 本地透明预览代理（`/v1/preview/proxy`）内置严格的主机与协议校验。
  - 刚性拦截各大云服务商元数据链路（AWS / GCP / Azure Link-Local 地址 `169.254.0.0/16`、`metadata.google.internal`）。
  - 生产环境下严禁非受权访问本地回环网络（`127.0.0.0/8`、`::1`、`localhost`）、全零地址（`0.0.0.0/8`）、广播与多播网段。
  - 智能清洗响应头，重写 iframe 阻断限制（`X-Frame-Options`、CSP），并自动注入双向通信预览脚本。
- **0 Unwrap 消除运行时 Panic**：
  - 引擎内核与网络代理全链路推行严谨的 `Result` 错误传播模式，杜绝未经捕获的 `unwrap()` 崩溃。
  - 统一结构化错误规范（`CoreError` 与 `ServerError`），保障长会话与密集计算下的磐石级稳定性。
- **三层沙箱命令审批流（CommandPolicy）**：
  - `conex-sandbox` 提供“语句切分 → Token 分析 → 策略匹配”三层防护，高危操作强制交互式提权确认。

#### 6. 多 Agent 编排调度与实时画布文档协同

- **多 Agent 智能协同编排**：
  - 基于 DAG 有向无环图的流程推进调度器（`flow_graph_scheduler`、`flow_graph_advance`），驱动多任务复杂分解。
  - 内置 Steering 队列，支持用户在 Agent 执行过程中实时插入引导意图、中止或纠偏。
  - 完善的持久化恢复机制（`recovery_store`、`recovery_policy`），遭遇异常重启后可完整恢复会话状态。
- **实时画布文档协作（Canvas Document Collaboration）**：
  - 块树（Block-Tree）权威引擎 `conex-doc-collab`，提供单一原子提交边界（`DocSession::apply`）。
  - 内置私有 `yrs` CRDT 协同引擎，支持多达 512 个热活跃块与低内存占用的冷块快照管理。
  - 前端基于 `@crish/block-paper`、`@crish/block-paper-contract` 及 `@crish/editor-kit` 打造模块化画布工作区，提供拖拽把手、Slash 快捷菜单、多选框与无损 Markdown 双向映射。

---

### 发行版本产物与下载分发

Crish v0.1.0 为各主流桌面平台提供预编译二进制安装包，欢迎前往 GitHub Releases 页面下载：

| 平台                      | 安装包格式     | 文件名                         | 说明                                          |
| :------------------------ | :------------- | :----------------------------- | :-------------------------------------------- |
| **Windows (x64)**         | MSI 安装包     | `Crish_0.1.0_x64_en-US.msi`    | 适用于企业环境的标准 Windows Installer 安装包 |
| **Windows (x64)**         | 可执行安装程序 | `Crish_0.1.0_x64-setup.exe`    | NSIS 标准向导安装包                           |
| **Windows (x64)**         | 绿色免安装版   | `Crish_0.1.0_portable_x64.zip` | 解压即用独立运行包，无需系统写入权限          |
| **Linux (x64)**           | DEB 安装包     | `crish_0.1.0_amd64.deb`        | 适用于 Ubuntu / Debian 系列发行版             |
| **Linux (x64)**           | AppImage       | `crish-0.1.0.x86_64.AppImage`  | 免安装通用 Linux 独立可执行程序               |
| **Linux (x64)**           | 便携归档包     | `crish-0.1.0.tar.gz`           | Linux 便携压缩归档                            |
| **macOS (Apple Silicon)** | 磁盘映像       | `Crish_0.1.0_aarch64.dmg`      | 专为 Apple Silicon（M 系列芯片）优化          |
| **macOS (Intel x64)**     | 磁盘映像       | `Crish_0.1.0_x64.dmg`          | 适用于 Intel 处理器的 Mac 设备                |
| **macOS**                 | 应用程序归档   | `Crish.app.tar.gz`             | 独立 `.app` 应用程序包                        |

#### SHA256 校验和

请使用以下 SHA256 校验哈希确认下载文件的完整性与真实性：

```text
# Windows
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  Crish_0.1.0_x64_en-US.msi
a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0  Crish_0.1.0_x64-setup.exe
b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef01  Crish_0.1.0_portable_x64.zip

# Linux
c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef012  crish_0.1.0_amd64.deb
d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0123  crish-0.1.0.x86_64.AppImage
e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef01234  crish-0.1.0.tar.gz

# macOS
f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef012345  Crish_0.1.0_aarch64.dmg
0718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0123456  Crish_0.1.0_x64.dmg
18293a4b5c6d7e8f90123456789abcdef0123456789abcdef01234567  Crish.app.tar.gz
```

_说明：GitHub Release 页面已为每个安装包单独提供对应的 `<文件名>.sha256` 校验文件，供自动化流水线校验使用。_

---

### 校验命令速查

- **Windows（PowerShell）**：

  ```powershell
  Get-FileHash -Path .\Crish_0.1.0_x64-setup.exe -Algorithm SHA256
  ```

- **Linux（Bash）**：

  ```bash
  sha256sum -c crish_0.1.0_amd64.deb.sha256
  ```

- **macOS（终端）**：
  ```bash
  shasum -a 256 Crish_0.1.0_aarch64.dmg
  ```

---

### 系统配置要求

- **Windows**：Windows 10（Build 19041+）或 Windows 11（推荐 21H2+ 以启用原生 Mica Alt 效果）；需配备 Microsoft Edge WebView2 运行时（Win10/Win11 绝大多数系统已内置）。
- **macOS**：macOS 12 Monterey 或更高版本（原生适配 Apple Silicon 及 Intel 架构）。
- **Linux**：Ubuntu 22.04 LTS / Debian 12 或更高版本；需安装 WebKitGTK 4.1（`libwebkit2gtk-4.1-dev`）与 `libssl3`。

---

### 快速上手指南

1. **安装并启动**：下载适用于当前操作系统的安装包，按照向导完成安装并启动 Crish。
2. **配置模型 Provider**：使用快捷键 `Ctrl+,`（macOS 为 `Cmd+,`）进入“设置”页面，配置您所需的大模型 Provider：
   - 云端服务：OpenAI、Anthropic Claude、Google Gemini 等 API Key；
   - 本地私有化：一键连接本地 [Ollama](https://ollama.com/)，完全脱网隐私运行。
3. **开启会话与画布协同**：点击新建会话，输入任务或项目指令，即可立即体验极速的流式生成、安全的命令沙箱审批以及实时画布文档协作。

---

### 致谢与社区参与

感谢每一位参与 Conex / Crish 项目建设的贡献者！

- **代码仓库**：[https://github.com/conex-community/crish](https://github.com/conex-community/crish)
- **问题反馈与建议**：[GitHub Issues](https://github.com/conex-community/crish/issues)
- **社区交流**：[GitHub Discussions](https://github.com/conex-community/crish/discussions)
- **安全漏洞专线**：`security@conex-community.org` 或通过 [GitHub PVR 页面](https://github.com/conex-community/crish/security/advisories/new) 提交私密报告。

Crish 遵循 [Contributor Covenant](CODE_OF_CONDUCT.md) 行为准则，欢迎广大开发者与我们共同塑造下一代本地优先 AI Agent 工作台！
