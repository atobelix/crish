import type { WebSocket } from "ws";
import type { DaemonInboundMessage, DaemonCorrelationFields } from "../types.js";
import type { ConnectedClient } from "../daemon-client-registry.js";
import type { DaemonOutboundMessage } from "../types.js";
import { getDaemonLogger, toLogErr } from "../daemon-logger.js";

export type MessageHandler = (
  msg: DaemonInboundMessage,
  ws: WebSocket,
  client: ConnectedClient
) => Promise<DaemonOutboundMessage | void>;

export type MessageHandlerSync = (
  msg: DaemonInboundMessage,
  ws: WebSocket,
  client: ConnectedClient
) => DaemonOutboundMessage | void;

export class DaemonMessageRouter {
  private handlers = new Map<string, MessageHandler>();
  private messageTasks = new Set<Promise<void>>();
  private onPauseStream?: (runId: string) => void;
  private onResumeStream?: (runId: string) => void;

  register(type: string, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  registerSync(type: string, handler: MessageHandlerSync): void {
    this.handlers.set(type, async (msg, ws, client) => handler(msg, ws, client));
  }

  setStreamPauseHandler(handler: (runId: string) => void): void {
    this.onPauseStream = handler;
  }

  setStreamResumeHandler(handler: (runId: string) => void): void {
    this.onResumeStream = handler;
  }

  pauseStream(runId: string): void {
    this.onPauseStream?.(runId);
  }

  resumeStream(runId: string): void {
    this.onResumeStream?.(runId);
  }

  async route(
    msg: DaemonInboundMessage,
    ws: WebSocket,
    client: ConnectedClient
  ): Promise<void> {
    const handler = this.handlers.get(msg.type);
    if (!handler) {
      client.ws.send(
        JSON.stringify({
          type: "error",
          code: "UNKNOWN_MESSAGE_TYPE",
          message: `Unknown message type: ${msg.type}`,
          ...correlationFromMessage(msg),
        })
      );
      return;
    }

    try {
      const response = await handler(msg, ws, client);
      if (response) {
        client.ws.send(JSON.stringify(response));
      }
    } catch (error) {
      getDaemonLogger().error("Message handler failed", {
        module: "message-router",
        msgType: msg.type,
        err: toLogErr(error),
      });
      client.ws.send(
        JSON.stringify({
          type: "error",
          code: "HANDLER_ERROR",
          message: error instanceof Error ? error.message : String(error),
          ...correlationFromMessage(msg),
        })
      );
    }
  }

  trackTask(task: Promise<void>): void {
    const tracked = task
      .catch((error) => {
        getDaemonLogger().error("Unhandled client message task failure", {
          module: "message-router",
          err: toLogErr(error),
        });
      })
      .finally(() => {
        this.messageTasks.delete(tracked);
      });
    this.messageTasks.add(tracked);
  }

  get pendingTaskCount(): number {
    return this.messageTasks.size;
  }

  async drainTasks(timeoutMs: number): Promise<void> {
    if (this.messageTasks.size === 0) return;
    const settled = Promise.allSettled([...this.messageTasks]).then(
      () => "settled" as const
    );
    const timedOut = delay(timeoutMs).then(() => "timed-out" as const);
    const result = await Promise.race([settled, timedOut]);
    if (result === "timed-out" && this.messageTasks.size > 0) {
      getDaemonLogger().warn("Shutdown timed out waiting for message tasks", {
        module: "message-router",
        taskCount: this.messageTasks.size,
      });
    }
  }
}

function correlationFromMessage(
  msg: DaemonInboundMessage | Record<string, unknown>
): DaemonCorrelationFields {
  const record = msg as Record<string, unknown>;
  return {
    ...(typeof record.requestId === "string" && record.requestId.length > 0
      ? { requestId: record.requestId }
      : {}),
    ...(typeof record.correlationId === "string" &&
    record.correlationId.length > 0
      ? { correlationId: record.correlationId }
      : {}),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
