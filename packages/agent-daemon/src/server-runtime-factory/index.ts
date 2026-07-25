import type { AgentRuntimeOptions, AgentTool } from "@crish/agent-runtime";
import { InMemoryContextState, JsonlSessionStore, McpLifecycleManager, createProductRuntimeDefaults } from "@crish/agent-runtime";
import { createAgentRuntimeRunEngineFactory, type CreateRunEngineInput, type RunEngineFactory } from "@crish/agent-orchestrator";
import { compactJsonObject, toJsonObject } from "@crish/shared-utils";
import type { JsonObject } from "@crish/shared-types";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { DaemonApprovalHandler } from "../daemon-approval-handler.js";
import { buildDaemonScopedPromptContext } from "../scoped-context-runtime.js";
import { createUnsupportedProductSurfaceStatus, type DaemonProductAdapterStatusSnapshot, type DaemonProductAdapters } from "../daemon-product-adapters.js";
import type { DaemonProviderStatusSnapshot, ArtifactRecord, ChangedFileRecord, CheckpointRecord, McpServerRecord, MemoryRecord } from "../types.js";
import { normalizeDaemonPermissionMode, DaemonPermissionPolicy } from "../daemon-permission-policy.js";
import { runtimeConfigMerger, runtimeConfigLayers, stringMetadata, numberMetadata, stringArrayMetadata, parseMcpDisabledTools, isMcpToolDisabledName, logRuntimeConfigValidation } from "./config-assembly.js";
import { aggregateMcpStatus, mcpStatusFromDiagnostics, unconfiguredMcpStatusSnapshot, idleMcpStatusSnapshot, configuredServersFromDefinitions, mcpRunMetadata, withMcpRunMetadata, withScopedContextRunMetadata, syntheticMcpDiagnostic, mcpDiagnosticToJson } from "./mcp-factory.js";
import { WorkspaceCoordinatorManager, createToolsForRun, backgroundCommandManagerForCwd, providerStatusProviderFromFactory } from "./tool-assembly.js";
import type { DaemonProviderFactory, DaemonRuntimeFactoryOptions, DaemonMcpStatusSnapshot, DaemonToolFactory, DaemonMcpLifecycleManagerFactoryInput } from "./types.js";
import { DaemonUnsupportedCapabilityError } from "./types.js";
export type { DaemonProviderFactory, DaemonToolFactory, DaemonToolFactoryInput, DaemonMcpLifecycleManagerFactory, DaemonMcpLifecycleManagerFactoryInput, DaemonMcpStatusSnapshot } from "./types.js";
export { DaemonUnsupportedCapabilityError } from "./types.js";

export class DaemonRuntimeFactory {
  private providerFactory?: DaemonProviderFactory;
  private providerStatusProvider: (() => DaemonProviderStatusSnapshot) | undefined;
  private toolFactory?: DaemonToolFactory;
  private readonly coordinators = new WorkspaceCoordinatorManager();
  private readonly mcpManagers = new Set<McpLifecycleManager>();
  private sharedMcpManager: McpLifecycleManager | undefined;
  private lastMcpStatus?: DaemonMcpStatusSnapshot;

  constructor(private readonly options: DaemonRuntimeFactoryOptions) {}

  setProviderFactory(factory: DaemonProviderFactory): void {
    this.providerFactory = factory;
    this.providerStatusProvider = providerStatusProviderFromFactory(factory);
  }

  setToolFactory(factory: DaemonToolFactory): void { this.toolFactory = factory; }

  hasProviderFactory(): boolean { return this.providerFactory !== undefined; }

  getProviderStatusSnapshot(): DaemonProviderStatusSnapshot {
    return this.withMcpProviderDiagnostics(this.providerStatusProvider?.() ?? unconfiguredProviderStatus());
  }

  getMcpStatusSnapshot(): DaemonMcpStatusSnapshot {
    if (this.mcpManagers.size > 0) { this.lastMcpStatus = aggregateMcpStatus([...this.mcpManagers]); return this.lastMcpStatus; }
    if (this.sharedMcpManager) { this.lastMcpStatus = aggregateMcpStatus([this.sharedMcpManager]); return this.lastMcpStatus; }
    if (this.lastMcpStatus) return this.lastMcpStatus;
    if (this.options.mcpLifecycleManagerFactory || (this.options.mcpServers?.length ?? 0) > 0) {
      this.lastMcpStatus = idleMcpStatusSnapshot(this.options.mcpServers?.length ?? 0, configuredServersFromDefinitions(this.options.mcpServers));
      return this.lastMcpStatus;
    }
    this.lastMcpStatus = unconfiguredMcpStatusSnapshot();
    return this.lastMcpStatus;
  }

  async setMcpServers(servers: import("@crish/agent-runtime").McpServerDefinition[]): Promise<void> {
    this.options.mcpServers = servers;
    if (this.sharedMcpManager) { this.mcpManagers.delete(this.sharedMcpManager); try { await this.sharedMcpManager.teardown(); } catch {} this.sharedMcpManager = undefined; }
    this.lastMcpStatus = servers.length === 0 ? unconfiguredMcpStatusSnapshot() : idleMcpStatusSnapshot(servers.length, configuredServersFromDefinitions(servers));
  }

  getWorkspaceMutationCoordinator(cwd: string) { return this.coordinators.getCoordinator(cwd); }
  listMutationLeases() { return this.coordinators.listLeases(); }

  getProductAdapterStatusSnapshot(now: Date = new Date()): DaemonProductAdapterStatusSnapshot {
    return {
      artifacts: this.options.productAdapters?.artifact?.status(now) ?? createUnsupportedProductSurfaceStatus("artifacts", now),
      memory: this.options.productAdapters?.memory?.status(now) ?? createUnsupportedProductSurfaceStatus("memory", now),
      checkpoints: this.options.productAdapters?.checkpoint?.status(now) ?? createUnsupportedProductSurfaceStatus("checkpoints", now),
    };
  }

  private adapterCall<T>(adapterKey: keyof DaemonProductAdapters, capability: string, fn: (adapter: NonNullable<DaemonProductAdapters[typeof adapterKey]>) => T): T {
    const adapters = this.options.productAdapters;
    if (!adapters) throw new DaemonUnsupportedCapabilityError(capability, `${capability} is not supported because no daemon ${capability} adapter is configured.`);
    const adapter = adapters[adapterKey];
    if (!adapter) throw new DaemonUnsupportedCapabilityError(capability, `${capability} is not supported because no daemon ${capability} adapter is configured.`);
    return fn(adapter as NonNullable<DaemonProductAdapters[typeof adapterKey]>);
  }

  async listArtifacts(sessionId?: string): Promise<ArtifactRecord[]> { return this.adapterCall("artifact", "artifacts", (a) => (a as import("../daemon-product-adapters.js").DaemonArtifactAdapter).listArtifacts(sessionId)); }
  async getArtifactContent(artifactUri: string): Promise<{ content: string; mimeType?: string }> { return this.adapterCall("artifact", "artifacts", (a) => (a as import("../daemon-product-adapters.js").DaemonArtifactAdapter).getArtifactContent(artifactUri)); }
  async listMemories(scope?: string): Promise<MemoryRecord[]> { return this.adapterCall("memory", "memory", (a) => (a as import("../daemon-product-adapters.js").DaemonMemoryAdapter).listMemories(scope)); }
  async deleteMemory(memoryId: string): Promise<void> { return this.adapterCall("memory", "memory", (a) => (a as import("../daemon-product-adapters.js").DaemonMemoryAdapter).deleteMemory(memoryId)); }
  async listCheckpoints(runId?: string, sessionId?: string): Promise<CheckpointRecord[]> { return this.adapterCall("checkpoint", "checkpoints", (a) => (a as import("../daemon-product-adapters.js").DaemonCheckpointAdapter).listCheckpoints({ ...(runId !== undefined ? { runId } : {}), ...(sessionId !== undefined ? { sessionId } : {}) })); }
  async restoreCheckpoint(checkpointId: string): Promise<{ runId: string }> { return this.adapterCall("checkpoint", "checkpoints", (a) => { const ca = a as import("../daemon-product-adapters.js").DaemonCheckpointAdapter; if (!ca.restoreCheckpoint) throw new DaemonUnsupportedCapabilityError("checkpoints", "Checkpoint restore is not supported by the configured adapter."); return ca.restoreCheckpoint(checkpointId); }); }
  async getCheckpointDiff(checkpointId: string): Promise<ChangedFileRecord[]> { return this.adapterCall("checkpoint", "checkpoints", (a) => (a as import("../daemon-product-adapters.js").DaemonCheckpointAdapter).getCheckpointDiff!(checkpointId)); }

  sendToSubagent(subagentRunId: string, message: string): boolean {
    const text = message.trim();
    if (!text) return false;
    if (!this.options.steerRun) throw new DaemonUnsupportedCapabilityError("subagent", "Subagent steer is not wired (missing steerRun on runtime factory)");
    return this.options.steerRun(subagentRunId, text);
  }

  getSubagentStatus(subagentRunId: string): { status: string; progress?: string; latestError?: string } {
    if (this.options.isRunActive?.(subagentRunId)) return { status: "running", progress: "active" };
    const rec = this.options.getRunStatus?.(subagentRunId);
    return rec ? { status: rec.status } : { status: "unknown" };
  }

  startMcpServer(serverId: string): { state: string } {
    for (const manager of this.mcpManagers) {
      const srv = manager as unknown as Record<string, unknown>;
      if (typeof srv.startServer === "function") {
        try { return { state: ((srv.startServer as (id: string) => { state?: string })(serverId))?.state ?? "starting" }; } catch {}
      }
    }
    return { state: "unknown" };
  }

  stopMcpServer(serverId: string): { state: string } {
    for (const manager of this.mcpManagers) {
      const srv = manager as unknown as Record<string, unknown>;
      if (typeof srv.stopServer === "function") {
        try { return { state: ((srv.stopServer as (id: string) => { state?: string })(serverId))?.state ?? "stopped" }; } catch {}
      }
    }
    return { state: "unknown" };
  }

  listMcpServers(): McpServerRecord[] {
    const status = this.lastMcpStatus?.servers ? this.lastMcpStatus : this.getMcpStatusSnapshot();
    if (!status.servers) return [];
    return status.servers.map((s: Record<string, unknown>) => ({
      id: String(s.id ?? s.name ?? ""), name: String(s.name ?? s.id ?? ""), state: String(s.state ?? "unknown"),
      transport: s.transport != null ? String(s.transport) : undefined,
      cachedToolCount: s.cachedToolCount != null ? Number(s.cachedToolCount) : s.toolCount != null ? Number(s.toolCount) : undefined,
      lastError: s.lastError != null ? String(s.lastError) : s.error != null ? String(s.error) : undefined,
      startedAt: s.startedAt != null ? String(s.startedAt) : undefined,
    })) as McpServerRecord[];
  }

  createRunEngineFactory(): RunEngineFactory {
    return createAgentRuntimeRunEngineFactory(async ({ runId, session, run }) => this.createRuntimeOptions({ runId, session, run }));
  }

  async createRuntimeOptions({ runId, session, run }: CreateRunEngineInput): Promise<AgentRuntimeOptions> {
    if (!this.providerFactory) throw new Error("Provider factory not configured. Call setProviderFactory() first.");

    const { config: mergedConfig, validation } = runtimeConfigMerger.mergeAndValidate(runtimeConfigLayers({ daemonConfig: this.options.config, runMetadata: run.metadata } as unknown as import("./config-assembly.js").RuntimeConfigLayerSources));
    logRuntimeConfigValidation(runId, validation);

    const permissionMode = normalizeDaemonPermissionMode(mergedConfig.permissionMode ?? "ask");
    const maxTurns = (mergedConfig.maxTurns as number) ?? 32;
    const subagentDepth = (mergedConfig.subagentDepth as number) ?? 0;
    const permissionPolicy = new DaemonPermissionPolicy(permissionMode);
    const mutationCoordinator = this.coordinators.getCoordinator(run.cwd);
    const backgroundManager = backgroundCommandManagerForCwd(run.cwd, this.options.getBackgroundCommandManager);
    const contextState = new InMemoryContextState();
    const sessionStore = new JsonlSessionStore(this.sessionStorePath(session.id, run.cwd), { mode: "resume-or-create" });

    const scopedPromptContext = await buildDaemonScopedPromptContext(this.options.scopedContextStore, {
      cwd: run.cwd,
      ...(stringMetadata(run.metadata, "workspaceRoot") !== undefined ? { workspaceRoot: stringMetadata(run.metadata, "workspaceRoot") } : {}),
      ...(stringMetadata(run.metadata, "projectRoot") !== undefined ? { projectRoot: stringMetadata(run.metadata, "projectRoot") } : {}),
      ...(stringArrayMetadata(run.metadata, "projectMarkers") !== undefined ? { projectMarkers: stringArrayMetadata(run.metadata, "projectMarkers") } : {}),
      ...(stringArrayMetadata(run.metadata, "projectFiles") !== undefined ? { projectFiles: stringArrayMetadata(run.metadata, "projectFiles") } : {}),
      ...(stringArrayMetadata(run.metadata, "projectTags") !== undefined ? { projectTags: stringArrayMetadata(run.metadata, "projectTags") } : {}),
      ...(stringArrayMetadata(run.metadata, "packageNames") !== undefined ? { packageNames: stringArrayMetadata(run.metadata, "packageNames") } : {}),
      metadata: run.metadata,
    } as unknown as import("../scoped-context-runtime.js").DaemonScopedPromptContextInput);
    run.metadata = withScopedContextRunMetadata(run.metadata, scopedPromptContext.metadata) as JsonObject;

    const mcpTools = await this.startMcpForRun({ runId, sessionId: session.id, cwd: run.cwd, metadata: run.metadata, runMetadataTarget: run });
    const disabledMcp = parseMcpDisabledTools(run.metadata);
    const filteredMcpTools = disabledMcp.size === 0 ? mcpTools : mcpTools.filter((tool) => !isMcpToolDisabledName(tool.name, disabledMcp));

    return {
      sessionId: session.id, cwd: run.cwd,
      systemPrompt: stringMetadata(run.metadata, "systemPrompt"),
      promptContext: { stableContext: scopedPromptContext.stableContext, volatileContext: scopedPromptContext.volatileContext, metadata: scopedPromptContext.metadata },
      provider: await this.providerFactory(runId, run.cwd),
      tools: [...createToolsForRun({ runId, sessionId: session.id, cwd: run.cwd, mutationCoordinator, backgroundManager, permissionMode, subagentDepth, maxTurns, ...(this.toolFactory !== undefined ? { toolFactory: this.toolFactory } : {}), startRun: (r) => this.options.startRun(r), cancelRun: (id, reason) => this.options.cancelRun(id, reason) }), ...filteredMcpTools],
      maxTurns, permissionPolicy,
      approvalHandler: new DaemonApprovalHandler(this.options.approvalQueue, runId),
      sessionStore, resumeSession: true, workspaceMutationCoordinator: mutationCoordinator,
      ...createProductRuntimeDefaults({ cwd: run.cwd, contextWindowTokens: numberMetadata(run.metadata, "contextWindowTokens"), thresholdTokens: numberMetadata(run.metadata, "autoCompactAtTokens"), preferredWorkingTokens: numberMetadata(run.metadata, "preferredWorkingTokens"), contextState } as unknown as import("@crish/agent-runtime").ProductRuntimeDefaultsOptions),
    } as unknown as Promise<AgentRuntimeOptions>;
  }

  async close(): Promise<void> {
    const managers = [...this.mcpManagers];
    if (managers.length === 0) return;
    await Promise.all(managers.map((m) => m.teardown()));
    this.lastMcpStatus = aggregateMcpStatus(managers);
    this.mcpManagers.clear();
    this.sharedMcpManager = undefined;
  }

  private sessionStorePath(sessionId: string, cwd: string): string {
    const root = resolve(this.options.sessionStoreDir ?? ".codex/daemon-runtime-sessions");
    const cwdHash = createHash("sha256").update(workspaceCoordinatorKey(cwd)).digest("hex").slice(0, 16);
    return join(root, `${safePathSegment(sessionId)}-${cwdHash}.jsonl`);
  }

  private async startMcpForRun(input: { runId: string; sessionId: string; cwd: string; metadata?: JsonObject; runMetadataTarget: { metadata?: JsonObject } }): Promise<AgentTool[]> {
    const manager = await this.resolveMcpManager(input);
    if (!manager) return [];
    this.mcpManagers.add(manager);
    try {
      const startResult = await manager.start();
      this.lastMcpStatus = aggregateMcpStatus([...this.mcpManagers]);
      input.runMetadataTarget.metadata = withMcpRunMetadata(input.runMetadataTarget.metadata, mcpRunMetadata(startResult, manager.snapshot()));
      return startResult.tools;
    } catch (cause) {
      const diagnostic = syntheticMcpDiagnostic(cause, "daemon-mcp");
      this.lastMcpStatus = mcpStatusFromDiagnostics([diagnostic]);
      input.runMetadataTarget.metadata = withMcpRunMetadata(input.runMetadataTarget.metadata, {
        configured: true, readiness: "degraded", readyServers: [], degradedServers: [], pendingServers: [], stoppedServers: [],
        timedOut: false, toolCount: 0, diagnostics: [mcpDiagnosticToJson(diagnostic)], snapshot: toJsonObject(this.lastMcpStatus),
      });
      return [];
    }
  }

  private async resolveMcpManager(input: DaemonMcpLifecycleManagerFactoryInput): Promise<McpLifecycleManager | undefined> {
    if (this.options.mcpLifecycleManagerFactory) return this.options.mcpLifecycleManagerFactory(input);
    return this.ensureSharedMcpManagerForControl();
  }

  private async ensureSharedMcpManagerForControl(): Promise<McpLifecycleManager | undefined> {
    if (this.options.mcpLifecycleManagerFactory) {
      for (const m of this.mcpManagers) return m;
      const created = await this.options.mcpLifecycleManagerFactory({ runId: "mcp-control", sessionId: "mcp-control", cwd: this.options.config.defaultCwd });
      if (created) { this.sharedMcpManager = created; this.mcpManagers.add(created); }
      return created;
    }
    if (!this.options.mcpServers?.length) return undefined;
    if (!this.sharedMcpManager) {
      this.sharedMcpManager = new McpLifecycleManager({ id: "daemon-mcp", label: "Daemon MCP", servers: this.options.mcpServers, startupGateTimeoutMs: this.options.mcpStartupGateTimeoutMs } as unknown as import("@crish/agent-runtime").McpLifecycleManagerOptions);
    }
    return this.sharedMcpManager;
  }

  private withMcpProviderDiagnostics(status: DaemonProviderStatusSnapshot): DaemonProviderStatusSnapshot {
    const mcpStatus = this.getMcpStatusSnapshot();
    if (!mcpStatus.configured || mcpStatus.diagnostics.length === 0) return status;
    const metadata = compactJsonObject({ ...(status.lastDiagnostic?.metadata ?? {}), mcp: toJsonObject(mcpStatus) });
    const lastDiagnostic = status.lastDiagnostic ? { ...status.lastDiagnostic, metadata } : {
      code: mcpStatus.readiness === "degraded" ? "mcp_degraded" : "mcp_not_ready",
      message: mcpStatus.readiness === "degraded" ? "One or more MCP servers are degraded." : "MCP lifecycle is not ready.",
      kind: "mcp" as const, updatedAt: mcpStatus.updatedAt, metadata,
    };
    return { ...status, lastDiagnostic };
  }
}

function workspaceCoordinatorKey(cwd: string): string {
  const normalized = resolve(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "session";
}

function unconfiguredProviderStatus(): DaemonProviderStatusSnapshot {
  const updatedAt = new Date().toISOString();
  return {
    credentialMode: "auto", readiness: "missing", providerId: "unconfigured", routeId: "unconfigured",
    baseUrl: "", model: "", upstreamModel: "", endpoint: "auto", stream: true, systemPromptWireMode: "user-prefix",
    apiKey: { hasApiKey: false, source: "unset" }, hasDirectApiKey: false, apiKeySource: "unset",
    gateway: { ready: false, credentialConfigured: false, routeDecision: ["provider_factory_missing"] },
    lastDiagnostic: { code: "provider_factory_missing", message: "Provider factory is not configured.", updatedAt }, updatedAt,
    lastProbeOk: undefined, lastProbeAt: undefined,
  };
}
