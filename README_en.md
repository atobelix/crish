# Crish — Desktop AI Agent Workbench

[English](README_en.md) | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#prerequisites)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-green.svg)](https://nodejs.org/)
[![Rust](https://img.shields.io/badge/Rust-2021%20stable-orange.svg)](https://www.rust-lang.org/)
[![CI](https://img.shields.io/badge/CI-Three--Tier-blueviolet.svg)](.github/workflows/)

> **License** MIT · **Platforms** Windows · macOS · Linux · **Node** ≥ 20 · **Rust** stable (edition 2021) · **CI** Three-Tier (Fast / Mid / Slow)
>
> Repository directory `conex`, product name **Crish**, maintained by **Conex Community** (`https://github.com/conex-community/crish`).

Crish is a local-first AI Agent desktop workbench: **Tauri 2 shell + React 19 desktop UI + Rust engine** (`crates/`).
The engine and UI run within the same process, communicating through Tauri IPC commands and event contracts. The architectural vision is a **unified engine contract surface** serving GUI, TUI, and Web interfaces concurrently.

> **Transition Note**: The engine has fully transitioned to Rust (see [`docs/rust-rewrite/`](docs/rust-rewrite/00-master-plan.md) for phase progress).
> Legacy TypeScript backend packages (`agent-daemon` / `agent-orchestrator` / `agent-runtime`, etc.) have been removed.
> References in legacy documentation and tests have been cleaned up (historical entries preserved only with migration notes).

---

## ✨ Features

- **Multi-Model Provider Engine**: OpenAI Compatible / Anthropic / Gemini / Ollama (`crates/agent-provider`, reqwest + SSE streaming).
- **Session Loop & Execution Control**: `session-loop` state machine, steering queues, run / stop / approve control plane (`crates/session-loop`, `crates/orchestrator`).
- **Tools & Approval Workflows**: File system (fs), shell, search tools with granular user approval gates (`crates/agent-tools`, `crates/orchestrator`).
- **Sandbox Command Guardrails**: Three-stage `CommandPolicy` pipeline (statement splitting → tokenization → policy evaluation) with dynamic escalation approval (`crates/conex-sandbox`).
- **Streaming Markdown Rendering**: Rust-authoritative full rendering (`crates/conex-markdown`) combined with frontend incremental rendering for smooth frame rates on long outputs.
- **Session Persistence & Search**: SQLite session and event store (`crates/conex-db`), full-text search (`crates/conex-search`), and diff view (`crates/conex-diff`).
- **Integrated Terminal**: Built-in xterm.js terminal integration (`apps/crish-desktop`).
- **Cross-Interface Architecture**: Shared engine contract surface for GUI (React), TUI (planned), and Web (subsequent; see Architecture section below).

---

## 📸 Screenshots

_(To be added upon release)_

---

<a id="prerequisites"></a>

## ⚙️ Environment Prerequisites

Before building from source, please ensure the following dependencies are installed on your system:

- **Node.js**: ≥ 20.0.0 (LTS recommended) and npm
- **Rust**: Stable toolchain (edition 2021), installed via [rustup.rs](https://rustup.rs/)
- **Tauri v2 Native Platform Dependencies**:
  - **Linux (Ubuntu / Debian)**:
    ```bash
    sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libappindicator3-dev librsvg2-dev patchelf
    ```
  - **Windows**:
    - Install [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (select "Desktop development with C++");
    - Ensure Microsoft Edge WebView2 Runtime is installed (built into Windows 10/11).
  - **macOS**:
    - Install Xcode Command Line Tools: `xcode-select --install`

---

## 🚀 Quick Start (Build from Source)

```bash
git clone https://github.com/conex-community/crish.git
cd crish

npm install

npm run dev:desktop     # React UI only (Vite, dev port 5174)
npm run dev:workbench   # Tauri shell + desktop co-debugging (loads crish-desktop)
```

After launching for the first time:

1. Open the **Settings** page and configure a model Provider (cloud API keys or local [Ollama](https://ollama.com/));
2. Create a new session and start chatting; tool execution, approval gates, and streaming rendering work out of the box.

> Binary distribution channels (Releases / Official site) and auto-updates (Tauri updater) will be finalized and documented in `docs/INSTALL.md` upon the first public release. Please build from source currently.

---

## 🛠️ Development Commands

### Frontend & Shell

| Command                 | Description                                 |
| ----------------------- | ------------------------------------------- |
| `npm run dev:desktop`   | Start React UI dev server (Vite)            |
| `npm run dev:workbench` | Start Tauri desktop application             |
| `npm run build:desktop` | Production build for crish-desktop          |
| `npm run check:desktop` | Desktop typecheck + UI layering gate checks |

### Rust Engine

| Command                                   | Description                                           |
| ----------------------------------------- | ----------------------------------------------------- |
| `cargo build --workspace`                 | Build all crates and Tauri shell                      |
| `cargo test --workspace`                  | Run full workspace test suite (CI mid-tier gate)      |
| `cargo clippy --workspace -- -D warnings` | Workspace linter gate (CI mid-tier gate)              |
| `cargo check --workspace --locked`        | Fast check against locked `Cargo.lock` (CI fast-tier) |

### Testing

- `npm run test:desktop-helpers` — Desktop API & Store unit tests (Vitest)
- `cargo test` — Engine Rust unit & integration tests
- End-to-end: `npx playwright test` (`tests/e2e`, includes mock engine suites)

> Migration completed: Code and scripts no longer reference deleted packages (historical paths only retained in a few test comments for context); CI fast-tier gate (`cargo check --workspace --locked` + vitest fast suite) serves as the baseline.

---

## 🏗️ Architecture Overview

```text
┌───────────────────────────────────────────────────────────────┐
│ Engine Contract Surface (Backend, in-process Rust)            │
│   core_* commands (run/control/approve/session/event/status/  │
│   config)                                                     │
│   workbench-run-event channel (sequence + runId injection)    │
│   CoreError unified error protocol + conex-telemetry          │
└───────────────┬────────────────────────────┬───────────────────┘
        ┌───────▼────────┐           ┌───────▼────────┐
        │ GUI (React)    │           │ TUI (Planned)  │
        │ Adaptation     │           │ Adaptation     │
        │ workbench_*    │           │ Contract-only  │
        │ Desktop-only   │           │                │
        └────────────────┘           └────────────────┘
```

- **Engine Contract Surface**: `core_*` + `config_*` + `session_*` + `workbench-run-event` + `CoreError`, shared across all frontends;
- **GUI Exclusive**: `workbench_*` (fs / pty / process / power / host desktop capabilities);
- **Web Interface**: HTTP adaptation of the same contract surface (exposed via gateway);
- **TUI Interface**: Direct consumer of the contract surface (commands + event channel) with independent rendering.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`docs/rust-rewrite/23-architecture-hardening-plan.md`](docs/rust-rewrite/23-architecture-hardening-plan.md) for details.

---

## 📚 Documentation

| Document                                                                                 | Description                                                          |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                                                     | Architectural ground truth: Rust kernel, contract surface, crate map |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                                                     | Contribution guide: environment, building, code style, PR flow       |
| [`docs/opensource/CONTRIBUTING-PROVIDERS.md`](docs/opensource/CONTRIBUTING-PROVIDERS.md) | Provider integration guide (Schema, auth, testing, PR checklist)     |
| [`CHANGELOG.md`](CHANGELOG.md)                                                           | Release changelog (Keep a Changelog)                                 |
| [`SECURITY.md`](SECURITY.md)                                                             | Security vulnerability disclosure process and PVR support            |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)                                               | Contributor Covenant Code of Conduct                                 |
| [`NOTICE`](NOTICE)                                                                       | Copyright and attribution notices                                    |
| [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md)                                     | Third-party dependency licenses                                      |
| [`docs/rust-rewrite/`](docs/rust-rewrite/00-master-plan.md)                              | Rust rewrite plans and audits (internal transition record)           |

---

## 🤝 Community

- GitHub Issues & Discussions: [`conex-community/crish`](https://github.com/conex-community/crish)
- Community contact: `contact@conex-community.org`
- Security reports: `security@conex-community.org` or via [GitHub PVR](https://github.com/conex-community/crish/security/advisories/new)
- Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) before submitting pull requests.

---

## 📄 License

Licensed under the **MIT License**. Copyright (c) 2026 Conex Community. See [`LICENSE`](LICENSE) for details.
