# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Rust 引擎（Phase A–D）**：`crates/orchestrator`（会话/运行生命周期、事件持久化、审批状态机）、
  `crates/session-loop`（会话状态机与 steering）、`crates/agent-provider`（OpenAI 兼容 / Anthropic /
  Gemini / Ollama，reqwest + SSE）、`crates/agent-tools`（fs / shell / search 工具）、
  `crates/conex-*` 基础设施（db / ipc / types / telemetry / sandbox / search / fs / diff / markdown / compaction）。
- **引擎契约面**：`core_*` / `config_*` / `session_*` 命令、`workbench-run-event` 事件通道、
  `CoreError` 统一错误协议（GUI / TUI / Web 三端共用）。
- **沙箱命令门禁**：`conex-sandbox` `CommandPolicy` 三层管线（语句切分 → token 化 → 策略匹配，
  动态内容升级审批）。
- **桌面 UI**：`apps/crish-desktop`（React 19 + Vite + zustand），含 xterm 终端、流式 markdown 增量渲染、
  会话持久化与全文检索界面。
- **CI 三层**：快层（`cargo check --locked` + vitest 快集 + 安全门禁）/ 中层（`cargo test` 全量 +
  clippy）/ 慢层（压力测试 + Criterion 基准）。
- **Cargo.lock 纳入版本控制**：保证 workspace 可复现构建与依赖审计。

### Changed

- **引擎架构**：TS daemon + WebSocket 链路 → Rust 引擎进程内 + Tauri IPC 单路径（invoke + event）。
- **npm workspaces**：收敛为现存 9 个包（2 apps + 7 packages），移除已删除包声明。
- **可观测性**：conex-telemetry（tracing + panic hook）接线，sessionId/runId span 注入，日志脱敏。

### Removed

- **TS 后端包**：`agent-daemon` / `agent-orchestrator` / `agent-runtime` / `agent-core` / `agent-model`
  及 WS 协议层（sidecar、StreamRecovery、zod 协议层、directFetchBridge）——由 Rust 引擎替代
  （见 `docs/rust-rewrite/00-master-plan.md` §0.3）。

## [0.1.0] - 2026-07-18

### Added

- **Monorepo Structure**: Organized the project into a workspace-based monorepo consisting of:
  - `apps/crish-desktop` (React UI)
  - `apps/agent-workbench` (Tauri workbench shell)
  - `packages/agent-runtime` (LLM/tool execution paths)
  - `packages/agent-orchestrator` (session lifecycle & execution)
  - `packages/agent-daemon` (long-running WebSocket daemon)
  - `packages/shared-types` (TypeScript shared type definitions)
  - `packages/shared-utils` (TypeScript helper utilities)
  - `packages/decision-engine` (Agent reasoning & decision loops)
  - `packages/agent-provider-http` (Rust-based workspace provider integration)
- **MIT Licensing**: Set up MIT license files, workspace package configuration inherits, and community metadata.
- **Documentation**: Added core architectural guidelines and documents introducing entrypoints and structure.

[Unreleased]: https://github.com/conex-community/crish/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/conex-community/crish/releases/tag/v0.1.0
