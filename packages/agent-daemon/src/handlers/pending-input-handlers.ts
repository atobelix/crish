/**
 * Pending Input Handlers
 *
 * Extracted from DaemonRequestHandlers to reduce the monolithic
 * server-handlers.ts. Each handler function takes its dependencies
 * explicitly as parameters.
 */

import type { WebSocket } from "ws";
import { errorMessage } from "@crish/shared-utils";
import type {
  CancelPendingInputMessage,
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  DispatchPendingInputMessage,
  EnqueuePendingInputMessage,
  ListPendingInputsMessage,
} from "../types.js";
import type { AgentOrchestrator } from "@crish/agent-orchestrator";

interface PendingInputTransport {
  send(ws: WebSocket, message: unknown): boolean;
  sendError(ws: WebSocket, code: string, message: string, runId?: string, correlation?: DaemonCorrelationFields): boolean;
}

export async function handleEnqueuePendingInput(
  ws: WebSocket,
  msg: EnqueuePendingInputMessage & DaemonCorrelationFields,
  orchestrator: AgentOrchestrator,
  transport: PendingInputTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const result = await orchestrator.enqueuePendingInput({
      id: msg.inputId,
      sessionId: msg.sessionId,
      runId: msg.runId,
      text: msg.text,
      mode: msg.mode,
      source: msg.source,
      metadata: msg.metadata,
    });
    transport.send(
      ws,
      correlateResponse(
        {
          type: "pending-input-queued",
          input: result.input,
          event: result.event,
        },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "PENDING_INPUT_ERROR", errorMessage(error), msg.runId, msg);
  }
}

export async function handleCancelPendingInput(
  ws: WebSocket,
  msg: CancelPendingInputMessage & DaemonCorrelationFields,
  orchestrator: AgentOrchestrator,
  transport: PendingInputTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const result = await orchestrator.cancelPendingInput({
      id: msg.inputId,
      sessionId: msg.sessionId,
      reason: msg.reason,
    });
    transport.send(
      ws,
      correlateResponse(
        {
          type: "pending-input-cancelled",
          input: result.input,
          event: result.event,
        },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "PENDING_INPUT_ERROR", errorMessage(error), undefined, msg);
  }
}

export async function handleDispatchPendingInput(
  ws: WebSocket,
  msg: DispatchPendingInputMessage & DaemonCorrelationFields,
  orchestrator: AgentOrchestrator,
  transport: PendingInputTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const result = await orchestrator.dispatchPendingInput({
      id: msg.inputId,
      sessionId: msg.sessionId,
      targetRunId: msg.targetRunId,
    });
    transport.send(
      ws,
      correlateResponse(
        {
          type: "pending-input-dispatched",
          input: result.input,
          event: result.event,
        },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "PENDING_INPUT_ERROR", errorMessage(error), undefined, msg);
  }
}

export function handleListPendingInputs(
  ws: WebSocket,
  msg: ListPendingInputsMessage & DaemonCorrelationFields,
  orchestrator: AgentOrchestrator,
  transport: PendingInputTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): void {
  transport.send(
    ws,
    correlateResponse(
      {
        type: "pending-inputs-listed",
        inputs: orchestrator.listPendingInputs(msg.sessionId),
        ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
      },
      msg
    )
  );
}
