/**
 * Workflow Handlers
 *
 * Extracted from DaemonRequestHandlers to reduce the monolithic
 * server-handlers.ts. Each handler function takes its dependencies
 * explicitly as parameters.
 */

import type { WebSocket } from "ws";
import { errorMessage } from "@crish/shared-utils";
import type {
  DaemonCorrelationFields,
  CreateWorkflowMessage,
  DeleteWorkflowMessage,
  ListWorkflowRunsMessage,
  ListWorkflowsMessage,
  TriggerWorkflowMessage,
  UpdateWorkflowMessage,
} from "../types.js";
import {
  WorkflowStoreConflictError,
  WorkflowStoreError,
} from "../workflow-store.js";
import type { WorkflowStore } from "../workflow-store.js";
import type { ConnectedClient } from "../daemon-client-registry.js";
import type { WorkflowRunAccepted } from "../workflow-scheduler.js";

// ─── Error class ───────────────────────────────────────────

export class DaemonWorkflowNotFoundError extends Error {
  readonly code = "WORKFLOW_NOT_FOUND";

  constructor(readonly workflowId: string) {
    super(`Workflow not found: ${workflowId}`);
    this.name = "DaemonWorkflowNotFoundError";
  }
}

// ─── Transport abstraction ─────────────────────────────────

export interface DaemonMessageTransport {
  send(ws: WebSocket, message: unknown): boolean;
  sendError(
    ws: WebSocket,
    code: string,
    message: string,
    runId?: string,
    correlation?: DaemonCorrelationFields
  ): boolean;
}

// ─── Correlate helper ──────────────────────────────────────

function correlateResponse<T extends { type: string }>(
  response: T,
  msg: DaemonCorrelationFields
): T & DaemonCorrelationFields {
  return {
    ...response,
    correlationId: msg.correlationId,
  };
}

function correlationFrom(msg: DaemonCorrelationFields): DaemonCorrelationFields {
  return { correlationId: msg.correlationId };
}

// ─── Error dispatcher ──────────────────────────────────────

export function sendWorkflowStoreError(
  transport: DaemonMessageTransport,
  ws: WebSocket,
  error: unknown,
  runId?: string,
  correlation?: DaemonCorrelationFields
): void {
  if (error instanceof Error && "code" in error && "runId" in error && error.name === "DaemonRunPreflightError") {
    transport.sendError(ws, (error as Error & { code: string }).code, error.message, (error as Error & { runId: string }).runId, correlation);
    return;
  }
  if (error instanceof DaemonWorkflowNotFoundError) {
    transport.sendError(ws, error.code, error.message, runId, correlation);
    return;
  }
  if (error instanceof WorkflowStoreConflictError) {
    transport.sendError(ws, "WORKFLOW_CONFLICT", error.message, runId, correlation);
    return;
  }
  if (error instanceof WorkflowStoreError) {
    const detail = error.issues.length > 0 ? `: ${error.issues.join("; ")}` : "";
    transport.sendError(ws, error.code, `${error.message}${detail}`, runId, correlation);
    return;
  }

  transport.sendError(ws, "WORKFLOW_ERROR", errorMessage(error), runId, correlation);
}

// ─── Handler functions ─────────────────────────────────────

export async function handleListWorkflows(
  ws: WebSocket,
  msg: ListWorkflowsMessage & DaemonCorrelationFields,
  transport: DaemonMessageTransport,
  workflowStore: WorkflowStore
): Promise<void> {
  try {
    transport.send(
      ws,
      correlateResponse(
        {
          type: "workflows-listed",
          workflows: await workflowStore.listWorkflows(),
        },
        msg
      )
    );
  } catch (error) {
    sendWorkflowStoreError(transport, ws, error, undefined, msg);
  }
}

export async function handleCreateWorkflow(
  ws: WebSocket,
  msg: CreateWorkflowMessage & DaemonCorrelationFields,
  transport: DaemonMessageTransport,
  workflowStore: WorkflowStore,
  defaultCwd: string
): Promise<void> {
  try {
    const workflow = await workflowStore.createWorkflow({
      ...(msg.id !== undefined ? { id: msg.id } : {}),
      name: msg.name,
      prompt: msg.prompt,
      cwd: msg.cwd ?? defaultCwd,
      ...(msg.mode !== undefined ? { mode: msg.mode } : {}),
      schedule: msg.schedule,
      ...(msg.enabled !== undefined ? { enabled: msg.enabled } : {}),
      ...(msg.metadata !== undefined ? { metadata: msg.metadata } : {}),
    });
    transport.send(ws, correlateResponse({ type: "workflow-created", workflow }, msg));
  } catch (error) {
    sendWorkflowStoreError(transport, ws, error, undefined, msg);
  }
}

export async function handleUpdateWorkflow(
  ws: WebSocket,
  msg: UpdateWorkflowMessage & DaemonCorrelationFields,
  transport: DaemonMessageTransport,
  workflowStore: WorkflowStore
): Promise<void> {
  try {
    const workflow = await workflowStore.updateWorkflow(msg.workflowId, {
      ...(msg.name !== undefined ? { name: msg.name } : {}),
      ...(msg.prompt !== undefined ? { prompt: msg.prompt } : {}),
      ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
      ...(msg.mode !== undefined ? { mode: msg.mode } : {}),
      ...(msg.schedule !== undefined ? { schedule: msg.schedule } : {}),
      ...(msg.enabled !== undefined ? { enabled: msg.enabled } : {}),
      ...(msg.metadata !== undefined ? { metadata: msg.metadata } : {}),
    });
    if (!workflow) {
      transport.sendError(
        ws,
        "WORKFLOW_NOT_FOUND",
        `Workflow not found: ${msg.workflowId}`,
        undefined,
        correlationFrom(msg)
      );
      return;
    }
    transport.send(ws, correlateResponse({ type: "workflow-updated", workflow }, msg));
  } catch (error) {
    sendWorkflowStoreError(transport, ws, error, undefined, msg);
  }
}

export async function handleDeleteWorkflow(
  ws: WebSocket,
  msg: DeleteWorkflowMessage & DaemonCorrelationFields,
  transport: DaemonMessageTransport,
  workflowStore: WorkflowStore
): Promise<void> {
  try {
    const deleted = await workflowStore.deleteWorkflow(msg.workflowId);
    if (!deleted) {
      transport.sendError(
        ws,
        "WORKFLOW_NOT_FOUND",
        `Workflow not found: ${msg.workflowId}`,
        undefined,
        correlationFrom(msg)
      );
      return;
    }
    transport.send(
      ws,
      correlateResponse(
        {
          type: "workflow-deleted",
          workflowId: msg.workflowId,
        },
        msg
      )
    );
  } catch (error) {
    sendWorkflowStoreError(transport, ws, error, undefined, msg);
  }
}

/**
 * handleTriggerWorkflow: delegates actual trigger logic via a callback
 * to keep the heavy orchestration (triggerWorkflowRun) in the main class.
 */
export async function handleTriggerWorkflow(
  ws: WebSocket,
  client: ConnectedClient,
  msg: TriggerWorkflowMessage & DaemonCorrelationFields,
  transport: DaemonMessageTransport,
  triggerFn: (input: {
    workflowId: string;
    runId?: string;
    sessionId?: string;
    clientId: string;
    ws: WebSocket;
  }) => Promise<WorkflowRunAccepted>
): Promise<void> {
  try {
    const accepted = await triggerFn({
      workflowId: msg.workflowId,
      ...(msg.runId !== undefined ? { runId: msg.runId } : {}),
      ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
      clientId: client.id,
      ws,
    });
    transport.send(
      ws,
      correlateResponse(
        {
          type: "workflow-triggered",
          accepted: true,
          runId: accepted.runId,
          workflowRunId: accepted.workflowRunId,
          run: accepted.run,
        },
        msg
      )
    );
  } catch (error) {
    sendWorkflowStoreError(transport, ws, error, msg.runId, msg);
  }
}

export async function handleListWorkflowRuns(
  ws: WebSocket,
  msg: ListWorkflowRunsMessage & DaemonCorrelationFields,
  transport: DaemonMessageTransport,
  workflowStore: WorkflowStore
): Promise<void> {
  try {
    transport.send(
      ws,
      correlateResponse(
        {
          type: "workflow-runs-listed",
          runs: await workflowStore.listRuns(msg.workflowId),
          ...(msg.workflowId !== undefined ? { workflowId: msg.workflowId } : {}),
        },
        msg
      )
    );
  } catch (error) {
    sendWorkflowStoreError(transport, ws, error, undefined, msg);
  }
}