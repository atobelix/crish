import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { JsonObject, JsonValue } from "@crish/shared-types";
import type { AgentRuntimeOptions, McpServerDefinition } from "@crish/agent-runtime";
import { errorMessage } from "@crish/shared-utils";
import {
  AgentOrchestrator,
  type OrchestratorEvent,
  type OrchestratorEventStoreError,
  type OrchestratorRunHandle,
  type RunStatus,
  type StartRunRequest,
} from "@crish/agent-orchestrator";
import type {
  DaemonConfig,
  DaemonCorrelationFields,
  DaemonInboundMessage,
  DaemonLifecycleSnapshot,
  DaemonMcpStatusSnapshot,
  DaemonProviderStatusSnapshot,
} from "./types.js";
import { ApprovalQueue } from "./approval-queue.js";
import {
  normalizeDaemonConfig,
  resolveDaemonEventLogPath,
  resolveDaemonCheckpointManifestPath,
  resolveDaemonMemoryStorePath,
  resolveDaemonPlanDocumentStorePath,
  resolveDaemonRuntimeSessionDir,
  resolveDaemonScopedContextStorePath,
  resolveDaemonSessionMetadataStorePath,
  resolveDaemonWorkflowStorePath,
} from "./persistence.js";
import {
  formatProtocolValidationError,
  validateInboundMessage,
} from "./protocol/protocol.js";
import {
  DaemonClientRegistry,
  type ConnectedClient,
  type DaemonClientTransportDiagnostic,
} from "./daemon-client-registry.js";
import { DaemonEventStore } from "./server-event-store.js";
import {
  DaemonRuntimeFactory,
  type DaemonMcpLifecycleManagerFactory,
  type DaemonToolFactory,
} from "./server-runtime-factory.js";
import {
  DaemonCheckpointManifestAdapter,
  DaemonJsonlMemoryAdapter,
  type DaemonProductAdapters,
} from "./daemon-product-adapters.js";
import {
  DaemonRequestHandlers,
  type DaemonRuntimeConfigUpdate,
} from "./server-handlers.js";
import { RunHandler } from "./handlers/run-handlers.js";
import { DaemonSubagentBridge } from "./daemon-subagent-bridge.js";
import { DaemonLifecycleTracker } from "./daemon-lifecycle.js";
import { WorkflowScheduler } from "./workflow-scheduler.js";
import type { WorkflowSchedulerTickResult } from "./workflow-scheduler.js";
import { FileWorkflowStore } from "./workflow-store.js";
import { FilePlanDocumentStore } from "./plan-document-store.js";
import { FileScopedContextStore } from "./scoped-context-store.js";
import { FileSessionMetadataStore } from "./session-metadata-store.js";
import { DaemonBackgroundTaskManager } from "./background-task-manager.js";

export interface DaemonServerOptions {
  productAdapters?: DaemonProductAdapters;
  mcpServers?: McpServerDefinition[];
  mcpLifecycleManagerFactory?: DaemonMcpLifecycleManagerFactory;
  mcpStartupGateTimeoutMs?: number;
  maxClientBufferedBytes?: number;
}

export class DaemonServer {
  private wss!: WebSocketServer;
  private port!: number;
  private lifecycle!: DaemonLifecycleTracker;
  private clients!: DaemonClientRegistry;
  private messageTasks = new Set<Promise<void>>();
  private orchestrator!: AgentOrchestrator;
  private eventStore!: DaemonEventStore;
  private approvalQueue!: ApprovalQueue;
  private config!: DaemonConfig;
  private eventLogPath!: string;
  private workflowStore!: FileWorkflowStore;
  private planDocumentStore!: FilePlanDocumentStore;
  private scopedContextStore!: FileScopedContextStore;
  private sessionMetadataStore!: FileSessionMetadataStore;
  private workflowScheduler!: WorkflowScheduler;
  private runtimeFactory!: DaemonRuntimeFactory;
  private backgroundTasks!: DaemonBackgroundTaskManager;
  private requestHandlers!: DaemonRequestHandlers;
  private subagentBridge!: DaemonSubagentBridge;
  private configUpdateHandler?: (update: DaemonRuntimeConfigUpdate) => void;
  private pendingProviderFactory?: (runId: string, cwd: string) => AgentRuntimeOptions["provider"] | Promise<AgentRuntimeOptions["provider"]>;
  private pendingToolFactory?: DaemonToolFactory;
  private stopPromise?: Promise<void>;
  private workflowSchedulerTimer?: NodeJS.Timeout;
  private workflowSchedulerTickTask?: Promise<WorkflowSchedulerTickResult>;

  constructor(
    config?: Partial<DaemonConfig>,
    private readonly options: DaemonServerOptions = {}
  ) {
    this.config = normalizeDaemonConfig(config);
  }

  setProviderFactory(
    factory: (runId: string, cwd: string) => AgentRuntimeOptions["provider"] | Promise<AgentRuntimeOptions["provider"]>
  ): void {
    if (this.runtimeFactory) {
      this.runtimeFactory.setProviderFactory(factory);
    } else {
      this.pendingProviderFactory = factory;
    }
  }

  setToolFactory(factory: DaemonToolFactory): void {
    if (this.runtimeFactory) {
      this.runtimeFactory.setToolFactory(factory);
    } else {
      this.pendingToolFactory = factory;
    }
  }

  setConfigUpdateHandler(handler: (update: DaemonRuntimeConfigUpdate) => void): void {
    this.configUpdateHandler = handler;
  }

  private buildDependencies(): void {
    this.lifecycle = new DaemonLifecycleTracker();
    this.clients = new DaemonClientRegistry({
      maxBufferedBytes: this.options.maxClientBufferedBytes,
      onDiagnostic: (diagnostic) => this.recordClientTransportDiagnostic(diagnostic),
    });
    this.eventLogPath = resolveDaemonEventLogPath(this.config);
    this.workflowStore = new FileWorkflowStore(resolveDaemonWorkflowStorePath(this.config));
    this.planDocumentStore = new FilePlanDocumentStore(resolveDaemonPlanDocumentStorePath(this.config));
    this.scopedContextStore = new FileScopedContextStore(resolveDaemonScopedContextStorePath(this.config));
    this.sessionMetadataStore = new FileSessionMetadataStore(resolveDaemonSessionMetadataStorePath(this.config));
    this.approvalQueue = new ApprovalQueue({ defaultTimeoutMs: this.config.approvalTimeoutMs });
    this.eventStore = new DaemonEventStore(this.eventLogPath);
    this.backgroundTasks = new DaemonBackgroundTaskManager({
      defaultWorkspaceRoot: this.config.defaultCwd,
      managerOptions: { defaultTimeoutMs: 30 * 60_000, maxOutputBytes: 500_000 },
    });
    this.runtimeFactory = new DaemonRuntimeFactory({
      config: this.config,
      approvalQueue: this.approvalQueue,
      sessionStoreDir: resolveDaemonRuntimeSessionDir(this.config),
      scopedContextStore: this.scopedContextStore,
      productAdapters: {
        checkpoint: new DaemonCheckpointManifestAdapter({ manifestPath: resolveDaemonCheckpointManifestPath(this.config) }),
        memory: new DaemonJsonlMemoryAdapter({ storePath: resolveDaemonMemoryStorePath(this.config) }),
        ...this.options.productAdapters,
      },
      getBackgroundCommandManager: (cwd) => this.backgroundTasks.getManagerForCwd(cwd),
      mcpServers: this.options.mcpServers,
      mcpLifecycleManagerFactory: this.options.mcpLifecycleManagerFactory,
      mcpStartupGateTimeoutMs: this.options.mcpStartupGateTimeoutMs,
      startRun: (request) => this.startDurableRun(request),
      cancelRun: (runId, reason) => this.orchestrator.cancelRun(runId, reason),
    });
    if (this.pendingProviderFactory) {
      this.runtimeFactory.setProviderFactory(this.pendingProviderFactory);
      this.pendingProviderFactory = undefined;
    }
    if (this.pendingToolFactory) {
      this.runtimeFactory.setToolFactory(this.pendingToolFactory);
      this.pendingToolFactory = undefined;
    }
    this.orchestrator = new AgentOrchestrator({
      eventStore: this.eventStore,
      createRunEngine: this.runtimeFactory.createRunEngineFactory(),
    });
    this.subagentBridge = new DaemonSubagentBridge(
      (message) => this.clients.broadcast(message),
      this.approvalQueue,
    );
    const runHandler = new RunHandler({
      orchestrator: this.orchestrator,
      approvalQueue: this.approvalQueue,
      config: this.config,
      runtimeFactory: this.runtimeFactory,
      transport: this.clients,
      subagentBridge: this.subagentBridge,
      workflowStore: this.workflowStore,
      recordDiagnostic: (input) => this.lifecycle.recordError(input),
    });
    this.requestHandlers = new DaemonRequestHandlers({
      runHandler,
      orchestrator: this.orchestrator,
      approvalQueue: this.approvalQueue,
      config: this.config,
      runtimeFactory: this.runtimeFactory,
      backgroundTasks: this.backgroundTasks,
      workflowStore: this.workflowStore,
      planDocumentStore: this.planDocumentStore,
      scopedContextStore: this.scopedContextStore,
      sessionMetadataStore: this.sessionMetadataStore,
      transport: this.clients,
      subagentBridge: this.subagentBridge,
      getLifecycleSnapshot: (input) => this.getLifecycleSnapshot(input),
      recordDiagnostic: (input) => this.lifecycle.recordError(input),
      getConfigUpdateHandler: () => this.configUpdateHandler,
    });
    this.workflowScheduler = new WorkflowScheduler({
      store: this.workflowStore,
      triggerWorkflow: (due, now) => {
        this.assertEventStoreAvailableForNewRun(undefined, "scheduled-workflow");
        return this.requestHandlers.triggerDueWorkflow(due, now);
      },
    });
  }

  async start(): Promise<number> {
    this.buildDependencies();

    try {
      await this.orchestrator.restoreFromEventStore();
    } catch (error) {
      this.lifecycle.recordError({
        code: "EVENT_STORE_RESTORE_FAILED",
        message: `Failed to restore daemon event store: ${errorMessage(error)}`,
        source: "event-store",
        detail: errorDetail(error),
      });
      this.lifecycle.markStopped();
      throw error;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      this.wss = new WebSocketServer({ port: this.config.port });

      this.wss.on("listening", () => {
        const address = this.wss.address() as AddressInfo;
        this.port = address.port;
        this.lifecycle.markReady(this.port);
        this.startWorkflowSchedulerLoop();
        console.log(`[Daemon] WebSocket server listening on port ${this.port}`);
        settled = true;
        resolve(this.port);
      });

      this.wss.on("error", (error) => {
        console.error("[Daemon] Server error:", error);
        this.lifecycle.recordError({
          code: "WEBSOCKET_SERVER_ERROR",
          message: `WebSocket server error: ${error.message}`,
          source: "websocket",
          detail: error.stack,
        });
        if (!settled) {
          settled = true;
          this.lifecycle.markStopped();
          reject(error);
        }
      });

      this.wss.on("connection", (ws) => this.handleConnection(ws));

      this.wss.on("close", () => {
        console.log("[Daemon] Server closed");
        if (!this.stopPromise) {
          this.lifecycle.markStopped();
        }
      });
    });
  }

  async stop(): Promise<void> {
    this.stopPromise ??= this.stopInner();
    await this.stopPromise;
  }

  private async stopInner(): Promise<void> {
    this.lifecycle.markStopping();
    this.stopWorkflowSchedulerLoop();
    const failures: unknown[] = [];
    await this.runStopStep("WORKFLOW_SCHEDULER_DRAIN_FAILED", "Failed to drain workflow scheduler tick", () =>
      this.waitForWorkflowSchedulerTick(2_000), failures);
    this.approvalQueue.clearAll("daemon-shutdown");
    this.cancelActiveRuns("daemon-shutdown");
    for (const client of this.clients.closeAll(1001, "Daemon shutting down")) {
      this.lifecycle.recordClientDisconnected(client, 1001, "Daemon shutting down");
    }

    await this.runStopStep("WEBSOCKET_CLOSE_FAILED", "Failed to close WebSocket server", () =>
      this.closeWebSocketServer(), failures);
    await this.runStopStep("ACTIVE_RUN_SETTLE_FAILED", "Failed to settle active runs", () =>
      this.waitForActiveRunsToSettle("daemon-shutdown", 5_000), failures);
    await this.runStopStep("WORKFLOW_BACKGROUND_RUN_DRAIN_FAILED", "Failed to drain background workflow runs", () =>
      this.requestHandlers.waitForBackgroundWorkflowRuns(5_000), failures);
    await this.runStopStep("MESSAGE_TASK_DRAIN_FAILED", "Failed to drain daemon message tasks", () =>
      this.waitForMessageTasks(5_000), failures);
    await this.runStopStep("RUNTIME_FACTORY_CLOSE_FAILED", "Failed to close daemon runtime factory", () =>
      this.runtimeFactory.close(), failures);
    await this.runStopStep("EVENT_STORE_CLOSE_FAILED", "Failed to close daemon event store", () =>
      this.eventStore.close(), failures);

    if (failures.length > 0) {
      throw failures[0];
    }

    this.lifecycle.markStopped();
    console.log("[Daemon] Server stopped");
  }

  getApprovalQueue(): ApprovalQueue {
    return this.approvalQueue;
  }

  async readSessionEvents(sessionId: string, afterSequence?: number): Promise<OrchestratorEvent[]> {
    return this.orchestrator.readSessionEvents(sessionId, afterSequence);
  }

  async readRunEvents(runId: string, afterSequence?: number): Promise<OrchestratorEvent[]> {
    return this.orchestrator.readRunEvents(runId, afterSequence);
  }

  getEventLogPath(): string {
    return this.eventLogPath;
  }

  getWorkflowStorePath(): string {
    return this.workflowStore.filePath;
  }

  getPlanDocumentStorePath(): string {
    return this.planDocumentStore.filePath;
  }

  getScopedContextStorePath(): string {
    return this.scopedContextStore.filePath;
  }

  getSessionMetadataStorePath(): string {
    return this.sessionMetadataStore.filePath;
  }

  async tickScheduler(now: Date = new Date()) {
    if (this.workflowSchedulerTickTask) {
      return this.workflowSchedulerTickTask;
    }

    const task = this.workflowScheduler.tickScheduler(now).finally(() => {
      if (this.workflowSchedulerTickTask === task) {
        this.workflowSchedulerTickTask = undefined;
      }
    });
    this.workflowSchedulerTickTask = task;
    return task;
  }

  getLifecycleSnapshot(input?: {
    activeRunCount?: number;
    providerStatus?: DaemonProviderStatusSnapshot;
    mcpStatus?: DaemonMcpStatusSnapshot;
  }): DaemonLifecycleSnapshot {
    const providerStatus = input?.providerStatus ?? this.runtimeFactory.getProviderStatusSnapshot();
    const mcpStatus = input?.mcpStatus ?? this.runtimeFactory.getMcpStatusSnapshot();
    const activeRunCount =
      input?.activeRunCount ??
      this.orchestrator.listRuns().filter((run) => isActiveRunStatus(run.status)).length;

    return this.lifecycle.snapshot({
      activeRunCount,
      connectedClientCount: this.clients.size,
      eventLogPath: this.eventLogPath,
      eventStoreFailure: this.eventStore.getFailure(),
      providerStatus,
      mcpStatus,
    });
  }

  private handleConnection(ws: WebSocket): void {
    const client = this.clients.connect(ws);
    this.lifecycle.recordClientConnected(client);
    console.log(`[Daemon] Client connected: ${client.id} (total: ${this.clients.size})`);

    // 协议握手：客户端应发送 hello 消息
    // 如果 5 秒内未收到 hello，关闭连接
    const handshakeTimer = setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        ws.close(4002, "Handshake timeout: expected hello message");
      }
    }, 5_000);
    handshakeTimer.unref?.();

    ws.on("message", (data) => {
      clearTimeout(handshakeTimer);
      this.trackMessageTask(this.handleMessage(ws, data));
    });
    ws.on("close", (code, reason) => {
      this.handleDisconnect(ws, code, reason);
    });
    ws.on("error", (error) => {
      this.lifecycle.recordError({
        code: "CLIENT_SOCKET_ERROR",
        message: `Client ${client.id} socket error: ${error.message}`,
        source: "client",
        detail: error.stack,
        metadata: { clientId: client.id },
      });
      console.error(`[Daemon] Client ${client.id} error:`, error.message);
    });

    // 使用 WebSocket 协议内置 ping/pong
    ws.on("ping", (data) => {
      ws.pong(data);
    });
  }

  private async handleMessage(ws: WebSocket, data: RawData): Promise<void> {
    const parsed = parseClientMessage(data);
    if (!parsed.ok) {
      const client = this.clients.get(ws);
      this.lifecycle.recordError({
        code: "CLIENT_PARSE_ERROR",
        message: parsed.message,
        source: "client",
        ...(client ? { metadata: { clientId: client.id } } : {}),
      });
      this.clients.sendError(ws, "PARSE_ERROR", parsed.message);
      return;
    }

    // 协议握手：处理 hello 消息
    const raw = parsed.value as Record<string, unknown>;
    if (raw.type === "hello") {
      this.handleHello(ws, raw);
      return;
    }

    const validation = validateInboundMessage(parsed.value);
    if (!validation.ok) {
      this.clients.sendError(
        ws,
        validation.error.code,
        formatProtocolValidationError(validation.error),
        undefined,
        correlationFromRawMessage(parsed.value)
      );
      return;
    }

    const client = this.clients.get(ws);
    if (!client) return;

    if (this.rejectDurableRunWhenEventStoreFailed(ws, client, validation.value)) {
      return;
    }

    try {
      await this.requestHandlers.handleInboundMessage(ws, client, validation.value);
    } catch (error) {
      console.error("[Daemon] Client message handler failed:", error);
      this.lifecycle.recordError({
        code: "DAEMON_MESSAGE_HANDLER_ERROR",
        message: `Daemon message handler failed: ${errorMessage(error)}`,
        source: "daemon",
        detail: errorDetail(error),
        metadata: { clientId: client.id },
      });
      this.clients.sendError(
        ws,
        "DAEMON_ERROR",
        error instanceof Error ? error.message : String(error),
        undefined,
        validation.value
      );
    }
  }

  private handleHello(ws: WebSocket, message: Record<string, unknown>): void {
    const clientVersion = typeof message.protocolVersion === "number" ? message.protocolVersion : 0;
    const serverVersion = 2;

    if (clientVersion < 1) {
      ws.close(4003, `Protocol version ${clientVersion} not supported. Server requires version >= 1`);
      return;
    }

    this.clients.send(ws, {
      type: "welcome",
      protocolVersion: serverVersion,
      serverName: "crish-daemon",
      capabilities: ["run-task", "approval", "pending-input", "workflow", "git", "plan-document"],
    });
  }

  private handleDisconnect(ws: WebSocket, code: number, reason: Buffer): void {
    const client = this.clients.disconnect(ws);
    if (client) {
      this.lifecycle.recordClientDisconnected(client, code, reason.toString());
      console.log(
        `[Daemon] Client disconnected: ${client.id} (code=${code}, reason=${reason.toString()})`
      );
    }
  }

  private trackMessageTask(task: Promise<void>): void {
    const tracked = task
      .catch((error) => {
        console.error("[Daemon] Unhandled client message task failure:", error);
      })
      .finally(() => {
        this.messageTasks.delete(tracked);
      });
    this.messageTasks.add(tracked);
  }

  private cancelActiveRuns(reason: string): void {
    for (const run of this.orchestrator.listRuns()) {
      if (isActiveRunStatus(run.status)) {
        this.orchestrator.cancelRun(run.id, reason);
      }
    }
  }

  private async startDurableRun(request: StartRunRequest): Promise<OrchestratorRunHandle> {
    this.assertEventStoreAvailableForNewRun(request.id, "subagent");
    return this.orchestrator.startRun(request);
  }

  private rejectDurableRunWhenEventStoreFailed(
    ws: WebSocket,
    client: ConnectedClient,
    message: DaemonInboundMessage
  ): boolean {
    if (!isNewDurableRunMessage(message)) {
      return false;
    }

    const failure = this.eventStore.getFailure();
    if (!failure) {
      return false;
    }

    const runId = message.type === "run-task" ? message.runId : message.runId;
    console.warn(
      `[Daemon] Rejecting ${message.type} because event store is degraded: ${failure.message}`
    );
    this.clients.sendError(
      ws,
      "EVENT_STORE_DEGRADED",
      degradedRunRejectionMessage(failure),
      runId,
      message
    );
    this.lifecycle.recordError({
      code: "EVENT_STORE_DEGRADED_RUN_REJECTED",
      message: `Rejected durable run while event store is degraded: ${failure.message}`,
      source: "event-store",
      severity: "warning",
      detail: failure.stack,
      metadata: {
        clientId: client.id,
        requestType: message.type,
        ...(runId ? { runId } : {}),
        ...eventStoreFailureMetadata(failure, this.eventLogPath),
      },
    });
    return true;
  }

  private assertEventStoreAvailableForNewRun(
    runId: string | undefined,
    requestType: string
  ): void {
    const failure = this.eventStore.getFailure();
    if (!failure) {
      return;
    }

    this.lifecycle.recordError({
      code: "EVENT_STORE_DEGRADED_RUN_REJECTED",
      message: `Rejected durable run while event store is degraded: ${failure.message}`,
      source: "event-store",
      severity: "warning",
      detail: failure.stack,
      metadata: {
        requestType,
        ...(runId ? { runId } : {}),
        ...eventStoreFailureMetadata(failure, this.eventLogPath),
      },
    });
    throw new DaemonEventStoreDegradedError(runId, failure);
  }

  private recordEventStoreFailure(failure: OrchestratorEventStoreError): void {
    this.lifecycle.recordError({
      code: eventStoreFailureCode(failure),
      message: failure.message,
      source: "event-store",
      severity: "error",
      detail: failure.stack,
      metadata: eventStoreFailureMetadata(failure, this.eventLogPath),
    });
  }

  private recordClientTransportDiagnostic(diagnostic: DaemonClientTransportDiagnostic): void {
    this.lifecycle.recordError({
      code: diagnostic.code,
      message: diagnostic.message,
      source: diagnostic.source,
      severity: diagnostic.severity,
      ...(diagnostic.detail !== undefined ? { detail: diagnostic.detail } : {}),
      ...(diagnostic.metadata !== undefined
        ? { metadata: diagnosticMetadata(diagnostic.metadata) }
        : diagnostic.clientId !== undefined
          ? { metadata: { clientId: diagnostic.clientId } }
          : {}),
    });
  }

  private startWorkflowSchedulerLoop(): void {
    if (this.workflowSchedulerTimer || this.config.workflowSchedulerIntervalMs <= 0) {
      return;
    }

    const runTick = () => {
      void this.tickScheduler().catch((error) => {
        if (error instanceof DaemonEventStoreDegradedError) {
          this.lifecycle.recordError({
            code: "EVENT_STORE_DEGRADED_RUN_REJECTED",
            message: error.message,
            source: "event-store",
            severity: "warning",
            detail: error.stack,
            metadata: {
              ...(error.runId ? { runId: error.runId } : {}),
              ...eventStoreFailureMetadata(error.failure, this.eventLogPath),
            },
          });
          console.warn("[Daemon] Workflow scheduler skipped durable run:", error.message);
          return;
        }
        this.lifecycle.recordError({
          code: "WORKFLOW_SCHEDULER_TICK_FAILED",
          message: `Workflow scheduler tick failed: ${errorMessage(error)}`,
          source: "daemon",
          detail: errorDetail(error),
        });
        console.error("[Daemon] Workflow scheduler tick failed:", error);
      });
    };

    this.workflowSchedulerTimer = setInterval(runTick, this.config.workflowSchedulerIntervalMs);
    this.workflowSchedulerTimer.unref?.();
    runTick();
  }

  private stopWorkflowSchedulerLoop(): void {
    if (!this.workflowSchedulerTimer) {
      return;
    }
    clearInterval(this.workflowSchedulerTimer);
    this.workflowSchedulerTimer = undefined;
  }

  private async waitForWorkflowSchedulerTick(timeoutMs: number): Promise<void> {
    if (!this.workflowSchedulerTickTask) {
      return;
    }

    const settled = this.workflowSchedulerTickTask.then(
      () => "settled" as const,
      () => "settled" as const
    );
    const timedOut = delay(timeoutMs).then(() => "timed-out" as const);
    const result = await Promise.race([settled, timedOut]);
    if (result === "timed-out") {
      console.warn("[Daemon] Shutdown timed out waiting for workflow scheduler tick");
    }
  }

  private async closeWebSocketServer(): Promise<void> {
    if (!this.wss || this.wss.address() === null) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.wss.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async waitForActiveRunsToSettle(reason: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const activeRuns = this.orchestrator.listRuns().filter((run) => isActiveRunStatus(run.status));
      if (activeRuns.length === 0) {
        return;
      }
      for (const run of activeRuns) {
        this.orchestrator.cancelRun(run.id, reason);
      }
      await delay(25);
    }

    const activeRuns = this.orchestrator.listRuns().filter((run) => isActiveRunStatus(run.status));
    if (activeRuns.length > 0) {
      console.warn(
        `[Daemon] Shutdown timed out waiting for active runs: ${activeRuns.map((run) => `${run.id}:${run.status}`).join(", ")}`
      );
    }
  }

  private async waitForMessageTasks(timeoutMs: number): Promise<void> {
    if (this.messageTasks.size === 0) {
      return;
    }

    const settled = Promise.allSettled([...this.messageTasks]).then(() => "settled" as const);
    const timedOut = delay(timeoutMs).then(() => "timed-out" as const);
    const result = await Promise.race([settled, timedOut]);
    if (result === "timed-out" && this.messageTasks.size > 0) {
      console.warn(`[Daemon] Shutdown timed out waiting for ${this.messageTasks.size} message task(s)`);
    }
  }

  private async runStopStep(
    code: string,
    message: string,
    operation: () => Promise<void>,
    failures: unknown[]
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.lifecycle.recordError({
        code,
        message: `${message}: ${errorMessage(error)}`,
        source: code === "EVENT_STORE_CLOSE_FAILED" ? "event-store" : "daemon",
        detail: errorDetail(error),
      });
      failures.push(error);
    }
  }
}

function parseClientMessage(data: RawData): ParseMessageResult {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);

  try {
    return { ok: true, value: JSON.parse(buffer.toString("utf8")) };
  } catch (error) {
    return { ok: false, message: `Invalid JSON: ${(error as Error).message}` };
  }
}

function isActiveRunStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "awaiting-approval" || status === "cancelling";
}

function isNewDurableRunMessage(
  message: DaemonInboundMessage
): message is Extract<DaemonInboundMessage, { type: "run-task" | "trigger-workflow" }> {
  return message.type === "run-task" || message.type === "trigger-workflow";
}

class DaemonEventStoreDegradedError extends Error {
  readonly code = "EVENT_STORE_DEGRADED";

  constructor(
    readonly runId: string | undefined,
    readonly failure: OrchestratorEventStoreError
  ) {
    super(degradedRunRejectionMessage(failure));
    this.name = "DaemonEventStoreDegradedError";
  }
}

function degradedRunRejectionMessage(failure: OrchestratorEventStoreError): string {
  return `Daemon event store is degraded; durable run start rejected. ${failure.message}`;
}

function eventStoreFailureCode(failure: OrchestratorEventStoreError): "EVENT_STORE_CLOSED" | "EVENT_STORE_WRITE_FAILED" {
  return failure.kind === "closed" ? "EVENT_STORE_CLOSED" : "EVENT_STORE_WRITE_FAILED";
}

function eventStoreFailureMetadata(
  failure: OrchestratorEventStoreError,
  eventLogPath: string
): JsonObject {
  return {
    kind: failure.kind,
    filePath: failure.filePath || eventLogPath,
    ...(failure.eventId ? { eventId: failure.eventId } : {}),
  };
}

function diagnosticMetadata(metadata: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(metadata)) {
    result[key] = toDiagnosticJsonValue(value);
  }
  return result;
}

function toDiagnosticJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isNaN(value) ? null : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toDiagnosticJsonValue(item));
  }
  if (value && typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = toDiagnosticJsonValue(nested);
    }
    return result;
  }
  return String(value);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}


function errorDetail(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function correlationFromRawMessage(value: unknown): DaemonCorrelationFields | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.requestId === "string" && record.requestId.length > 0
      ? { requestId: record.requestId }
      : {}),
    ...(typeof record.correlationId === "string" && record.correlationId.length > 0
      ? { correlationId: record.correlationId }
      : {}),
  };
}

type ParseMessageResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };
