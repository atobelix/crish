/**
 * Subagent Handlers
 *
 * Extracted from DaemonRequestHandlers to reduce the monolithic
 * server-handlers.ts. Each handler function takes its dependencies
 * explicitly as parameters.
 */

import type { WebSocket } from "ws";
import { errorMessage } from "@crish/shared-utils";
import type {
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  GetSubagentStatusMessage,
  SendToSubagentMessage,
} from "../types.js";
import type { DaemonRuntimeFactory } from "../server-runtime-factory.js";

interface SubagentTransport {
  send(ws: WebSocket, message: unknown): boolean;
  sendError(ws: WebSocket, code: string, message: string, runId?: string, correlation?: DaemonCorrelationFields): boolean;
}

export function handleSendToSubagent(
  ws: WebSocket,
  msg: SendToSubagentMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: SubagentTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): void {
  try {
    const accepted = runtimeFactory.sendToSubagent(msg.subagentRunId, msg.message);
    transport.send(
      ws,
      correlateResponse(
        { type: "subagent-message-sent", subagentRunId: msg.subagentRunId, accepted },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "SUBAGENT_SEND_ERROR", errorMessage(error), undefined, msg);
  }
}

export function handleGetSubagentStatus(
  ws: WebSocket,
  msg: GetSubagentStatusMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: SubagentTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): void {
  try {
    const status = runtimeFactory.getSubagentStatus(msg.subagentRunId);
    transport.send(
      ws,
      correlateResponse(
        { type: "subagent-status", subagentRunId: msg.subagentRunId, ...status },
        msg
      )
    );
  } catch (error) {
    transport.sendError(ws, "SUBAGENT_STATUS_ERROR", errorMessage(error), undefined, msg);
  }
}
