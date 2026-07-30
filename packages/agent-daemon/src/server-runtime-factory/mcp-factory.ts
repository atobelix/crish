import type { JsonObject } from "@crish/shared-types";
import { compactJsonObject } from "@crish/shared-utils";
import { McpLifecycleManager } from "@crish/agent-mcp";
import type { McpLifecycleDiagnostic, McpLifecycleSnapshot, McpLifecycleStartResult, McpServerDefinition } from "@crish/agent-mcp";
import type { DaemonMcpStatusSnapshot } from "./types.js";

interface IMcpServerManager {
  startServer(serverId: string): { state?: string };
  stopServer(serverId: string): { state?: string };
}

function isMcpServerManager(
  manager: McpLifecycleManager
): manager is McpLifecycleManager & IMcpServerManager {
  return typeof (manager as IMcpServerManager).startServer === "function";
}

function aggregateMcpStatus(
  managers: McpLifecycleManager[]
): DaemonMcpStatusSnapshot {
  if (managers.length === 0) return unconfiguredMcpStatusSnapshot();

  const snapshots = managers.map((manager) => manager.snapshot());
  const servers = snapshots.flatMap((snapshot) => snapshot.servers);
  const diagnostics = snapshots.flatMap((snapshot) => snapshot.diagnostics);
  const summary: Record<string, number> = {
    discovering: 0,
    starting: 0,
    ready: 0,
    degraded: 0,
    reconnecting: 0,
    stopped: 0,
  };

  for (const snapshot of snapshots) {
    for (const [state, count] of Object.entries(snapshot.summary)) {
      summary[state] = (summary[state] ?? 0) + count;
    }
  }

  const updatedAt =
    servers
      .map((server) => server.updatedAt)
      .sort()
      .at(-1) ?? new Date().toISOString();

  return {
    configured: true,
    readiness: readinessFromSummary(summary),
    serverCount: servers.length,
    summary: summary as JsonObject,
    diagnostics: diagnostics.map(mcpDiagnosticToJson),
    servers: servers.map(mcpServerSnapshotToJson),
    updatedAt,
  };
}

function mcpStatusFromDiagnostics(
  diagnostics: McpLifecycleDiagnostic[]
): DaemonMcpStatusSnapshot {
  const updatedAt =
    diagnostics
      .map((diagnostic) => diagnostic.timestamp)
      .sort()
      .at(-1) ?? new Date().toISOString();
  return {
    configured: true,
    readiness: "degraded",
    serverCount: 0,
    summary: {
      discovering: 0,
      starting: 0,
      ready: 0,
      degraded: 1,
      reconnecting: 0,
      stopped: 0,
    },
    diagnostics: diagnostics.map(mcpDiagnosticToJson),
    servers: [],
    updatedAt,
  };
}

function unconfiguredMcpStatusSnapshot(): DaemonMcpStatusSnapshot {
  return {
    configured: false,
    readiness: "unknown",
    serverCount: 0,
    summary: {
      discovering: 0,
      starting: 0,
      ready: 0,
      degraded: 0,
      reconnecting: 0,
      stopped: 0,
    },
    diagnostics: [],
    servers: [],
    updatedAt: new Date().toISOString(),
  };
}

function idleMcpStatusSnapshot(
  serverCount: number,
  servers: JsonObject[] = []
): DaemonMcpStatusSnapshot {
  return {
    configured: true,
    readiness: "unknown",
    serverCount,
    summary: {
      discovering: 0,
      starting: 0,
      ready: 0,
      degraded: 0,
      reconnecting: 0,
      stopped: 0,
    },
    diagnostics: [],
    servers,
    updatedAt: new Date().toISOString(),
  };
}

function configuredServersFromDefinitions(
  definitions: McpServerDefinition[] | undefined
): JsonObject[] {
  if (!definitions?.length) return [];
  const updatedAt = new Date().toISOString();
  return definitions.map((server) =>
    compactJsonObject({
      id: server.name,
      name: server.name,
      label: server.label ?? server.name,
      state: "configured",
      transport: "stdio",
      cachedToolCount: server.cachedTools?.length ?? 0,
      updatedAt,
    })
  );
}

function mapLifecycleServersToList(
  servers: JsonObject[] | Array<Record<string, unknown>>
): Array<{
  id: string;
  name: string;
  state: string;
  transport?: string | undefined;
  cachedToolCount?: number | undefined;
  lastError?: string | undefined;
  startedAt?: string | undefined;
}> {
  return servers.map((s) => {
    const row = s as Record<string, unknown>;
    const name = String(row.name ?? row.id ?? "");
    const diagnostic =
      row.diagnostic && typeof row.diagnostic === "object"
        ? (row.diagnostic as Record<string, unknown>)
        : undefined;
    return {
      id: String(row.id ?? row.name ?? name),
      name,
      state: String(row.state ?? "unknown"),
      transport: typeof row.transport === "string" ? row.transport : undefined,
      cachedToolCount:
        typeof row.cachedToolCount === "number"
          ? row.cachedToolCount
          : typeof row.toolCount === "number"
            ? row.toolCount
            : undefined,
      lastError:
        typeof row.lastError === "string"
          ? row.lastError
          : typeof row.error === "string"
            ? row.error
            : typeof diagnostic?.message === "string"
              ? diagnostic.message
              : undefined,
      startedAt: typeof row.startedAt === "string" ? row.startedAt : undefined,
    } as { id: string; name: string; state: string; transport?: string | undefined; cachedToolCount?: number | undefined; lastError?: string | undefined; startedAt?: string | undefined };
  });
}

function readinessFromMcpSnapshot(
  snapshot: McpLifecycleSnapshot
): DaemonMcpStatusSnapshot["readiness"] {
  return readinessFromSummary(snapshot.summary);
}

function readinessFromSummary(
  summary: Record<string, number>
): DaemonMcpStatusSnapshot["readiness"] {
  if ((summary.degraded ?? 0) > 0) return "degraded";
  if (
    (summary.starting ?? 0) > 0 ||
    (summary.discovering ?? 0) > 0 ||
    (summary.reconnecting ?? 0) > 0
  ) {
    return "starting";
  }
  if ((summary.ready ?? 0) > 0) return "ready";
  if ((summary.stopped ?? 0) > 0) return "stopped";
  return "unknown";
}

function mcpLifecycleSnapshotToJson(
  snapshot: McpLifecycleSnapshot
): JsonObject {
  return compactJsonObject({
    summary: snapshot.summary,
    diagnostics: snapshot.diagnostics.map(mcpDiagnosticToJson),
    servers: snapshot.servers.map(mcpServerSnapshotToJson),
  });
}

function mcpServerSnapshotToJson(
  server: McpLifecycleSnapshot["servers"][number]
): JsonObject {
  return compactJsonObject({
    name: server.name,
    label: server.label,
    state: server.state,
    cachedToolCount: server.cachedToolCount,
    liveToolCount: server.liveToolCount,
    availableToolCount: server.availableToolCount,
    diagnosticCount: server.diagnosticCount,
    diagnostics: server.diagnostics.map(mcpDiagnosticToJson),
    diagnostic: server.diagnostic
      ? mcpDiagnosticToJson(server.diagnostic)
      : undefined,
    startedAt: server.startedAt,
    updatedAt: server.updatedAt,
  });
}

function mcpDiagnosticToJson(diagnostic: McpLifecycleDiagnostic): JsonObject {
  return compactJsonObject({
    code: diagnostic.code,
    message: diagnostic.message,
    phase: diagnostic.phase,
    severity: diagnostic.severity,
    retryable: diagnostic.retryable,
    timestamp: diagnostic.timestamp,
    server: diagnostic.server,
    state: diagnostic.state,
    toolName: diagnostic.toolName,
    cause: diagnostic.cause,
  });
}

function syntheticMcpDiagnostic(
  cause: unknown,
  server: string
): McpLifecycleDiagnostic {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: "MCP_CONNECT_FAILED",
    message,
    phase: "startup-gate",
    severity: "error",
    retryable: true,
    timestamp: new Date().toISOString(),
    server,
    state: "degraded",
    cause: message,
  };
}

function mcpRunMetadata(
  startResult: McpLifecycleStartResult,
  snapshot: McpLifecycleSnapshot
): JsonObject {
  return compactJsonObject({
    configured: true,
    readiness: readinessFromMcpSnapshot(snapshot),
    readyServers: startResult.readyServers,
    degradedServers: startResult.degradedServers.map((entry) => ({
      server: entry.server,
      diagnostic: mcpDiagnosticToJson(entry.diagnostic),
    })),
    pendingServers: startResult.pendingServers,
    stoppedServers: startResult.stoppedServers,
    timedOut: startResult.timedOut,
    toolCount: startResult.tools.length,
    diagnostics: startResult.diagnostics.map(mcpDiagnosticToJson),
    snapshot: mcpLifecycleSnapshotToJson(snapshot),
  });
}

function withMcpRunMetadata(
  metadata: JsonObject | undefined,
  mcp: JsonObject
): JsonObject {
  return {
    ...(metadata ?? {}),
    mcp,
  };
}

function withScopedContextRunMetadata(
  metadata: JsonObject | undefined,
  scopedContext: unknown
): JsonObject {
  return {
    ...(metadata ?? {}),
    scopedContext: scopedContext as JsonObject[keyof JsonObject],
  };
}

export type { IMcpServerManager };
export {
  isMcpServerManager,
  aggregateMcpStatus,
  mcpStatusFromDiagnostics,
  unconfiguredMcpStatusSnapshot,
  idleMcpStatusSnapshot,
  configuredServersFromDefinitions,
  mapLifecycleServersToList,
  readinessFromMcpSnapshot,
  readinessFromSummary,
  mcpLifecycleSnapshotToJson,
  mcpServerSnapshotToJson,
  mcpDiagnosticToJson,
  syntheticMcpDiagnostic,
  mcpRunMetadata,
  withMcpRunMetadata,
  withScopedContextRunMetadata,
};
