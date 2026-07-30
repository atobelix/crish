/**
 * Core Event Protocol - Public exports
 *
 * Layer 4 of the conex architecture improvement plan:
 * "Event Protocol - Unified Skeleton + Consumer-side Aggregation"
 *
 * This module provides:
 * 1. CoreEventBase and CoreAgentEvent type definitions (6 domains + phase mechanism)
 * 2. CoreEventProjector - maps 24 internal AgentEvent types to 6 CoreAgentEvent domains
 * 3. Type guard utilities for CoreAgentEvent domain discrimination
 * 4. Domain string constants for switch statements
 */

// ─── Type definitions ──────────────────────────────────────

export type {
  // Core base
  CoreEventBase,

  // Phase & severity types
  AgentPhase,
  TurnPhase,
  MessagePhase,
  ToolPhase,
  CompressionPhase,
  DiagnosticSeverity,

  // Meta types
  AgentMeta,
  TurnMeta,
  MessageMeta,
  ToolMeta,
  CompressionMeta,
  DiagnosticMeta,
  DiagnosticDetails,

  // Diagnostic detail subtypes
  ApprovalRequestedDetails,
  ApprovalResolvedDetails,
  RuntimeSteeringDetails,
  RuntimeErrorDetails,
  ProviderDiagnosticDetails,
  CheckpointCreatedDetails,
  CheckpointRestoredDetails,
  ToolInputRepairedDetails,
  RunTerminalDetails,

  // Core event union type
  CoreAgentEvent,

  // Domain type
  CoreEventDomain,
} from "./core-event-types";

// ─── Constants ──────────────────────────────────────────────

export {
  CORE_EVENT_DOMAINS,
} from "./core-event-types";

// ─── Projector ──────────────────────────────────────────────

export {
  CoreEventProjector,
  isCoreEventDomain,
  isPhasedCoreEvent,
  isDiagnosticCoreEvent,
  getCoreEventPhase,
  getCoreEventSeverity,
} from "./core-event-projector";