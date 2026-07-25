import type { JsonObject } from "@crish/shared-types";
import { RingBuffer } from "@crish/shared-utils";
import type { OrchestratorEventStoreError } from "@crish/agent-orchestrator";
import type { ConnectedClient } from "./daemon-client-registry.js";
import type {
  DaemonEventStoreStatusSnapshot,
  DaemonLifecycleDiagnostic,
  DaemonLifecycleDiagnosticSource,
  DaemonLifecycleDiagnosticSeverity,
  DaemonLifecycleSnapshot,
  DaemonLifecycleState,
  DaemonMcpStatusSnapshot,
  DaemonProviderStatusSnapshot,
} from "./types.js";

const MAX_RECENT_ERRORS = 10;

type BaseDaemonLifecycleState = Exclude<DaemonLifecycleState, "degraded">;

export interface DaemonLifecycleSnapshotInput {
  activeRunCount: number;
  connectedClientCount: number;
  eventLogPath: string;
  eventStoreFailure: OrchestratorEventStoreError | undefined;
  providerStatus: DaemonProviderStatusSnapshot;
  mcpStatus: DaemonMcpStatusSnapshot;
}

export interface DaemonLifecycleErrorInput {
  code: string;
  message: string;
  source: DaemonLifecycleDiagnosticSource;
  severity: DaemonLifecycleDiagnosticSeverity | undefined;
  detail: string | undefined;
  metadata: JsonObject | undefined;
}

export class DaemonLifecycleTracker {
  private baseState: BaseDaemonLifecycleState = "starting";
  private readonly startedAtMs = Date.now();
  private readyAtMs?: number;
  private stoppingAtMs?: number;
  private stoppedAtMs?: number;
  private currentPortValue: number | null = null;
  private totalClientConnectionCount = 0;
  private totalClientDisconnectCount = 0;
  private recentDisconnect?: DaemonLifecycleSnapshot["recentDisconnect"];
  private readonly recentErrors = new RingBuffer<DaemonLifecycleDiagnostic>(MAX_RECENT_ERRORS);
  private eventStoreFailure?: OrchestratorEventStoreError;
  private eventStoreFailureDiagnostic?: DaemonLifecycleDiagnostic;

  markReady(port: number, now = Date.now()): void {
    this.baseState = "ready";
    this.currentPortValue = port;
    this.readyAtMs ??= now;
  }

  markStopping(now = Date.now()): void {
    if (this.baseState === "stopped") return;
    this.baseState = "stopping";
    this.stoppingAtMs ??= now;
  }

  markStopped(now = Date.now()): void {
    this.baseState = "stopped";
    this.currentPortValue = null;
    this.stoppedAtMs ??= now;
  }

  recordClientConnected(_client: ConnectedClient): void {
    this.totalClientConnectionCount += 1;
  }

  recordClientDisconnected(
    client: ConnectedClient,
    code: number,
    reason: string,
    now = Date.now()
  ): void {
    this.totalClientDisconnectCount += 1;
    this.recentDisconnect = {
      clientId: client.id,
      code,
      reason,
      connectedAt: toIso(client.connectedAt),
      disconnectedAt: toIso(now),
      durationMs: Math.max(0, now - client.connectedAt),
    };
  }

  recordError(input: DaemonLifecycleErrorInput, now = Date.now()): void {
    const error: DaemonLifecycleDiagnostic = {
      code: input.code,
      message: input.message,
      updatedAt: toIso(now),
      source: input.source,
      severity: input.severity ?? "error",
      detail: input.detail ?? undefined,
      metadata: input.metadata ?? undefined,
    };
    this.recentErrors.pushOverwritingOldest(error);
  }

  getRecentErrors(): DaemonLifecycleDiagnostic[] {
    return this.recentErrors.toArray();
  }

  snapshot(input: DaemonLifecycleSnapshotInput, now = Date.now()): DaemonLifecycleSnapshot {
    const eventStore = this.eventStoreStatus(input.eventLogPath, input.eventStoreFailure, now);
    const recentError = this.recentErrors.peekLast() ?? eventStore.failure;
    const errors = this.recentErrors.toArray();
    const state = this.deriveState(input.providerStatus, input.mcpStatus, eventStore);

    return {
      state,
      startedAt: toIso(this.startedAtMs),
      updatedAt: toIso(now),
      readyAt: this.readyAtMs !== undefined ? toIso(this.readyAtMs) : undefined,
      stoppingAt: this.stoppingAtMs !== undefined ? toIso(this.stoppingAtMs) : undefined,
      stoppedAt: this.stoppedAtMs !== undefined ? toIso(this.stoppedAtMs) : undefined,
      uptimeMs: Math.max(0, (this.stoppedAtMs ?? now) - this.startedAtMs),
      currentPort: this.currentPortValue,
      connectedClientCount: input.connectedClientCount,
      totalClientConnectionCount: this.totalClientConnectionCount,
      totalClientDisconnectCount: this.totalClientDisconnectCount,
      activeRunCount: input.activeRunCount,
      recentDisconnect: this.recentDisconnect ?? undefined,
      recentError: recentError ?? undefined,
      recentErrors: errors.length > 0 ? errors : undefined,
      eventStore,
      providerReadiness: input.providerStatus.readiness,
      mcpReadiness: input.mcpStatus.readiness,
    };
  }

  private deriveState(
    providerStatus: DaemonProviderStatusSnapshot,
    mcpStatus: DaemonMcpStatusSnapshot,
    eventStore: DaemonEventStoreStatusSnapshot
  ): DaemonLifecycleState {
    if (this.baseState !== "ready") return this.baseState;
    if (eventStore.status === "failed") return "degraded";
    if (providerStatus.readiness !== "ready") return "degraded";
    if (mcpStatus.configured && mcpStatus.readiness !== "ready") return "degraded";
    return "ready";
  }

  private eventStoreStatus(
    eventLogPath: string,
    failure: OrchestratorEventStoreError | undefined,
    now: number
  ): DaemonEventStoreStatusSnapshot {
    if (!failure) {
      return {
        status: "ok",
        path: eventLogPath,
        failure: undefined,
      };
    }

    if (this.eventStoreFailure !== failure) {
      this.eventStoreFailure = failure;
      this.eventStoreFailureDiagnostic = eventStoreFailureDiagnostic(failure, eventLogPath, now);
    }

    return {
      status: "failed",
      path: eventLogPath,
      failure: this.eventStoreFailureDiagnostic,
    };
  }
}

function eventStoreFailureDiagnostic(
  failure: OrchestratorEventStoreError,
  eventLogPath: string,
  now: number
): DaemonLifecycleDiagnostic {
  const kind = stringField(failure, "kind") ?? "write-failed";
  const eventId = stringField(failure, "eventId");
  const filePath = stringField(failure, "filePath") ?? eventLogPath;
  const metadata: JsonObject = {
    kind,
    filePath,
    ...(eventId ? { eventId } : {}),
  };

  return {
    code: kind === "closed" ? "EVENT_STORE_CLOSED" : "EVENT_STORE_WRITE_FAILED",
    message: failure.message,
    updatedAt: toIso(now),
    source: "event-store",
    severity: "error",
    detail: failure.stack ?? undefined,
    metadata,
  };
}

function stringField(value: object, key: string): string | undefined {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}
