# Crish — Desktop AI Agent Workbench

[English](README_en.md) | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.1-blue.svg)](https://github.com/atobelix/crish/releases)

Maintainer: [张浩健](https://github.com/atobelix). The repository directory is `conex`. The product name is **Crish**. This is a one-person project. There is no community organization and no public contact mailbox.

Source: <https://github.com/atobelix/crish>

Crish is a local-first AI agent desktop workbench: a Tauri 2 shell, a React 19 UI, and a Rust engine (`crates/`). The engine and the UI share one process and talk over Tauri IPC. A TUI and a web UI are not built yet. The diagram below marks them as planned.

## Install

You do not have to compile it. Download an installer from [Releases](https://github.com/atobelix/crish/releases). The public version is **0.1.1**.

Windows:

- `Crish_0.1.1_x64-setup.exe` — setup wizard
- `Crish_0.1.1_x64_en-US.msi` — MSI

Linux and macOS installers are uploaded by the same release workflow. Use the files that are actually attached to the release. The `v0.1.0` tag is older. Do not treat it as the current version.

On first launch, open Settings and add a model provider key, or point Crish at local [Ollama](https://ollama.com/). Then start a conversation.

## Screenshots

Appearance settings:

![Settings, appearance](docs/screenshots/settings-appearance.jpg)

Extensions (plugins, skills, MCP servers):

![Extensions](docs/screenshots/extensions.jpg)

## Features

- Models: OpenAI-compatible, Anthropic, Gemini, Ollama (`crates/agent-provider`)
- Session loop: run, stop, approve (`crates/session-loop`, `crates/orchestrator`)
- Tools: files, shell, search, with approval (`crates/agent-tools`)
- Command policy: `crates/conex-sandbox`
- Markdown rendering: `crates/conex-markdown`
- Session storage and search: `crates/conex-db`, `crates/conex-search`, `crates/conex-diff`
- Built-in terminal: `apps/crish-desktop`
- Plugins, skills, and MCP servers

## Build from source

You need Node.js 20 or newer, npm, Rust stable (edition 2021), and the Tauri 2 system packages.

Linux (Ubuntu / Debian):

```bash
sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

Windows needs the [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) workload “Desktop development with C++”, plus WebView2. Windows 10 and 11 usually already include WebView2.

macOS: `xcode-select --install`

```bash
git clone https://github.com/atobelix/crish.git
cd crish
npm install
npm run dev:workbench
```

`npm run dev:desktop` starts only the React UI (Vite, port 5174). It is not the desktop app.

| Command | What it does |
| --- | --- |
| `npm run dev:workbench` | Start the desktop app |
| `npm run dev:desktop` | Start the UI only |
| `npm run build:desktop` | Build the UI |
| `npm run check:desktop` | Typecheck and UI gates |
| `cargo build --workspace` | Build the Rust workspace |
| `cargo test --workspace` | Rust tests |
| `cargo clippy --workspace -- -D warnings` | Clippy |

## Architecture

```text
Engine (Rust, in process)
  core_* commands, workbench-run-event, CoreError
        |
        +-- GUI (React, shipped) workbench_* desktop APIs
        +-- TUI (planned)
        +-- Web (planned)
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Docs

| Doc | What it is |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Architecture |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to change the code |
| [`CHANGELOG.md`](CHANGELOG.md) | Changelog |
| [`SECURITY.md`](SECURITY.md) | Private vulnerability reports |
| [`LICENSE`](LICENSE) | MIT |
| [`NOTICE`](NOTICE) | Third-party notices |
| [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) | Dependency licenses |

Use [Issues](https://github.com/atobelix/crish/issues) for bugs and questions. Do not post vulnerability details there. Follow [`SECURITY.md`](SECURITY.md) and use GitHub private vulnerability reporting.

## License

MIT. Copyright (c) 2026 张浩健. See [`LICENSE`](LICENSE).
