/**
 * Config / Status / Capabilities Handlers
 *
 * Extracted from DaemonRequestHandlers to reduce the monolithic
 * server-handlers.ts. Each handler function takes its dependencies
 * explicitly as parameters.
 */

import type { WebSocket } from "ws";
import type { JsonObject } from "@crish/shared-types";
import type {
  DaemonCorrelationFields,
  DaemonLifecycleSnapshot,
  DaemonOutboundMessage,
  DaemonProviderCredentialMode,
  GetStatusMessage,
  ListCapabilitiesMessage,
  UpdateConfigMessage,
} from "../types.js";
import type { RunStatus } from "@crish/shared-types";
import type { AgentOrchestrator } from "@crish/agent-orchestrator";
import type { ApprovalQueue } from "../approval-queue.js";
import { approvalStatusSnapshot } from "../approval-projection.js";
import type { DaemonRuntimeFactory } from "../server-runtime-factory.js";
import { buildDaemonCapabilitySnapshot } from "../capabilities.js";

// ─── Helper functions ──────────────────────────────────────

function isActiveRunStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "awaiting-approval" || status === "cancelling";
}

function stringMetadata(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

// ─── Transport & dependency interfaces ─────────────────────

interface ConfigTransport {
  send(ws: WebSocket, message: unknown): boolean;
  sendError(ws: WebSocket, code: string, message: string, runId?: string, correlation?: DaemonCorrelationFields): boolean;
}

export interface DaemonRuntimeConfigUpdate {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  credentialMode?: DaemonProviderCredentialMode;
  endpoint?: "auto" | "responses" | "chat-completions";
  stream?: boolean;
}

interface ConfigHandlerDeps {
  orchestrator: AgentOrchestrator;
  approvalQueue: ApprovalQueue;
  runtimeFactory: DaemonRuntimeFactory;
  transport: ConfigTransport;
  activeRunCount: number;
  getLifecycleSnapshot(input: {
    activeRunCount: number;
    providerStatus: unknown;
    mcpStatus: unknown;
  }): DaemonLifecycleSnapshot;
  getConfigUpdateHandler(): ((update: DaemonRuntimeConfigUpdate) => void) | undefined;
}

// ─── Handler functions ─────────────────────────────────────

export function handleGetStatus(
  ws: WebSocket,
  msg: GetStatusMessage & DaemonCorrelationFields,
  deps: ConfigHandlerDeps,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): void {
  const activeRuns = deps.orchestrator
    .listRuns()
    .filter((run) => isActiveRunStatus(run.status))
    .map((run) => ({
      runId: run.id,
      prompt: stringMetadata(run.metadata, "prompt") ?? "",
      status: run.status,
      startedAt: Date.parse(run.startedAt ?? run.createdAt),
      cwd: run.cwd,
    }));

  const pendingApprovals = deps.approvalQueue.getPendingApprovals().map((p) => ({
    ...approvalStatusSnapshot(p),
  }));
  const recentApprovals = deps.approvalQueue.getRecentApprovals().map((p) => ({
    ...approvalStatusSnapshot(p),
  }));
  const providerStatus = deps.runtimeFactory.getProviderStatusSnapshot();
  const mcpStatus = deps.runtimeFactory.getMcpStatusSnapshot();
  const lifecycle = deps.getLifecycleSnapshot({
    activeRunCount: deps.activeRunCount,
    providerStatus,
    mcpStatus,
  });
  const capabilities = buildDaemonCapabilitySnapshot({
    providerStatus,
    mcpStatus,
    productAdapters: deps.runtimeFactory.getProductAdapterStatusSnapshot(),
    lifecycle,
  });

  deps.transport.send(
    ws,
    correlateResponse(
      {
        type: "status-response",
        lifecycle,
        activeRuns,
        pendingApprovals,
        recentApprovals,
        providerStatus,
        mcpStatus,
        capabilities,
      },
      msg
    )
  );
}

export function handleListCapabilities(
  ws: WebSocket,
  msg: ListCapabilitiesMessage & DaemonCorrelationFields,
  deps: ConfigHandlerDeps,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): void {
  const providerStatus = deps.runtimeFactory.getProviderStatusSnapshot();
  const mcpStatus = deps.runtimeFactory.getMcpStatusSnapshot();
  const lifecycle = deps.getLifecycleSnapshot({
    activeRunCount: deps.activeRunCount,
    providerStatus,
    mcpStatus,
  });
  const snapshot = buildDaemonCapabilitySnapshot({
    providerStatus,
    mcpStatus,
    productAdapters: deps.runtimeFactory.getProductAdapterStatusSnapshot(),
    lifecycle,
  });

  deps.transport.send(
    ws,
    correlateResponse(
      {
        type: "capabilities-response",
        snapshot,
      },
      msg
    )
  );
}

export function handleUpdateConfig(
  ws: WebSocket,
  msg: UpdateConfigMessage & DaemonCorrelationFields,
  deps: ConfigHandlerDeps,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T,
  correlationFrom: (correlation: DaemonCorrelationFields) => DaemonCorrelationFields
): void {
  const updatedFields: string[] = [];

  if (msg.apiKey !== undefined) updatedFields.push("apiKey");
  if (msg.baseUrl !== undefined) updatedFields.push("baseUrl");
  if (msg.model !== undefined) updatedFields.push("model");
  if (msg.credentialMode !== undefined) updatedFields.push("credentialMode");
  if (msg.endpoint !== undefined) updatedFields.push("endpoint");
  if (msg.stream !== undefined) updatedFields.push("stream");

  if (updatedFields.length === 0) {
    deps.transport.sendError(
      ws,
      "NO_FIELDS",
      "No config fields provided in update-config message",
      undefined,
      correlationFrom(msg)
    );
    return;
  }

  deps.getConfigUpdateHandler()?.({
    ...(msg.apiKey !== undefined ? { apiKey: msg.apiKey } : {}),
    ...(msg.baseUrl !== undefined ? { baseUrl: msg.baseUrl } : {}),
    ...(msg.model !== undefined ? { model: msg.model } : {}),
    ...(msg.credentialMode !== undefined ? { credentialMode: msg.credentialMode } : {}),
    ...(msg.endpoint !== undefined ? { endpoint: msg.endpoint } : {}),
    ...(msg.stream !== undefined ? { stream: msg.stream } : {}),
  });

  console.log(`[Daemon] Config update requested: ${updatedFields.join(", ")}`);

  deps.transport.send(
    ws,
    correlateResponse(
      {
        type: "config-updated",
        updatedFields,
      },
      msg
    )
  );
}
