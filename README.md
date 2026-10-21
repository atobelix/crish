# Crish — 桌面 AI Agent 工作台

[English](README_en.md) | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.1-blue.svg)](https://github.com/atobelix/crish/releases)

Crish 是本地优先的 AI Agent 桌面工作台，基于 Tauri 2、React 19 桌面界面与 Rust 高性能引擎内核（`crates/`）构建，通过进程内 Tauri IPC 进行高效通信。

## 下载安装

前往 [Releases 页面](https://github.com/atobelix/crish/releases) 下载适合您操作系统的安装包：

- **Windows**：
  - `Crish_0.1.1_x64-setup.exe`：图形化安装向导
  - `Crish_0.1.1_x64_en-US.msi`：MSI 安装程序
- **macOS**：下载对应架构的 `.dmg` 镜像安装包
- **Linux**：下载 `.AppImage` 或 `.deb` 软件包

首次打开应用后，前往设置页填写模型服务 API 密钥，或连接本地 [Ollama](https://ollama.com/)，即可开始新建对话。

## 截图

设置里的外观页：

![设置 · 外观](docs/screenshots/settings-appearance.jpg)

扩展页（插件、技能、MCP 服务）：

![扩展](docs/screenshots/extensions.jpg)

## 功能特性

- **多模型支持**：OpenAI 兼容、Anthropic、Gemini、本地 Ollama（`crates/agent-provider`）
- **会话循环与调度**：执行流转、主动中断、人机确认审批（`crates/session-loop`、`crates/orchestrator`）
- **自主工具集**：文件系统操作、终端 Shell 执行、实时搜索及权限审批拦截（`crates/agent-tools`）
- **命令沙箱与门禁**：细粒度命令语法分析与安全策略匹配（`crates/conex-sandbox`）
- **流式 Markdown 渲染**：高性能 AST 解析与平滑增量挂载（`crates/conex-markdown`）
- **会话存储与检索**：本地 SQLite 持久化、全文检索与多版本差异对比（`crates/conex-db`、`crates/conex-search`、`crates/conex-diff`）
- **内置终端集成**：无缝交互的高性能终端面板（`apps/crish-desktop`）
- **生态扩展能力**：支持社区插件、技能集与 Model Context Protocol (MCP) 服务

## 从源码构建

开发与构建需要 Node.js 20+、npm、Rust stable（edition 2021）以及对应平台的 Tauri 2 系统依赖。

### 平台依赖

- **Linux（Ubuntu / Debian）**：
  ```bash
  sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
  ```
- **Windows**：需要安装 [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（勾选“使用 C++ 的桌面开发”）与 WebView2 运行时。
- **macOS**：需要安装 Xcode Command Line Tools：
  ```bash
  xcode-select --install
  ```

### 快速开始

```bash
git clone https://github.com/atobelix/crish.git
cd crish
npm install
npm run dev:workbench
```

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev:workbench` | 启动完整的桌面应用开发环境（Tauri + 前端） |
| `npm run dev:desktop` | 仅启动 React 前端界面（Vite，端口 5174） |
| `npm run build:desktop` | 生产构建前端产物 |
| `npm run check:desktop` | 前端类型检查与架构规范门禁 |
| `cargo build --workspace` | 构建 Rust 工作区引擎 |
| `cargo test --workspace` | 运行 Rust 工作区单元测试 |
| `cargo clippy --workspace -- -D warnings` | Rust 代码规范静态检查 |

## 架构简述

```text
引擎（Rust，进程内）
  core_* 命令、workbench-run-event、CoreError
        |
        +-- GUI（React 19）workbench_* 桌面交互界面
        +-- TUI（规划中）
        +-- Web（规划中）
```

详细设计请参阅 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 项目文档

| 文档 | 说明 |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 总体架构设计与核心契约 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 代码贡献指南与规范 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本更新与发布日志 |
| [`SECURITY.md`](SECURITY.md) | 安全策略与漏洞通报指引 |
| [`LICENSE`](LICENSE) | 开源许可协议 (MIT) |
| [`NOTICE`](NOTICE) | 第三方依赖与资产归属声明 |
| [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) | 依赖开源许可证完整列表 |

问题反馈请提交至 [Issues](https://github.com/atobelix/crish/issues)。如发现安全漏洞，请勿直接公开提 Issue，建议根据 [`SECURITY.md`](SECURITY.md) 提交 GitHub 私密报告。

## License

[MIT License](LICENSE) © 2026 atobelix
