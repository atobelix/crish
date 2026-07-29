# Crish Documentation Index

Welcome to the Crish project documentation. This index introduces the overall architecture, codebase directory structure, and details the primary entrypoints to the project's documentation.

---

## Core Architecture Overview

**Crish** is a desktop AI Agent Workbench designed with a decoupled architecture:
1. **Frontend UI** ([crish-desktop](file:///c:/Software/conex/apps/crish-desktop)): A modern React 19 + Zustand application.
2. **Desktop Shell** ([agent-workbench](file:///c:/Software/conex/apps/agent-workbench)): A Tauri 2 shell that hosts the React frontend and handles native windowing and sidecar supervisor logic.
3. **Daemon Core** ([agent-daemon](file:///c:/Software/conex/packages/agent-daemon)): A Node-based daemon serving session management, WebSocket APIs, and workflow orchestrations.
4. **Execution Layer**:
   - [agent-orchestrator](file:///c:/Software/conex/packages/agent-orchestrator): Governs state machines, session trees, and target continuation.
   - [agent-runtime](file:///c:/Software/conex/packages/agent-runtime): Manages LLM connections, tools, context compression, and execution checkpoints.

For a detailed view of the architectural truth, please check the root documentation:
- [ARCHITECTURE.md](file:///c:/Software/conex/ARCHITECTURE.md)
- [DEVELOPMENT_LOG.md](file:///c:/Software/conex/DEVELOPMENT_LOG.md)

---

## Documentation Entrypoints

### 1. Architecture Design Documents (`docs/architecture/`)

These documents detail specific sub-systems, protocol contracts, and technical choices:
- [Daemon Protocol Single Source](file:///c:/Software/conex/docs/architecture/daemon-protocol-single-source.md): The unified source of truth for the daemon-to-UI protocol.
- [Daemon Runtime Selection](file:///c:/Software/conex/docs/architecture/daemon-runtime-selection.md): Architecture details on runtime environments and integration points.
- [Observability & Session Loading](file:///c:/Software/conex/docs/architecture/observability-and-session-loading.md): Details on observability, logging, and session state rehydration.
- [Streaming Transport Contract](file:///c:/Software/conex/docs/architecture/streaming-transport-contract.md): Specifications of streaming formats and event payloads over WebSockets.
- [Workbench Session Actions and Split View](file:///c:/Software/conex/docs/architecture/workbench-session-actions-and-split-view.md): Product SessionAction / Split View contracts (not the deleted `store/session-actions/` directory; see OPT-E8).

### 2. Implementation Plans (`docs/plans/`)

Active design proposals and roadmap execution plans:
- [Product Trust Topdown Plan](file:///c:/Software/conex/docs/plans/2026-07-product-trust-topdown.md): High-level strategy for product stability, trust, and execution validation.
- [UI System Coherence Plan](file:///c:/Software/conex/docs/plans/2026-07-ui-system-coherence.md): Guidelines and milestones for frontend component normalization and styling consistency.

---

## How to Contribute

To get started with development, please read the [CONTRIBUTING.md](file:///c:/Software/conex/CONTRIBUTING.md) guide in the repository root.
