import type {
  OrchestratorEvent,
  OrchestratorSessionEventSummary,
  RunStatus
} from "./types";
import { isRecord } from "@crish/shared-utils";

export interface OrchestratorRunSummaryState {
  runId: string;
  status: RunStatus;
  updatedAt: string;
  lastEventId?: string;
  lastSequence?: number;
}

export interface MutableSessionEventSummary {
  sessionId: string;
  lastUpdated: string;
  eventCount: number;
  runIds: Set<string>;
  runStates: Map<string, OrchestratorRunSummaryState>;
  lastEventId?: string;
  lastSequence?: number;
  lastMessagePreview?: string;
  pendingInputIds: Set<string>;
  pendingInputEventCount: number;
}

const RUN_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "awaiting-approval",
  "cancelling",
  "cancelled",
  "completed",
  "failed"
]);

const ACTIVE_RUN_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "awaiting-approval",
  "cancelling"
]);

export function summarizeOrchestratorSessionEvents(events: OrchestratorEvent[]): OrchestratorSessionEventSummary[] {
  const summaries = new Map<string, MutableSessionEventSummary>();
  for (const event of events) {
    updateSessionSummary(summaries, event);
  }
  return [...summaries.values()].map(toOrchestratorSessionEventSummary).sort(compareSessionSummaries);
}

export function updateSessionSummary(index: Map<string, MutableSessionEventSummary>, event: OrchestratorEvent): void {
  const summary =
    index.get(event.sessionId) ??
    {
      sessionId: event.sessionId,
      lastUpdated: event.timestamp,
      eventCount: 0,
      runIds: new Set<string>(),
      runStates: new Map<string, OrchestratorRunSummaryState>(),
      pendingInputIds: new Set<string>(),
      pendingInputEventCount: 0
    };

  summary.eventCount += 1;
  updatePendingInputSummaryState(summary, event);
  if (event.runId) {
    summary.runIds.add(event.runId);
    updateRunSummaryState(summary, event);
  }
  if (summary.lastSequence === undefined || event.sequence >= summary.lastSequence) {
    summary.lastUpdated = event.timestamp;
    summary.lastEventId = event.id;
    summary.lastSequence = event.sequence;
  }
  const preview = messagePreviewFromEvent(event);
  if (preview) summary.lastMessagePreview = preview;
  index.set(event.sessionId, summary);
}

export function toOrchestratorSessionEventSummary(summary: MutableSessionEventSummary): OrchestratorSessionEventSummary {
  const runStates = [...summary.runStates.values()];
  const activeRunStates = runStates.filter((state) => ACTIVE_RUN_STATUSES.has(state.status)).sort(compareRunStates);
  const latestRun = runStates.sort(compareRunStates)[0];
  const pendingApprovalCount = runStates.filter((state) => state.status === "awaiting-approval").length;

  return {
    sessionId: summary.sessionId,
    lastUpdated: summary.lastUpdated,
    eventCount: summary.eventCount,
    runCount: summary.runIds.size,
    ...(runStates.length > 0 ? { activeRunCount: activeRunStates.length } : {}),
    ...(runStates.length > 0 ? { pendingApprovalCount } : {}),
    ...(activeRunStates.length > 0 ? { activeRunIds: activeRunStates.map((state) => state.runId) } : {}),
    ...(latestRun
      ? {
          latestRunId: latestRun.runId,
          latestRunStatus: latestRun.status,
          latestRunUpdatedAt: latestRun.updatedAt
        }
      : {}),
    ...(summary.pendingInputEventCount > 0 ? { pendingInputCount: summary.pendingInputIds.size } : {}),
    ...(summary.lastEventId ? { lastEventId: summary.lastEventId } : {}),
    ...(summary.lastSequence !== undefined ? { lastSequence: summary.lastSequence } : {}),
    ...(summary.lastMessagePreview ? { lastMessagePreview: summary.lastMessagePreview } : {})
  };
}

function updatePendingInputSummaryState(summary: MutableSessionEventSummary, event: OrchestratorEvent): void {
  const inputId = pendingInputIdFromEvent(event);
  if (!inputId) return;
  summary.pendingInputEventCount += 1;
  if (event.type === "pending-input-created") {
    summary.pendingInputIds.add(inputId);
    return;
  }
  if (event.type === "pending-input-cancelled" || event.type === "pending-input-dispatched") {
    summary.pendingInputIds.delete(inputId);
  }
}

function pendingInputIdFromEvent(event: OrchestratorEvent): string | undefined {
  const input = event.payload.input;
  if (isRecord(input) && typeof input.id === "string" && input.id.length > 0) return input.id;
  return typeof event.payload.inputId === "string" && event.payload.inputId.length > 0 ? event.payload.inputId : undefined;
}

export function compareSessionSummaries(
  left: OrchestratorSessionEventSummary,
  right: OrchestratorSessionEventSummary
): number {
  const byUpdated = right.lastUpdated.localeCompare(left.lastUpdated);
  if (byUpdated !== 0) return byUpdated;
  return (right.lastSequence ?? 0) - (left.lastSequence ?? 0);
}

function updateRunSummaryState(summary: MutableSessionEventSummary, event: OrchestratorEvent): void {
  if (!event.runId) return;
  const status = runStatusFromEvent(event);
  if (!status) return;

  const existing = summary.runStates.get(event.runId);
  if (existing?.lastSequence !== undefined && event.sequence < existing.lastSequence) return;

  summary.runStates.set(event.runId, {
    runId: event.runId,
    status,
    updatedAt: event.timestamp,
    lastEventId: event.id,
    lastSequence: event.sequence
  });
}

function runStatusFromEvent(event: OrchestratorEvent): RunStatus | undefined {
  const payloadRunStatus = runStatusFromPayload(event.payload.run);
  if (payloadRunStatus) return payloadRunStatus;

  switch (event.type) {
    case "run-queued":
      return "queued";
    case "run-started":
    case "goal-round-started":
    case "goal-continuation-decided":
      return "running";
    case "run-cancel-requested":
      return "cancelling";
    case "run-cancelled":
      return "cancelled";
    case "run-completed":
      return "completed";
    case "run-failed":
      return "failed";
    case "runtime-event":
      return runStatusFromRuntimeEvent(event.payload.event);
    default:
      return undefined;
  }
}

function runStatusFromRuntimeEvent(value: unknown): RunStatus | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "approval-requested") return "awaiting-approval";
  if (value.type === "approval-resolved") return "running";
  return undefined;
}

function runStatusFromPayload(value: unknown): RunStatus | undefined {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  return RUN_STATUSES.has(value.status as RunStatus) ? (value.status as RunStatus) : undefined;
}

function messagePreviewFromEvent(event: OrchestratorEvent): string | undefined {
  if (event.type !== "runtime-event") return undefined;
  const runtimeEvent = event.payload.event;
  if (!isRecord(runtimeEvent) || runtimeEvent.type !== "message-end") return undefined;
  const message = runtimeEvent.message;
  if (!isRecord(message)) return undefined;
  return previewText(message.content ?? message.blocks);
}

function previewText(value: unknown): string | undefined {
  if (typeof value === "string") return truncatePreview(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const preview = previewText(item);
      if (preview) return preview;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const text = previewText(value.text ?? value.content ?? value.output);
  return text ? truncatePreview(text) : undefined;
}

function truncatePreview(value: string): string | undefined {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function compareRunStates(left: OrchestratorRunSummaryState, right: OrchestratorRunSummaryState): number {
  const bySequence = (right.lastSequence ?? 0) - (left.lastSequence ?? 0);
  if (bySequence !== 0) return bySequence;
  return right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId);
}


