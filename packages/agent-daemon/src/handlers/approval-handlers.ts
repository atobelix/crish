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
  DenyToolMessage,
} from "../types.js";
import type { ApprovalQueue } from "../approval-queue.js";
import { getDaemonLogger } from "../daemon-logger.js";

interface ApprovalHandlerTransport {
  send(ws: WebSocket, message: unknown): boolean;
  broadcast(message: unknown): number;
  sendError?(
    ws: WebSocket,
    code: string,
    message: string,
    runId?: string,
    correlation?: { requestId?: string; clientRequestId?: string }
  ): boolean;
}

function lateResolvePayload(
  approvalQueue: ApprovalQueue,
  toolCallId: string
): { status: string | null; reason?: string; expiredAt?: number } {
  const snapshot = approvalQueue.getApproval(toolCallId);
  if (!snapshot) {
    return { status: approvalQueue.getStatus(toolCallId) };
  }
  return {
    status: snapshot.status,
    ...(snapshot.reason !== undefined ? { reason: snapshot.reason } : {}),
    ...(snapshot.expiredAt !== undefined ? { expiredAt: snapshot.expiredAt } : {}),
  };
}

export function handleApproveTool(
  msg: ApproveToolMessage,
  approvalQueue: ApprovalQueue,
  transport: ApprovalHandlerTransport,
  ws?: WebSocket
): void {
  const resolved = approvalQueue.resolve(msg.toolCallId, "approved", msg.scope);
  if (resolved) {
    getDaemonLogger().info('Tool approved', { module: 'approval-handlers', toolCallId: msg.toolCallId, scope: msg.scope || 'project' });
    transport.broadcast({
      type: "approval-resolved",
      toolCallId: msg.toolCallId,
      decision: "approved",
      reason: "user-approved",
    });
    return;
  }

  // Late approve after timeout / unknown id: typed feedback for the requesting client.
  const late = lateResolvePayload(approvalQueue, msg.toolCallId);
  getDaemonLogger().warn('Late/unknown approve-tool', { module: 'approval-handlers', toolCallId: msg.toolCallId, status: late.status ?? 'missing' });
  if (ws && transport.sendError) {
    transport.sendError(
      ws,
      late.status === "expired" ? "APPROVAL_EXPIRED" : "APPROVAL_NOT_PENDING",
      late.status === "expired"
        ? `Approval ${msg.toolCallId} already expired; re-run the tool to request a new approval`
        : `No pending approval for toolCallId: ${msg.toolCallId}`,
    );
  }
}

export function handleDenyTool(
  msg: DenyToolMessage,
  approvalQueue: ApprovalQueue,
  transport: ApprovalHandlerTransport,
  ws?: WebSocket
): void {
  const resolved = approvalQueue.resolve(msg.toolCallId, "denied");
  if (resolved) {
    getDaemonLogger().info('Tool denied', { module: 'approval-handlers', toolCallId: msg.toolCallId });
    transport.broadcast({
      type: "approval-resolved",
      toolCallId: msg.toolCallId,
      decision: "denied",
      reason: "user-denied",
    });
    return;
  }

  const late = lateResolvePayload(approvalQueue, msg.toolCallId);
  getDaemonLogger().warn('Late/unknown deny-tool', { module: 'approval-handlers', toolCallId: msg.toolCallId, status: late.status ?? 'missing' });
  if (ws && transport.sendError) {
    transport.sendError(
      ws,
      late.status === "expired" ? "APPROVAL_EXPIRED" : "APPROVAL_NOT_PENDING",
      late.status === "expired"
        ? `Approval ${msg.toolCallId} already expired`
        : `No pending approval for toolCallId: ${msg.toolCallId}`,
    );
  }
}
