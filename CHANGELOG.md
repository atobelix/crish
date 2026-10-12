# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-12

First official open-source release of Crish — Tauri desktop AI agent workbench.
Comprehensive release notes are available in [RELEASE_NOTES_v0.1.0.md](RELEASE_NOTES_v0.1.0.md).

### Added

- **Conex Kernel (Rust 2021)**: High-performance in-process Rust engine (`crates/*`):
  - `crates/orchestrator` (session lifecycle, event persistence, approval state machine, DAG flow graph scheduler, crash recovery).
  - `crates/session-loop` (session state machine and interactive steering queue).
  - `crates/agent-provider` (OpenAI-compatible, Anthropic Claude, Google Gemini, and local Ollama via reqwest + SSE streaming).
  - `crates/agent-tools` (fs, shell, search, and system tools with approval escalation).
  - `crates/conex-*` core infrastructure crates (db, ipc, types, telemetry, sandbox, search, fs, diff, markdown, compaction, doc-collab).
- **Crish Desktop UI (React 19 + TypeScript + Vite)**: Modern desktop interface (`apps/crish-desktop`):
  - Zustand state islands, virtualized chat timeline scrolling, and fast incremental streaming Markdown rendering.
  - Native xterm.js terminal integration and side-by-side AST diff viewer.
  - Interactive canvas workspace powered by `@crish/block-paper`, `@crish/block-paper-contract`, and `@crish/editor-kit`.
- **Tauri Desktop Shell (`apps/agent-workbench/src-tauri`)**: Unified native desktop wrapper:
  - Native Windows 11 **Mica Alt (`Tabbed`)** backdrop material with tiered fallback (Mica Alt -> standard Mica -> Windows 10 Acrylic -> Solid).
  - Dynamic bidirectional light/dark theme synchronization with WebView2.
- **Internationalization (i18n)**: Out-of-the-box dual language support for Simplified Chinese (`zh-CN`) and English (`en-US`) across UI, error messages, and system directives.
- **Hardened Security & Sandboxing**:
  - `conex-sandbox` three-tier command gatekeeper (statement splitting -> tokenization -> policy match with interactive elevation).
  - Transparent application preview proxy (`/v1/preview/proxy`) with strict SSRF metadata blocking (AWS/GCP/Azure link-local, `metadata.google.internal`, loopback in production).
  - Zero unwrap runtime panics: disciplined `Result`-driven error propagation across engine and server boundaries.
- **Open Source Licensing & Compliance**:
  - Pure MIT License with zero copyleft pollution (GPL/AGPL-free).
  - Comprehensive third-party license disclosure and notice documentation (`THIRD-PARTY-LICENSES.md`, `NOTICE`) covering MPL-2.0 dependencies and SIL OFL-1.1 fonts.
- **Three-Tier CI & Cross-Platform Releases**:
  - Fast tier (cargo check, vitest fast suite, safety gates), mid tier (cargo test, clippy), slow tier (stress test, Criterion benchmarks).
  - Multi-platform GitHub Actions release automation for Windows (`.msi`, `.exe`, `.zip`), Linux (`.deb`, `.AppImage`), and macOS (`.dmg`).

### Changed

- **Engine Architecture**: Unified in-process Rust engine communicating with React UI via Tauri IPC channels, replacing external daemon WebSocket pathways.
- **Monorepo Cleanup**: Pruned obsolete packages, consolidating active workspace packages under `apps/` and `packages/`.
- **Full Observability**: Integrated `conex-telemetry` (tracing spans, panic hooks, session/run tracking, and log redaction).

### Removed

- Deprecated legacy TypeScript backend packages (`agent-daemon`, `agent-orchestrator`, `agent-runtime`, `agent-core`, `agent-model`) in favor of the Rust kernel.

[Unreleased]: https://github.com/conex-community/crish/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/conex-community/crish/releases/tag/v0.1.0
