# Crish — 桌面 AI Agent 工作台

[English](README_en.md) | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#prerequisites)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-green.svg)](https://nodejs.org/)
[![Rust](https://img.shields.io/badge/Rust-2021%20stable-orange.svg)](https://www.rust-lang.org/)
[![CI](https://img.shields.io/badge/CI-Three--Tier-blueviolet.svg)](.github/workflows/)

> **License** MIT · **平台** Windows · macOS · Linux · **Node** ≥ 20 · **Rust** stable (edition 2021) · **CI** 三层（快 / 中 / 慢）
>
> 仓库目录名 `conex`，产品名 **Crish**，由 **Conex Community** 维护（`https://github.com/conex-community/crish`）。

Crish 是本地优先的 AI Agent 桌面工作台：**Tauri 2 壳 + React 19 桌面 UI + Rust 引擎**（`crates/`）。
引擎与 UI 同进程，通过 Tauri IPC 命令/事件契约通信；目标形态是**同一引擎契约面**同时服务
GUI / TUI / Web 三种界面。

> **过渡状态说明**：引擎已完成 Rust 化（阶段进度见 [`docs/rust-rewrite/`](docs/rust-rewrite/00-master-plan.md)），
> 旧 TS 后端包（`agent-daemon` / `agent-orchestrator` / `agent-runtime` 等）已删除。
> 存量文档与测试中的旧包引用已清理（历史条目仅以迁移说明保留）。

## ✨ 功能特性

- **多模型 Provider 引擎**：OpenAI 兼容 / Anthropic / Gemini / Ollama（`crates/agent-provider`，reqwest + SSE 流式）
- **会话循环与运行控制**：`session-loop` 状态机、steering 队列、run / stop / approve 控制面（`crates/session-loop`、`crates/orchestrator`）
- **工具与审批流**：文件（fs）、shell、搜索等工具 + 审批流（`crates/agent-tools`、`crates/orchestrator`）
- **沙箱命令门禁**：`CommandPolicy` 三层管线（语句切分 → token 化 → 策略匹配），动态内容升级审批（`crates/conex-sandbox`）
- **流式 Markdown 渲染**：Rust 权威整篇渲染（`crates/conex-markdown`）+ 前端增量渲染，长文本流式帧率稳定
- **会话持久化与检索**：SQLite 会话/事件存储（`crates/conex-db`）、全文搜索（`crates/conex-search`）、diff 视图（`crates/conex-diff`）
- **内置终端**：xterm.js 集成（`apps/crish-desktop`）
- **三端目标架构**：GUI（React）/ TUI（规划中）/ Web（后续）共用引擎契约面（见下方架构节）

## 📸 截图

（发布时补充）

<a id="prerequisites"></a>

## ⚙️ 环境依赖与前置准备

在从源码构建前，请确保系统已安装以下前置依赖：

- **Node.js**：≥ 20.0.0（推荐使用 LTS 版本）与 npm
- **Rust**：Stable 工具链（edition 2021），可通过 [rustup.rs](https://rustup.rs/) 安装
- **Tauri v2 平台原生依赖**：
  - **Linux (Ubuntu / Debian)**：
    ```bash
    sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libappindicator3-dev librsvg2-dev patchelf
    ```
  - **Windows**：
    - 安装 [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（勾选“使用 C++ 的桌面开发”）；
    - 确保系统已安装 Microsoft Edge WebView2 Runtime（Windows 10/11 通常已内置）。
  - **macOS**：
    - 安装 Xcode Command Line Tools：`xcode-select --install`

## 🚀 快速开始（从源码构建）

```bash
git clone https://github.com/conex-community/crish.git
cd crish

npm install

npm run dev:desktop     # 仅 React UI（Vite，dev 端口 5174）
npm run dev:workbench   # Tauri 壳 + 桌面联调（加载 crish-desktop）
```

首次运行后：

1. 打开 **设置** 页，配置模型 Provider（云端 API Key，或本地 [Ollama](https://ollama.com/)）；
2. 新建会话，开始对话；工具调用、审批、流式渲染直接可用。

> 安装包分发渠道（Releases / 官网）与自动更新（Tauri updater）将在首个公开版本发布时确认并补充
> `docs/INSTALL.md`。当前请从源码构建使用。

## 🛠️ 开发命令

**前端 / 壳**

| 命令                    | 作用                                             |
| ----------------------- | ------------------------------------------------ |
| `npm run dev:desktop`   | 仅启动 React UI（Vite）                          |
| `npm run dev:workbench` | 启动 Tauri 壳 + 桌面联调                         |
| `npm run build:desktop` | crish-desktop 生产构建（`tsc -b && vite build`） |
| `npm run check:desktop` | 桌面端 typecheck + UI 分层检查                   |

**Rust 引擎**

| 命令                                      | 作用                                                      |
| ----------------------------------------- | --------------------------------------------------------- |
| `cargo build --workspace`                 | 构建全部 crate 与 Tauri 壳                                |
| `cargo test --workspace`                  | 引擎全量测试（CI 中层门禁）                               |
| `cargo clippy --workspace -- -D warnings` | Lint 门禁（CI 中层；本地可先 `cargo clippy --workspace`） |
| `cargo check --workspace --locked`        | 快速检查，验证 `Cargo.lock` 与工作区一致（CI 快层门禁）   |

**测试**

- `npm run test:desktop-helpers` — 桌面端 api / store 单测（vitest）
- `cargo test` — 引擎侧 Rust 测试
- 端到端：`npx playwright test`（`tests/e2e`，含 mock 引擎套件）

> 迁移收尾已完成：代码/脚本已无对已删除包的引用（仅个别测试注释保留历史路径说明）；以 CI 快层门禁
> （`cargo check --workspace --locked` + vitest 快集）为准。

## 🏗️ 架构（简）

```text
┌───────────────────────────────────────────────────────────────┐
│ 引擎契约面（后端，Rust 进程内）—— web/gui/tui 三端共用          │
│   core_* 命令（run/control/approve/session/event/status/config）│
│   workbench-run-event 事件通道（sequence + runId 注入）         │
│   CoreError 统一错误协议 + conex-telemetry 全链路可观测         │
└───────────────┬────────────────────────────┬───────────────────┘
        ┌───────▼────────┐           ┌───────▼────────┐
        │ GUI (React)    │           │ TUI (规划)     │
        │ 渲染适配层       │           │ 渲染适配层      │
        │ workbench_*    │           │ 仅依赖契约面    │
        │ 仅 GUI 桌面能力 │           │                │
        └────────────────┘           └────────────────┘
```

- **引擎契约面** = `core_*` + `config_*` + `session_*` + `workbench-run-event` + `CoreError`，三端共用；
- **GUI 专属** = `workbench_*`（fs / pty / process / power / host 等桌面能力）；
- **Web 形态** = 同一契约面的 HTTP 适配（后续由网关暴露）；
- **TUI 形态** = 直接消费契约面（命令 + 事件通道），渲染层独立。

详见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 与 [`docs/rust-rewrite/23-architecture-hardening-plan.md`](docs/rust-rewrite/23-architecture-hardening-plan.md)。

## 📚 文档

| 文档                                                                                     | 说明                                                      |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                                                     | 架构真相：Rust 内核、引擎契约面、crate 地图、重写过渡状态 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                                                     | 贡献指南：环境、构建、代码规范、PR 流程                   |
| [`docs/opensource/CONTRIBUTING-PROVIDERS.md`](docs/opensource/CONTRIBUTING-PROVIDERS.md) | Provider 接入指南（Schema、认证、测试、PR checklist）     |
| [`CHANGELOG.md`](CHANGELOG.md)                                                           | 变更日志（Keep a Changelog）                              |
| [`SECURITY.md`](SECURITY.md)                                                             | 安全漏洞报告流程与 PVR 支持                               |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)                                               | 行为准则（Contributor Covenant）                          |
| [`NOTICE`](NOTICE)                                                                       | 版权与开源声明                                            |
| [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md)                                     | 第三方依赖开源许可证                                      |
| [`docs/rust-rewrite/`](docs/rust-rewrite/00-master-plan.md)                              | Rust 重写阶段方案与审计（内部过渡记录）                   |

## 🤝 社区

- GitHub Issues / Discussions（仓库 [`conex-community/crish`](https://github.com/conex-community/crish)）
- 社区邮箱：`contact@conex-community.org`
- 安全漏洞：`security@conex-community.org` 或通过 [GitHub PVR](https://github.com/conex-community/crish/security/advisories/new)
- 参与开发请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md) 与 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)

## 📄 License

MIT，Copyright (c) 2026 Conex Community。详见 [`LICENSE`](LICENSE)。
