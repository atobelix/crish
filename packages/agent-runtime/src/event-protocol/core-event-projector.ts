/**
 * Core Event Projector - Maps 24 internal AgentEvent types to 6 CoreAgentEvent domains
 *
 * Layer 4 of the conex architecture improvement plan.
 *
 * The projector is the mapping layer between the internal AgentEvent system
 * (24 types for runtime internals) and the external CoreAgentEvent contract
 * (6 domains for UI, daemon, orchestrator consumers).
 *
 * Design principles:
 * 1. The projector is a PURE MAPPING layer - it does not modify, filter, or
 *    enrich events. It only restructures them into the 6-domain format.
 * 2. The internal 24 AgentEvent types remain unchanged for backward compatibility.
 * 3. The projector is deterministic: the same AgentEvent always produces the
 *    same CoreAgentEvent.
 * 4. "tool-update" in AgentEvent maps to tool phase "delta" in CoreAgentEvent
 *    (unified naming: both message and tool use start/delta/end).
 */

import type { AgentEvent } from "@crish/shared-types";
import type {
  CoreAgentEvent,
  CoreEventBase,
  AgentMeta,
  AgentPhase,
  TurnMeta,
  TurnPhase,
  MessageMeta,
  MessagePhase,
  ToolMeta,
  ToolPhase,
  CompressionMeta,
  CompressionPhase,
  DiagnosticMeta,
  DiagnosticSeverity,
  DiagnosticDetails,
} from "./core-event-types";

// ─── Provider diagnostic phase → severity mapping ──────────

/**
 * Maps ProviderDiagnostic phase to DiagnosticSeverity.
 *
 * Progress phases → info
 * Recovery/fallback phases → warn
 * Error phases → error
 */
function providerDiagnosticSeverity(phase: string): DiagnosticSeverity {
  switch (phase) {
    // Normal progress events
    case "request-start":
    case "response-start":
    case "sse-first-byte":
    case "stream-end":
    case "model-selected":
      return "info";

    // Recovery/fallback - something went wrong but we're handling it
    case "retry":
    case "endpoint-fallback":
    case "transport-fallback":
    case "model-mismatch":
      return "warn";

    // Error - something failed
    case "request-error":
      return "error";

    // Unknown phases default to info
    default:
      return "info";
  }
}

// ─── Timestamp extraction ───────────────────────────────────

/**
 * Extracts timestamp from an AgentEvent.
 *
 * Most AgentEvent types have a `timestamp` field directly.
 * The exceptions are `message-start` and `message-end`, which
 * carry their timestamp inside `message.createdAt`.
 */
function extractEventTimestamp(event: AgentEvent): string {
  if (event.type === "message-start" || event.type === "message-end") {
    return event.message.createdAt;
  }
  // All other AgentEvent variants have `timestamp: string`
  return event.timestamp;
}

// ─── CoreEventProjector ────────────────────────────────────

/**
 * CoreEventProjector maps internal AgentEvent types to external CoreAgentEvent domains.
 *
 * Usage:
 * ```typescript
 * const projector = new CoreEventProjector();
 * for await (const event of runtime.run(input)) {
 *   const coreEvent = projector.project(event);
 *   // Consumer switches on coreEvent.type (6 cases, not 24)
 * }
 * ```
 *
 * The projector can also accept optional tracing context (traceId, spanId)
 * to enrich the CoreEventBase fields. This is useful when the projector is
 * used within a traced pipeline.
 */
export class CoreEventProjector {
  /**
   * Project an internal AgentEvent to a CoreAgentEvent.
   *
   * @param event - The internal AgentEvent to project
   * @param tracing - Optional tracing context to add to CoreEventBase
   * @returns The projected CoreAgentEvent
   */
  project(event: AgentEvent, tracing?: { traceId?: string; spanId?: string }): CoreAgentEvent {
    const base: CoreEventBase = {
      sessionId: event.sessionId,
      timestamp: extractEventTimestamp(event),
      traceId: tracing?.traceId,
      spanId: tracing?.spanId,
    };

    switch (event.type) {
      // ─── Agent domain ──────────────────────────────────────
      case "agent-start":
        return {
          ...base,
          type: "agent",
          phase: "start",
          meta: {},
        };

      case "agent-end":
        return {
          ...base,
          type: "agent",
          phase: "end",
          meta: {
            reason: event.reason,
            error: event.error,
          },
        };

      case "runtime-intervention-required":
        return {
          ...base,
          type: "agent",
          phase: "intervention-required",
          meta: {
            interventionReason: event.reason as never,
            choices: event.choices as never,
            interventionMessage: event.message,
          },
        };

      // ─── Turn domain ───────────────────────────────────────
      case "turn-start":
        return {
          ...base,
          type: "turn",
          phase: "start",
          meta: {
            turnIndex: event.turnIndex,
          },
        };

      case "turn-end":
        return {
          ...base,
          type: "turn",
          phase: "end",
          meta: {
            turnIndex: event.turnIndex,
            toolCallCount: event.toolCallCount,
          },
        };

      // ─── Message domain ────────────────────────────────────
      case "message-start":
        return {
          ...base,
          type: "message",
          phase: "start",
          meta: {
            message: event.message,
          },
        };

      case "message-delta":
        return {
          ...base,
          type: "message",
          phase: "delta",
          meta: {
            messageId: event.messageId,
            block: event.block,
          },
        };

      case "message-end":
        return {
          ...base,
          type: "message",
          phase: "end",
          meta: {
            message: event.message,
          },
        };

      // ─── Tool domain ───────────────────────────────────────
      case "tool-batch-start":
        return {
          ...base,
          type: "tool",
          phase: "start",
          meta: {
            batchId: event.batchId,
            summary: event.summary,
            calls: event.calls,
          },
        };

      case "tool-batch-end":
        return {
          ...base,
          type: "tool",
          phase: "end",
          meta: {
            batchId: event.batchId,
            batchResults: event.calls,
          },
        };

      case "tool-start":
        return {
          ...base,
          type: "tool",
          phase: "start",
          meta: {
            batchId: event.batchId,
            call: event.call,
          },
        };

      case "tool-update":
        // KEY: tool-update maps to tool phase "delta" (unified naming)
        return {
          ...base,
          type: "tool",
          phase: "delta",
          meta: {
            batchId: event.batchId,
            toolCallId: event.toolCallId,
            update: event.update,
          },
        };

      case "tool-end":
        return {
          ...base,
          type: "tool",
          phase: "end",
          meta: {
            batchId: event.batchId,
            result: event.result,
          },
        };

      // ─── Compression domain ────────────────────────────────
      case "context-compression-start":
        return {
          ...base,
          type: "compression",
          phase: "start",
          meta: {
            reason: event.reason as never,
            tokensBefore: event.tokensBefore,
          },
        };

      case "context-compression-end":
        return {
          ...base,
          type: "compression",
          phase: "end",
          meta: {
            result: event.result,
            aborted: event.aborted,
            error: event.error,
          },
        };

      // ─── Diagnostic domain ─────────────────────────────────
      case "approval-requested":
        return {
          ...base,
          type: "diagnostic",
          severity: "info",
          meta: {
            originalType: "approval-requested",
            message: `Approval requested for ${event.request.toolName}: ${event.request.summary}`,
            details: {
              kind: "approval-requested",
              request: event.request,
            },
          },
        };

      case "approval-resolved":
        return {
          ...base,
          type: "diagnostic",
          severity: "info",
          meta: {
            originalType: "approval-resolved",
            message: `Approval resolved: ${event.decision.behavior}`,
            details: {
              kind: "approval-resolved",
              requestId: event.requestId,
              decision: event.decision,
            },
          },
        };

      case "runtime-steering":
        return {
          ...base,
          type: "diagnostic",
          severity: "info",
          meta: {
            originalType: "runtime-steering",
            message: `Runtime steering injected: ${event.reason}`,
            details: {
              kind: "runtime-steering",
              reason: event.reason as never,
              message: event.message,
            },
          },
        };

      case "runtime-error":
        return {
          ...base,
          type: "diagnostic",
          severity: "error",
          meta: {
            originalType: "runtime-error",
            message: `Runtime error: ${event.error}`,
            details: {
              kind: "runtime-error",
              error: event.error,
            },
          },
        };

      case "provider-diagnostic":
        return {
          ...base,
          type: "diagnostic",
          severity: providerDiagnosticSeverity(event.diagnostic.phase),
          meta: {
            originalType: "provider-diagnostic",
            message: `Provider diagnostic: ${event.diagnostic.phase}`,
            details: {
              kind: "provider-diagnostic",
              diagnostic: event.diagnostic,
            },
          },
        };

      case "checkpoint-created":
        return {
          ...base,
          type: "diagnostic",
          severity: "info",
          meta: {
            originalType: "checkpoint-created",
            message: `Checkpoint created: ${event.checkpoint.label}`,
            details: {
              kind: "checkpoint-created",
              checkpoint: event.checkpoint,
            },
          },
        };

      case "checkpoint-restored":
        return {
          ...base,
          type: "diagnostic",
          severity: "info",
          meta: {
            originalType: "checkpoint-restored",
            message: `Checkpoint restored: ${event.restore.checkpointId}`,
            details: {
              kind: "checkpoint-restored",
              restore: event.restore,
            },
          },
        };

      case "tool-input-repaired":
        return {
          ...base,
          type: "diagnostic",
          severity: "info",
          meta: {
            originalType: "tool-input-repaired",
            message: `Tool input repaired: ${event.toolName} (${event.notes.join(", ")})`,
            details: {
              kind: "tool-input-repaired",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              notes: event.notes,
            },
          },
        };

      case "run-terminal":
        // run-terminal: severity based on terminal status
        const terminalSeverity: DiagnosticSeverity =
          event.terminal === "failed" ? "error" :
          event.terminal === "cancelled" ? "warn" : "info";
        return {
          ...base,
          type: "diagnostic",
          severity: terminalSeverity,
          meta: {
            originalType: "run-terminal",
            message: `Run ${event.terminal}: ${event.runId}${event.error ? ` (${event.error})` : ""}`,
            details: {
              kind: "run-terminal",
              runId: event.runId,
              terminal: event.terminal,
              error: event.error,
            },
          },
        };

      default:
        // Exhaustive check: this should never happen if all 24 types are handled
        // but we provide a safe fallback for unknown types
        const _exhaustive: never = event;
        return {
          ...base,
          type: "diagnostic",
          severity: "info",
          meta: {
            originalType: (event as { type: string }).type,
            message: `Unknown event type: ${(event as { type: string }).type}`,
          },
        };
    }
  }
}

// ─── Type guard utilities ──────────────────────────────────

/**
 * Type guard: check if a CoreAgentEvent belongs to a specific domain.
 */
export function isCoreEventDomain<T extends CoreAgentEvent["type"]>(
  event: CoreAgentEvent,
  domain: T,
): event is Extract<CoreAgentEvent, { type: T }> {
  return event.type === domain;
}

/**
 * Type guard: check if a CoreAgentEvent is a phased event (agent, turn, message, tool, compression).
 */
export function isPhasedCoreEvent(
  event: CoreAgentEvent,
): event is Extract<CoreAgentEvent, { phase: string }> {
  return event.type !== "diagnostic";
}

/**
 * Type guard: check if a CoreAgentEvent is a diagnostic event.
 */
export function isDiagnosticCoreEvent(
  event: CoreAgentEvent,
): event is Extract<CoreAgentEvent, { type: "diagnostic" }> {
  return event.type === "diagnostic";
}

/**
 * Get the phase of a phased CoreAgentEvent.
 * Returns undefined for diagnostic events (which use severity instead).
 */
export function getCoreEventPhase(event: CoreAgentEvent): string | undefined {
  if (event.type === "diagnostic") return undefined;
  return event.phase;
}

/**
 * Get the severity of a diagnostic CoreAgentEvent.
 * Returns undefined for phased events (which use phase instead).
 */
export function getCoreEventSeverity(event: CoreAgentEvent): DiagnosticSeverity | undefined {
  if (event.type !== "diagnostic") return undefined;
  return event.severity;
}