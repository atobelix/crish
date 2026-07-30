// agent-core/src/index.ts
// Barrel for @crish/agent-core — Round 5 top-layer runtime execution kernel.

// Core runtime (Agent 5-A)
export * from './core/runtime';
export * from './core/IAgentRuntime';
export * from './core/runtime-defaults';
export * from './core/runtime-helpers';
export * from './core/runtime-options';

// Session loop (Agent 5-A)
export * from './session-loop';

// State machine (Agent 5-A)
export * from './state-machine';

// ControlBus L1/L2/L3 (Agent 5-A)
export * from './control';

// SteeringCoordinator + 3 strategies (Agent 5-A)
export * from './steering';

// Error classifier + bridge (Agent 5-B-1)
export * from './error-classifier';

// Recovery pipeline (Agent 5-B-1)
export * from './recovery-pipeline';

// Recovery / stream recovery (Agent 5-B-1)
export * from './recovery';

// Fallback chain (Agent 5-B-1)
export * from './fallback-chain';

// Hooks — observe/on dual mode (Agent 5-B-1, injunction 14)
export * from './hooks';

// Runtime components (Agent 5-B-2)
export * from './runtime-components';

// Runtime metrics (Agent 5-B-2)
export * from './runtime-metrics';

// Config (Agent 5-B-2)
export * from './config';

// Rendering (Agent 5-B-2)
export * from './rendering';

// Process lifecycle (Agent 5-B-2)
export * from './process-lifecycle';

// Event protocol (Agent 5-B-2)
export * from './event-protocol';

// Event queue (Agent 5-B-2)
export * from './event-queue';

// Tool stream (Agent 5-B-2)
export * from './tool-stream';

// Plan document (Agent 5-B-2)
export * from './plan-document';

// Thinking config (Agent 5-B-2)
export * from './stream';

// Testing infrastructure (Agent 5-B-2)
export * from './testing';

// Root-level modules (Agent 5-B-2)
export * from './agent-input-queue';
export * from './agent-session-loop';
