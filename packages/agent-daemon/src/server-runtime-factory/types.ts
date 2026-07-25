import type { AgentRuntimeOptions, AgentTool } from "@crish/agent-runtime";
import type { JsonObject } from "@crish/shared-types";
import type { DaemonConfig } from "../types.js";
import type { ScopedContextStore } from "../scoped-context-store.js";
import type {
  BackgroundCommandManager,
  McpLifecycleManager,
  McpServerDefinition,
  WorkspaceMutationCoordinator,
} from "@crish/agent-runtime";
import type {
  OrchestratorRunHandle,
  StartRunRequest,
} from "@crish/agent-orchestrator";
import { ApprovalQueue } from "../approval-queue.js";
import type { DaemonProductAdapters } from "../daemon-product-adapters.js";

export type DaemonProviderFactory = (
  runId: string,
  cwd: string
) => AgentRuntimeOptions["provider"] | Promise<AgentRuntimeOptions["provider"]>;

export interface DaemonToolFactoryInput {
  cwd: string;
  mutationCoordinator: WorkspaceMutationCoordinator;
  backgroundManager: BackgroundCommandManager;
}

export type DaemonToolFactory = (input: DaemonToolFactoryInput) => AgentTool[];

export class DaemonUnsupportedCapabilityError extends Error {
  readonly code = "UNSUPPORTED_CAPABILITY";

  constructor(
    readonly capability: string,
    message: string
  ) {
    super(message);
    this.name = "DaemonUnsupportedCapabilityError";
  }
}

export interface DaemonMcpLifecycleManagerFactoryInput {
  runId: string;
  sessionId: string;
  cwd: string;
  metadata?: JsonObject;
}

export type DaemonMcpLifecycleManagerFactory = (
  input: DaemonMcpLifecycleManagerFactoryInput
) => McpLifecycleManager | undefined | Promise<McpLifecycleManager | undefined>;

export interface DaemonMcpStatusSnapshot {
  configured: boolean;
  readiness: "ready" | "degraded" | "starting" | "stopped" | "unknown";
  serverCount: number;
  summary: JsonObject;
  diagnostics: JsonObject[];
  servers: JsonObject[];
  updatedAt: string;
}

export interface DaemonRuntimeFactoryOptions {
  config: DaemonConfig;
  approvalQueue: ApprovalQueue;
  sessionStoreDir?: string;
  scopedContextStore?: ScopedContextStore;
  productAdapters?: DaemonProductAdapters;
  getBackgroundCommandManager?(cwd: string): BackgroundCommandManager;
  mcpServers?: McpServerDefinition[];
  mcpLifecycleManagerFactory?: DaemonMcpLifecycleManagerFactory;
  mcpStartupGateTimeoutMs?: number;
  startRun(request: StartRunRequest): Promise<OrchestratorRunHandle>;
  cancelRun(runId: string, reason?: string): boolean;
  steerRun?(runId: string, message: string): boolean;
  isRunActive?(runId: string): boolean;
  getRunStatus?(runId: string): { status: string } | undefined;
}
