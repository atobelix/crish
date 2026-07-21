import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { JsonObject, JsonValue } from '@crish/shared-types';
import type {
  AgentRuntimeOptions,
  McpServerDefinition,
} from '@crish/agent-runtime';
import { errorMessage, TokenBucket } from '@crish/shared-utils';
import {
  AgentOrchestrator,
  type OrchestratorEvent,
  type OrchestratorEventStoreError,
  type OrchestratorRunHandle,
  type RunStatus,
  type StartRunRequest,
} from '@crish/agent-orchestrator';
import type {
  DaemonConfig,
  DaemonCorrelationFields,
  DaemonInboundMessage,
  DaemonLifecycleSnapshot,
  DaemonMcpServerConfig,
  DaemonMcpStatusSnapshot,
  DaemonProviderStatusSnapshot,
} from './types.js';
import { ApprovalQueue } from './approval-queue.js';
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
} from './persistence.js';
import {
  buildMcpServerDefinitions,
  normalizeDaemonMcpServers,
} from './mcp-config.js';
import {
  formatProtocolValidationError,
  validateInboundMessage,
} from './protocol/protocol.js';
import {
  DaemonClientRegistry,
  type ConnectedClient,
  type DaemonClientTransportDiagnostic,
} from './daemon-client-registry.js';
import { DaemonEventStore } from './server-event-store.js';
import {
  DaemonRuntimeFactory,
  type DaemonMcpLifecycleManagerFactory,
  type DaemonToolFactory,
} from './server-runtime-factory.js';
import {
  DaemonCheckpointManifestAdapter,
  DaemonJsonlMemoryAdapter,
  type DaemonProductAdapters,
} from './daemon-product-adapters.js';
import {
  DaemonRequestHandlers,
  type DaemonRuntimeConfigUpdate,
} from './server-handlers.js';
import { RunHandler } from './handlers/run-handlers.js';
import { DaemonSubagentBridge } from './daemon-subagent-bridge.js';
import { readDaemonSubagentBridgeUpdateFromAgentEvent } from './subagent-runtime.js';
import { DaemonLifecycleTracker } from './daemon-lifecycle.js';
import { WorkflowScheduler } from './workflow-scheduler.js';
import type { WorkflowSchedulerTickResult } from './workflow-scheduler.js';
import { FileWorkflowStore } from './workflow-store.js';
import { FilePlanDocumentStore } from './plan-document-store.js';
import { FileScopedContextStore } from './scoped-context-store.js';
import { FileSessionMetadataStore } from './session-metadata-store.js';
import { DaemonBackgroundTaskManager } from './background-task-manager.js';
import {
  BINARY_FRAME_CAPABILITY,
  BinaryFrameType,
  decodeBinaryFrame,
  decodeMetaBodyPayload,
  encodeBinaryFrame,
  looksLikeBinaryFrame,
  type BinaryFrameTypeCode,
} from './binary-frame.js';

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
  private runHandler!: RunHandler;
  private subagentBridge!: DaemonSubagentBridge;
  private configUpdateHandler?: (update: DaemonRuntimeConfigUpdate) => void;
  private pendingProviderFactory?: (
    runId: string,
    cwd: string
  ) =>
    AgentRuntimeOptions['provider'] | Promise<AgentRuntimeOptions['provider']>;
  private pendingToolFactory?: DaemonToolFactory;
  private stopPromise?: Promise<void>;
  private workflowSchedulerTimer?: NodeJS.Timeout;
  private workflowSchedulerTickTask?: Promise<WorkflowSchedulerTickResult>;
  private connectionLimiter = new TokenBucket(50, 50);
  private byteLimiter = new TokenBucket(4 * 1024 * 1024, 4 * 1024 * 1024);

  constructor(
    config?: Partial<DaemonConfig>,
    private readonly options: DaemonServerOptions = {}
  ) {
    const normalized = normalizeDaemonConfig(config);
    // 仅规范化显式传入的 mcpServers；env/默认 mcp.json 由 startDaemon 合并，避免测试侧隐式加载
    if (normalized.mcpServers?.length) {
      normalized.mcpServers = normalizeDaemonMcpServers(normalized.mcpServers);
    } else {
      normalized.mcpServers = [];
    }
    this.config = normalized;
  }

  /**
   * 热更新 MCP 配置（可序列化条目 → definitions → factory）。
   * 供 update-config.mcpServers 使用。
   */
  async applyMcpServerConfigs(configs: DaemonMcpServerConfig[]): Promise<void> {
    const normalized = normalizeDaemonMcpServers(configs);
    this.config.mcpServers = normalized;
    if (!this.runtimeFactory) return;
    await this.runtimeFactory.setMcpServers(
      buildMcpServerDefinitions(normalized)
    );
  }

  setProviderFactory(
    factory: (
      runId: string,
      cwd: string
    ) =>
      AgentRuntimeOptions['provider'] | Promise<AgentRuntimeOptions['provider']>
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

  setConfigUpdateHandler(
    handler: (update: DaemonRuntimeConfigUpdate) => void
  ): void {
    this.configUpdateHandler = handler;
  }

  private buildDependencies(): void {
    this.lifecycle = new DaemonLifecycleTracker();
    this.clients = new DaemonClientRegistry({
      maxBufferedBytes: this.options.maxClientBufferedBytes,
      onDiagnostic: (diagnostic) =>
        this.recordClientTransportDiagnostic(diagnostic),
    });
    this.eventLogPath = resolveDaemonEventLogPath(this.config);
    this.workflowStore = new FileWorkflowStore(
      resolveDaemonWorkflowStorePath(this.config)
    );
    this.planDocumentStore = new FilePlanDocumentStore(
      resolveDaemonPlanDocumentStorePath(this.config)
    );
    this.scopedContextStore = new FileScopedContextStore(
      resolveDaemonScopedContextStorePath(this.config)
    );
    this.sessionMetadataStore = new FileSessionMetadataStore(
      resolveDaemonSessionMetadataStorePath(this.config)
    );
    this.approvalQueue = new ApprovalQueue({
      defaultTimeoutMs: this.config.approvalTimeoutMs,
    });
    this.eventStore = new DaemonEventStore(this.eventLogPath);
    this.eventStore.installSignalHandlers();
    this.backgroundTasks = new DaemonBackgroundTaskManager({
      defaultWorkspaceRoot: this.config.defaultCwd,
      managerOptions: {
        defaultTimeoutMs: 30 * 60_000,
        maxOutputBytes: 500_000,
      },
    });
    // options.mcpServers（已是 definition）优先；否则从 config 可序列化条目构造
    const mcpServerDefinitions =
      this.options.mcpServers ??
      buildMcpServerDefinitions(this.config.mcpServers ?? []);
    this.runtimeFactory = new DaemonRuntimeFactory({
      config: this.config,
      approvalQueue: this.approvalQueue,
      sessionStoreDir: resolveDaemonRuntimeSessionDir(this.config),
      scopedContextStore: this.scopedContextStore,
      productAdapters: {
        checkpoint: new DaemonCheckpointManifestAdapter({
          manifestPath: resolveDaemonCheckpointManifestPath(this.config),
        }),
        memory: new DaemonJsonlMemoryAdapter({
          storePath: resolveDaemonMemoryStorePath(this.config),
        }),
        ...this.options.productAdapters,
      },
      getBackgroundCommandManager: (cwd) =>
        this.backgroundTasks.getManagerForCwd(cwd),
      mcpServers:
        mcpServerDefinitions.length > 0 ? mcpServerDefinitions : undefined,
      mcpLifecycleManagerFactory: this.options.mcpLifecycleManagerFactory,
      mcpStartupGateTimeoutMs: this.options.mcpStartupGateTimeoutMs,
      startRun: (request) => this.startDurableRun(request),
      cancelRun: (runId, reason) => this.orchestrator.cancelRun(runId, reason),
      steerRun: (runId, message) => this.orchestrator.steerRun(runId, message),
      isRunActive: (runId) => this.orchestrator.isRunActive(runId),
      getRunStatus: (runId) => {
        const run = this.orchestrator.getRun(runId);
        return run ? { status: run.status } : undefined;
      },
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
      this.approvalQueue
    );
    this.runHandler = new RunHandler({
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
      runHandler: this.runHandler,
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
      applyMcpServerConfigs: (configs) => this.applyMcpServerConfigs(configs),
    });
    this.workflowScheduler = new WorkflowScheduler({
      store: this.workflowStore,
      triggerWorkflow: (due, now) => {
        this.assertEventStoreAvailableForNewRun(
          undefined,
          'scheduled-workflow'
        );
        return this.requestHandlers.triggerDueWorkflow(due, now);
      },
    });
  }

  async start(): Promise<number> {
    this.buildDependencies();

    try {
      await this.orchestrator.restoreFromEventStore();
      await this.rebuildActiveSubagentsFromEventStore();
    } catch (error) {
      this.lifecycle.recordError({
        code: 'EVENT_STORE_RESTORE_FAILED',
        message: `Failed to restore daemon event store: ${errorMessage(error)}`,
        source: 'event-store',
        detail: errorDetail(error),
      });
      this.lifecycle.markStopped();
      throw error;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      this.wss = new WebSocketServer({ port: this.config.port });

      this.wss.on('listening', () => {
        const address = this.wss.address() as AddressInfo;
        this.port = address.port;
        this.lifecycle.markReady(this.port);
        this.startWorkflowSchedulerLoop();
        console.log(`[Daemon] WebSocket server listening on port ${this.port}`);
        settled = true;
        resolve(this.port);
      });

      this.wss.on('error', (error) => {
        console.error('[Daemon] Server error:', error);
        this.lifecycle.recordError({
          code: 'WEBSOCKET_SERVER_ERROR',
          message: `WebSocket server error: ${error.message}`,
          source: 'websocket',
          detail: error.stack,
        });
        if (!settled) {
          settled = true;
          this.lifecycle.markStopped();
          reject(error);
        }
      });

      this.wss.on('connection', (ws) => this.handleConnection(ws));

      this.wss.on('close', () => {
        console.log('[Daemon] Server closed');
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
    await this.runStopStep(
      'WORKFLOW_SCHEDULER_DRAIN_FAILED',
      'Failed to drain workflow scheduler tick',
      () => this.waitForWorkflowSchedulerTick(2_000),
      failures
    );
    this.approvalQueue.clearAll('daemon-shutdown');
    this.cancelActiveRuns('daemon-shutdown');
    for (const client of this.clients.closeAll(1001, 'Daemon shutting down')) {
      this.lifecycle.recordClientDisconnected(
        client,
        1001,
        'Daemon shutting down'
      );
    }

    await this.runStopStep(
      'WEBSOCKET_CLOSE_FAILED',
      'Failed to close WebSocket server',
      () => this.closeWebSocketServer(),
      failures
    );
    await this.runStopStep(
      'ACTIVE_RUN_SETTLE_FAILED',
      'Failed to settle active runs',
      () => this.waitForActiveRunsToSettle('daemon-shutdown', 5_000),
      failures
    );
    await this.runStopStep(
      'WORKFLOW_BACKGROUND_RUN_DRAIN_FAILED',
      'Failed to drain background workflow runs',
      () => this.requestHandlers.waitForBackgroundWorkflowRuns(5_000),
      failures
    );
    await this.runStopStep(
      'MESSAGE_TASK_DRAIN_FAILED',
      'Failed to drain daemon message tasks',
      () => this.waitForMessageTasks(5_000),
      failures
    );
    await this.runStopStep(
      'BACKGROUND_TASKS_DISPOSE_FAILED',
      'Failed to dispose background tasks',
      () => this.disposeBackgroundTasks(),
      failures
    );
    await this.runStopStep(
      'RUNTIME_FACTORY_CLOSE_FAILED',
      'Failed to close daemon runtime factory',
      () => this.runtimeFactory.close(),
      failures
    );
    await this.runStopStep(
      'EVENT_STORE_CLOSE_FAILED',
      'Failed to close daemon event store',
      () => this.eventStore.close(),
      failures
    );

    if (failures.length > 0) {
      throw failures[0];
    }

    this.lifecycle.markStopped();
    console.log('[Daemon] Server stopped');
  }

  getApprovalQueue(): ApprovalQueue {
    return this.approvalQueue;
  }

  async readSessionEvents(
    sessionId: string,
    afterSequence?: number
  ): Promise<OrchestratorEvent[]> {
    return this.orchestrator.readSessionEvents(sessionId, afterSequence);
  }

  async readRunEvents(
    runId: string,
    afterSequence?: number
  ): Promise<OrchestratorEvent[]> {
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
    const providerStatus =
      input?.providerStatus ?? this.runtimeFactory.getProviderStatusSnapshot();
    const mcpStatus =
      input?.mcpStatus ?? this.runtimeFactory.getMcpStatusSnapshot();
    const activeRunCount =
      input?.activeRunCount ?? this.orchestrator.countActiveRuns();

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
    if (!client) {
      return;
    }
    this.lifecycle.recordClientConnected(client);
    console.log(
      `[Daemon] Client connected: ${client.id} (total: ${this.clients.size})`
    );

    // 协议握手：客户端应发送 hello 消息
    // 如果 5 秒内未收到 hello，关闭连接
    const handshakeTimer = setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        ws.close(4002, 'Handshake timeout: expected hello message');
      }
    }, 5_000);
    handshakeTimer.unref?.();

    ws.on('message', (data) => {
      clearTimeout(handshakeTimer);
      this.trackMessageTask(this.handleMessage(ws, data));
    });
    ws.on('close', (code, reason) => {
      this.handleDisconnect(ws, code, reason);
      ws.removeAllListeners('message');
      ws.removeAllListeners('ping');
      ws.removeAllListeners('pong');
    });
    ws.on('error', (error) => {
      this.lifecycle.recordError({
        code: 'CLIENT_SOCKET_ERROR',
        message: `Client ${client.id} socket error: ${error.message}`,
        source: 'client',
        detail: error.stack,
        metadata: { clientId: client.id },
      });
      console.error(`[Daemon] Client ${client.id} error:`, error.message);
    });

    // 使用 WebSocket 协议内置 ping/pong
    ws.on('ping', (data) => {
      ws.pong(data);
    });
  }

  private async handleMessage(ws: WebSocket, data: RawData): Promise<void> {
    const buffer = rawDataToBuffer(data);
    const msgBytes = buffer.byteLength;
    if (
      !this.connectionLimiter.tryConsume(1) ||
      !this.byteLimiter.tryConsume(msgBytes)
    ) {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'RATE_LIMITED',
          message: 'Too many requests',
        })
      );
      return;
    }

    // Binary frame path (CR magic) — large artifacts without base64-in-JSON
    if (looksLikeBinaryFrame(buffer)) {
      await this.handleBinaryFrame(ws, buffer);
      return;
    }

    const parsed = parseClientMessage(buffer);
    if (!parsed.ok) {
      const client = this.clients.get(ws);
      this.lifecycle.recordError({
        code: 'CLIENT_PARSE_ERROR',
        message: parsed.message,
        source: 'client',
        ...(client ? { metadata: { clientId: client.id } } : {}),
      });
      this.clients.sendError(ws, 'PARSE_ERROR', parsed.message);
      return;
    }

    // 协议握手：处理 hello 消息
    const raw = parsed.value as Record<string, unknown>;
    if (raw.type === 'hello') {
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

    if (
      this.rejectDurableRunWhenEventStoreFailed(ws, client, validation.value)
    ) {
      return;
    }

    try {
      await this.requestHandlers.handleInboundMessage(
        ws,
        client,
        validation.value
      );
    } catch (error) {
      console.error('[Daemon] Client message handler failed:', error);
      this.lifecycle.recordError({
        code: 'DAEMON_MESSAGE_HANDLER_ERROR',
        message: `Daemon message handler failed: ${errorMessage(error)}`,
        source: 'daemon',
        detail: errorDetail(error),
        metadata: { clientId: client.id },
      });
      this.clients.sendError(
        ws,
        'DAEMON_ERROR',
        error instanceof Error ? error.message : String(error),
        undefined,
        validation.value
      );
    }
  }

  private handleHello(ws: WebSocket, message: Record<string, unknown>): void {
    const clientVersion =
      typeof message.protocolVersion === 'number' ? message.protocolVersion : 0;
    const serverVersion = 2;

    if (clientVersion < 1) {
      ws.close(
        4003,
        `Protocol version ${clientVersion} not supported. Server requires version >= 1`
      );
      return;
    }

    this.clients.send(ws, {
      type: 'welcome',
      protocolVersion: serverVersion,
      serverName: 'crish-daemon',
      capabilities: [
        'run-task',
        'approval',
        'pending-input',
        'workflow',
        'git',
        'plan-document',
        BINARY_FRAME_CAPABILITY,
      ],
    });

    for (const sub of this.subagentBridge?.getActiveSubagentsSnapshot() ?? []) {
      this.clients.send(ws, {
        type: 'subagent-started',
        runId: sub.runId,
        subagentId: sub.subagentId,
        subagentRunId: sub.subagentRunId,
        parentToolCallId: sub.parentToolCallId,
        description: sub.description,
        mode: sub.mode,
      });
    }
  }

  /**
   * Inbound CR binary frames. Decode without exploding; stream control + blobs
   * get a STREAM_ACK receipt (binary). Full stream recovery is client-side (3.3).
   */
  private async handleBinaryFrame(
    ws: WebSocket,
    buffer: Buffer
  ): Promise<void> {
    const client = this.clients.get(ws);
    const decoded = decodeBinaryFrame(buffer);
    if (!decoded.ok) {
      this.lifecycle.recordError({
        code: 'CLIENT_BINARY_FRAME_ERROR',
        message: decoded.error,
        source: 'client',
        ...(client ? { metadata: { clientId: client.id } } : {}),
      });
      this.clients.sendError(ws, 'BINARY_FRAME_ERROR', decoded.error);
      return;
    }

    const frame = decoded.frame;
    try {
      switch (frame.type) {
        case BinaryFrameType.STREAM_PAUSE:
        case BinaryFrameType.STREAM_RESUME: {
          let runId = '';
          if (frame.payload.byteLength > 0) {
            try {
              const meta = JSON.parse(frame.payload.toString('utf8')) as {
                runId?: unknown;
              };
              runId = typeof meta.runId === 'string' ? meta.runId : '';
            } catch {
              /* ignore invalid meta — still ACK */
            }
          }
          if (frame.type === BinaryFrameType.STREAM_PAUSE) {
            this.runHandler.pauseStream(runId);
          } else {
            this.runHandler.resumeStream(runId);
          }
          console.info(
            `[Daemon] binary ${frame.typeName} from ${client?.id ?? 'unknown'} runId=${runId || '(none)'}`
          );
          this.sendBinaryAck(ws, {
            ok: true,
            type: frame.typeName,
            runId,
            receivedAt: Date.now(),
          });
          return;
        }

        case BinaryFrameType.STREAM_ACK: {
          const note =
            frame.payload.byteLength > 0
              ? frame.payload.toString('utf8').slice(0, 256)
              : '';
          console.info(
            `[Daemon] binary ${frame.typeName} from ${client?.id ?? 'unknown'}${note ? `: ${note}` : ''}`
          );
          this.sendBinaryAck(ws, {
            ok: true,
            type: frame.typeName,
            receivedAt: Date.now(),
          });
          return;
        }

        case BinaryFrameType.CONTROL_JSON: {
          let control: unknown;
          try {
            control = JSON.parse(frame.payload.toString('utf8'));
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            this.clients.sendError(
              ws,
              'BINARY_CONTROL_JSON_ERROR',
              `Invalid CONTROL_JSON payload: ${message}`
            );
            return;
          }
          if (
            control !== null &&
            typeof control === 'object' &&
            !Array.isArray(control)
          ) {
            const raw = control as Record<string, unknown>;
            if (raw.type === 'hello') {
              this.handleHello(ws, raw);
              return;
            }
            const validation = validateInboundMessage(control);
            if (!validation.ok) {
              this.clients.sendError(
                ws,
                validation.error.code,
                formatProtocolValidationError(validation.error),
                undefined,
                correlationFromRawMessage(control)
              );
              return;
            }
            if (!client) return;
            await this.requestHandlers.handleInboundMessage(
              ws,
              client,
              validation.value
            );
          }
          return;
        }

        case BinaryFrameType.FILE_PATCH:
        case BinaryFrameType.DIFF_TEXT: {
          const metaBody = decodeMetaBodyPayload(frame.payload);
          if (!metaBody.ok) {
            this.sendBinaryAck(ws, {
              ok: true,
              type: frame.typeName,
              bodyBytes: frame.payload.byteLength,
              meta: null,
            });
            return;
          }
          this.sendBinaryAck(ws, {
            ok: true,
            type: frame.typeName,
            bodyBytes: metaBody.body.byteLength,
            meta: metaBody.meta,
          });
          return;
        }

        case BinaryFrameType.TOOL_BLOB: {
          this.sendBinaryAck(ws, {
            ok: true,
            type: frame.typeName,
            bodyBytes: frame.payload.byteLength,
          });
          return;
        }

        default: {
          this.clients.sendError(
            ws,
            'BINARY_FRAME_UNSUPPORTED',
            `Unhandled binary frame type: ${frame.typeName}`
          );
        }
      }
    } catch (error) {
      console.error('[Daemon] binary frame handler failed:', error);
      this.lifecycle.recordError({
        code: 'DAEMON_BINARY_FRAME_HANDLER_ERROR',
        message: `Binary frame handler failed: ${errorMessage(error)}`,
        source: 'daemon',
        detail: errorDetail(error),
        ...(client
          ? { metadata: { clientId: client.id, frameType: frame.typeName } }
          : {}),
      });
      this.clients.sendError(
        ws,
        'DAEMON_ERROR',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /** STREAM_ACK binary receipt with UTF-8 JSON payload. */
  private sendBinaryAck(
    ws: WebSocket,
    receipt: Record<string, unknown>
  ): boolean {
    return this.sendBinaryFrame(
      ws,
      BinaryFrameType.STREAM_ACK,
      Buffer.from(JSON.stringify(receipt), 'utf8')
    );
  }

  /** Send a CR binary frame (WS binary). No-op if socket not open. */
  private sendBinaryFrame(
    ws: WebSocket,
    type: BinaryFrameTypeCode,
    payload: Buffer
  ): boolean {
    if (ws.readyState !== ws.OPEN) return false;
    try {
      const frame = encodeBinaryFrame(type, payload);
      ws.send(frame);
      return true;
    } catch (error) {
      console.error('[Daemon] failed to send binary frame:', error);
      return false;
    }
  }

  /**
   * Rebuild active subagent projections after restore.
   *
   * Prefer the single-scan projections collected by orchestrator.restoreFromEventStore
   * (consumeRestoredSubagentRuntimeEvents) — zero extra event-log I/O.
   * Fallback: one streaming/full pass over the event store for still-active runs
   * (never N×readRun cold scans).
   */
  private async rebuildActiveSubagentsFromEventStore(): Promise<void> {
    // Projections gathered during restore for runs that were non-terminal at end-of-log
    // (before interrupt). Apply them so reconnecting clients can see pre-restart state.
    const restored = this.orchestrator.consumeRestoredSubagentRuntimeEvents();
    for (const proj of restored) {
      if (!proj.agentEvent || typeof proj.agentEvent !== 'object') continue;
      const update = readDaemonSubagentBridgeUpdateFromAgentEvent(
        proj.agentEvent as never
      );
      if (update?.phase === 'started') {
        this.subagentBridge.rebuildStarted(update, proj.runId);
      }
    }

    const activeRuns = this.orchestrator
      .listRuns()
      .filter(
        (run) =>
          run.status === 'running' ||
          run.status === 'queued' ||
          run.status === 'awaiting-approval'
      );
    if (activeRuns.length === 0) return;

    const activeRunIds = new Set(activeRuns.map((run) => run.id));
    // Single scan fallback — never N full-file readRun cold scans.
    const store = this.eventStore as {
      readAllStreaming?: (
        afterSequence?: number
      ) => AsyncIterable<import('@crish/agent-orchestrator').OrchestratorEvent>;
      readAll?: (
        afterSequence?: number
      ) => Promise<import('@crish/agent-orchestrator').OrchestratorEvent[]>;
    };
    if (typeof store.readAllStreaming === 'function') {
      for await (const event of store.readAllStreaming(0)) {
        if (!event.runId || !activeRunIds.has(event.runId)) continue;
        if (event.type !== 'runtime-event') continue;
        const agentEvent = (event.payload as { event?: unknown }).event;
        if (!agentEvent || typeof agentEvent !== 'object') continue;
        const update = readDaemonSubagentBridgeUpdateFromAgentEvent(
          agentEvent as never
        );
        if (update?.phase === 'started') {
          this.subagentBridge.rebuildStarted(update, event.runId);
        }
      }
      return;
    }

    if (typeof store.readAll === 'function') {
      const all = await store.readAll(0);
      for (const event of all) {
        if (!event.runId || !activeRunIds.has(event.runId)) continue;
        if (event.type !== 'runtime-event') continue;
        const agentEvent = (event.payload as { event?: unknown }).event;
        if (!agentEvent || typeof agentEvent !== 'object') continue;
        const update = readDaemonSubagentBridgeUpdateFromAgentEvent(
          agentEvent as never
        );
        if (update?.phase === 'started') {
          this.subagentBridge.rebuildStarted(update, event.runId);
        }
      }
    }
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
        console.error('[Daemon] Unhandled client message task failure:', error);
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

  private async startDurableRun(
    request: StartRunRequest
  ): Promise<OrchestratorRunHandle> {
    this.assertEventStoreAvailableForNewRun(request.id, 'subagent');
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

    const runId = message.type === 'run-task' ? message.runId : message.runId;
    console.warn(
      `[Daemon] Rejecting ${message.type} because event store is degraded: ${failure.message}`
    );
    this.clients.sendError(
      ws,
      'EVENT_STORE_DEGRADED',
      degradedRunRejectionMessage(failure),
      runId,
      message
    );
    this.lifecycle.recordError({
      code: 'EVENT_STORE_DEGRADED_RUN_REJECTED',
      message: `Rejected durable run while event store is degraded: ${failure.message}`,
      source: 'event-store',
      severity: 'warning',
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
      code: 'EVENT_STORE_DEGRADED_RUN_REJECTED',
      message: `Rejected durable run while event store is degraded: ${failure.message}`,
      source: 'event-store',
      severity: 'warning',
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
      source: 'event-store',
      severity: 'error',
      detail: failure.stack,
      metadata: eventStoreFailureMetadata(failure, this.eventLogPath),
    });
  }

  private recordClientTransportDiagnostic(
    diagnostic: DaemonClientTransportDiagnostic
  ): void {
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
    if (
      this.workflowSchedulerTimer ||
      this.config.workflowSchedulerIntervalMs <= 0
    ) {
      return;
    }

    const runTick = () => {
      void this.tickScheduler().catch((error) => {
        if (error instanceof DaemonEventStoreDegradedError) {
          this.lifecycle.recordError({
            code: 'EVENT_STORE_DEGRADED_RUN_REJECTED',
            message: error.message,
            source: 'event-store',
            severity: 'warning',
            detail: error.stack,
            metadata: {
              ...(error.runId ? { runId: error.runId } : {}),
              ...eventStoreFailureMetadata(error.failure, this.eventLogPath),
            },
          });
          console.warn(
            '[Daemon] Workflow scheduler skipped durable run:',
            error.message
          );
          return;
        }
        this.lifecycle.recordError({
          code: 'WORKFLOW_SCHEDULER_TICK_FAILED',
          message: `Workflow scheduler tick failed: ${errorMessage(error)}`,
          source: 'daemon',
          detail: errorDetail(error),
        });
        console.error('[Daemon] Workflow scheduler tick failed:', error);
      });
    };

    this.workflowSchedulerTimer = setInterval(
      runTick,
      this.config.workflowSchedulerIntervalMs
    );
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
      () => 'settled' as const,
      () => 'settled' as const
    );
    const timedOut = delay(timeoutMs).then(() => 'timed-out' as const);
    const result = await Promise.race([settled, timedOut]);
    if (result === 'timed-out') {
      console.warn(
        '[Daemon] Shutdown timed out waiting for workflow scheduler tick'
      );
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

  private async waitForActiveRunsToSettle(
    reason: string,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.orchestrator.countActiveRuns() === 0) {
        return;
      }
      const activeRuns = this.orchestrator
        .listRuns()
        .filter((run) => isActiveRunStatus(run.status));
      for (const run of activeRuns) {
        this.orchestrator.cancelRun(run.id, reason);
      }
      await delay(25);
    }

    if (this.orchestrator.countActiveRuns() > 0) {
      const activeRuns = this.orchestrator
        .listRuns()
        .filter((run) => isActiveRunStatus(run.status));
      console.warn(
        `[Daemon] Shutdown timed out waiting for active runs: ${activeRuns.map((run) => `${run.id}:${run.status}`).join(', ')}`
      );
    }
  }

  private async waitForMessageTasks(timeoutMs: number): Promise<void> {
    if (this.messageTasks.size === 0) {
      return;
    }

    const settled = Promise.allSettled([...this.messageTasks]).then(
      () => 'settled' as const
    );
    const timedOut = delay(timeoutMs).then(() => 'timed-out' as const);
    const result = await Promise.race([settled, timedOut]);
    if (result === 'timed-out' && this.messageTasks.size > 0) {
      console.warn(
        `[Daemon] Shutdown timed out waiting for ${this.messageTasks.size} message task(s)`
      );
    }
  }

  /**
   * 关停后台任务管理器：终止全部运行中子进程、清理定时器、清空 tasks Map。
   * 同时清理 subagent bridge 的孤儿追踪记录（运行未正常收尾的子代理）。
   */
  private async disposeBackgroundTasks(): Promise<void> {
    this.backgroundTasks.dispose();
    // subagent bridge 的 activeSubagents 在 run-handlers finally 中按 run 清理，
    // 但若 run 未正常 settle（超时），孤儿条目会残留；关停时兜底全清。
    this.subagentBridge.clearAll();
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
        source: code === 'EVENT_STORE_CLOSE_FAILED' ? 'event-store' : 'daemon',
        detail: errorDetail(error),
      });
      failures.push(error);
    }
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  // SharedArrayBuffer / ArrayBufferView / string
  return Buffer.from(data as Buffer | string | Uint8Array);
}

function parseClientMessage(data: RawData | Buffer): ParseMessageResult {
  const buffer = Buffer.isBuffer(data) ? data : rawDataToBuffer(data);

  try {
    return { ok: true, value: JSON.parse(buffer.toString('utf8')) };
  } catch (error) {
    return { ok: false, message: `Invalid JSON: ${(error as Error).message}` };
  }
}

function isActiveRunStatus(status: RunStatus): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'awaiting-approval' ||
    status === 'cancelling'
  );
}

function isNewDurableRunMessage(
  message: DaemonInboundMessage
): message is Extract<
  DaemonInboundMessage,
  { type: 'run-task' | 'trigger-workflow' }
> {
  return message.type === 'run-task' || message.type === 'trigger-workflow';
}

class DaemonEventStoreDegradedError extends Error {
  readonly code = 'EVENT_STORE_DEGRADED';

  constructor(
    readonly runId: string | undefined,
    readonly failure: OrchestratorEventStoreError
  ) {
    super(degradedRunRejectionMessage(failure));
    this.name = 'DaemonEventStoreDegradedError';
  }
}

function degradedRunRejectionMessage(
  failure: OrchestratorEventStoreError
): string {
  return `Daemon event store is degraded; durable run start rejected. ${failure.message}`;
}

function eventStoreFailureCode(
  failure: OrchestratorEventStoreError
): 'EVENT_STORE_CLOSED' | 'EVENT_STORE_WRITE_FAILED' {
  return failure.kind === 'closed'
    ? 'EVENT_STORE_CLOSED'
    : 'EVENT_STORE_WRITE_FAILED';
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
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return Number.isNaN(value) ? null : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toDiagnosticJsonValue(item));
  }
  if (value && typeof value === 'object') {
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

function correlationFromRawMessage(
  value: unknown
): DaemonCorrelationFields | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.requestId === 'string' && record.requestId.length > 0
      ? { requestId: record.requestId }
      : {}),
    ...(typeof record.correlationId === 'string' &&
    record.correlationId.length > 0
      ? { correlationId: record.correlationId }
      : {}),
  };
}

type ParseMessageResult =
  { ok: true; value: unknown } | { ok: false; message: string };
