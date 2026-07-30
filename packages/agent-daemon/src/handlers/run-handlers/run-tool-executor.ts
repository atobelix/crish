/**
 * Run Tool Executor & Event Notification Bridge
 * Handles event sinks, transport dispatching, message correlation,
 * and approval/event broadcasting.
 */

import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { JsonObject, AgentEvent, AgentMessage } from "@crish/shared-types";
import { toJsonObject } from "@crish/shared-utils";
import { createTextMessage } from "@crish/agent-context";
import type { OrchestratorEvent } from "@crish/agent-orchestrator";
import { readEnv } from "../../env-whitelist.js";
import { getDaemonLogger } from "../../daemon-logger.js";
import { ApprovalQueue } from "../../approval-queue.js";
import {
  broadcastApprovalRequested as broadcastApprovalRequestedExtracted,
  broadcastExpiredApprovalResolved as broadcastExpiredApprovalResolvedExtracted,
} from "../session-handlers.js";
import type {
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  RunTaskMessage,
  WorkflowRunEntry,
} from "../../types.js";
import { StreamBackpressureRegistry } from "../../stream-backpressure.js";

// ─── Transport abstraction ─────────────────────────────────

export interface DaemonMessageTransport {
  send(ws: WebSocket, message: DaemonOutboundMessage): boolean;
  sendError(
    ws: WebSocket,
    code: string,
    message: string,
    runId?: string,
    correlation?: DaemonCorrelationFields
  ): boolean;
  broadcast(message: DaemonOutboundMessage): number;
}

export interface RunEventSink {
  send(message: DaemonOutboundMessage): void;
  sendError(
    code: string,
    message: string,
    correlation?: DaemonCorrelationFields
  ): void;
  dispose(): void;
}

// ─── Event & Error Dispatching ──────────────────────────────

export function sendRunEvent(
  eventSink: RunEventSink,
  runId: string,
  orchestratorEvent: OrchestratorEvent,
  event: AgentEvent
): void {
  eventSink.send({
    type: 'event',
    runId,
    orchestratorEventId: orchestratorEvent.id,
    sequence: orchestratorEvent.sequence,
    timestamp: orchestratorEvent.timestamp,
    event,
  });
}

export function sendError(
  transport: DaemonMessageTransport,
  ws: WebSocket | undefined,
  code: string,
  message: string,
  runId?: string,
  correlation?: DaemonCorrelationFields
): void {
  if (ws) {
    transport.sendError(ws, code, message, runId, correlation);
  } else {
    transport.broadcast({
      type: 'error',
      code,
      message,
      ...(runId !== undefined ? { runId } : {}),
      ...correlationFrom(correlation ?? {}),
    });
  }
}

// ─── Correlation Helpers ────────────────────────────────────

export function correlateResponse<T extends DaemonOutboundMessage>(
  message: T,
  correlation: DaemonCorrelationFields
): T {
  return {
    ...message,
    ...correlationFrom(correlation),
  };
}

export function correlationFrom(
  input: DaemonCorrelationFields
): DaemonCorrelationFields {
  return {
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.correlationId !== undefined
      ? { correlationId: input.correlationId }
      : {}),
  };
}

// ─── Broadcasting Helpers ───────────────────────────────────

export function broadcastApprovalRequested(
  event: Extract<AgentEvent, { type: 'approval-requested' }>,
  runId: string,
  approvalQueue: ApprovalQueue,
  transport: DaemonMessageTransport
): void {
  broadcastApprovalRequestedExtracted(
    event,
    runId,
    approvalQueue,
    transport
  );
}

export function broadcastExpiredApprovalResolved(
  event: Extract<AgentEvent, { type: 'approval-resolved' }>,
  transport: DaemonMessageTransport
): void {
  broadcastExpiredApprovalResolvedExtracted(event, transport);
}

export function broadcastWorkflowRunUpdated(
  run: WorkflowRunEntry,
  transport: DaemonMessageTransport
): void {
  transport.broadcast({
    type: 'workflow-run-updated',
    runId: run.runId,
    workflowRunId: run.runId,
    workflowId: run.workflowId,
    run,
  });
}

// ─── Event Sink Creation ────────────────────────────────────

export function createRunEventSink(
  input: { runId: string; sessionId: string; clientId: string; ws?: WebSocket | undefined },
  transport: DaemonMessageTransport,
  backpressure: StreamBackpressureRegistry,
  activeRunSockets: Map<string, WebSocket | undefined>,
  recordDiagnostic?: (input: {
    code: string;
    message: string;
    source: 'daemon' | 'websocket' | 'client' | 'event-store' | 'provider' | 'mcp';
    severity?: 'warning' | 'error';
    detail?: string;
    metadata?: JsonObject;
  }) => void
): RunEventSink {
  activeRunSockets.set(input.runId, input.ws);

  if (!input.ws) {
    return {
      send: (message) => {
        if (backpressure.tryBuffer(input.runId, message)) return;
        if (
          !readEnv("VITEST") &&
          message.type === "event" &&
          (message.event.type.startsWith("tool-batch-") ||
            message.event.type.startsWith("checkpoint-"))
        ) {
          return;
        }
        transport.broadcast(message);
      },
      sendError: (code, message, correlation) =>
        transport.broadcast({
          type: 'error',
          code,
          message,
          runId: input.runId,
          ...correlationFrom(correlation ?? {}),
        }),
      dispose: () => {
        activeRunSockets.delete(input.runId);
      },
    };
  }

  let subscribed = true;
  const markSubscriptionLost = (code?: number, reason?: Buffer): void => {
    if (!subscribed) return;
    subscribed = false;
    getDaemonLogger().warn('Run lost originating WebSocket subscription', { module: 'RunHandler', runId: input.runId, sessionId: input.sessionId, clientId: input.clientId });
    recordDiagnostic?.({
      code: 'RUN_STREAM_SUBSCRIPTION_LOST',
      message: `Originating WebSocket subscription lost for run ${input.runId}; run remains active in daemon ownership`,
      source: 'websocket',
      severity: 'warning',
      metadata: {
        runId: input.runId,
        sessionId: input.sessionId,
        clientId: input.clientId,
        ...(code !== undefined ? { closeCode: code } : {}),
        ...(reason !== undefined ? { closeReason: reason.toString() } : {}),
      },
    });
  };
  input.ws.once('close', markSubscriptionLost);
  const ensureSubscribed = (): boolean => {
    if (!subscribed) return false;
    if (input.ws?.readyState === input.ws?.OPEN) return true;
    markSubscriptionLost();
    return false;
  };

  return {
    send: (message) => {
      if (process.env.DEBUG_BATCHER === '1') {
        const msgType = (message as { type?: string }).type;
        const evtType = (message as { event?: { type?: string } })?.event?.type;
        console.error('[EventSink] send:', msgType, evtType ? `(${evtType})` : '', 'paused=' + backpressure.isPaused(input.runId));
      }
      if (backpressure.tryBuffer(input.runId, message)) return;
      const subscribed = ensureSubscribed();
      const sent = subscribed && transport.send(input.ws!, message);
      if (process.env.DEBUG_BATCHER === '1') {
        console.error('[EventSink] result:', 'subscribed=' + subscribed, 'sent=' + sent);
      }
      if (subscribed && !sent) {
        markSubscriptionLost();
      }
    },
    sendError: (code, message, correlation) => {
      if (
        ensureSubscribed() &&
        !transport.sendError(
          input.ws!,
          code,
          message,
          input.runId,
          correlation
        )
      ) {
        markSubscriptionLost();
      }
    },
    dispose: () => {
      input.ws?.off('close', markSubscriptionLost);
      activeRunSockets.delete(input.runId);
    },
  };
}

// ─── Prompt Message Creation ────────────────────────────────

export function createBackendUserMessageId(runId: string): string {
  return `user_boundary_${safeIdSegment(runId)}_${randomUUID()}`;
}

export function createRunPromptMessage(
  prompt: string,
  userMessageId: string,
  multimodal?: {
    content?: RunTaskMessage['content'];
    hasImages?: boolean;
    attachments?: RunTaskMessage['attachments'];
  }
): AgentMessage {
  const hasImages =
    Boolean(multimodal?.hasImages) ||
    Boolean(
      multimodal?.content?.some(
        (part) =>
          part &&
          typeof part === 'object' &&
          (part as { type?: string }).type === 'image_url'
      )
    );
  const metadata: JsonObject = {
    kind: 'daemon-user-message-boundary',
    boundaryId: userMessageId,
    generatedBy: 'agent-daemon',
    // Align with UI clientMessageId for hydrate pickStableMessageId
    clientMessageId: userMessageId,
  };
  if (multimodal?.content?.length) {
    metadata.contentParts = toJsonObject(multimodal.content);
  }
  if (hasImages) metadata.hasImages = true;
  if (multimodal?.attachments?.length) {
    metadata.attachments = toJsonObject(multimodal.attachments);
  }
  const message = createTextMessage('user', prompt, metadata);
  return {
    ...message,
    id: userMessageId,
    clientMessageId: userMessageId,
  };
}

function safeIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'run';
}
