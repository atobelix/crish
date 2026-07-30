# Plan 03: Module Splitting & Architecture Refactoring

> Based on best practices from Grok Build (xAI), Codex CLI (OpenAI), Kimi Code (Moonshot AI), and Pi (π).

## Table of Contents

1. [Current State Analysis: agent-runtime](#1-current-state-analysis-agent-runtime)
2. [Target Module Split: agent-runtime → 9 Packages](#2-target-module-split-agent-runtime--9-packages)
3. [agent-orchestrator Split](#3-agent-orchestrator-split)
4. [agent-daemon Split](#4-agent-daemon-split)
5. [Rust Side Refinements](#5-rust-side-refinements)
6. [Cross-Package Dependency Graph](#6-cross-package-dependency-graph)
7. [Migration Strategy](#7-migration-strategy)
8. [File-Level Norms](#8-file-level-norms)
9. [npm Workspace Configuration](#9-npm-workspace-configuration)
10. [Implementation Checklist](#10-implementation-checklist)

---

## 1. Current State Analysis: agent-runtime

### Directory Heatmap (195 files)

The `packages/agent-runtime/src/` contains 195 entries with the following major functional clusters:

| Cluster                                                                                  | Files | Responsibility                                                        | Suggested Target Package         |
| ---------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------- | -------------------------------- |
| `runtime.ts`, `runtime-defaults.ts`, `runtime-metrics.ts`, `runtime-metrics/`            | 4     | Agent runtime bootstrap, options, metrics                             | `agent-core`                     |
| `agent-session-loop.ts`, `session-loop/`                                                 | 5+    | Session loop orchestration                                            | `agent-core`                     |
| `session/`, `session-store/`, `session.ts`, `session.test.ts`                            | 6     | Session persistence, replay                                           | `agent-core`                     |
| `state-machine/`                                                                         | 8     | Turn lifecycle, branching, run lifecycle                              | `agent-core`                     |
| `agent-input-queue.ts`                                                                   | 1     | Input queue (steer/force)                                             | `agent-core`                     |
| `control/`                                                                               | 4     | Control bus (L1/L2/L3)                                                | `agent-core`                     |
| `steering/`                                                                              | 8     | Steering coordinator, strategies                                      | `agent-core`                     |
| `hooks/`                                                                                 | 12    | Lifecycle hooks, extension registry                                   | `agent-core`                     |
| `runtime-components/`                                                                    | 18    | Context manager, conversation engine, tool executor, provider gateway | `agent-core`                     |
| `tools/`, `tool-registry.ts`, `tool-stream/`, `tool-discovery.ts`                        | 8+    | Tool definitions, registry, middleware                                | `agent-tools`                    |
| `local-tools/`                                                                           | 11    | Workspace tools (fs, shell, search)                                   | `agent-tools`                    |
| `tools.ts`, `tools.test.ts`                                                              | 2     | Tool execution                                                        | `agent-tools`                    |
| `stream/`                                                                                | 5     | SSE streaming, thinking config                                        | `agent-stream`                   |
| `openai-stream-parse.ts`, `anthropic-stream-parse.ts`, `gemini-stream-parse.ts`          | 3     | Stream parsing per provider                                           | `agent-stream`                   |
| `context-compression/`, `context-compression.ts`                                         | 6     | Compression strategies, token estimation                              | `agent-context`                  |
| `context-slicer.ts`, `context-state.ts`, `context-projection.ts`                         | 3     | Context window slicing                                                | `agent-context`                  |
| `model-routing/`, `model-routing.ts`                                                     | 7     | Model routing, role assignment                                        | `agent-model`                    |
| `provider/`                                                                              | 15+   | Provider SPI, engines, factory, registry                              | `agent-model`                    |
| `provider-gateway/`                                                                      | 7     | Gateway, credential resolver, route selector                          | `agent-model`                    |
| `provider-transport/`                                                                    | 6     | Connection manager, stream recovery, token tracker                    | `agent-model`                    |
| `provider-openai-*.ts`, `provider-anthropic.ts`, `provider-gemini.ts`                    | 10+   | Provider implementations                                              | `agent-model`                    |
| `provider-stream-contract/`                                                              | 8     | Stream contract, normalizer, sequencer                                | `agent-model`                    |
| `provider-cache-hints.ts`, `provider-error-classifier.ts`, `provider-request-machine.ts` | 3     | Provider helpers                                                      | `agent-model`                    |
| `mcp-lifecycle/`, `mcp-lifecycle.ts`                                                     | 6     | MCP server lifecycle                                                  | `agent-mcp`                      |
| `permission/`                                                                            | 3     | Trust zone, command classification                                    | `agent-permissions`              |
| `subagents.ts`, `subagent-loop.ts`, `subagent-*.ts`                                      | 5     | Subagent dispatch                                                     | `agent-subagent`                 |
| `plan-document/`, `plan-document.ts`                                                     | 6     | Plan document model                                                   | `agent-orchestrator` (shared)    |
| `checkpoint/`, `checkpoints.ts`, `checkpoint-manifest.ts`                                | 5     | Checkpoint management                                                 | `agent-core`                     |
| `event-architecture/`, `event-protocol/`, `event-queue/`                                 | 7     | Event system                                                          | `agent-core`                     |
| `approval/`                                                                              | 4     | Approval pipeline                                                     | `agent-core`                     |
| `encoding.ts`, `wasm-tiktoken.ts`                                                        | 2     | Token encoding                                                        | `agent-context`                  |
| `blob-externalization.ts`                                                                | 1     | Blob storage                                                          | `agent-core`                     |
| `config/`                                                                                | 2     | Config merging                                                        | `agent-core` (or `shared-utils`) |
| `fallback-chain/`                                                                        | 4     | Provider fallback chain                                               | `agent-model`                    |
| `pricing-engine.ts`                                                                      | 1     | Token pricing                                                         | `agent-model`                    |
| `testing/`                                                                               | 6     | Test utilities, mocks                                                 | `test-utils`                     |
| `types.ts`                                                                               | 1     | Shared types (285 lines)                                              | Mostly belongs to `shared-types` |
| Other singletons                                                                         | ~15   | Prompt assembly, git versioning, etc.                                 | Distributed                      |

### Key Design Issues

1. **Circular dependencies within package**: `runtime.ts` imports from `session-loop/`, `runtime-components/`, `session/`, `control/`, `permission/`, `provider-transport/`, `tools/` — a massive hub.
2. **No layer boundaries**: Provider code (`provider/`, `provider-gateway/`, etc.) is at the same directory level as session-loop (which should depend on provider, not co-exist).
3. **195 files in one package** violates the "avoid large modules" rule from Codex CLI (500 LoC per module, 800 LoC per file).
4. **Types.ts is a 285-line monolith** mixing runtime options, provider interfaces, session stores, and permission types.
5. **Testing utilities** embedded in the runtime package are pulled by `agent-daemon` for mocks, creating a dev-dependency anti-pattern.

---

## 2. Target Module Split: agent-runtime → 9 Packages

### 2.1 `@crish/agent-core`

**Responsibility**: Agent runtime bootstrap, session lifecycle, turn state machine, event system, control bus, hooks, approval pipeline.

**Source files map**:

```
packages/agent-runtime/src/  →  packages/agent-core/src/
  runtime.ts                    core/agent-runtime.ts
  runtime-defaults.ts           core/runtime-defaults.ts
  runtime-metrics.ts            core/runtime-metrics.ts
  runtime-metrics/              core/runtime-metrics/
  agent-session-loop.ts         session-loop/index.ts (barrel)
  session-loop/                 session-loop/
    index.ts                      session-loop.ts
    types.ts                      session-loop-types.ts
    provider-call.ts              session-loop-provider-call.ts
    tool-execution.ts             session-loop-tool-execution.ts
    control-check.ts              session-loop-control-check.ts
    steering-delegate.ts          session-loop-steering-delegate.ts
    recovery.ts                   session-loop-recovery.ts
  session/                      session/
    session-types.ts              session-types.ts
    session-storage.ts            session-storage.ts
    session-replay.ts             session-replay.ts
  session-store/                session-store/
    types.ts                      types.ts
    archive-store.ts              archive-store.ts
  state-machine/                state-machine/
    core.ts                       state-machine.ts
    agent-session.ts              agent-session.ts
    session-branch.ts             session-branch.ts
    run-lifecycle.ts              run-lifecycle.ts
    turn-types.ts                 turn-types.ts
  agent-input-queue.ts          agent-input-queue.ts
  control/                      control/
    types.ts                      types.ts
    control-bus.ts                control-bus.ts
  steering/                     steering/
    steering-types.ts             types.ts
    steering-coordinator.ts       coordinator.ts
    steering-input-queue.ts       input-queue.ts
    compression-recovery-strategy.ts
    goal-audit-strategy.ts
    recovery-steering-strategy.ts
  hooks/                        hooks/
    hook-types.ts                 types.ts
    agent-hooks.ts                agent-hooks.ts
    extension-registry.ts         extension-registry.ts
    lifecycle-hooks.ts            lifecycle-hooks.ts
    tool-hook-types.ts            tool-hook-types.ts
    tool-hook-observability.ts    tool-hook-observability.ts
    compact-lifecycle.ts          compact-lifecycle.ts
    health-hook-pack.ts           health-hook-pack.ts
  runtime-components/           runtime-components/
    execution-strategy.ts         execution-strategy.ts
    tool-executor.ts              tool-executor.ts
    tool-executor-options.ts      tool-executor-options.ts
    single-tool-executor.ts       single-tool-executor.ts
    context-manager.ts            context-manager.ts
    conversation-engine.ts        conversation-engine.ts
    provider-call-gateway.ts      provider-call-gateway.ts
    provider-response-consumer.ts provider-response-consumer.ts
    token-estimator.ts            token-estimator.ts
    context-compression-gate.ts   context-compression-gate.ts
  checkpoint/                   checkpoint/
    checkpoint-manager.ts         checkpoint-manager.ts
  checkpoints.ts                checkpoint/checkpoints.ts
  checkpoint-manifest.ts        checkpoint/checkpoint-manifest.ts
  event-architecture/           event/
    canonical-event.ts            canonical-event.ts
  event-protocol/               event/
    core-event-types.ts           core-event-types.ts
    core-event-projector.ts       core-event-projector.ts
  event-queue/                  event/
    event-queue.ts                event-queue.ts
  approval/                     approval/
    approval-pipeline.ts          pipeline.ts
    approval-cache.ts             cache.ts
    chain-approval.ts             chain.ts
  blob-externalization.ts       blob-externalization.ts
  config/                       config/
    config-merger.ts              config-merger.ts
  IAgentRuntime.ts              IAgentRuntime.ts
  ISessionStore.ts              ISessionStore.ts
```

**New `index.ts`**:

```ts
// packages/agent-core/src/index.ts
export { AgentRuntime } from './core/agent-runtime';
export type { IAgentRuntime } from './IAgentRuntime';
export type { ISessionStore } from './ISessionStore';
export * from './state-machine/types';
export * from './approval/types';
export * from './session/types';
export * from './control/types';
export * from './steering/types';
export * from './event/types';
export * from './hooks/types';
```

**package.json**:

```json
{
  "name": "@crish/agent-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "dependencies": {
    "@crish/shared-types": "*",
    "@crish/agent-context": "*",
    "@crish/agent-model": "*",
    "@crish/agent-tools": "*",
    "@crish/agent-permissions": "*"
  },
  "devDependencies": {
    "@crish/shared-utils": "*",
    "@crish/agent-stream": "*"
  }
}
```

### 2.2 `@crish/agent-tools`

**Responsibility**: Tool definitions, tool registry, tool execution, tool middleware, local workspace tools, LSP tools.

**Source files map**:

```
packages/agent-runtime/src/  →  packages/agent-tools/src/
  tools/                        registry/
    index.ts                      index.ts
    tool-definition.ts            tool-definition.ts
    tool-middleware.ts            middleware.ts
    tool-preset-registry.ts       preset-registry.ts
    tool-system.test.ts           __tests__/tool-system.test.ts
  tool-registry.ts              registry/simple-registry.ts
  tool-stream/                  stream/
    tool-stream.ts                tool-stream.ts
  tool-discovery.ts             discovery/discovery.ts
  tools.ts                      execution/tool-executor.ts
  local-tools/                  workspace/
    types.ts                      types.ts
    shared.ts                     shared.ts
    fs-edit-tools.ts              fs-edit.ts
    fs-edit-tools/                fs-edit/
    fs-read-tools.ts              fs-read.ts
    shell-tools.ts                shell.ts
    search-tools.ts               search.ts
    checkpoint-tools.ts           checkpoint-tools.ts
    pre-mutation.ts               pre-mutation.ts
  lsp-tools.ts                  lsp/lsp-tools.ts
```

**New `index.ts`**:

```ts
export { ToolRegistry } from './registry/tool-definition';
export type {
  ToolDefinition,
  ToolRegistrationOptions,
  LlmToolDefinition,
} from './registry/tool-definition';
export type {
  ToolMiddleware,
  MiddlewareBeforeResult,
  MiddlewareAfterResult,
} from './registry/middleware';
export {
  PermissionMiddleware,
  CheckpointMiddleware,
  OutputMaterializationMiddleware,
} from './registry/middleware';
export * from './workspace/types';
export * from './workspace/fs-edit';
export * from './workspace/fs-read';
export * from './workspace/shell';
export * from './workspace/search';
export * from './lsp/lsp-tools';
export { createLocalWorkspaceTools } from './workspace/factory';
```

### 2.3 `@crish/agent-stream`

**Responsibility**: SSE streaming, stream parsing per provider, thinking config.

**Source files map**:

```
packages/agent-runtime/src/  →  packages/agent-stream/src/
  stream/                       sse/
    streaming-tool-executor.ts    streaming-tool-executor.ts
    thinking-config.ts            thinking-config.ts
  openai-stream-parse.ts        parse/openai.ts
  anthropic-stream-parse.ts     parse/anthropic.ts
  gemini-stream-parse.ts        parse/gemini.ts
  openai-request-build.ts       build/openai.ts
  anthropic-request-build.ts    build/anthropic.ts
  gemini-request-build.ts       build/gemini.ts
```

**New `index.ts`**:

```ts
export { StreamingToolExecutor } from './sse/streaming-tool-executor';
export type { ThinkingConfig } from './sse/thinking-config';
export * from './parse/types';
export { parseOpenAIStream } from './parse/openai';
export { parseAnthropicStream } from './parse/anthropic';
export { parseGeminiStream } from './parse/gemini';
export { buildOpenAIRequest } from './build/openai';
export { buildAnthropicRequest } from './build/anthropic';
export { buildGeminiRequest } from './build/gemini';
```

### 2.4 `@crish/agent-context`

**Responsibility**: Context compression strategies, token estimation, context slicing, encoding.

**Source files map**:

```
packages/agent-runtime/src/  →  packages/agent-context/src/
  context-compression/          compression/
    compression-utils.ts          utils.ts
    index.ts                      index.ts (strategies)
    serializer.ts                 serializer.ts
    token-estimator.ts            token-estimator.ts
  context-compression.ts        compression/composite.ts
  context-slicer.ts             slicer.ts
  context-state.ts              state/context-state.ts
  context-projection.ts         projection.ts
  encoding.ts                   encoding.ts
  wasm-tiktoken.ts              wasm-tiktoken.ts
```

### 2.5 `@crish/agent-model`

**Responsibility**: Provider abstraction, model routing, provider gateway, pricing, fallback.

**Source files map**:

```
packages/agent-runtime/src/  →  packages/agent-model/src/
  provider/                     spi/
    spi/                          index.ts
      index.ts                    provider-factory.ts
      provider-factory.ts         provider-class.ts
      provider-class.ts           engine-class.ts
      engine-class.ts
    factory.ts                    factory.ts
    loader.ts                     loader.ts
    registry-v2.ts                registry.ts
    types.ts                      types.ts
    health-checker.ts             health-checker.ts
    faux-provider.ts              faux/faux-provider.ts
    provider-gateway-v2.ts        gateway-v2.ts
    declarative-schema.ts         declarative-schema.ts
  provider-gateway/             gateway/
    index.ts                      index.ts
    types.ts                      types.ts
    factory.ts                    factory.ts
    credential-resolver.ts        credential-resolver.ts
    route-selector.ts             route-selector.ts
  provider-transport/           transport/
    index.ts                      index.ts
    connection-manager.ts         connection-manager.ts
    stream-recovery.ts            stream-recovery.ts
    token-tracker.ts              token-tracker.ts
  model-routing/                routing/
    index.ts                      index.ts
    types.ts                      types.ts
    matcher.ts                    matcher.ts
    profile.ts                    profile.ts
  model-routing.ts              routing/enhanced.ts
  model-routing-roles.ts        routing/roles.ts
  model-catalog/                catalog/
    types.ts                      types.ts
    catalog-sync.ts               catalog-sync.ts
  provider-openai-*.ts          providers/openai/
  provider-anthropic.ts         providers/anthropic/
  provider-gemini.ts            providers/gemini/
  provider-openai-compatible.ts providers/compatible/
  provider-stream-contract/     contract/
    types.ts                      types.ts
    normalizer.ts                 normalizer.ts
    sequencer.ts                  sequencer.ts
    error.ts                      error.ts
    json-repair.ts                json-repair.ts
  provider-cache-hints.ts       cache-hints.ts
  provider-error-classifier.ts  error-classifier.ts
  provider-request-machine.ts   request-machine.ts
  fallback-chain/               fallback/
    engine.ts                     engine.ts
    types.ts                      types.ts
  pricing-engine.ts             pricing.ts
```

### 2.6 `@crish/agent-mcp`

**Responsibility**: MCP lifecycle, MCP protocol utilities.

**Source files map**:

```
packages/agent-runtime/src/  →  packages/agent-mcp/src/
  mcp-lifecycle/                lifecycle/
    index.ts                      index.ts
    types.ts                      types.ts
    utils.ts                      utils.ts
    mcp-lifecycle-manager.ts      manager.ts
    mcp-server-controller.ts      controller.ts
```

### 2.7 `@crish/agent-permissions`

**Responsibility**: Trust zone policy, permission engine, command classification.

**Source files map**:

```
packages/agent-runtime/src/  →  packages/agent-permissions/src/
  permission/                   policy/
    trust-zone-policy.ts          trust-zone.ts
    command-classification.ts     command-classification.ts
```

Currently, `decision-engine` also has permission logic. The goal is:

- `decision-engine` → command classification + risk + hardline patterns (decision layer)
- `agent-permissions` → runtime trust zone policy (permission enforcement at runtime)

```
packages/decision-engine/src/  →  packages/agent-permissions/src/ (only permission-related)
  permission-engine.ts
  permissions.ts
```

### 2.8 `@crish/agent-subagent`

**Responsibility**: Subagent dispatch, subagent skill runner, context packing.

**Source files map**:

```
packages/agent-runtime/src/  →  packages/agent-subagent/src/
  subagents.ts                  dispatch/subagent-dispatcher.ts
  subagent-loop.ts              dispatch/subagent-loop.ts
  subagent-skill-runner.ts      dispatch/skill-runner.ts
  subagent-types.ts             types.ts
  subagent-context-pack.ts      context-pack.ts
```

### 2.9 `packages/agent-runtime` → Legacy Shim

Becomes a thin re-export barrel for backward compatibility:

```ts
// packages/agent-runtime/src/index.ts — LEGACY SHIM
export * from '@crish/agent-core';
export * from '@crish/agent-tools';
export * from '@crish/agent-stream';
export * from '@crish/agent-context';
export * from '@crish/agent-model';
export * from '@crish/agent-mcp';
export * from '@crish/agent-permissions';
export * from '@crish/agent-subagent';
```

**package.json changes**:

```json
{
  "name": "@crish/agent-runtime",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "@crish/agent-core": "*",
    "@crish/agent-tools": "*",
    "@crish/agent-stream": "*",
    "@crish/agent-context": "*",
    "@crish/agent-model": "*",
    "@crish/agent-mcp": "*",
    "@crish/agent-permissions": "*",
    "@crish/agent-subagent": "*"
  }
}
```

---

## 3. agent-orchestrator Split

### Current Structure (29 files)

```
packages/agent-orchestrator/src/
  artifact-store.ts, artifact-store.test.ts
  conversation-rewind.ts, conversation-rewind.test.ts
  event-store.ts, event-store.test.ts, event-store/
  event-store-projection.ts
  event-scan-goal-strategy.ts
  goal-continuation.ts
  orchestrator.ts, orchestrator.test.ts, orchestrator/
  protocol.ts, protocol.test.ts
  runtime-engine.ts
  session-summary.ts
  session-tree.ts, session-tree.test.ts
  state-machine.ts, state-machine.test.ts
  task-assessment.ts, task-assessment.test.ts
  types.ts
```

### Target Split

#### 3.1 `@crish/event-store` — New Package

**Files**:

```
packages/event-store/src/
  index.ts
  types.ts                           // Event, EventStore, EventProjection types
  event-store.ts                     // Core EventStore (was event-store.ts)
  event-store/
    in-memory.ts                     // InMemoryOrchestratorEventStore
    file-based.ts                    // FileEventStore (extracted from daemon)
  event-store-projection.ts          // Event projection logic
  event-scan-goal-strategy.ts        // Goal scanning from event stream
  epoch-snapshot.ts                  // Epoch snapshot logic
  state-snapshot.ts                  // State snapshot logic
```

#### 3.2 `@crish/session-state-machine` — New Package

**Files**:

```
packages/session-state-machine/src/
  index.ts
  state-machine.ts                   // Session state machine (was src/state-machine.ts)
  session-tree.ts                    // Session tree (was src/session-tree.ts)
  session-summary.ts                 // Session summary (was src/session-summary.ts)
  types.ts                           // State machine types
```

#### 3.3 `@crish/artifact-store` — New Package

**Files**:

```
packages/artifact-store/src/
  index.ts
  artifact-store.ts                  // Artifact store (was src/artifact-store.ts)
  types.ts                           // Artifact types
```

#### 3.4 `@crish/goal-continuation` — New Package

**Files**:

```
packages/goal-continuation/src/
  index.ts
  goal-continuation.ts               // Goal continuation (was src/goal-continuation.ts)
  task-assessment.ts                 // Task assessment (was src/task-assessment.ts)
  types.ts                           // Goal and task types
```

#### 3.5 `@crish/agent-orchestrator` — Slimmed

Remaining files:

```
packages/agent-orchestrator/src/
  index.ts
  orchestrator.ts                    // Orchestrator shell, delegates to sub-packages
  orchestrator/
    agent-loop.ts
    task-dispatcher.ts
  protocol.ts, protocol.test.ts
  conversation-rewind.ts
  runtime-engine.ts
  types.ts                           // Orchestrator-specific types only
```

---

## 4. agent-daemon Split

### Current Structure (75 files)

The daemon currently mixes:

- **Server/transport** (`server.ts`, `server/`, `protocol/`, `binary-frame.ts`)
- **Handlers** (`handlers/`) — 17 handler files
- **Provider** (`daemon-provider-gateway/`, `daemon-provider-gateway.ts`)
- **Lifecycle/approval** (`daemon-lifecycle.ts`, `daemon-approval-handler.ts`)
- **Storage** (`permission-store.ts`, `scoped-context-store.ts`, `plan-document-store.ts`, `workflow-store.ts`)
- **Subagent bridge** (`subagent-runtime.ts`, `subagent-lifecycle.ts`)
- **Workflow** (`workflow-scheduler.ts`)

### Target Split

#### 4.1 `@crish/daemon-server` — New Package

**Purpose**: Pure server transport layer (WebSocket, HTTP, binary framing).

```
packages/daemon-server/src/
  index.ts
  server/
    index.ts                          // DaemonServer class
    connection-manager.ts             // WebSocket connection registry
    message-router.ts                 // Message routing
    http-servers.ts                   // HTTP server setup
  protocol/
    protocol.ts                       // Protocol definitions
    protocol-types.ts                 // Wire protocol types
    protocol-codec.ts                 // Encode/decode protocol messages
    codec/                            // Binary codec
    registry.ts                       // Protocol message registry
    schema-groups.ts                  // Schema grouping
  binary-frame.ts                     // Binary framing
  capabilities.ts                     // Capability negotiation
  types/
    config.ts                         // DaemonConfig type
    entities.ts                       // Entity types
  daemon-client-registry.ts           // Client registry
```

#### 4.2 `@crish/daemon-handlers` — New Package

**Purpose**: All message handlers (routed by daemon-server).

```
packages/daemon-handlers/src/
  index.ts
  run-handlers.ts                    // Session run control
  run-handlers/
    stream-pause.ts
  session-handlers.ts                // Session CRUD
  approval-handlers.ts               // Approval flow
  config-handlers.ts                 // Config management
  mcp-handlers.ts                    // MCP forwarding
  subagent-handlers.ts               // Subagent control
  background-task-handlers.ts        // Background tasks
  git-handlers.ts                    // Git operations
  plan-document-handlers.ts          // Plan doc operations
  artifact-handlers.ts               // Artifact operations
  scoped-context-handlers.ts         // Scoped context
  pending-input-handlers.ts          // Pending input
  workflow-handlers.ts               // Workflow management
```

#### 4.3 `@crish/daemon-stores` — New Package

**Purpose**: Storage backends for the daemon.

```
packages/daemon-stores/src/
  index.ts
  permission-store.ts                // Permission decision store
  permission-store.adversarial.test.ts
  scoped-context-store.ts            // Scoped context store
  plan-document-store.ts             // Plan document persistence
  workflow-store.ts                  // Workflow definitions & runs
  session-metadata-store.ts          // Session metadata
  server-event-store.ts              // Server event store
  approval-queue.ts                  // Approval queue store
  approval-projection.ts             // Approval projection
  persistence.ts                     // File persistence utilities
```

#### 4.4 `@crish/daemon-lifecycle` — New Package

**Purpose**: Daemon lifecycle, subagent bridge, workflow scheduling.

```
packages/daemon-lifecycle/src/
  index.ts
  daemon-lifecycle.ts                // Start/stop lifecycle
  daemon-logger.ts                   // Daemon-specific logging
  daemon-approval-handler.ts         // Approval handler
  daemon-permission-policy.ts        // Permission policy
  daemon-provider-gateway.ts         // Provider gateway integration
  daemon-subagent-bridge.ts          // Subagent bridge
  subagent-runtime.ts                // Subagent runtime
  subagent-lifecycle.ts              // Subagent lifecycle
  workflow-scheduler.ts              // Workflow schedule engine
  background-task-manager.ts         // Background task manager
  scoped-context-runtime.ts          // Scoped context runtime
  scoped-context-query-handlers.ts   // Context query handlers
  env-whitelist.ts                   // Environment whitelist
  daemon-product-adapters.ts         // Product-specific adapters
  task-snapshot-projection.ts        // Task snapshot projection
  conversation-rewind-boundary.ts    // Rewind boundary
```

#### 4.5 `@crish/agent-daemon` — Slimmed Shell

**Remaining**: Bootstrap only.

```
packages/agent-daemon/src/
  index.ts                          // startDaemon() entry point (imports from sub-packages)
  server-runtime-factory.ts         // Factory wiring
  server-runtime-factory/
  test-temp-cleanup.ts              // Test utilities
```

---

## 5. Rust Side Refinements

### Current Crates (12)

```
crates/conex-types/         →  Keep as-is (core types)
crates/conex-compaction/    →  Keep as-is
crates/conex-db/           →  Keep as-is
crates/conex-diff/         →  Keep as-is
crates/conex-fs/           →  Keep as-is
crates/conex-ipc/          →  Keep as-is
crates/conex-markdown/     →  Keep as-is
crates/conex-net/          →  Keep as-is
crates/conex-sandbox/      →  Keep as-is
crates/conex-search/       →  Keep as-is
crates/conex-stream/       →  Keep as-is
crates/conex-test-utils/   →  Keep as-is
```

### New Crates

#### 5.1 `crates/conex-telemetry/`

**Purpose**: Structured telemetry, tracing, OpenTelemetry bridges.

```toml
[package]
name = "conex-telemetry"
description = "Structured telemetry and tracing for Conex daemon"
```

Depends on: `conex-types`

#### 5.2 `crates/conex-plugin/`

**Purpose**: Plugin system (WASM-based or dynamic lib loading).

```toml
[package]
name = "conex-plugin"
description = "Plugin system for Conex daemon — WASM plugin loading, sandbox, registry"
```

Depends on: `conex-types`, `conex-ipc`

#### 5.3 `crates/conex-events/`

**Purpose**: Event type definitions shared between Rust and TS via transpiled types.

```toml
[package]
name = "conex-events"
description = "Canonical event types — source of truth for event wire format"
```

Depends on: `conex-types`

### Cargo Workspace Update

Add to root `Cargo.toml` members:

```toml
members = [
    # ... existing ...
    "crates/conex-telemetry",
    "crates/conex-plugin",
    "crates/conex-events",
]
```

---

## 6. Cross-Package Dependency Graph

### 6.1 Leaf Layer (no internal dependencies)

```
┌───────────────────────────────────────────────┐
│  Leaf Packages (depend only on shared-types)   │
├───────────────────────────────────────────────┤
│  @crish/agent-stream     @crish/agent-context  │
│  @crish/agent-permissions                      │
│  @crish/event-store      @crish/artifact-store │
│  @crish/session-state-machine                  │
│  @crish/goal-continuation                      │
│  @crish/daemon-handlers   @crish/daemon-stores │
│  @crish/daemon-server                          │
└───────────────────────┬───────────────────────┘
                        │
┌───────────────────────▼───────────────────────┐
│  Middle Layer                                  │
├───────────────────────────────────────────────┤
│  @crish/agent-tools  ← agent-context           │
│  @crish/agent-model  ← agent-context, stream   │
│  @crish/agent-mcp    ← agent-tools             │
│  @crish/agent-subagent ← agent-core, agent-mcp │
│  @crish/daemon-lifecycle ← daemon-stores       │
└───────────────────────┬───────────────────────┘
                        │
┌───────────────────────▼───────────────────────┐
│  Top Layer                                     │
├───────────────────────────────────────────────┤
│  @crish/agent-core                              │
│    ← context, model, tools, permissions, mcp    │
│  @crish/agent-orchestrator                      │
│    ← event-store, session-state-machine,        │
│      artifact-store, goal-continuation          │
│  @crish/agent-daemon (shell)                    │
│    ← daemon-server, daemon-handlers,            │
│      daemon-stores, daemon-lifecycle            │
└───────────────────────────────────────────────┘
```

### 6.2 Explicit Dependency Graph

```
@crish/shared-types          (no internal deps)
@crish/shared-utils          (no internal deps)
@crish/decision-engine       (dep: shared-types)
@crish/plugin-sdk            (dep: shared-types, agent-tools)

--- Leaf layer ---
@crish/agent-stream          (dep: shared-types)
@crish/agent-context         (dep: shared-types, agent-stream)
@crish/agent-permissions     (dep: shared-types, decision-engine)
@crish/agent-mcp             (dep: shared-types, agent-tools)
@crish/agent-tools           (dep: shared-types, agent-context)
@crish/agent-model           (dep: shared-types, agent-context, agent-stream)
@crish/agent-subagent        (dep: shared-types, agent-core, agent-mcp)
@crish/event-store           (dep: shared-types)
@crish/artifact-store        (dep: shared-types)
@crish/session-state-machine (dep: shared-types)
@crish/goal-continuation     (dep: shared-types, event-store)
@crish/daemon-server         (dep: shared-types, shared-utils)
@crish/daemon-handlers       (dep: shared-types, daemon-stores)
@crish/daemon-stores         (dep: shared-types, shared-utils)

--- Middle layer ---
@crish/daemon-lifecycle      (dep: daemon-server, daemon-stores, agent-model, agent-mcp, agent-subagent, agent-permissions)

--- Top layer ---
@crish/agent-core            (dep: agent-context, agent-model, agent-tools, agent-permissions, agent-mcp, event-store)
@crish/agent-orchestrator    (dep: event-store, session-state-machine, artifact-store, goal-continuation, agent-core)

--- Apps ---
@crish/agent-daemon          (dep: daemon-server, daemon-handlers, daemon-stores, daemon-lifecycle, agent-orchestrator, agent-runtime [legacy shim])
apps/crish-desktop           (dep: agent-runtime, agent-orchestrator, agent-daemon)
apps/agent-workbench         (dep: agent-runtime, agent-daemon)
```

### 6.3 DAG Validation

This graph is acyclic. Proof of topological order:

```
Level 0: shared-types, shared-utils
Level 1: decision-engine, plugin-sdk, agent-stream
Level 2: agent-context, agent-tools, agent-permissions, event-store, artifact-store, session-state-machine, daemon-server, daemon-stores
Level 3: agent-mcp, agent-model, goal-continuation, daemon-handlers
Level 4: agent-subagent
Level 5: agent-core, daemon-lifecycle
Level 6: agent-orchestrator
Level 7: agent-daemon, apps
```

No cycles. Each package only depends on packages at lower levels.

---

## 7. Migration Strategy

### Phase 0: Preparation (Week 1)

1. Create all target package directories with `package.json` and empty `src/index.ts`
2. Create legacy shim barrel in `agent-runtime`

```bash
# Create target packages
mkdir -p packages/agent-core/src
mkdir -p packages/agent-tools/src
mkdir -p packages/agent-stream/src
mkdir -p packages/agent-context/src
mkdir -p packages/agent-model/src
mkdir -p packages/agent-mcp/src
mkdir -p packages/agent-permissions/src
mkdir -p packages/agent-subagent/src
mkdir -p packages/event-store/src
mkdir -p packages/artifact-store/src
mkdir -p packages/session-state-machine/src
mkdir -p packages/goal-continuation/src
mkdir -p packages/daemon-server/src
mkdir -p packages/daemon-handlers/src
mkdir -p packages/daemon-stores/src
mkdir -p packages/daemon-lifecycle/src
```

3. Update root `package.json` workspaces:

```json
"workspaces": [
    "apps/*",
    "packages/*"
]
```

### Phase 1: Leaf Package Extraction (Week 2–3)

Extract packages that have no internal dependencies first.

**Step 1.1**: `@crish/agent-stream`

- Move `stream/`, `*-stream-parse.ts`, `*-request-build.ts`
- No change to imports yet — keep legacy shim in `agent-runtime`

**Step 1.2**: `@crish/agent-permissions`

- Move `permission/` from `agent-runtime` + permission pieces from `decision-engine`
- Update `decision-engine/src/index.ts` to re-export from `@crish/agent-permissions`

**Step 1.3**: `@crish/agent-context`

- Move `context-compression/`, `context-slicer.ts`, `context-state.ts`, `context-projection.ts`, `encoding.ts`, `wasm-tiktoken.ts`
- Add `@crish/agent-stream` as dependency

**Step 1.4**: `@crish/event-store`, `@crish/artifact-store`, `@crish/session-state-machine`, `@crish/goal-continuation`

- Copy files from `agent-orchestrator/src/`
- Update `agent-orchestrator/src/index.ts` to re-export from new packages (via `export * from '@crish/event-store'` etc.)

### Phase 2: Middle Layer (Week 3–4)

**Step 2.1**: `@crish/agent-tools`

- Move `tools/`, `tool-registry.ts`, `tool-stream/`, `local-tools/`, `lsp-tools.ts`, `tool-discovery.ts`
- Add `@crish/agent-context` dependency

**Step 2.2**: `@crish/agent-model`

- Move `provider/`, `provider-gateway/`, `provider-transport/`, `model-routing/`, `model-catalog/`, `fallback-chain/`, `pricing-engine.ts`
- Add `@crish/agent-context`, `@crish/agent-stream` as dependencies

**Step 2.3**: `@crish/agent-mcp`

- Move `mcp-lifecycle/`
- Add `@crish/agent-tools` dependency

**Step 2.4**: `@crish/daemon-server`, `@crish/daemon-stores`

- Extract server transport and stores from `agent-daemon`

### Phase 3: Top Layer (Week 4–5)

**Step 3.1**: `@crish/agent-core`

- Move the remaining big chunk from `agent-runtime/src/`
  - `runtime.ts`, `runtime-defaults.ts`, `runtime-metrics.ts`
  - `session-loop/`, `session/`, `session-store/`
  - `state-machine/`, `control/`, `steering/`, `hooks/`
  - `runtime-components/`, `checkpoint/`, `event-architecture/`, `event-protocol/`, `event-queue/`
  - `approval/`, `blob-externalization.ts`, `config/`, `agent-input-queue.ts`
- This is the most complex step — requires careful import path updates

**Step 3.2**: `@crish/agent-orchestrator` (slimmed)

- Remove extracted parts, keep only orchestrator shell

**Step 3.3**: `@crish/daemon-lifecycle`

- Extract lifecycle, subagent bridge, workflow scheduling from `agent-daemon`

### Phase 4: Final Cleanup (Week 5–6)

1. **Remove legacy shim**: `packages/agent-runtime/src/index.ts` becomes a thin re-export
2. **Update all imports** in consumer packages:
   - `@crish/agent-daemon` → imports from individual packages
   - `apps/crish-desktop` → imports from individual packages
3. **Run full test suite** to verify everything passes
4. **Delete original files** from `agent-runtime/src/`
5. **Final verification**: `npm run build && npm run test:core`

### Backward Compatibility Layer

During migration, each new package should have a deprecation notice at the top of its barrel:

```ts
/**
 * @deprecated Import from '@crish/agent-core' instead of '@crish/agent-runtime'
 */
```

Consumer packages that still import from `@crish/agent-runtime` will continue to work via the re-export shim. The `@crish/agent-runtime` `package.json` depends on all sub-packages:

```json
{
  "name": "@crish/agent-runtime",
  "dependencies": {
    "@crish/agent-core": "*",
    "@crish/agent-tools": "*",
    "@crish/agent-stream": "*",
    "@crish/agent-context": "*",
    "@crish/agent-model": "*",
    "@crish/agent-mcp": "*",
    "@crish/agent-permissions": "*",
    "@crish/agent-subagent": "*"
  }
}
```

This ensures `npm install` still resolves all transitive dependencies.

### CI/CD Pipeline Changes

Update `turbo.json` to reflect the new package graph:

```json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    },
    "typecheck": {
      "dependsOn": ["^build"]
    }
  }
}
```

The dependency graph in turbo.json will be auto-resolved from `package.json` dependencies.

---

## 8. File-Level Norms

### 8.1 Line Limits (from Codex CLI AGENTS.md)

| Rule                    | Limit                       | Exception                            |
| ----------------------- | --------------------------- | ------------------------------------ |
| Max lines per module    | ≤ 500 LoC (excluding tests) | N/A — split into submodules          |
| Max lines per file      | ≤ 800 LoC                   | Strong documented reason required    |
| Max lines per test file | ≤ 500 LoC                   | Separate into `__tests__/` directory |

### 8.2 Module Organization

```
packages/agent-core/src/
  core/
    agent-runtime.ts              # ≤500 LoC — runtime bootstrap
    runtime-defaults.ts           # ≤200 LoC — defaults
    runtime-metrics.ts            # ≤300 LoC — metrics
  session-loop/
    session-loop.ts               # ≤500 LoC — main loop
    session-loop-provider-call.ts # ≤300 LoC — provider call step
    session-loop-tool-execution.ts# ≤300 LoC — tool execution step
    session-loop-control-check.ts # ≤200 LoC — control check
    session-loop-steering-delegate.ts  # ≤200 LoC
    session-loop-recovery.ts      # ≤300 LoC
  state-machine/
    state-machine.ts              # ≤500 LoC — core state machine
    agent-session.ts              # ≤300 LoC
    session-branch.ts             # ≤200 LoC
    run-lifecycle.ts              # ≤300 LoC
    turn-types.ts                 # ≤200 LoC
  approval/
    pipeline.ts                   # ≤300 LoC
    cache.ts                      # ≤200 LoC
    chain.ts                      # ≤300 LoC
```

### 8.3 Test File Mapping

```
src/core/agent-runtime.ts           →  src/core/__tests__/agent-runtime.test.ts
src/session-loop/session-loop.ts    →  src/session-loop/__tests__/session-loop.test.ts
src/approval/pipeline.ts            →  src/approval/__tests__/pipeline.test.ts
```

Adversarial tests keep their `*.adversarial.test.ts` suffix and co-locate:

```
src/approval/pipeline.ts            →  src/approval/__tests__/pipeline.adversarial.test.ts
```

### 8.4 Import Path Conventions

- **Internal imports**: Relative (`./state-machine/types`)
- **Sibling package imports**: Named package (`@crish/agent-model`)
- **Shared types**: From `@crish/shared-types`
- **No deep imports**: Do not import from `@crish/agent-core/dist/...`

### 8.5 Export Hygiene

Each package's `index.ts` should:

1. **Export types first**: `export type { ... }`
2. **Export classes/functions**: `export { ... }`
3. **Re-export submodules**: `export * from './submodule'` only if submodule is part of public API
4. **Avoid barrel re-exports of internal modules**: Only expose what consumers need

### 8.6 Deprecation Annotations

For every re-export in the legacy shim:

```ts
/** @deprecated Import from '@crish/agent-model' instead. Will be removed in v0.3.0. */
export { ModelRouter } from '@crish/agent-model';
```

---

## 9. npm Workspace Configuration

### 9.1 Root `package.json` Workspaces

```json
{
  "name": "crish",
  "private": true,
  "workspaces": [
    "apps/crish-desktop",
    "apps/agent-workbench",
    "packages/agent-runtime",
    "packages/agent-core",
    "packages/agent-tools",
    "packages/agent-stream",
    "packages/agent-context",
    "packages/agent-model",
    "packages/agent-mcp",
    "packages/agent-permissions",
    "packages/agent-subagent",
    "packages/agent-orchestrator",
    "packages/agent-daemon",
    "packages/event-store",
    "packages/artifact-store",
    "packages/session-state-machine",
    "packages/goal-continuation",
    "packages/daemon-server",
    "packages/daemon-handlers",
    "packages/daemon-stores",
    "packages/daemon-lifecycle",
    "packages/shared-types",
    "packages/shared-utils",
    "packages/decision-engine",
    "packages/plugin-sdk",
    "packages/test-utils"
  ]
}
```

### 9.2 Turbo Configuration

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": ["**/.env.*local"],
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "build:types": {
      "dependsOn": ["^build:types"],
      "outputs": ["dist/**/*.d.ts"]
    },
    "typecheck": {
      "dependsOn": ["^build:types"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    },
    "clean": {
      "cache": false
    }
  }
}
```

### 9.3 TypeScript Project References

Root `tsconfig.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "./",
    "paths": {
      "@crish/agent-core": ["packages/agent-core/src"],
      "@crish/agent-tools": ["packages/agent-tools/src"],
      "@crish/agent-stream": ["packages/agent-stream/src"],
      "@crish/agent-context": ["packages/agent-context/src"],
      "@crish/agent-model": ["packages/agent-model/src"],
      "@crish/agent-mcp": ["packages/agent-mcp/src"],
      "@crish/agent-permissions": ["packages/agent-permissions/src"],
      "@crish/agent-subagent": ["packages/agent-subagent/src"],
      "@crish/event-store": ["packages/event-store/src"],
      "@crish/artifact-store": ["packages/artifact-store/src"],
      "@crish/session-state-machine": ["packages/session-state-machine/src"],
      "@crish/goal-continuation": ["packages/goal-continuation/src"],
      "@crish/daemon-server": ["packages/daemon-server/src"],
      "@crish/daemon-handlers": ["packages/daemon-handlers/src"],
      "@crish/daemon-stores": ["packages/daemon-stores/src"],
      "@crish/daemon-lifecycle": ["packages/daemon-lifecycle/src"]
    }
  },
  "references": [
    { "path": "packages/shared-types" },
    { "path": "packages/shared-utils" },
    { "path": "packages/decision-engine" },
    { "path": "packages/agent-stream" },
    { "path": "packages/agent-context" },
    { "path": "packages/agent-tools" },
    { "path": "packages/agent-permissions" },
    { "path": "packages/agent-model" },
    { "path": "packages/agent-mcp" },
    { "path": "packages/agent-subagent" },
    { "path": "packages/agent-core" },
    { "path": "packages/event-store" },
    { "path": "packages/artifact-store" },
    { "path": "packages/session-state-machine" },
    { "path": "packages/goal-continuation" },
    { "path": "packages/agent-orchestrator" },
    { "path": "packages/daemon-server" },
    { "path": "packages/daemon-handlers" },
    { "path": "packages/daemon-stores" },
    { "path": "packages/daemon-lifecycle" },
    { "path": "packages/agent-daemon" }
  ]
}
```

---

## 10. Implementation Checklist

### Phase 0 — Setup

- [ ] Create 16 new package directories
- [ ] Write `package.json` for each (name, version, deps)
- [ ] Update root `package.json` workspaces
- [ ] Update `tsconfig.json` project references
- [ ] Update `turbo.json` pipeline

### Phase 1 — Leaf Packages

- [ ] `@crish/agent-stream` — move stream parse/request build
- [ ] `@crish/agent-permissions` — move trust zone + permission
- [ ] `@crish/agent-context` — move compression + encoding
- [ ] `@crish/event-store` — extract from orchestrator
- [ ] `@crish/artifact-store` — extract from orchestrator
- [ ] `@crish/session-state-machine` — extract from orchestrator
- [ ] `@crish/goal-continuation` — extract from orchestrator
- [ ] Run `npm run test:core` — all pass

### Phase 2 — Middle Layer

- [ ] `@crish/agent-tools` — move tool definitions, local tools, LSP
- [ ] `@crish/agent-model` — move provider, routing, pricing
- [ ] `@crish/agent-mcp` — move MCP lifecycle
- [ ] `@crish/daemon-server` — extract server/transport from daemon
- [ ] `@crish/daemon-stores` — extract stores from daemon
- [ ] Run `npm run test:core` — all pass

### Phase 3 — Top Layer

- [ ] `@crish/agent-core` — move runtime, session-loop, state-machine, hooks, etc.
- [ ] `@crish/daemon-lifecycle` — extract lifecycle from daemon
- [ ] `@crish/agent-orchestrator` — slim down to shell
- [ ] `@crish/agent-daemon` — slim down to bootstrap
- [ ] Run `npm run build && npm run test:core` — all pass

### Phase 4 — Legacy Removal

- [ ] Remove re-exports from `agent-runtime` (keep only shim)
- [ ] Update all consumer import paths
- [ ] Run `npm run check:all` — all pass
- [ ] Run `npm run build` — all packages build
- [ ] Run `git status` — verify no circular imports

---

## Appendix A: New Package Index

| #   | Package Name                   | New/Existing | Source                          | Approx. Files |
| --- | ------------------------------ | ------------ | ------------------------------- | ------------- |
| 1   | `@crish/agent-core`            | New          | agent-runtime (core)            | ~60           |
| 2   | `@crish/agent-tools`           | New          | agent-runtime (tools)           | ~25           |
| 3   | `@crish/agent-stream`          | New          | agent-runtime (stream)          | ~10           |
| 4   | `@crish/agent-context`         | New          | agent-runtime (context)         | ~10           |
| 5   | `@crish/agent-model`           | New          | agent-runtime (provider)        | ~50           |
| 6   | `@crish/agent-mcp`             | New          | agent-runtime (mcp)             | ~6            |
| 7   | `@crish/agent-permissions`     | New          | agent-runtime + decision-engine | ~5            |
| 8   | `@crish/agent-subagent`        | New          | agent-runtime (subagent)        | ~5            |
| 9   | `@crish/agent-runtime`         | Legacy       | — (shim)                        | ~1            |
| 10  | `@crish/event-store`           | New          | agent-orchestrator              | ~6            |
| 11  | `@crish/artifact-store`        | New          | agent-orchestrator              | ~2            |
| 12  | `@crish/session-state-machine` | New          | agent-orchestrator              | ~4            |
| 13  | `@crish/goal-continuation`     | New          | agent-orchestrator              | ~2            |
| 14  | `@crish/agent-orchestrator`    | Slimmed      | —                               | ~6            |
| 15  | `@crish/daemon-server`         | New          | agent-daemon (server)           | ~15           |
| 16  | `@crish/daemon-handlers`       | New          | agent-daemon (handlers)         | ~17           |
| 17  | `@crish/daemon-stores`         | New          | agent-daemon (stores)           | ~10           |
| 18  | `@crish/daemon-lifecycle`      | New          | agent-daemon (lifecycle)        | ~15           |
| 19  | `@crish/agent-daemon`          | Slimmed      | —                               | ~3            |

**Total new packages**: 16 (from current 9 → 25 total workspaces)

## Appendix B: Key Interface Contracts

### B.1 IAgentRuntime (lives in agent-core)

```ts
// packages/agent-core/src/IAgentRuntime.ts
export interface IAgentRuntime {
  abort(reason?: string): void;
  requestCooperativeStop?(reason?: string): void;
  getTokenTracker(): TokenTracker;
  enqueueSteerInput(message: AgentMessage): void;
  enqueueForceInput?(message: AgentMessage): void;
  hasPendingSteerInput(): boolean;
  peekSteerInput(): AgentMessage | null;
  dequeueSteerInput(): AgentMessage | undefined;
  run(
    userInput: string | AgentMessage
  ): AsyncGenerator<AgentEvent, AgentMessage[]>;
}
```

### B.2 ModelProvider (lives in agent-model)

```ts
// packages/agent-model/src/spi/provider-class.ts
export interface ModelProvider {
  readonly id: string;
  stream(request: ModelRequest): AsyncIterable<ProviderStreamEvent>;
  init?(): Promise<void>;
  dispose?(): Promise<void>;
  healthCheck?(): Promise<HealthCheckResult>;
}

export interface ModelRequest {
  sessionId: string;
  cwd: string;
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  signal: AbortSignal;
  promptAssembly?: PromptAssemblyMetadata;
}
```

### B.3 ToolRegistry (lives in agent-tools)

```ts
// packages/agent-tools/src/registry/tool-definition.ts
export class ToolRegistry {
  register(tool: AgentTool): void;
  get(name: string): AgentTool | undefined;
  list(): AgentTool[];
  listByCategory(): Record<string, AgentTool[]>;
}

export interface ToolMiddleware {
  before?(tool: AgentTool, input: JsonObject): Promise<MiddlewareBeforeResult>;
  after?(
    tool: AgentTool,
    input: JsonObject,
    output: ToolOutput
  ): Promise<MiddlewareAfterResult>;
}
```

### B.4 StreamParser (lives in agent-stream)

```ts
// packages/agent-stream/src/parse/types.ts
export interface StreamParser {
  parse(chunk: string): ProviderStreamEvent[];
  reset(): void;
}

export type StreamParserFactory = (
  options?: StreamParserOptions
) => StreamParser;
```

### B.5 ContextCompressor (lives in agent-context)

```ts
// packages/agent-context/src/compression/index.ts
export interface ContextCompressor {
  shouldCompress(state: ContextState): boolean;
  compress(
    conversation: AgentMessage[],
    state: ContextState
  ): Promise<CompressionResult>;
  estimateTokens(text: string): number;
}
```

### B.6 EventStore (lives in event-store)

```ts
// packages/event-store/src/types.ts
export interface EventStore {
  append(event: StoredEvent): Promise<void>;
  readRange(
    sessionId: string,
    fromSeq: number,
    toSeq?: number
  ): Promise<StoredEvent[]>;
  readLatest(sessionId: string, limit: number): Promise<StoredEvent[]>;
  getSnapshot(sessionId: string): Promise<StateSnapshot | null>;
  saveSnapshot(sessionId: string, snapshot: StateSnapshot): Promise<void>;
}
```

### B.7 DaemonServer (lives in daemon-server)

```ts
// packages/daemon-server/src/server/index.ts
export class DaemonServer {
  constructor(config: DaemonConfig);
  start(): Promise<number>;
  stop(): Promise<void>;
  setProviderFactory(factory: ProviderFactory): void;
  setToolFactory(factory: ToolFactory): void;
  setConfigUpdateHandler(handler: ConfigUpdateHandler): void;
  recordLifecycleError(error: LifecycleError): void;
}
```

---

## Appendix C: File-Size Audit for Current Hot Spots

Files in current `agent-runtime/src/` exceeding 500 LoC (to be split during migration):

| File                                              | Est. Lines | Split Plan                                                                                                       |
| ------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `types.ts`                                        | ~285       | Move provider types to `agent-model/types.ts`; runtime options to `agent-core`; context types to `agent-context` |
| `runtime.ts`                                      | ~248       | Keep in `agent-core/core/agent-runtime.ts`; extract dependencies as imports                                      |
| `runtime-components/tool-executor.ts`             | ~300+      | Keep in `agent-core/runtime-components/tool-executor.ts`                                                         |
| `runtime-components/conversation-engine.ts`       | ~300+      | Keep in `agent-core/runtime-components/conversation-engine.ts`                                                   |
| `provider/provider-gateway-v2.ts`                 | ~200+      | Move to `agent-model/gateway-v2.ts`                                                                              |
| `provider/registry-v2.ts`                         | ~150+      | Move to `agent-model/registry.ts`                                                                                |
| `local-tools/fs-edit-tools.ts`                    | ~400+      | Keep in `agent-tools/workspace/fs-edit.ts` (split into read/write)                                               |
| `local-tools/shell-tools.ts`                      | ~200+      | Keep in `agent-tools/workspace/shell.ts`                                                                         |
| `local-tools/search-tools.ts`                     | ~200+      | Keep in `agent-tools/workspace/search.ts`                                                                        |
| `prompt-assembly.ts`                              | ~200+      | Move to `agent-core/prompt-assembly.ts`                                                                          |
| `agent-session-loop.ts` → `session-loop/index.ts` | ~200+      | Already split into sub-modules                                                                                   |
| `subagents.ts`                                    | ~200+      | Move to `agent-subagent/dispatch/subagent-dispatcher.ts` (split into sub-modules)                                |
| `mcp-lifecycle/mcp-lifecycle-manager.ts`          | ~200+      | Move to `agent-mcp/lifecycle/manager.ts`                                                                         |
| `hooks/lifecycle-hooks.ts`                        | ~150+      | Move to `agent-core/hooks/lifecycle-hooks.ts`                                                                    |
| `hooks/extension-registry.ts`                     | ~150+      | Move to `agent-core/hooks/extension-registry.ts`                                                                 |

---

_End of Plan 03. See `analysis/plan-04-*.md` for executable build scripts._
