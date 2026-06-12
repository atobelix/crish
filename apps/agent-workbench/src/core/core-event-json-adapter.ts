/**
 * Core Event Projector - JSON Adapter
 *
 * Bridges the gap between the raw JSON payloads received from the
 * DaemonOrchestratorEvent stream and the typed CoreEventProjector.
 *
 * Architecture:
 *   DaemonOrchestratorEvent (JSON) -> JsonCoreEventProjector -> CoreAgentEvent (6 domains)
 *                                                             -> RuntimeEventProjector -> RuntimeProjectionState
 *
 * This adapter is the ONLY place where raw JSON is parsed into the
 * CoreAgentEvent contract. All downstream consumers (UI, daemon, etc.)
 * work with the typed 6-domain events.
 */

import type { CoreAgentEvent, CoreEventBase, DiagnosticSeverity } from "@crish/agent-runtime";

type JsonRecord = Record<string, unknown>;

/**
 * Project a raw JSON runtime event into a CoreAgentEvent.
 *
 * This is the JSON-compatible counterpart to CoreEventProjector.project().
 * It accepts untyped JsonRecord payloads (as received from the daemon
 * event stream) and produces the same 6-domain CoreAgentEvent output.
 *
 * @param runtimeEvent - The raw JSON payload from a runtime-event
 * @param context - Optional session/run context to fill missing fields
 */
export function projectJsonCoreEvent(
  runtimeEvent: JsonRecord,
  context?: { sessionId?: string; runId?: string; timestamp?: string | number }
): CoreAgentEvent | null {
  const type = stringValue(runtimeEvent.type);
  if (!type) return null;

  const base: CoreEventBase = {
    sessionId: stringValue(runtimeEvent.sessionId) ?? context?.sessionId ?? "",
    timestamp: stringValue(runtimeEvent.timestamp) ?? parseTimestamp(context?.timestamp),
  };

  switch (type) {
    // ─── Agent domain ──────────────────────────────────────
    case "agent-start":
      return { ...base, type: "agent", phase: "start", meta: {} };

    case "agent-end":
      return {
        ...base,
        type: "agent",
        phase: "end",
        meta: {
          reason: stringValue(runtimeEvent.reason),
          error: stringValue(runtimeEvent.error),
        } as Extract<CoreAgentEvent, { type: "agent" }>["meta"],
      };

    case "runtime-intervention-required":
      return {
        ...base,
        type: "agent",
        phase: "intervention-required",
        meta: {
          interventionReason: stringValue(runtimeEvent.reason) as never,
          choices: Array.isArray(runtimeEvent.choices) ? runtimeEvent.choices : [],
          interventionMessage: stringValue(runtimeEvent.message),
        },
      };

    // ─── Turn domain ───────────────────────────────────────
    case "turn-start":
      return {
        ...base,
        type: "turn",
        phase: "start",
        meta: { turnIndex: Number(runtimeEvent.turnIndex ?? 0) },
      };

    case "turn-end":
      return {
        ...base,
        type: "turn",
        phase: "end",
        meta: {
          turnIndex: Number(runtimeEvent.turnIndex ?? 0),
          toolCallCount: Number(runtimeEvent.toolCallCount ?? 0),
        },
      };

    // ─── Message domain ────────────────────────────────────
    case "message-start":
      return {
        ...base,
        type: "message",
        phase: "start",
        meta: { message: payloadRecord(runtimeEvent, "message") as never },
      };

    case "message-delta":
      return {
        ...base,
        type: "message",
        phase: "delta",
        meta: {
          messageId: stringValue(runtimeEvent.messageId),
          block: payloadRecord(runtimeEvent, "block") as never,
        },
      };

    case "message-end":
      return {
        ...base,
        type: "message",
        phase: "end",
        meta: { message: payloadRecord(runtimeEvent, "message") as never },
      };

    // ─── Tool domain ───────────────────────────────────────
    case "tool-batch-start":
      return {
        ...base,
        type: "tool",
        phase: "start",
        meta: {
          batchId: stringValue(runtimeEvent.batchId),
          summary: stringValue(runtimeEvent.summary),
          calls: Array.isArray(runtimeEvent.calls) ? runtimeEvent.calls : [],
        },
      };

    case "tool-batch-end":
      return {
        ...base,
        type: "tool",
        phase: "end",
        meta: {
          batchId: stringValue(runtimeEvent.batchId),
          batchResults: Array.isArray(runtimeEvent.calls) ? runtimeEvent.calls : [],
        },
      };

    case "tool-start":
      return {
        ...base,
        type: "tool",
        phase: "start",
        meta: {
          batchId: stringValue(runtimeEvent.batchId),
          call: payloadRecord(runtimeEvent, "call") as never,
        },
      };

    case "tool-update":
      // KEY: tool-update maps to tool phase "delta" (unified naming)
      return {
        ...base,
        type: "tool",
        phase: "delta",
        meta: {
          batchId: stringValue(runtimeEvent.batchId),
          toolCallId: stringValue(runtimeEvent.toolCallId),
          update: payloadRecord(runtimeEvent, "update") as never,
        },
      };

    case "tool-end":
      return {
        ...base,
        type: "tool",
        phase: "end",
        meta: {
          batchId: stringValue(runtimeEvent.batchId),
          result: payloadRecord(runtimeEvent, "result") as never,
        },
      };

    // ─── Compression domain ────────────────────────────────
    case "context-compression-start":
      return {
        ...base,
        type: "compression",
        phase: "start",
        meta: {
          reason: stringValue(runtimeEvent.reason) as never,
          tokensBefore: Number(runtimeEvent.tokensBefore ?? 0),
        },
      };

    case "context-compression-end":
      return {
        ...base,
        type: "compression",
        phase: "end",
        meta: {
          result: payloadRecord(runtimeEvent, "result") as never,
          aborted: runtimeEvent.aborted === true,
          error: stringValue(runtimeEvent.error),
        },
      };

    // ─── Diagnostic domain ─────────────────────────────────
    case "approval-requested": {
      const request = payloadRecord(runtimeEvent, "request");
      const tool = request ? payloadRecord(request, "tool") : undefined;
      return {
        ...base,
        type: "diagnostic",
        severity: "info" as DiagnosticSeverity,
        meta: {
          originalType: "approval-requested",
          message: `Approval requested for ${stringValue(tool?.label) ?? "tool"}: ${stringValue(request?.summary) ?? ""}`,
          details: { kind: "approval-requested", request: request as never },
        },
      };
    }

    case "approval-resolved":
      return {
        ...base,
        type: "diagnostic",
        severity: "info" as DiagnosticSeverity,
        meta: {
          originalType: "approval-resolved",
          message: `Approval resolved: ${stringValue(runtimeEvent.decision) ?? ""}`,
          details: {
            kind: "approval-resolved",
            requestId: stringValue(runtimeEvent.requestId) ?? "",
            decision: payloadRecord(runtimeEvent, "decision") as never,
          },
        },
      };

    case "runtime-steering":
      return {
        ...base,
        type: "diagnostic",
        severity: "info" as DiagnosticSeverity,
        meta: {
          originalType: "runtime-steering",
          message: `Runtime steering injected: ${stringValue(runtimeEvent.reason) ?? ""}`,
          details: {
            kind: "runtime-steering",
            reason: stringValue(runtimeEvent.reason) as never,
            message: payloadRecord(runtimeEvent, "message") as never,
          },
        },
      };

    case "runtime-error":
      return {
        ...base,
        type: "diagnostic",
        severity: "error" as DiagnosticSeverity,
        meta: {
          originalType: "runtime-error",
          message: `Runtime error: ${stringValue(runtimeEvent.error) ?? "Unknown error"}`,
          details: {
            kind: "runtime-error",
            error: stringValue(runtimeEvent.error) ?? "Unknown error",
          },
        },
      };

    case "provider-diagnostic": {
      const diagnostic = payloadRecord(runtimeEvent, "diagnostic");
      const phase = stringValue(diagnostic?.phase) ?? "";
      const severity = providerDiagnosticSeverityFromPhase(phase);
      return {
        ...base,
        type: "diagnostic",
        severity,
        meta: {
          originalType: "provider-diagnostic",
          message: `Provider diagnostic: ${phase}`,
          details: { kind: "provider-diagnostic", diagnostic: diagnostic as never },
        },
      };
    }

    case "checkpoint-created": {
      const checkpoint = payloadRecord(runtimeEvent, "checkpoint");
      return {
        ...base,
        type: "diagnostic",
        severity: "info" as DiagnosticSeverity,
        meta: {
          originalType: "checkpoint-created",
          message: `Checkpoint created: ${stringValue(checkpoint?.label) ?? ""}`,
          details: { kind: "checkpoint-created", checkpoint: checkpoint as never },
        },
      };
    }

    case "checkpoint-restored": {
      const restore = payloadRecord(runtimeEvent, "restore");
      return {
        ...base,
        type: "diagnostic",
        severity: "info" as DiagnosticSeverity,
        meta: {
          originalType: "checkpoint-restored",
          message: `Checkpoint restored: ${stringValue(restore?.checkpointId) ?? ""}`,
          details: { kind: "checkpoint-restored", restore: restore as never },
        },
      };
    }

    case "tool-input-repaired":
      return {
        ...base,
        type: "diagnostic",
        severity: "info" as DiagnosticSeverity,
        meta: {
          originalType: "tool-input-repaired",
          message: `Tool input repaired: ${stringValue(runtimeEvent.toolName) ?? ""} (${(Array.isArray(runtimeEvent.notes) ? runtimeEvent.notes : []).join(", ")})`,
          details: {
            kind: "tool-input-repaired",
            toolCallId: stringValue(runtimeEvent.toolCallId) ?? "",
            toolName: stringValue(runtimeEvent.toolName) ?? "",
            notes: Array.isArray(runtimeEvent.notes) ? runtimeEvent.notes as string[] : [],
          },
        },
      };

    case "run-terminal": {
      const terminal = stringValue(runtimeEvent.terminal) ?? "completed";
      const terminalSeverity: DiagnosticSeverity =
        terminal === "failed" ? "error" : terminal === "cancelled" ? "warn" : "info";
      return {
        ...base,
        type: "diagnostic",
        severity: terminalSeverity,
        meta: {
          originalType: "run-terminal",
          message: `Run ${terminal}: ${stringValue(runtimeEvent.runId) ?? ""}${runtimeEvent.error ? ` (${stringValue(runtimeEvent.error)})` : ""}`,
          details: {
            kind: "run-terminal",
            runId: stringValue(runtimeEvent.runId) ?? "",
            terminal: terminal as "completed" | "cancelled" | "failed",
            error: stringValue(runtimeEvent.error),
          },
        },
      };
    }

    default:
      return {
        ...base,
        type: "diagnostic",
        severity: "info" as DiagnosticSeverity,
        meta: {
          originalType: type,
          message: `Unknown event type: ${type}`,
        },
      };
  }
}

// ─── Helpers ────────────────────────────────────────────────

function providerDiagnosticSeverityFromPhase(phase: string): DiagnosticSeverity {
  switch (phase) {
    case "request-start":
    case "response-start":
    case "sse-first-byte":
    case "stream-end":
    case "model-selected":
      return "info";
    case "retry":
    case "endpoint-fallback":
    case "transport-fallback":
    case "model-mismatch":
      return "warn";
    case "request-error":
      return "error";
    default:
      return "info";
  }
}

function payloadRecord(parent: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const value = parent?.[key];
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimestamp(value?: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value) return value;
  return new Date().toISOString();
}
