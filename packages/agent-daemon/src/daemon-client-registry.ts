import type { WebSocket } from "ws";
import type { DaemonCorrelationFields, DaemonOutboundMessage } from "./types.js";
import {
  encodeOutboundMessage,
  formatProtocolValidationError,
} from "./protocol/protocol.js";
import { BoundedMap, MAX_CLIENTS, MAX_PENDING_WS_MESSAGES } from "@crish/shared-utils";
import { getDaemonLogger, toLogErr } from "./daemon-logger.js";

export interface ConnectedClient {
  ws: WebSocket;
  id: string;
  connectedAt: number;
  pendingMessagesCount: number | undefined;
  subscriptions: Set<() => void> | undefined;
}

export type DaemonClientTransportDiagnosticCode =
  | "OUTBOUND_PROTOCOL_ERROR"
  | "CLIENT_SEND_BACKPRESSURE"
  | "CLIENT_SEND_FAILED";

export interface DaemonClientTransportDiagnostic {
  code: DaemonClientTransportDiagnosticCode;
  message: string;
  source: "daemon" | "client" | "websocket";
  severity: "warning" | "error";
  clientId: string | undefined;
  detail: string | undefined;
  metadata: Record<string, unknown> | undefined;
}

export interface DaemonClientRegistryOptions {
  maxBufferedBytes?: number;
  onDiagnostic?: (diagnostic: DaemonClientTransportDiagnostic) => void;
}

const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;
const SEND_BACKPRESSURE_CLOSE_CODE = 1013;
const SEND_FAILURE_CLOSE_CODE = 1011;

export class DaemonClientRegistry {
  private readonly clients = new BoundedMap<WebSocket, ConnectedClient>(MAX_CLIENTS, undefined);
  private readonly maxBufferedBytes: number;
  private readonly maxClients: number;
  private readonly failedTransports = new WeakSet<WebSocket>();
  private clientIdCounter = 0;
  private onDiagnostic: ((diagnostic: DaemonClientTransportDiagnostic) => void) | undefined;

  constructor(options: DaemonClientRegistryOptions = {}) {
    this.maxBufferedBytes = Math.max(1, options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES);
    this.maxClients = MAX_CLIENTS;
    this.onDiagnostic = options.onDiagnostic;
  }

  setDiagnosticHandler(handler: ((diagnostic: DaemonClientTransportDiagnostic) => void) | undefined): void {
    this.onDiagnostic = handler;
  }

  connect(ws: WebSocket): ConnectedClient | null {
    if (this.clients.size >= this.maxClients) {
      ws.close(1013, "Too many clients");
      return null;
    }
    const client: ConnectedClient = {
      ws,
      id: `client-${++this.clientIdCounter}`,
      connectedAt: Date.now(),
      pendingMessagesCount: undefined,
      subscriptions: undefined,
    };
    this.clients.set(ws, client);
    return client;
  }

  disconnect(ws: WebSocket): ConnectedClient | undefined {
    const client = this.clients.get(ws);
    if (client) {
      this.cleanupSubscriptions(client);
      this.clients.delete(ws);
    }
    this.failedTransports.delete(ws);
    return client;
  }

  remove(clientId: string): ConnectedClient | undefined {
    for (const [ws, client] of this.clients) {
      if (client.id === clientId) {
        return this.disconnect(ws);
      }
    }
    return undefined;
  }

  get(ws: WebSocket): ConnectedClient | undefined {
    return this.clients.get(ws);
  }

  get size(): number {
    return this.clients.size;
  }

  closeAll(code: number, reason: string): ConnectedClient[] {
    const closedClients = [...this.clients.values()];
    for (const client of closedClients) {
      client.ws.close(code, reason);
    }
    this.clients.clear();
    return closedClients;
  }

  send(ws: WebSocket, message: DaemonOutboundMessage): boolean {
    const payload = this.encodeOutbound(message);
    if (!payload) return false;
    return this.sendPayload(ws, payload, "send");
  }

  broadcast(message: DaemonOutboundMessage): number {
    const payload = this.encodeOutbound(message);
    if (!payload) return 0;

    const payloadBytes = Buffer.byteLength(payload, "utf8");
    let sent = 0;
    for (const [ws] of this.clients) {
      if (this.sendPayload(ws, payload, "broadcast", payloadBytes)) {
        sent += 1;
      }
    }
    return sent;
  }

  sendError(
    ws: WebSocket,
    code: string,
    message: string,
    runId?: string,
    correlation?: DaemonCorrelationFields
  ): boolean {
    return this.send(ws, {
      type: "error",
      code,
      message,
      ...(runId !== undefined ? { runId } : {}),
      ...correlationFields(correlation),
    });
  }

  private encodeOutbound(message: DaemonOutboundMessage): string | undefined {
    const encoded = encodeOutboundMessage(message);
    if (!encoded.ok) {
      const detail = formatProtocolValidationError(encoded.error);
      if (process.env.DEBUG_BATCHER === '1') {
        console.error('[Encode] Refusing:', detail);
      }
      getDaemonLogger().error('Refusing invalid outbound message', { module: 'DaemonClientRegistry', detail });
      this.reportDiagnostic({
        code: "OUTBOUND_PROTOCOL_ERROR",
        message: "Refusing invalid outbound message",
        source: "daemon",
        severity: "error",
        clientId: undefined,
        detail,
        metadata: undefined,
      });
      return undefined;
    }

    return encoded.value;
  }

  private sendPayload(ws: WebSocket, payload: string, operation: "send" | "broadcast", payloadBytes?: number): boolean {
    const client = this.clients.get(ws);
    if (!client || ws.readyState !== ws.OPEN) {
      return false;
    }

    payloadBytes ??= Buffer.byteLength(payload, "utf8");
    if (ws.bufferedAmount + payloadBytes > this.maxBufferedBytes) {
      this.reportTransportFailure(ws, {
        code: "CLIENT_SEND_BACKPRESSURE",
        message: `Client ${client.id} exceeded daemon WebSocket send buffer limit`,
        source: "client",
        severity: "warning",
        clientId: client.id,
        detail: undefined,
        metadata: {
          clientId: client.id,
          operation,
          bufferedAmount: ws.bufferedAmount,
          payloadBytes,
          maxBufferedBytes: this.maxBufferedBytes,
        },
      });
      this.closeClient(ws, SEND_BACKPRESSURE_CLOSE_CODE, "Daemon send backpressure");
      return false;
    }

    client.pendingMessagesCount ??= 0;
    if (client.pendingMessagesCount >= MAX_PENDING_WS_MESSAGES) {
      this.reportTransportFailure(ws, {
        code: "CLIENT_SEND_BACKPRESSURE",
        message: `Client ${client.id} exceeded daemon WebSocket pending message queue limit (${MAX_PENDING_WS_MESSAGES})`,
        source: "client",
        severity: "warning",
        clientId: client.id,
        detail: undefined,
        metadata: {
          clientId: client.id,
          operation,
          pendingMessagesCount: client.pendingMessagesCount,
          maxPendingMessages: MAX_PENDING_WS_MESSAGES,
        },
      });
      this.closeClient(ws, SEND_BACKPRESSURE_CLOSE_CODE, "Daemon send backpressure");
      return false;
    }

    client.pendingMessagesCount++;
    try {
      ws.send(payload, (error) => {
        if (client.pendingMessagesCount !== undefined) {
          client.pendingMessagesCount--;
        }
        if (error) {
          this.reportTransportFailure(ws, {
            code: "CLIENT_SEND_FAILED",
            message: `Failed to send daemon message to ${client.id}: ${error.message}`,
            source: "websocket",
            severity: "error",
            clientId: client.id,
            detail: error.stack,
            metadata: {
              clientId: client.id,
              operation,
              bufferedAmount: ws.bufferedAmount,
              payloadBytes,
            },
          });
          this.closeClient(ws, SEND_FAILURE_CLOSE_CODE, "Daemon send failed");
        }
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportTransportFailure(ws, {
        code: "CLIENT_SEND_FAILED",
        message: `Failed to send daemon message to ${client.id}: ${message}`,
        source: "websocket",
        severity: "error",
        clientId: client.id,
        detail: error instanceof Error ? error.stack : undefined,
        metadata: {
          clientId: client.id,
          operation,
          bufferedAmount: ws.bufferedAmount,
          payloadBytes,
        },
      });
      this.closeClient(ws, SEND_FAILURE_CLOSE_CODE, "Daemon send failed");
      return false;
    }
  }

  private reportTransportFailure(
    ws: WebSocket,
    diagnostic: DaemonClientTransportDiagnostic
  ): void {
    if (this.failedTransports.has(ws)) {
      return;
    }
    this.failedTransports.add(ws);
    this.reportDiagnostic(diagnostic);
  }

  private cleanupSubscriptions(client: ConnectedClient): void {
    if (client.subscriptions) {
      for (const unsubscribe of client.subscriptions) {
        try { unsubscribe(); } catch { /* ignore cleanup errors */ }
      }
      client.subscriptions.clear();
    }
  }

  private reportDiagnostic(diagnostic: DaemonClientTransportDiagnostic): void {
    this.onDiagnostic?.(diagnostic);
  }

  private closeClient(ws: WebSocket, code: number, reason: string): void {
    try {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(code, reason);
        return;
      }
      if (ws.readyState === ws.CLOSING) {
        return;
      }
      ws.terminate();
    } catch (error) {
      getDaemonLogger().error('Failed to close WebSocket after send failure', { module: 'DaemonClientRegistry', err: toLogErr(error) });
      ws.terminate();
    }
  }
}

function correlationFields(correlation: DaemonCorrelationFields | undefined): DaemonCorrelationFields {
  return {
    ...(correlation?.requestId !== undefined ? { requestId: correlation.requestId } : {}),
    ...(correlation?.correlationId !== undefined ? { correlationId: correlation.correlationId } : {}),
  };
}
