/**
 * Approval Handlers
 *
 * Extracted from DaemonRequestHandlers to reduce the monolithic
 * server-handlers.ts. Each handler function takes its dependencies
 * explicitly as parameters.
 */

import type { WebSocket } from "ws";
import type {
  ApproveToolMessage,
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  DenyToolMessage,
  ListApprovalHistoryMessage,
} from "../types.js";
import type { ApprovalQueue } from "../approval-queue.js";
import type { AgentOrchestrator } from "@crish/agent-orchestrator";
import { createApprovalHistoryResponse } from "../approval-history-query-handlers.js";

interface ApprovalHandlerTransport {
  send(ws: WebSocket, message: unknown): boolean;
  broadcast(message: unknown): number;
}

export function handleApproveTool(
  msg: ApproveToolMessage,
  approvalQueue: ApprovalQueue,
  transport: ApprovalHandlerTransport
): void {
  const resolved = approvalQueue.resolve(msg.toolCallId, "approved", msg.scope);
  if (resolved) {
    console.log(`[Daemon] Tool approved: ${msg.toolCallId} (scope: ${msg.scope || "project"})`);
    transport.broadcast({
      type: "approval-resolved",
      toolCallId: msg.toolCallId,
      decision: "approved",
    });
  }
}

export function handleDenyTool(
  msg: DenyToolMessage,
  approvalQueue: ApprovalQueue,
  transport: ApprovalHandlerTransport
): void {
  const resolved = approvalQueue.resolve(msg.toolCallId, "denied");
  if (resolved) {
    console.log(`[Daemon] Tool denied: ${msg.toolCallId}`);
    transport.broadcast({
      type: "approval-resolved",
      toolCallId: msg.toolCallId,
      decision: "denied",
    });
  }
}

export async function handleListApprovalHistory(
  ws: WebSocket,
  msg: ListApprovalHistoryMessage & DaemonCorrelationFields,
  orchestrator: AgentOrchestrator,
  approvalQueue: ApprovalQueue,
  transport: ApprovalHandlerTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  const response = await createApprovalHistoryResponse(orchestrator, approvalQueue, msg);
  transport.send(ws, correlateResponse(response, msg));
}
