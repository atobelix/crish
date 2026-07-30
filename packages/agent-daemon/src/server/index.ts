import { errorMessage } from "@crish/shared-utils";
import { getDaemonLogger } from "../daemon-logger.js";
import { AgentOrchestrator } from "@crish/agent-orchestrator";
import type { OrchestratorEvent } from "@crish/agent-orchestrator";
import type { JsonObject } from "@crish/shared-types";
import type { DaemonConfig, DaemonLifecycleSnapshot, DaemonProviderStatusSnapshot, DaemonMcpStatusSnapshot, DaemonMcpServerConfig } from "../types.js";
import { normalizeDaemonConfig, resolveDaemonCheckpointManifestPath, resolveDaemonMemoryStorePath, resolveDaemonRuntimeSessionDir } from "../persistence.js";
import { buildMcpServerDefinitions, normalizeDaemonMcpServers } from "../mcp-config.js";
import { ApprovalQueue } from "../approval-queue.js";
import { DaemonRuntimeFactory, type DaemonMcpLifecycleManagerFactory, type DaemonToolFactory } from "../server-runtime-factory.js";
import { DaemonCheckpointManifestAdapter, DaemonJsonlMemoryAdapter } from "../daemon-product-adapters.js";
import { DaemonBackgroundTaskManager } from "../background-task-manager.js";
import { DaemonSubagentBridge } from "../daemon-subagent-bridge.js";
import { readDaemonSubagentBridgeUpdateFromAgentEvent } from "../subagent-runtime.js";
import { DaemonLifecycleTracker, type DaemonLifecycleErrorInput } from "../daemon-lifecycle.js";
import type { DaemonRuntimeConfigUpdate } from "../server-handlers.js";
import { RunHandler, correlateResponse } from "../handlers/run-handlers.js";
import { DaemonRequestHandlers } from "../server-handlers.js";
import type { AgentRuntimeOptions } from "@crish/agent-core";
import type { McpServerDefinition } from "@crish/agent-mcp";
import { DaemonStoreRegistry } from "./store-registry.js";
import { DaemonConnectionManager } from "./connection-manager.js";
import { DaemonMessageRouter } from "./message-router.js";
import { DaemonWorkflowManager } from "./workflow-manager.js";
import { ApprovalBridge } from "./approval-bridge.js";
import { startHealthServer, startMetricsServer, startMetricsFlushLoop } from "./http-servers.js";
import type { Server as HttpServer } from "node:http";
import { PrometheusExporter } from "../observability/prometheus-exporter.js";

export { DaemonStoreRegistry } from "./store-registry.js";
export { DaemonConnectionManager } from "./connection-manager.js";
export { DaemonMessageRouter } from "./message-router.js";
export { DaemonWorkflowManager } from "./workflow-manager.js";
export { ApprovalBridge } from "./approval-bridge.js";

export interface DaemonServerOptions {
  productAdapters?: import("../daemon-product-adapters.js").DaemonProductAdapters;
  mcpServers?: McpServerDefinition[];
  mcpLifecycleManagerFactory?: DaemonMcpLifecycleManagerFactory;
  mcpStartupGateTimeoutMs?: number;
  maxClientBufferedBytes?: number;
}

export class DaemonServer {
  private lifecycle!: DaemonLifecycleTracker;
  private stores!: DaemonStoreRegistry;
  private connections!: DaemonConnectionManager;
  private messageRouter!: DaemonMessageRouter;
  private workflows!: DaemonWorkflowManager;
  private approvalBridge = new ApprovalBridge();
  private orchestrator!: AgentOrchestrator;
  private runtimeFactory!: DaemonRuntimeFactory;
  private backgroundTasks!: DaemonBackgroundTaskManager;
  private subagentBridge!: DaemonSubagentBridge;
  private runHandler!: RunHandler;
  private requestHandlers!: DaemonRequestHandlers;
  /** Per-session active run tracking: sessionId → runId */
  private readonly activeRuns = new Map<string, string>();
  private config!: DaemonConfig;
  private approvalQueue!: ApprovalQueue;
  private eventLogPath!: string;
  private configUpdateHandler?: (update: DaemonRuntimeConfigUpdate) => void;
  private pendingProviderFactory: ((runId: string, cwd: string) => AgentRuntimeOptions["provider"] | Promise<AgentRuntimeOptions["provider"]>) | undefined;
  private pendingToolFactory: DaemonToolFactory | undefined;
  private stopPromise?: Promise<void>;
  private healthServer: HttpServer | undefined;
  private metricsServer: HttpServer | undefined;
  private prometheusExporter: PrometheusExporter | undefined;
  private metricsFlushTimer: ReturnType<typeof setInterval> | undefined;
  private providerProbeTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config?: Partial<DaemonConfig>, private readonly options: DaemonServerOptions = {}) {
    const normalized = normalizeDaemonConfig(config);
    if (normalized.mcpServers?.length) {
      normalized.mcpServers = normalizeDaemonMcpServers(normalized.mcpServers);
    } else {
      normalized.mcpServers = [];
    }
    this.config = normalized;
  }

  async applyMcpServerConfigs(configs: DaemonMcpServerConfig[]): Promise<void> {
    const normalized = normalizeDaemonMcpServers(configs);
    this.config.mcpServers = normalized;
    if (!this.runtimeFactory) return;
    await this.runtimeFactory.setMcpServers(buildMcpServerDefinitions(normalized));
  }

  setProviderFactory(factory: (runId: string, cwd: string) => AgentRuntimeOptions["provider"] | Promise<AgentRuntimeOptions["provider"]>): void {
    if (this.runtimeFactory) this.runtimeFactory.setProviderFactory(factory);
    else this.pendingProviderFactory = factory;
  }

  setToolFactory(factory: DaemonToolFactory): void {
    if (this.runtimeFactory) this.runtimeFactory.setToolFactory(factory);
    else this.pendingToolFactory = factory;
  }

  setConfigUpdateHandler(handler: (update: DaemonRuntimeConfigUpdate) => void): void {
    this.configUpdateHandler = handler;
  }

  recordLifecycleError(input: DaemonLifecycleErrorInput): void {
    this.lifecycle.recordError(input);
  }

  getApprovalQueue(): ApprovalQueue { return this.approvalQueue; }

  /** 手动触发工作流调度器 tick（用于测试或外部触发） */
  async tickScheduler(now: Date = new Date()) {
    return this.workflows.tickScheduler(now);
  }

  async readSessionEvents(sessionId: string, afterSequence?: number): Promise<OrchestratorEvent[]> {
    return this.orchestrator.readSessionEvents(sessionId, afterSequence);
  }

  async readRunEvents(runId: string, afterSequence?: number): Promise<OrchestratorEvent[]> {
    return this.orchestrator.readRunEvents(runId, afterSequence);
  }

  getEventLogPath(): string { return this.eventLogPath; }
  getWorkflowStorePath(): string { return this.stores.workflowStore.filePath; }
  getPlanDocumentStorePath(): string { return this.stores.planDocumentStore.filePath; }
  getScopedContextStorePath(): string { return this.stores.scopedContextStore.filePath; }
  getSessionMetadataStorePath(): string { return this.stores.sessionMetadataStore.filePath; }

  getLifecycleSnapshot(input?: { activeRunCount: number | undefined; providerStatus: DaemonProviderStatusSnapshot | undefined; mcpStatus: DaemonMcpStatusSnapshot | undefined }): DaemonLifecycleSnapshot {
    const providerStatus = input?.providerStatus ?? this.runtimeFactory.getProviderStatusSnapshot();
    const mcpStatus = input?.mcpStatus ?? this.runtimeFactory.getMcpStatusSnapshot();
    const activeRunCount = input?.activeRunCount ?? this.orchestrator.countActiveRuns();
    return this.lifecycle.snapshot({
      activeRunCount, connectedClientCount: this.connections.clients.size, eventLogPath: this.eventLogPath,
      eventStoreFailure: this.stores.eventStore.getFailure(), providerStatus, mcpStatus,
    });
  }

  private buildDependencies(): void {
    this.lifecycle = new DaemonLifecycleTracker();
    this.stores = new DaemonStoreRegistry(this.config);
    this.eventLogPath = this.stores.eventLogPath;
    this.approvalQueue = new ApprovalQueue({ defaultTimeoutMs: this.config.approvalTimeoutMs });
    this.backgroundTasks = new DaemonBackgroundTaskManager({
      defaultWorkspaceRoot: this.config.defaultCwd,
      managerOptions: { defaultTimeoutMs: 30 * 60_000, maxOutputBytes: 500_000 },
    });
    this.messageRouter = new DaemonMessageRouter();
    this.connections = new DaemonConnectionManager(
      { port: this.config.port, ...(this.config.secretToken !== undefined ? { secretToken: this.config.secretToken } : {}), ...(this.options.maxClientBufferedBytes !== undefined ? { maxClientBufferedBytes: this.options.maxClientBufferedBytes } : {}) },
      this.stores, this.messageRouter, this.lifecycle
    );
    this.connections.setLifecycleErrorHandler((input) => this.lifecycle.recordError(input));

    const mcpServerDefinitions = this.options.mcpServers ?? buildMcpServerDefinitions(this.config.mcpServers ?? []);
    this.runtimeFactory = new DaemonRuntimeFactory({
      config: this.config, approvalQueue: this.approvalQueue,
      sessionStoreDir: resolveDaemonRuntimeSessionDir(this.config),
      scopedContextStore: this.stores.scopedContextStore,
      productAdapters: {
        checkpoint: new DaemonCheckpointManifestAdapter({ manifestPath: resolveDaemonCheckpointManifestPath(this.config) }),
        memory: new DaemonJsonlMemoryAdapter({ storePath: resolveDaemonMemoryStorePath(this.config) }),
        ...this.options.productAdapters,
      },
      getBackgroundCommandManager: (cwd) => this.backgroundTasks.getManagerForCwd(cwd),
      ...(mcpServerDefinitions.length > 0 ? { mcpServers: mcpServerDefinitions } : {}),
      ...(this.options.mcpLifecycleManagerFactory !== undefined ? { mcpLifecycleManagerFactory: this.options.mcpLifecycleManagerFactory } : {}),
      ...(this.options.mcpStartupGateTimeoutMs !== undefined ? { mcpStartupGateTimeoutMs: this.options.mcpStartupGateTimeoutMs } : {}),
      startRun: (request) => this.startDurableRun(request),
      cancelRun: (runId, reason) => this.orchestrator.cancelRun(runId, reason),
      steerRun: (runId, message) => this.orchestrator.steerRun(runId, message),
      isRunActive: (runId) => this.orchestrator.isRunActive(runId),
      getRunStatus: (runId) => { const run = this.orchestrator.getRun(runId); return run ? { status: run.status } : undefined; },
    });

    if (this.pendingProviderFactory) { this.runtimeFactory.setProviderFactory(this.pendingProviderFactory); this.pendingProviderFactory = undefined; }
    if (this.pendingToolFactory) { this.runtimeFactory.setToolFactory(this.pendingToolFactory); this.pendingToolFactory = undefined; }

    this.orchestrator = new AgentOrchestrator({
      eventStore: this.stores.eventStore,
      createRunEngine: this.runtimeFactory.createRunEngineFactory(),
    });

    this.subagentBridge = new DaemonSubagentBridge(
      (message) => this.connections.clients.broadcast(message), this.approvalQueue
    );
    this.connections.setSubagentBridge(this.subagentBridge);

    this.runHandler = new RunHandler({
      orchestrator: this.orchestrator, approvalQueue: this.approvalQueue, config: this.config,
      runtimeFactory: this.runtimeFactory, transport: this.connections.clients,
      subagentBridge: this.subagentBridge, workflowStore: this.stores.workflowStore,
      recordDiagnostic: (input: { code: string; message: string; source: string; severity?: string; detail?: string; metadata?: JsonObject }) => this.lifecycle.recordError({ code: input.code, message: input.message, source: input.source as import("../types.js").DaemonLifecycleDiagnosticSource, severity: input.severity as import("../types.js").DaemonLifecycleDiagnosticSeverity | undefined, detail: input.detail, metadata: input.metadata }),
    });

    this.requestHandlers = new DaemonRequestHandlers({
      runHandler: this.runHandler, orchestrator: this.orchestrator, approvalQueue: this.approvalQueue,
      config: this.config, runtimeFactory: this.runtimeFactory, backgroundTasks: this.backgroundTasks,
      workflowStore: this.stores.workflowStore, planDocumentStore: this.stores.planDocumentStore,
      scopedContextStore: this.stores.scopedContextStore, sessionMetadataStore: this.stores.sessionMetadataStore,
      transport: this.connections.clients, subagentBridge: this.subagentBridge,
      getLifecycleSnapshot: (input) => this.getLifecycleSnapshot(input),
      recordDiagnostic: (input: { code: string; message: string; source: string; severity?: string; detail?: string; metadata?: JsonObject }) => this.lifecycle.recordError({ code: input.code, message: input.message, source: input.source as import("../types.js").DaemonLifecycleDiagnosticSource, severity: input.severity as import("../types.js").DaemonLifecycleDiagnosticSeverity | undefined, detail: input.detail, metadata: input.metadata }),
      getConfigUpdateHandler: () => this.configUpdateHandler,
      applyMcpServerConfigs: (configs) => this.applyMcpServerConfigs(configs),
    });

    this.workflows = new DaemonWorkflowManager(
      this.stores.workflowStore,
      (due, now) => { this.assertEventStoreAvailableForNewRun(undefined, "scheduled-workflow"); return this.requestHandlers.triggerDueWorkflow(due, now); },
      this.config.workflowSchedulerIntervalMs,
      (error) => this.lifecycle.recordError({
        code: "WORKFLOW_SCHEDULER_TICK_FAILED",
        message: `Workflow scheduler tick failed: ${errorMessage(error)}`,
        source: "daemon",
        ...(error instanceof Error && error.stack !== undefined ? { detail: error.stack } : {}),
      })
    );
    this.registerMessageHandlers();
  }

  private registerMessageHandlers(): void {
    const rh = this.runHandler;
    const transport = this.connections.clients;
    const dh = this.requestHandlers;

    this.messageRouter.register("run-task", async (msg, ws, client) => {
      const taskMsg = msg as import("../types.js").RunTaskMessage;
      const sessionId = taskMsg.sessionId || taskMsg.runId;
      if (this.activeRuns.has(sessionId)) {
        transport.sendError(ws, "SESSION_BUSY", `Session ${sessionId} already has an active run`, taskMsg.runId, taskMsg as unknown as import("../types.js").DaemonCorrelationFields);
        return;
      }
      this.activeRuns.set(sessionId, taskMsg.runId || `run-${Date.now()}`);
      let sessionReleased = false;
      const releaseSession = (): void => {
        if (sessionReleased) return;
        sessionReleased = true;
        this.activeRuns.delete(sessionId);
      };
      try {
        await rh.handleRunTaskWithOrchestrator(ws, client.id, taskMsg, { onSessionRelease: releaseSession });
      } finally {
        releaseSession();
      }
    });
    const handleApproval = (handlerName: "handleApproveTool" | "handleDenyTool") => async (msg: import("../types.js").DaemonInboundMessage, ws: import("ws").WebSocket) => {
      const mod = await import("../handlers/approval-handlers.js");
      if (handlerName === "handleApproveTool") {
        mod.handleApproveTool(msg as import("../types.js").ApproveToolMessage, this.approvalQueue, transport, ws);
      } else {
        mod.handleDenyTool(msg as import("../types.js").DenyToolMessage, this.approvalQueue, transport, ws);
      }
    };
    this.messageRouter.register("approve-tool", handleApproval("handleApproveTool"));
    this.messageRouter.register("deny-tool", handleApproval("handleDenyTool"));
    this.messageRouter.register("cancel-run", async (msg) => { rh.handleCancelRun(msg as import("../types.js").CancelRunMessage); });
    this.messageRouter.register("run-control", async (msg) => { rh.handleRunControl(msg as import("../types.js").RunControlMessage); });
    this.messageRouter.register("stream-pause", async (msg, ws) => { rh.pauseStream((msg as unknown as Record<string, unknown>).runId as string); transport.send(ws, correlateResponse({ type: "pong" }, msg)); });
    this.messageRouter.register("stream-resume", async (msg, ws) => { rh.resumeStream((msg as unknown as Record<string, unknown>).runId as string); transport.send(ws, correlateResponse({ type: "pong" }, msg)); });
    this.messageRouter.register("ping", async (msg, ws) => { transport.send(ws, correlateResponse({ type: "pong" }, msg)); });

    const statusHandler = (handlerName: string) => (async (msg: import("../types.js").DaemonInboundMessage, ws: import("ws").WebSocket, _client: import("../daemon-client-registry.js").ConnectedClient) => {
      const mod = await import("../handlers/config-handlers.js");
      (mod[handlerName as keyof typeof mod] as Function)(ws, msg, {
        orchestrator: this.orchestrator, approvalQueue: this.approvalQueue, runtimeFactory: this.runtimeFactory,
        transport, activeRunCount: rh.activeRunCount(),
        getLifecycleSnapshot: (input: any) => this.getLifecycleSnapshot(input),
        getConfigUpdateHandler: () => this.configUpdateHandler,
      }, correlateResponse);
    });

    this.messageRouter.register("get-status", statusHandler("handleGetStatus"));
    this.messageRouter.register("list-capabilities", statusHandler("handleListCapabilities"));
    this.messageRouter.register("update-config", async (msg, ws) => {
      const mod = await import("../handlers/config-handlers.js");
      await mod.handleUpdateConfig(ws, msg as unknown as Parameters<typeof mod.handleUpdateConfig>[1], {
        orchestrator: this.orchestrator, approvalQueue: this.approvalQueue, runtimeFactory: this.runtimeFactory,
        transport, activeRunCount: rh.activeRunCount(),
        getLifecycleSnapshot: (input: any) => this.getLifecycleSnapshot(input),
        getConfigUpdateHandler: () => this.configUpdateHandler,
      }, correlateResponse, (corr: any) => corr);
    });

    const fallbackTypes = [
      "list-sessions", "list-runs", "get-run-snapshot", "read-session-events", "read-run-events",
      "create-workflow", "list-workflows", "update-workflow", "delete-workflow",
      "trigger-workflow", "list-workflow-runs", "list-plan-documents",
      "create-plan-document", "create-requirements-alignment-plan", "get-plan-document",
      "patch-plan-document", "delete-plan-document", "enqueue-pending-input",
      "cancel-pending-input", "dispatch-pending-input", "list-pending-inputs",
      "get-scoped-context", "upsert-scoped-context", "delete-scoped-context",
      "resolve-scoped-context", "start-mcp-server", "stop-mcp-server",
      "list-mcp-servers", "send-to-subagent", "get-subagent-status",
      "probe-provider-models", "probe-provider-chat", "list-background-tasks",
      "start-background-task", "cancel-background-task", "get-background-task-history",
      "list-artifacts", "get-artifact-content", "list-memories", "delete-memory",
      "list-checkpoints", "restore-checkpoint", "get-checkpoint-diff", "git-status",
      "git-diff", "preview-conversation-rewind", "apply-conversation-rewind",
      "preview-conversation-rewind-by-boundary", "resolve-conversation-rewind-boundary",
      "apply-session-action", "list-mutation-leases",
    ];
    for (const type of fallbackTypes) {
      this.messageRouter.register(type, async (msg, ws, client) => { await dh.handleInboundMessage(ws, client, msg); });
    }
    this.messageRouter.setStreamPauseHandler((runId) => rh.pauseStream(runId));
    this.messageRouter.setStreamResumeHandler((runId) => rh.resumeStream(runId));
  }

  async start(): Promise<number> {
    this.buildDependencies();
    try {
      await this.orchestrator.restoreFromEventStore();
      await this.rebuildActiveSubagentsFromEventStore();
    } catch (error) {
      this.lifecycle.recordError({
        code: "EVENT_STORE_RESTORE_FAILED",
        message: `Failed to restore daemon event store: ${errorMessage(error)}`,
        source: "event-store",
        ...(error instanceof Error && error.stack !== undefined ? { detail: error.stack } : {}),
      });
      this.lifecycle.markStopped();
      throw error;
    }
    const port = await this.connections.start();
    this.workflows.start();
    this.healthServer = startHealthServer(this.config.healthPort, () => this.getLifecycleSnapshot());
    const ms = startMetricsServer(this.config.metricsPort, this.prometheusExporter);
    if (ms.server) this.metricsServer = ms.server;
    if (ms.exporter) this.prometheusExporter = ms.exporter;
    this.metricsFlushTimer = startMetricsFlushLoop(this.prometheusExporter, () => this.getLifecycleSnapshot());
    this.startProviderProbeLoop();
    return port;
  }

  async stop(): Promise<void> {
    this.stopPromise ??= this.stopInner();
    await this.stopPromise;
  }

  private async stopInner(): Promise<void> {
    this.lifecycle.markStopping();
    this.workflows.stop();
    if (this.healthServer) { this.healthServer.close(); this.healthServer = undefined; }
    if (this.metricsServer) { this.metricsServer.close(); this.metricsServer = undefined; }
    this.stopMetricsFlushLoop();
    this.stopProviderProbeLoop();

    const failures: unknown[] = [];
    await this.runStopStep("WORKFLOW_SCHEDULER_DRAIN_FAILED", "Failed to drain workflow scheduler tick", () => this.workflows.waitForTick(2_000), failures);
    this.approvalQueue.clearAll("daemon-shutdown");
    this.cancelActiveRuns("daemon-shutdown");
    for (const client of this.connections.closeAllClientConnections(1001, "Daemon shutting down")) {
      this.lifecycle.recordClientDisconnected(client, 1001, "Daemon shutting down");
    }
    this.approvalBridge.rejectAllForDisconnect("Daemon shutting down");
    await this.runStopStep("WEBSOCKET_CLOSE_FAILED", "Failed to close WebSocket server", () => this.connections.stop(), failures);
    await this.runStopStep("ACTIVE_RUN_SETTLE_FAILED", "Failed to settle active runs", () => this.waitForActiveRunsToSettle("daemon-shutdown", 5_000), failures);
    await this.runStopStep("WORKFLOW_BACKGROUND_RUN_DRAIN_FAILED", "Failed to drain background workflow runs", () => this.requestHandlers.waitForBackgroundWorkflowRuns(5_000), failures);
    await this.runStopStep("MESSAGE_TASK_DRAIN_FAILED", "Failed to drain daemon message tasks", () => this.messageRouter.drainTasks(5_000), failures);
    await this.runStopStep("BACKGROUND_TASKS_DISPOSE_FAILED", "Failed to dispose background tasks", () => this.disposeBackgroundTasks(), failures);
    await this.runStopStep("RUNTIME_FACTORY_CLOSE_FAILED", "Failed to close daemon runtime factory", () => this.runtimeFactory.close(), failures);
    await this.runStopStep("EVENT_STORE_CLOSE_FAILED", "Failed to close daemon event store", () => this.stores.closeEventStore(), failures);

    if (failures.length > 0) throw failures[0];
    this.lifecycle.markStopped();
    getDaemonLogger().info("Server stopped", { module: "server" });
  }

  private stopMetricsFlushLoop(): void {
    if (this.metricsFlushTimer) { clearInterval(this.metricsFlushTimer); this.metricsFlushTimer = undefined; }
  }

  private startProviderProbeLoop(): void {
    if (this.providerProbeTimer) return;
    this.providerProbeTimer = setInterval(() => { this.probeProviderConnectivity().catch(() => {}); }, 60_000);
    this.providerProbeTimer.unref?.();
  }

  private stopProviderProbeLoop(): void {
    if (this.providerProbeTimer) { clearInterval(this.providerProbeTimer); this.providerProbeTimer = undefined; }
  }

  private async probeProviderConnectivity(): Promise<void> {
    try {
      const providerStatus = this.runtimeFactory.getProviderStatusSnapshot();
      if (!providerStatus.baseUrl || !providerStatus.apiKey.hasApiKey) return;
      const probeUrl = providerStatus.baseUrl.replace(/\/+$/, "") + "/v1/models";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(probeUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${providerStatus.apiKey.last4 ?? ""}` },
          signal: controller.signal,
        });
        const factory = this.runtimeFactory as unknown as Record<string, unknown>;
        const providerStatusProvider = factory["providerStatusProvider"] as (() => Record<string, unknown>) | undefined;
        if (providerStatusProvider) {
          Object.assign(providerStatusProvider(), { lastProbeOk: res.ok, lastProbeAt: new Date().toISOString() });
        }
      } finally { clearTimeout(timeout); }
    } catch { /* silent */ }
  }

  private async rebuildActiveSubagentsFromEventStore(): Promise<void> {
    const fn = (this.orchestrator as unknown as { consumeRestoredSubagentRuntimeEvents?: () => Array<{ agentEvent?: unknown; runId: string }> }).consumeRestoredSubagentRuntimeEvents;
    const restored = typeof fn === "function" ? fn.call(this.orchestrator) : [];
    for (const proj of restored) {
      if (!proj.agentEvent || typeof proj.agentEvent !== "object") continue;
      const update = readDaemonSubagentBridgeUpdateFromAgentEvent(proj.agentEvent as unknown as never);
      if (update?.phase === "started") this.subagentBridge.rebuildStarted(update, proj.runId);
    }
    const activeRuns = this.orchestrator.listRuns().filter((run) => ["running", "queued", "awaiting-approval"].includes(run.status));
    if (activeRuns.length === 0) return;
    const activeRunIds = new Set(activeRuns.map((run) => run.id));
    const store = this.stores.eventStore as { readAllStreaming?: (n?: number) => AsyncIterable<OrchestratorEvent>; readAll?: (n?: number) => Promise<OrchestratorEvent[]>; };
    if (typeof store.readAllStreaming === "function") {
      for await (const event of store.readAllStreaming(0)) {
        if (!event.runId || !activeRunIds.has(event.runId) || event.type !== "runtime-event") continue;
        const agentEvent = (event.payload as { event?: unknown }).event;
        if (!agentEvent || typeof agentEvent !== "object") continue;
        const update = readDaemonSubagentBridgeUpdateFromAgentEvent(agentEvent as unknown as never);
        if (update?.phase === "started") this.subagentBridge.rebuildStarted(update, event.runId);
      }
      return;
    }
    if (typeof store.readAll === "function") {
      const all = await store.readAll(0);
      for (const event of all) {
        if (!event.runId || !activeRunIds.has(event.runId) || event.type !== "runtime-event") continue;
        const agentEvent = (event.payload as { event?: unknown }).event;
        if (!agentEvent || typeof agentEvent !== "object") continue;
        const update = readDaemonSubagentBridgeUpdateFromAgentEvent(agentEvent as unknown as never);
        if (update?.phase === "started") this.subagentBridge.rebuildStarted(update, event.runId);
      }
    }
  }

  private cancelActiveRuns(reason: string): void {
    for (const run of this.orchestrator.listRuns()) {
      if (["queued", "running", "awaiting-approval", "cancelling"].includes(run.status)) {
        this.orchestrator.cancelRun(run.id, reason);
      }
    }
  }

  private async startDurableRun(request: import("@crish/agent-orchestrator").StartRunRequest): Promise<import("@crish/agent-orchestrator").OrchestratorRunHandle> {
    this.assertEventStoreAvailableForNewRun(request.id, "subagent");
    return this.orchestrator.startRun(request);
  }

  private assertEventStoreAvailableForNewRun(runId: string | undefined, requestType: string): void {
    const failure = this.stores.eventStore.getFailure();
    if (!failure) return;
    this.lifecycle.recordError({
      code: "EVENT_STORE_DEGRADED_RUN_REJECTED", message: `Rejected durable run while event store is degraded: ${failure.message}`,
      source: "event-store", severity: "warning", detail: failure.stack ?? undefined,
      metadata: { requestType, ...(runId ? { runId } : {}), kind: (failure as unknown as { kind: string | undefined }).kind ?? "unknown", filePath: ((failure as unknown as { filePath?: string }).filePath || this.eventLogPath) as string, eventId: (failure as unknown as { eventId?: string }).eventId ?? null },
    });
    class DegradedError extends Error { readonly code = "EVENT_STORE_DEGRADED"; constructor(readonly rid: string | undefined, readonly fail: unknown) { super(`Daemon event store is degraded; durable run start rejected. ${(fail as { message: string }).message}`); this.name = "DaemonEventStoreDegradedError"; } }
    throw new DegradedError(runId, failure);
  }

  private async waitForActiveRunsToSettle(reason: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.orchestrator.countActiveRuns() === 0) return;
      for (const run of this.orchestrator.listRuns().filter((r) => ["queued", "running", "awaiting-approval", "cancelling"].includes(r.status))) {
        this.orchestrator.cancelRun(run.id, reason);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.orchestrator.countActiveRuns() > 0) {
      const activeRuns = this.orchestrator.listRuns().filter((r) => ["queued", "running", "awaiting-approval", "cancelling"].includes(r.status));
      getDaemonLogger().warn("Shutdown timed out waiting for active runs", { module: "server", activeRuns: activeRuns.map((r) => `${r.id}:${r.status}`).join(", ") });
    }
  }

  private async disposeBackgroundTasks(): Promise<void> {
    this.backgroundTasks.dispose();
    this.subagentBridge.clearAll();
  }

  private async runStopStep(code: string, message: string, operation: () => Promise<void>, failures: unknown[]): Promise<void> {
    try { await operation(); } catch (error) {
      this.lifecycle.recordError({
        code,
        message: `${message}: ${errorMessage(error)}`,
        source: code === "EVENT_STORE_CLOSE_FAILED" ? "event-store" : "daemon",
        ...(error instanceof Error && error.stack !== undefined ? { detail: error.stack } : {}),
      });
      failures.push(error);
    }
  }
}
