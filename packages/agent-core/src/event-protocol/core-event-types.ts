/**
 * Core Event Protocol - Type Definitions
 *
 * Layer 4 of the conex architecture improvement plan:
 * "Event Protocol - Unified Skeleton + Consumer-side Aggregation"
 *
 * Design goals:
 * 1. Reduce 24 internal AgentEvent types to 6 core event domains for external consumers
 * 2. Unify naming: message and tool both use start/delta/end (not start/update/end)
 * 3. Keep internal AgentEvent types unchanged - CoreEventProjector is a MAPPING layer
 * 4. Provide a stable, simplified contract for UI, daemon, and orchestrator consumers
 *
 * The 6 core event domains:
 * - agent:       agent lifecycle (start, end, intervention-required)
 * - turn:        turn lifecycle (start, end)
 * - message:     message streaming (start, delta, end)
 * - tool:        tool execution (start, delta, end)
 * - compression: context compression (start, end)
 * - diagnostic:  informational/warning/error events (severity-based)
 */

import type {
  AgentMessage,
  AgentMessageBlock,
  ContextCompressionRecord,
  ContextCompressionTrigger,
  PermissionDecision,
  PermissionRequest,
  ProviderDiagnostic,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRestoreRecord,
  ToolBatchCall,
  ToolBatchResult,
  ToolProgressUpdate,
} from "@crish/shared-types";
import type {
  AgentEndReason,
  RuntimeRecoveryReason,
  RuntimeInterventionChoice,
} from '../core/runtime-options';

// ─── CoreEventBase ──────────────────────────────────────────

/**
 * Base interface shared by ALL CoreAgentEvent variants.
 *
 * Every core event carries session identity and timing info,
 * plus optional distributed-tracing fields for end-to-end correlation.
 */
export interface CoreEventBase {
  /** Session this event belongs to */
  sessionId: string;
  /** ISO 8601 timestamp of the event */
  timestamp: string;
  /** End-to-end trace ID (correlates events across layers) */
  traceId?: string;
  /** Current span ID (correlates events within a trace) */
  spanId?: string;
}

// ─── Phase types ────────────────────────────────────────────

/** Agent domain phases */
export type AgentPhase = "start" | "end" | "intervention-required";

/** Turn domain phases */
export type TurnPhase = "start" | "end";

/** Message domain phases */
export type MessagePhase = "start" | "delta" | "end";

/** Tool domain phases - uses "delta" (unified naming, replaces internal "update") */
export type ToolPhase = "start" | "delta" | "end";

/** Compression domain phases */
export type CompressionPhase = "start" | "end";

/** Diagnostic severity levels */
export type DiagnosticSeverity = "info" | "warn" | "error";

// ─── Meta types ─────────────────────────────────────────────

/**
 * Agent domain metadata
 *
 * Carries agent lifecycle data. Fields are populated based on phase:
 * - phase "start":           no extra fields (sessionId/timestamp are in CoreEventBase)
 * - phase "end":             reason, error
 * - phase "intervention-required": interventionReason, choices, interventionMessage
 */
export interface AgentMeta {
  /** Agent end reason (phase: "end") */
  reason?: AgentEndReason;
  /** Error message if agent ended due to error (phase: "end") */
  error?: string;
  /** Runtime recovery reason (phase: "intervention-required") */
  interventionReason?: RuntimeRecoveryReason;
  /** Available intervention choices (phase: "intervention-required") */
  choices?: RuntimeInterventionChoice[];
  /** Human-readable intervention message (phase: "intervention-required") */
  interventionMessage?: string;
}

/**
 * Turn domain metadata
 *
 * Carries turn lifecycle data:
 * - phase "start": turnIndex
 * - phase "end":   turnIndex, toolCallCount
 */
export interface TurnMeta {
  /** Turn index within the session */
  turnIndex: number;
  /** Number of tool calls in this turn (phase: "end") */
  toolCallCount?: number;
}

/**
 * Message domain metadata
 *
 * Carries message streaming data:
 * - phase "start": message
 * - phase "delta": messageId, block
 * - phase "end":   message (complete)
 */
export interface MessageMeta {
  /** Full or partial message (phase: "start", "end") */
  message?: AgentMessage;
  /** Message ID for delta correlation (phase: "delta") */
  messageId?: string;
  /** Message block delta (phase: "delta") */
  block?: AgentMessageBlock;
}

/**
 * Tool domain metadata
 *
 * Carries tool execution data:
 * - phase "start": batchId, call (single tool) OR batchId, summary, calls (batch)
 * - phase "delta": batchId, toolCallId, update
 * - phase "end":   batchId, result (single tool) OR batchId, calls (batch)
 */
export interface ToolMeta {
  /** Batch ID this tool call belongs to */
  batchId?: string;
  /** Single tool call info (phase: "start" for tool-start) */
  call?: ToolBatchCall;
  /** Batch summary (phase: "start" for tool-batch-start) */
  summary?: string;
  /** Batch calls (phase: "start" for tool-batch-start, phase: "end" for tool-batch-end) */
  calls?: ToolBatchCall[];
  /** Tool call ID for progress updates (phase: "delta") */
  toolCallId?: string;
  /** Tool progress update data (phase: "delta") */
  update?: ToolProgressUpdate;
  /** Single tool result (phase: "end" for tool-end) */
  result?: ToolBatchResult;
  /** Batch results (phase: "end" for tool-batch-end) */
  batchResults?: ToolBatchResult[];
}

/**
 * Compression domain metadata
 *
 * Carries context compression lifecycle data:
 * - phase "start": reason, tokensBefore
 * - phase "end":   result, aborted, error
 */
export interface CompressionMeta {
  /** Compression trigger reason (phase: "start") */
  reason?: ContextCompressionTrigger;
  /** Token count before compression (phase: "start") */
  tokensBefore?: number;
  /** Compression result record (phase: "end") */
  result?: ContextCompressionRecord;
  /** Whether compression was aborted (phase: "end") */
  aborted?: boolean;
  /** Error if compression failed (phase: "end") */
  error?: string;
}

/**
 * Diagnostic domain metadata
 *
 * Carries diagnostic information in a uniform format regardless of
 * which internal AgentEvent type produced it. Consumers switch on
 * severity first (6 domains), then inspect originalType and details
 * if they need type-specific data.
 */
export interface DiagnosticMeta {
  /** The original AgentEvent type that was mapped to this diagnostic */
  originalType: string;
  /** Brief human-readable summary of the diagnostic */
  message: string;
  /** Domain-specific details carrying the original event payload */
  details?: DiagnosticDetails;
}

// ─── Diagnostic detail subtypes ─────────────────────────────

/**
 * Discriminated union of diagnostic detail payloads.
 *
 * Each variant carries the domain-specific data from the original
 * AgentEvent, keyed by the original event type.
 */
export type DiagnosticDetails =
  | ApprovalRequestedDetails
  | ApprovalResolvedDetails
  | RuntimeSteeringDetails
  | RuntimeErrorDetails
  | ProviderDiagnosticDetails
  | CheckpointCreatedDetails
  | CheckpointRestoredDetails
  | ToolInputRepairedDetails
  | RunTerminalDetails;

export interface ApprovalRequestedDetails {
  kind: "approval-requested";
  request: PermissionRequest;
}

export interface ApprovalResolvedDetails {
  kind: "approval-resolved";
  requestId: string;
  decision: PermissionDecision;
}

export interface RuntimeSteeringDetails {
  kind: "runtime-steering";
  reason: RuntimeRecoveryReason;
  message: AgentMessage;
}

export interface RuntimeErrorDetails {
  kind: "runtime-error";
  error: string;
}

export interface ProviderDiagnosticDetails {
  kind: "provider-diagnostic";
  diagnostic: ProviderDiagnostic;
}

export interface CheckpointCreatedDetails {
  kind: "checkpoint-created";
  checkpoint: RuntimeCheckpointRecord;
}

export interface CheckpointRestoredDetails {
  kind: "checkpoint-restored";
  restore: RuntimeCheckpointRestoreRecord;
}

export interface ToolInputRepairedDetails {
  kind: "tool-input-repaired";
  toolCallId: string;
  toolName: string;
  notes: string[];
}

export interface RunTerminalDetails {
  kind: "run-terminal";
  runId: string;
  terminal: "completed" | "cancelled" | "failed";
  error?: string;
}

// ─── CoreAgentEvent ─────────────────────────────────────────

/**
 * Core Agent Event - The unified event contract for external consumers.
 *
 * Maps 24 internal AgentEvent types to 6 core domains with a phase/severity
 * mechanism. External consumers (UI, daemon, orchestrator) switch on the
 * `type` field (6 cases) instead of 24, and then inspect `phase` or
 * `severity` plus `meta` for domain-specific data.
 *
 * Key naming decisions:
 * - Tool events use "delta" phase instead of internal "update" (unified naming)
 * - runtime-intervention-required is elevated to agent domain phase "intervention-required"
 * - runtime-steering, approvals, checkpoints, etc. are mapped to diagnostic domain
 * - provider-diagnostic severity is derived from its phase field
 *
 * Internal AgentEvent types remain unchanged. CoreEventProjector is the
 * mapping layer between the two systems.
 */
export type CoreAgentEvent =
  | (CoreEventBase & { type: "agent"; phase: AgentPhase; meta: AgentMeta })
  | (CoreEventBase & { type: "turn"; phase: TurnPhase; meta: TurnMeta })
  | (CoreEventBase & { type: "message"; phase: MessagePhase; meta: MessageMeta })
  | (CoreEventBase & { type: "tool"; phase: ToolPhase; meta: ToolMeta })
  | (CoreEventBase & { type: "compression"; phase: CompressionPhase; meta: CompressionMeta })
  | (CoreEventBase & { type: "diagnostic"; severity: DiagnosticSeverity; meta: DiagnosticMeta });

// ─── Domain type string constants ──────────────────────────

/**
 * The 6 core event domain type strings, for use in switch statements
 * and type guards without relying on string literals.
 */
export const CORE_EVENT_DOMAINS = [
  "agent",
  "turn",
  "message",
  "tool",
  "compression",
  "diagnostic",
] as const;

export type CoreEventDomain = (typeof CORE_EVENT_DOMAINS)[number];