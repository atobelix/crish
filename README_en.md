# Crish — Desktop AI Agent Workbench

[English](README_en.md) | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.1-blue.svg)](https://github.com/atobelix/crish/releases)

Crish is a local-first AI agent desktop workbench built with Tauri 2, React 19, and a high-performance Rust engine kernel (`crates/`), communicating efficiently via in-process Tauri IPC.

## Download & Install

Head over to the [Releases page](https://github.com/atobelix/crish/releases) to download the package for your operating system:

- **Windows**:
  - `Crish_0.1.1_x64-setup.exe`: Setup wizard
  - `Crish_0.1.1_x64_en-US.msi`: Windows Installer (MSI)
- **macOS**: `.dmg` disk images for Apple Silicon and Intel Macs
- **Linux**: `.AppImage` or `.deb` packages

On first launch, open Settings to configure your model API keys or connect to local [Ollama](https://ollama.com/), and you're ready to start a session.

## Screenshots

Appearance settings:

![Settings · Appearance](docs/screenshots/settings-appearance.jpg)

Extensions (plugins, skills, MCP servers):

![Extensions](docs/screenshots/extensions.jpg)

## Features

- **Multi-Model Support**: OpenAI-compatible, Anthropic, Gemini, and local Ollama (`crates/agent-provider`)
- **Session Loop & Scheduling**: Lifecycle execution, user interruption, and interactive human-in-the-loop approvals (`crates/session-loop`, `crates/orchestrator`)
- **Autonomous Toolset**: File system operations, terminal shell execution, live search, and permission gating (`crates/agent-tools`)
- **Command Policy & Sandboxing**: Fine-grained command syntax analysis and rule-based safety gating (`crates/conex-sandbox`)
- **Streaming Markdown**: Fast AST rendering with smooth incremental UI patching (`crates/conex-markdown`)
- **Storage & Search**: Local SQLite persistence, full-text search, and multi-version diff views (`crates/conex-db`, `crates/conex-search`, `crates/conex-diff`)
- **Integrated Terminal**: Seamless xterm.js terminal panel within the workspace (`apps/crish-desktop`)
- **Extensible Ecosystem**: Community plugins, curated skills, and Model Context Protocol (MCP) server integration

## Build from Source

You need Node.js 24 (matching `.nvmrc`; `package.json` engines is `^24.3.0`), npm 11.6.2+, Rust 1.99.1 (edition 2021; pinned by the root `rust-toolchain.toml`, rustup installs it automatically), and the Tauri 2 system packages.

### Platform Dependencies

- **Linux (Ubuntu / Debian)**:
  ```bash
  sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
  ```
- **Windows**: Requires [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++" workload, plus the WebView2 runtime.
- **macOS**: Requires Xcode Command Line Tools:
  ```bash
  xcode-select --install
  ```

### Quick Start

```bash
git clone https://github.com/atobelix/crish.git
cd crish
npm install
npm run dev:workbench
```

### Common Commands

| Command | Description |
| --- | --- |
| `npm run dev:workbench` | Start full desktop app in development mode (Tauri + React UI) |
| `npm run dev:desktop` | Start React UI dev server only (Vite, port 5174) |
| `npm run build:desktop` | Build React UI for production |
| `npm run check:desktop` | Run frontend typecheck and architecture lint gates |
| `cargo build --workspace` | Build Rust workspace engine |
| `cargo test --workspace` | Run Rust workspace unit and integration tests |
| `cargo clippy --workspace -- -D warnings` | Run Clippy static analysis on Rust code |

## Architecture

```text
Engine (Rust, in-process)
  core_* commands, workbench-run-event, CoreError
        |
        +-- GUI (React 19) workbench_* desktop interaction UI
        +-- TUI (Planned)
        +-- Web (Planned)
```

For design details, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Documentation

| Document | Description |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | System architecture and core contracts |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contribution guidelines and coding standards |
| [`CHANGELOG.md`](CHANGELOG.md) | Version changelog and release history |
| [`SECURITY.md`](SECURITY.md) | Security policy and vulnerability reporting |
| [`LICENSE`](LICENSE) | Open source license (MIT) |
| [`NOTICE`](NOTICE) | Third-party notices and attributions |
| [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) | Complete list of dependency licenses |

For questions and issues, open a ticket on [GitHub Issues](https://github.com/atobelix/crish/issues). To report security vulnerabilities, please refer to [`SECURITY.md`](SECURITY.md) to submit a private security advisory.

## License

[MIT License](LICENSE) © 2026 atobelix
