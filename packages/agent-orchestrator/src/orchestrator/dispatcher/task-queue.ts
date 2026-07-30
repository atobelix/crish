import { CrishError } from "@crish/shared-types";
import { toJsonObject } from "@crish/shared-utils";
import type {
  CancelPendingInputRequest,
  DispatchPendingInputRequest,
  EnqueuePendingInputRequest,
  PendingInputRecord,
  PendingInputResult,
  PendingInputStatus
} from "../../types";
import type { AgentLoop } from "../agent-loop";

export function listPendingInputs(loop: AgentLoop, sessionId?: string): PendingInputRecord[] {
  return [...loop.pendingInputs.values()]
    .filter((input) => input.status === "pending" && (!sessionId || input.sessionId === sessionId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export async function enqueuePendingInput(loop: AgentLoop, request: EnqueuePendingInputRequest): Promise<PendingInputResult> {
  const session = loop.sessions.get(request.sessionId);
  if (!session) {
    // R6: migrated from SessionError(not_found) -> session.not_found
    throw new CrishError(`Session not found: ${request.sessionId}`, "session.not_found", "permanent", false);
  }

  const text = request.text.trim();
  if (!text) {
    // R6: migrated from SessionError(invalid_entry) -> session.invalid_entry
    throw new CrishError("Pending input text cannot be empty", "session.invalid_entry", "permanent", false);
  }

  const now = loop.now();
  const input = {
    id: request.id ?? loop.createId("pending_input"),
    sessionId: request.sessionId,
    ...(request.runId !== undefined ? { runId: request.runId } : {}),
    text,
    mode: request.mode ?? "after-current-run",
    status: "pending" as PendingInputStatus,
    createdAt: now,
    updatedAt: now,
    ...(request.source !== undefined ? { source: request.source } : {}),
    ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
  } as PendingInputRecord;
  const event = loop.event("pending-input-created", request.sessionId, request.runId, {
    input: toJsonObject(input)
  });
  await loop.storeEvent(event);
  loop.pendingInputs.set(input.id, input);
  session.updatedAt = now;

  return { input, event };
}

export async function cancelPendingInput(loop: AgentLoop, request: CancelPendingInputRequest): Promise<PendingInputResult> {
  const input = loop.pendingInputs.get(request.id);
  if (!input || input.status !== "pending") {
    // R6: migrated from SessionError(not_found) -> session.not_found
    throw new CrishError(`Pending input not found: ${request.id}`, "session.not_found", "permanent", false);
  }
  if (request.sessionId && input.sessionId !== request.sessionId) {
    // R6: migrated from SessionError(invalid_state) -> session.invalid_state
    throw new CrishError(`Pending input ${request.id} does not belong to session ${request.sessionId}`, "session.invalid_state", "permanent", false);
  }

  const updated = updatePendingInputStatus(loop, input, "cancelled");
  const event = loop.event("pending-input-cancelled", updated.sessionId, updated.runId, {
    input: toJsonObject(updated),
    inputId: updated.id,
    ...(request.reason ? { reason: request.reason } : {})
  });
  await loop.storeEvent(event);
  loop.pendingInputs.set(updated.id, updated);
  loop.sessions.get(updated.sessionId)!.updatedAt = updated.updatedAt;
  return { input: updated, event };
}

export async function dispatchPendingInput(loop: AgentLoop, request: DispatchPendingInputRequest): Promise<PendingInputResult> {
  const input = loop.pendingInputs.get(request.id);
  if (!input || input.status !== "pending") {
    // R6: migrated from SessionError(not_found) -> session.not_found
    throw new CrishError(`Pending input not found: ${request.id}`, "session.not_found", "permanent", false);
  }
  if (request.sessionId && input.sessionId !== request.sessionId) {
    // R6: migrated from SessionError(invalid_state) -> session.invalid_state
    throw new CrishError(`Pending input ${request.id} does not belong to session ${request.sessionId}`, "session.invalid_state", "permanent", false);
  }

  const updated = updatePendingInputStatus(loop, input, "dispatched", request.targetRunId);
  const event = loop.event("pending-input-dispatched", updated.sessionId, request.targetRunId ?? updated.runId, {
    input: toJsonObject(updated),
    inputId: updated.id,
    ...(request.targetRunId ? { targetRunId: request.targetRunId } : {})
  });
  await loop.storeEvent(event);
  loop.pendingInputs.set(updated.id, updated);
  loop.sessions.get(updated.sessionId)!.updatedAt = updated.updatedAt;
  return { input: updated, event };
}

export function updatePendingInputStatus(
  loop: AgentLoop,
  input: PendingInputRecord,
  status: Exclude<PendingInputRecord["status"], "pending">,
  runId?: string
): PendingInputRecord {
  return {
    ...input,
    ...(runId ? { runId } : {}),
    status,
    updatedAt: loop.now()
  };
}
