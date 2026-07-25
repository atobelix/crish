import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { TokenBucket } from "@crish/shared-utils";
import type { DaemonInboundMessage, DaemonCorrelationFields } from "../types.js";
import { DaemonClientRegistry, type ConnectedClient, type DaemonClientTransportDiagnostic } from "../daemon-client-registry.js";
import { DaemonLifecycleTracker, type DaemonLifecycleErrorInput } from "../daemon-lifecycle.js";
import { getDaemonLogger, toLogErr } from "../daemon-logger.js";
import { validateInboundMessage, formatProtocolValidationError } from "../protocol/protocol.js";
import { BINARY_FRAME_CAPABILITY, BinaryFrameType, decodeBinaryFrame, decodeMetaBodyPayload, encodeBinaryFrame, looksLikeBinaryFrame, type BinaryFrameTypeCode } from "../binary-frame.js";
import type { JsonObject, JsonValue } from "@crish/shared-types";
import type { DaemonStoreRegistry } from "./store-registry.js";
import type { DaemonMessageRouter } from "./message-router.js";
import type { DaemonSubagentBridge } from "../daemon-subagent-bridge.js";

export class DaemonConnectionManager {
  readonly wss!: WebSocketServer;
  readonly clients: DaemonClientRegistry;
  readonly port!: number;
  readonly lifecycle: DaemonLifecycleTracker;
  private connectionLimiter = new TokenBucket(50, 50);
  private byteLimiter = new TokenBucket(4 * 1024 * 1024, 4 * 1024 * 1024);
  private readonly secretToken: string | undefined;
  private readonly stores: DaemonStoreRegistry;
  private readonly messageRouter: DaemonMessageRouter;
  private subagentBridge?: DaemonSubagentBridge;
  private onLifecycleError?: (input: DaemonLifecycleErrorInput) => void;

  constructor(
    private readonly config: { port: number; secretToken?: string; maxClientBufferedBytes?: number },
    stores: DaemonStoreRegistry,
    messageRouter: DaemonMessageRouter,
    lifecycle: DaemonLifecycleTracker
  ) {
    this.secretToken = config.secretToken;
    this.stores = stores;
    this.messageRouter = messageRouter;
    this.lifecycle = lifecycle;
    this.clients = new DaemonClientRegistry({
      ...(config.maxClientBufferedBytes !== undefined ? { maxBufferedBytes: config.maxClientBufferedBytes } : {}),
      onDiagnostic: (diagnostic) => this.handleDiagnostic(diagnostic),
    });
  }

  setSubagentBridge(bridge: DaemonSubagentBridge): void {
    this.subagentBridge = bridge;
  }

  setLifecycleErrorHandler(handler: (input: DaemonLifecycleErrorInput) => void): void {
    this.onLifecycleError = handler;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      let settled = false;
      Object.defineProperty(this, "wss", {
        value: new WebSocketServer({ port: this.config.port }),
        writable: false,
      });

      this.wss.on("listening", () => {
        const address = this.wss.address() as AddressInfo;
        Object.defineProperty(this, "port", { value: address.port, writable: false });
        this.lifecycle.markReady(this.port);
        getDaemonLogger().info("WebSocket server listening", { module: "server", port: this.port });
        settled = true;
        resolve(this.port);
      });

      this.wss.on("error", (error) => {
        getDaemonLogger().error("Server error", { module: "server", err: toLogErr(error) });
        this.recordError({
          code: "WEBSOCKET_SERVER_ERROR",
          message: `WebSocket server error: ${error.message}`,
          source: "websocket",
          ...(error.stack !== undefined ? { detail: error.stack } : {}),
        });
        if (!settled) {
          settled = true;
          this.lifecycle.markStopped();
          reject(error);
        }
      });

      this.wss.on("connection", (ws) => this.handleConnection(ws));

      this.wss.on("close", () => {
        getDaemonLogger().info("Server closed", { module: "server" });
        if (!settled) {
          this.lifecycle.markStopped();
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.wss || this.wss.address() === null) return;
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  closeAllClientConnections(code: number, reason: string): ConnectedClient[] {
    return this.clients.closeAll(code, reason);
  }

  private handleConnection(ws: WebSocket): void {
    const client = this.clients.connect(ws);
    if (!client) return;

    this.lifecycle.recordClientConnected(client);
    getDaemonLogger().info("Client connected", { module: "server", clientId: client.id, totalClients: this.clients.size });

    const handshakeTimer = setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        ws.close(4002, "Handshake timeout: expected hello message");
      }
    }, 5_000);
    handshakeTimer.unref?.();

    ws.on("message", (data) => {
      clearTimeout(handshakeTimer);
      this.messageRouter.trackTask(this.handleMessage(ws, data));
    });
    ws.on("close", (code, reason) => {
      this.handleDisconnect(ws, code, reason);
      ws.removeAllListeners("message");
      ws.removeAllListeners("ping");
      ws.removeAllListeners("pong");
    });
    ws.on("error", (error) => {
      this.recordError({
        code: "CLIENT_SOCKET_ERROR",
        message: `Client ${client.id} socket error: ${error.message}`,
        source: "client",
        severity: undefined,
        detail: error.stack,
        metadata: { clientId: client.id },
      });
      getDaemonLogger().error("Client socket error", { module: "server", clientId: client.id, err: toLogErr(error) });
    });

    ws.on("ping", (data) => {
      ws.pong(data);
    });
  }

  private async handleMessage(ws: WebSocket, data: RawData): Promise<void> {
    const buffer = rawDataToBuffer(data);
    const msgBytes = buffer.byteLength;
    if (!this.connectionLimiter.tryConsume(1) || !this.byteLimiter.tryConsume(msgBytes)) {
      ws.send(JSON.stringify({ type: "error", code: "RATE_LIMITED", message: "Too many requests" }));
      return;
    }

    if (looksLikeBinaryFrame(buffer)) {
      await this.handleBinaryFrame(ws, buffer);
      return;
    }

    const parsed = parseClientMessage(buffer);
    if (!parsed.ok) {
      const client = this.clients.get(ws);
      this.recordError({
        code: "CLIENT_PARSE_ERROR",
        message: parsed.message,
        source: "client",
        ...(client ? { metadata: { clientId: client.id } } : {}),
      });
      this.clients.sendError(ws, "PARSE_ERROR", parsed.message);
      return;
    }

    const raw = parsed.value as Record<string, unknown>;
    if (raw.type === "hello") {
      this.handleHello(ws, raw);
      return;
    }

    const validation = validateInboundMessage(parsed.value);
    if (!validation.ok) {
      this.clients.sendError(ws, validation.error.code, formatProtocolValidationError(validation.error), undefined, correlationFromRawMessage(parsed.value));
      return;
    }

    const client = this.clients.get(ws);
    if (!client) return;

    if (this.rejectDurableRunWhenEventStoreFailed(ws, client, validation.value)) return;

    await this.messageRouter.route(validation.value, ws, client);
  }

  private handleHello(ws: WebSocket, message: Record<string, unknown>): void {
    const clientVersion = typeof message.protocolVersion === "number" ? message.protocolVersion : 0;
    const serverVersion = 2;

    if (clientVersion < 1) {
      ws.close(4003, `Protocol version ${clientVersion} not supported. Server requires version >= 1`);
      return;
    }

    if (this.secretToken) {
      const clientToken = typeof message.token === "string" ? message.token : "";
      if (clientToken !== this.secretToken) {
        getDaemonLogger().warn("Authentication failed: invalid token", { module: "server" });
        ws.close(4001, "Authentication failed");
        return;
      }
    }

    this.clients.send(ws, {
      type: "welcome",
      protocolVersion: serverVersion,
      serverName: "crish-daemon",
      capabilities: ["run-task", "approval", "pending-input", "workflow", "git", "plan-document", BINARY_FRAME_CAPABILITY],
    });

    for (const sub of this.subagentBridge?.getActiveSubagentsSnapshot() ?? []) {
      this.clients.send(ws, {
        type: "subagent-started",
        runId: sub.runId,
        subagentId: sub.subagentId,
        subagentRunId: sub.subagentRunId,
        parentToolCallId: sub.parentToolCallId,
        description: sub.description,
        mode: sub.mode,
      });
    }
  }

  private async handleBinaryFrame(ws: WebSocket, buffer: Buffer): Promise<void> {
    const client = this.clients.get(ws);
    const decoded = decodeBinaryFrame(buffer);
    if (!decoded.ok) {
      this.recordError({
        code: "CLIENT_BINARY_FRAME_ERROR",
        message: decoded.error,
        source: "client",
        ...(client ? { metadata: { clientId: client.id } } : {}),
      });
      this.clients.sendError(ws, "BINARY_FRAME_ERROR", decoded.error);
      return;
    }

    const frame = decoded.frame;
    try {
      switch (frame.type) {
        case BinaryFrameType.STREAM_PAUSE:
        case BinaryFrameType.STREAM_RESUME: {
          let runId = "";
          if (frame.payload.byteLength > 0) {
            try {
              const meta = JSON.parse(frame.payload.toString("utf8")) as { runId?: unknown };
              runId = typeof meta.runId === "string" ? meta.runId : "";
            } catch { /* ignore invalid meta */ }
          }
          if (frame.type === BinaryFrameType.STREAM_PAUSE) {
            this.messageRouter.pauseStream(runId);
          } else {
            this.messageRouter.resumeStream(runId);
          }
          this.sendBinaryAck(ws, { ok: true, type: frame.typeName, runId, receivedAt: Date.now() });
          return;
        }

        case BinaryFrameType.STREAM_ACK: {
          this.sendBinaryAck(ws, { ok: true, type: frame.typeName, receivedAt: Date.now() });
          return;
        }

        case BinaryFrameType.CONTROL_JSON: {
          let control: unknown;
          try {
            control = JSON.parse(frame.payload.toString("utf8"));
          } catch (error) {
            this.clients.sendError(ws, "BINARY_CONTROL_JSON_ERROR", `Invalid CONTROL_JSON payload: ${(error as Error).message}`);
            return;
          }
          if (control !== null && typeof control === "object" && !Array.isArray(control)) {
            const raw = control as Record<string, unknown>;
            if (raw.type === "hello") {
              this.handleHello(ws, raw);
              return;
            }
            const validation = validateInboundMessage(control);
            if (!validation.ok) {
              this.clients.sendError(ws, validation.error.code, formatProtocolValidationError(validation.error), undefined, correlationFromRawMessage(control));
              return;
            }
            if (!client) return;
            await this.messageRouter.route(validation.value, ws, client);
          }
          return;
        }

        case BinaryFrameType.FILE_PATCH:
        case BinaryFrameType.DIFF_TEXT: {
          const metaBody = decodeMetaBodyPayload(frame.payload);
          this.sendBinaryAck(ws, { ok: true, type: frame.typeName, bodyBytes: frame.payload.byteLength, meta: metaBody.ok ? metaBody.meta : null });
          return;
        }

        case BinaryFrameType.TOOL_BLOB: {
          this.sendBinaryAck(ws, { ok: true, type: frame.typeName, bodyBytes: frame.payload.byteLength });
          return;
        }

        default: {
          this.clients.sendError(ws, "BINARY_FRAME_UNSUPPORTED", `Unhandled binary frame type: ${frame.typeName}`);
        }
      }
    } catch (error) {
      this.recordError({
        code: "DAEMON_BINARY_FRAME_HANDLER_ERROR",
        message: `Binary frame handler failed: ${(error as Error).message}`,
        source: "daemon",
        severity: undefined,
        detail: (error as Error).stack,
        metadata: client ? { clientId: client.id, frameType: frame.typeName } : undefined,
      });
      this.clients.sendError(ws, "DAEMON_ERROR", error instanceof Error ? error.message : String(error));
    }
  }

  private sendBinaryAck(ws: WebSocket, receipt: Record<string, unknown>): boolean {
    return this.sendBinaryFrame(ws, BinaryFrameType.STREAM_ACK, Buffer.from(JSON.stringify(receipt), "utf8"));
  }

  private sendBinaryFrame(ws: WebSocket, type: BinaryFrameTypeCode, payload: Buffer): boolean {
    if (ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(encodeBinaryFrame(type, payload));
      return true;
    } catch (error) {
      return false;
    }
  }

  private handleDisconnect(ws: WebSocket, code: number, reason: Buffer): void {
    const client = this.clients.disconnect(ws);
    if (client) {
      this.lifecycle.recordClientDisconnected(client, code, reason.toString());
      getDaemonLogger().info("Client disconnected", { module: "server", clientId: client.id, code, reason: reason.toString() });
    }
  }

  private rejectDurableRunWhenEventStoreFailed(
    ws: WebSocket,
    client: ConnectedClient,
    message: DaemonInboundMessage
  ): boolean {
    if (!isNewDurableRunMessage(message)) return false;
    const failure = this.stores.eventStore.getFailure();
    if (!failure) return false;

    const runId = message.type === "run-task" ? message.runId : (message as unknown as Record<string, unknown>).runId as string;
    getDaemonLogger().warn("Rejecting run because event store is degraded", { module: "server", requestType: message.type, runId });
    this.clients.sendError(ws, "EVENT_STORE_DEGRADED", degradedRunRejectionMessage(failure), runId, message as unknown as import("../types.js").DaemonCorrelationFields);
    this.recordError({
      code: "EVENT_STORE_DEGRADED_RUN_REJECTED",
      message: `Rejected durable run while event store is degraded: ${failure.message}`,
      source: "event-store",
      severity: "warning",
      detail: failure.stack ?? undefined,
      metadata: { clientId: client.id, requestType: message.type, ...(runId ? { runId } : {}), ...eventStoreFailureMetadata(failure, this.stores.eventLogPath) },
    });
    return true;
  }

  private handleDiagnostic(diagnostic: DaemonClientTransportDiagnostic): void {
    const metadata = diagnostic.metadata !== undefined
      ? diagnosticMetadata(diagnostic.metadata)
      : diagnostic.clientId !== undefined
        ? { clientId: diagnostic.clientId }
        : undefined;
    this.recordError({
      code: diagnostic.code,
      message: diagnostic.message,
      source: diagnostic.source,
      severity: diagnostic.severity,
      ...(diagnostic.detail !== undefined ? { detail: diagnostic.detail } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }

  private recordError(input: DaemonLifecycleErrorInput): void {
    this.onLifecycleError?.(input);
    this.lifecycle.recordError(input);
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as Buffer | string | Uint8Array);
}

function parseClientMessage(data: RawData | Buffer): { ok: true; value: unknown } | { ok: false; message: string } {
  const buffer = Buffer.isBuffer(data) ? data : rawDataToBuffer(data);
  try {
    return { ok: true, value: JSON.parse(buffer.toString("utf8")) };
  } catch (error) {
    return { ok: false, message: `Invalid JSON: ${(error as Error).message}` };
  }
}

function correlationFromRawMessage(value: unknown): DaemonCorrelationFields | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.requestId === "string" && record.requestId.length > 0 ? { requestId: record.requestId } : {}),
    ...(typeof record.correlationId === "string" && record.correlationId.length > 0 ? { correlationId: record.correlationId } : {}),
  };
}

function isNewDurableRunMessage(message: DaemonInboundMessage): message is Extract<DaemonInboundMessage, { type: "run-task" | "trigger-workflow" }> {
  return message.type === "run-task" || message.type === "trigger-workflow";
}

function degradedRunRejectionMessage(failure: { message: string }): string {
  return `Daemon event store is degraded; durable run start rejected. ${failure.message}`;
}

function eventStoreFailureMetadata(failure: { kind: string | undefined; filePath: string | undefined; eventId: string | undefined }, eventLogPath: string): JsonObject {
  return { kind: failure.kind ?? "unknown", filePath: (failure.filePath || eventLogPath) as string, eventId: failure.eventId ?? null };
}

function diagnosticMetadata(metadata: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(metadata)) {
    result[key] = toDiagnosticJsonValue(value);
  }
  return result;
}

function toDiagnosticJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Number.isNaN(value) ? null : value;
  }
  if (Array.isArray(value)) return value.map((item) => toDiagnosticJsonValue(item));
  if (value && typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = toDiagnosticJsonValue(nested);
    }
    return result;
  }
  return String(value);
}
