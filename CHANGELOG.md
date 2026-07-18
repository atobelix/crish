# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
