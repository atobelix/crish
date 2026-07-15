import type { WebSocket } from "ws";
import type { DaemonCorrelationFields, DaemonOutboundMessage } from "./types.js";
import {
  encodeOutboundMessage,
  formatProtocolValidationError,
} from "./protocol/protocol.js";

export interface ConnectedClient {
  ws: WebSocket;
  id: string;
  connectedAt: number;
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
  clientId?: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface DaemonClientRegistryOptions {
  maxBufferedBytes?: number;
  onDiagnostic?: (diagnostic: DaemonClientTransportDiagnostic) => void;
}

const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;
const SEND_BACKPRESSURE_CLOSE_CODE = 1013;
const SEND_FAILURE_CLOSE_CODE = 1011;

export class DaemonClientRegistry {
  private readonly clients = new Map<WebSocket, ConnectedClient>();
  private readonly maxBufferedBytes: number;
  private readonly failedTransports = new WeakSet<WebSocket>();
  private clientIdCounter = 0;
  private onDiagnostic?: (diagnostic: DaemonClientTransportDiagnostic) => void;

  constructor(options: DaemonClientRegistryOptions = {}) {
    this.maxBufferedBytes = Math.max(1, options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES);
    this.onDiagnostic = options.onDiagnostic;
  }

  setDiagnosticHandler(handler: ((diagnostic: DaemonClientTransportDiagnostic) => void) | undefined): void {
    this.onDiagnostic = handler;
  }

  connect(ws: WebSocket): ConnectedClient {
    const client: ConnectedClient = {
      ws,
      id: `client-${++this.clientIdCounter}`,
      connectedAt: Date.now(),
    };
    this.clients.set(ws, client);
    return client;
  }

  disconnect(ws: WebSocket): ConnectedClient | undefined {
    const client = this.clients.get(ws);
    if (client) {
      this.clients.delete(ws);
    }
    return client;
  }

  get(ws: WebSocket): ConnectedClient | undefined {
    return this.clients.get(ws);
  }

  get size(): number {
    return this.clients.size;
  }

  closeAll(code: number, reason: string): ConnectedClient[] {
    const closedClients = [...this.clients.values()];
    for (const [ws] of this.clients) {
      ws.close(code, reason);
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

    let sent = 0;
    for (const [ws] of this.clients) {
      if (this.sendPayload(ws, payload, "broadcast")) {
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
      runId,
      ...correlationFields(correlation),
    });
  }

  private encodeOutbound(message: DaemonOutboundMessage): string | undefined {
    const encoded = encodeOutboundMessage(message);
    if (!encoded.ok) {
      const detail = formatProtocolValidationError(encoded.error);
      console.error(`[Daemon] Refusing invalid outbound message: ${detail}`);
      this.reportDiagnostic({
        code: "OUTBOUND_PROTOCOL_ERROR",
        message: "Refusing invalid outbound message",
        source: "daemon",
        severity: "error",
        detail,
      });
      return undefined;
    }

    return encoded.value;
  }

  private sendPayload(ws: WebSocket, payload: string, operation: "send" | "broadcast"): boolean {
    const client = this.clients.get(ws);
    if (!client || ws.readyState !== ws.OPEN) {
      return false;
    }

    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (ws.bufferedAmount + payloadBytes > this.maxBufferedBytes) {
      this.reportTransportFailure(ws, {
        code: "CLIENT_SEND_BACKPRESSURE",
        message: `Client ${client.id} exceeded daemon WebSocket send buffer limit`,
        source: "client",
        severity: "warning",
        clientId: client.id,
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

    try {
      ws.send(payload, (error) => {
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
      console.error("[Daemon] Failed to close WebSocket after send failure:", error);
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
