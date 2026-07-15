import type {
  AgentRuntimeOptions,
  AgentTool,
} from "@crish/agent-runtime";
import type { JsonObject, JsonValue } from "@crish/shared-types";
import { compactJsonObject } from "@crish/shared-utils";
import {
  BackgroundCommandManager,
  ConfigMerger,
  RUNTIME_CONFIG_SCHEMA,
  CONFIG_SOURCE_PRIORITIES,
  type ConfigSource,
  type ConfigSourcePriority,
  type ConfigValidationResult,
  createProductRuntimeDefaults,
  InMemoryContextState,
  JsonlSessionStore,
  McpLifecycleManager,
  WorkspaceMutationCoordinator,
  type McpLifecycleDiagnostic,
  type McpLifecycleSnapshot,
  type McpLifecycleStartResult,
  type McpServerDefinition,
} from "@crish/agent-runtime";
import {
  createAgentRuntimeRunEngineFactory,
  type CreateRunEngineInput,
  type OrchestratorRunHandle,
  type RunEngineFactory,
  type StartRunRequest,
} from "@crish/agent-orchestrator";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { ApprovalQueue } from "./approval-queue.js";
import { DaemonApprovalHandler } from "./daemon-approval-handler.js";
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  createDaemonSubagentTool,
  resolveMaxSubagentDepth,
} from "./subagent-runtime.js";
import { DaemonPermissionPolicy } from "./daemon-permission-policy.js";
import type { DaemonPermissionMode } from "./daemon-permission-policy.js";
import type { DaemonConfig, DaemonProviderStatusSnapshot } from "./types.js";
import type { ScopedContextStore } from "./scoped-context-store.js";
import {
  buildDaemonScopedPromptContext,
} from "./scoped-context-runtime.js";
import type {
  ArtifactRecord,
  ChangedFileRecord,
  CheckpointRecord,
  MemoryRecord,
} from "./types.js";
import {
  createUnsupportedProductSurfaceStatus,
  type DaemonProductAdapters,
  type DaemonProductAdapterStatusSnapshot,
} from "./daemon-product-adapters.js";

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

interface DaemonRuntimeFactoryOptions {
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
  /** 向活跃 run 注入 steer 消息；返回是否被接受 */
  steerRun?(runId: string, message: string): boolean;
  /** 查询 run 是否仍在跑 */
  isRunActive?(runId: string): boolean;
  getRunStatus?(runId: string): { status: string } | undefined;
}

/**
 * 共享的 Runtime 配置合并器，用于校验来自多来源的运行时参数。
 */
const runtimeConfigMerger = new ConfigMerger(RUNTIME_CONFIG_SCHEMA);

export class DaemonRuntimeFactory {
  private providerFactory?: DaemonProviderFactory;
  private providerStatusProvider?: () => DaemonProviderStatusSnapshot;
  private toolFactory?: DaemonToolFactory;
  private readonly mutationCoordinatorsByCwd = new Map<string, WorkspaceMutationCoordinator>();
  private readonly mcpManagers = new Set<McpLifecycleManager>();
  private sharedMcpManager?: McpLifecycleManager;
  private lastMcpStatus?: DaemonMcpStatusSnapshot;

  constructor(private readonly options: DaemonRuntimeFactoryOptions) {}

  setProviderFactory(factory: DaemonProviderFactory): void {
    this.providerFactory = factory;
    this.providerStatusProvider = providerStatusProviderFromFactory(factory);
  }

  setToolFactory(factory: DaemonToolFactory): void {
    this.toolFactory = factory;
  }

  hasProviderFactory(): boolean {
    return this.providerFactory !== undefined;
  }

  getProviderStatusSnapshot(): DaemonProviderStatusSnapshot {
    return this.withMcpProviderDiagnostics(
      this.providerStatusProvider?.() ?? unconfiguredProviderStatusSnapshot()
    );
  }

  getMcpStatusSnapshot(): DaemonMcpStatusSnapshot {
    if (this.mcpManagers.size > 0) {
      this.lastMcpStatus = aggregateMcpStatus([...this.mcpManagers]);
      return this.lastMcpStatus;
    }
    if (this.lastMcpStatus) return this.lastMcpStatus;
    if (this.options.mcpLifecycleManagerFactory || (this.options.mcpServers?.length ?? 0) > 0) {
      return idleMcpStatusSnapshot(this.options.mcpServers?.length ?? 0);
    }
    return unconfiguredMcpStatusSnapshot();
  }

  getWorkspaceMutationCoordinator(cwd: string): WorkspaceMutationCoordinator {
    const workspaceRoot = resolve(cwd);
    const key = workspaceCoordinatorKey(workspaceRoot);
    let coordinator = this.mutationCoordinatorsByCwd.get(key);
    if (!coordinator) {
      coordinator = new WorkspaceMutationCoordinator({ workspaceRoot });
      this.mutationCoordinatorsByCwd.set(key, coordinator);
    }
    return coordinator;
  }

  listMutationLeases(): Array<{
    token: string;
    scope: { type: "workspace" } | { type: "files"; paths: string[] };
    owner?: {
      runId?: string;
      sessionId?: string;
      toolCallId?: string;
      toolName?: string;
      cwd?: string;
      targetSummary?: string;
    };
    createdAt: string;
    expiresAt: string;
    ttlMs: number;
  }> {
    const allLeases: Array<{
      token: string;
      scope: { type: "workspace" } | { type: "files"; paths: string[] };
      owner?: {
        runId?: string;
        sessionId?: string;
        toolCallId?: string;
        toolName?: string;
        cwd?: string;
        targetSummary?: string;
      };
      createdAt: string;
      expiresAt: string;
      ttlMs: number;
    }> = [];
    for (const coordinator of this.mutationCoordinatorsByCwd.values()) {
      const leases = coordinator.listLeases();
      for (const lease of leases) {
        allLeases.push({
          token: lease.token,
          scope: lease.scope,
          owner: lease.owner,
          createdAt: lease.createdAt,
          expiresAt: lease.expiresAt,
          ttlMs: lease.ttlMs,
        });
      }
    }
    return allLeases;
  }

  getProductAdapterStatusSnapshot(now: Date = new Date()): DaemonProductAdapterStatusSnapshot {
    return {
      artifacts:
        this.options.productAdapters?.artifact?.status(now) ??
        createUnsupportedProductSurfaceStatus("artifacts", now),
      memory:
        this.options.productAdapters?.memory?.status(now) ??
        createUnsupportedProductSurfaceStatus("memory", now),
      checkpoints:
        this.options.productAdapters?.checkpoint?.status(now) ??
        createUnsupportedProductSurfaceStatus("checkpoints", now),
    };
  }

  async listArtifacts(sessionId?: string): Promise<ArtifactRecord[]> {
    const adapter = this.options.productAdapters?.artifact;
    if (!adapter) {
      throw new DaemonUnsupportedCapabilityError(
        "artifacts",
        "Artifact listing is not supported because no daemon artifact adapter is configured."
      );
    }
    return adapter.listArtifacts(sessionId);
  }

  async getArtifactContent(artifactUri: string): Promise<{ content: string; mimeType?: string }> {
    const adapter = this.options.productAdapters?.artifact;
    if (!adapter) {
      throw new DaemonUnsupportedCapabilityError(
        "artifacts",
        "Artifact content retrieval is not supported because no daemon artifact adapter is configured."
      );
    }
    return adapter.getArtifactContent(artifactUri);
  }

  async listMemories(scope?: string): Promise<MemoryRecord[]> {
    const adapter = this.options.productAdapters?.memory;
    if (!adapter) {
      throw new DaemonUnsupportedCapabilityError(
        "memory",
        "Memory listing is not supported because no daemon memory adapter is configured."
      );
    }
    return adapter.listMemories(scope);
  }

  async deleteMemory(memoryId: string): Promise<void> {
    const adapter = this.options.productAdapters?.memory;
    if (!adapter) {
      throw new DaemonUnsupportedCapabilityError(
        "memory",
        "Memory deletion is not supported because no daemon memory adapter is configured."
      );
    }
    await adapter.deleteMemory(memoryId);
  }

  async listCheckpoints(runId?: string, sessionId?: string): Promise<CheckpointRecord[]> {
    const adapter = this.options.productAdapters?.checkpoint;
    if (!adapter) {
      throw new DaemonUnsupportedCapabilityError(
        "checkpoints",
        "Checkpoint listing is not supported because no daemon checkpoint adapter is configured."
      );
    }
    return adapter.listCheckpoints({ runId, sessionId });
  }

  async restoreCheckpoint(checkpointId: string): Promise<{ runId: string }> {
    const adapter = this.options.productAdapters?.checkpoint;
    if (!adapter?.restoreCheckpoint) {
      throw new DaemonUnsupportedCapabilityError(
        "checkpoints",
        "Checkpoint restore is not supported because no daemon checkpoint restore adapter is configured."
      );
    }
    return adapter.restoreCheckpoint(checkpointId);
  }

  async getCheckpointDiff(checkpointId: string): Promise<ChangedFileRecord[]> {
    const adapter = this.options.productAdapters?.checkpoint;
    if (!adapter?.getCheckpointDiff) {
      throw new DaemonUnsupportedCapabilityError(
        "checkpoints",
        "Checkpoint diff is not supported because no daemon checkpoint diff adapter is configured."
      );
    }
    return adapter.getCheckpointDiff(checkpointId);
  }

  sendToSubagent(subagentRunId: string, message: string): boolean {
    const text = message.trim();
    if (!text) return false;
    if (!this.options.steerRun) {
      throw new DaemonUnsupportedCapabilityError(
        "subagent",
        "Subagent steer is not wired (missing steerRun on runtime factory)",
      );
    }
    return this.options.steerRun(subagentRunId, text);
  }

  getSubagentStatus(subagentRunId: string): {
    status: string;
    progress?: string;
    latestError?: string;
  } {
    if (this.options.isRunActive?.(subagentRunId)) {
      return { status: "running", progress: "active" };
    }
    const rec = this.options.getRunStatus?.(subagentRunId);
    if (rec) {
      return { status: rec.status };
    }
    return { status: "unknown" };
  }

  startMcpServer(serverId: string): { state: string } {
    for (const manager of this.mcpManagers) {
      if (typeof (manager as any).startServer === "function") {
        try {
          const result = (manager as any).startServer(serverId);
          return { state: result?.state ?? "starting" };
        } catch { /* continue */ }
      }
    }
    throw new DaemonUnsupportedCapabilityError("mcp", `MCP server start not supported: ${serverId}`);
  }

  stopMcpServer(serverId: string): { state: string } {
    for (const manager of this.mcpManagers) {
      if (typeof (manager as any).stopServer === "function") {
        try {
          const result = (manager as any).stopServer(serverId);
          return { state: result?.state ?? "stopped" };
        } catch { /* continue */ }
      }
    }
    throw new DaemonUnsupportedCapabilityError("mcp", `MCP server stop not supported: ${serverId}`);
  }

  listMcpServers(): Array<{
    id: string;
    name: string;
    state: string;
    transport?: string;
    cachedToolCount?: number;
    lastError?: string;
    startedAt?: string;
  }> {
    if (this.lastMcpStatus?.servers) {
      return (this.lastMcpStatus.servers as any[]).map((s: any) => ({
        id: s.id ?? s.name ?? "",
        name: s.name ?? s.id ?? "",
        state: s.state ?? "unknown",
        transport: s.transport ?? undefined,
        cachedToolCount: s.cachedToolCount ?? s.toolCount ?? undefined,
        lastError: s.lastError ?? s.error ?? undefined,
        startedAt: s.startedAt ?? undefined,
      }));
    }
    return [];
  }

  createRunEngineFactory(): RunEngineFactory {
    return createAgentRuntimeRunEngineFactory(async ({ runId, session, run }) => {
      return this.createRuntimeOptions({ runId, session, run });
    });
  }

  async createRuntimeOptions({ runId, session, run }: CreateRunEngineInput): Promise<AgentRuntimeOptions> {
    if (!this.providerFactory) {
      throw new Error("Provider factory not configured. Call setProviderFactory() first.");
    }

    // ── 多层配置合并 ──
    // 收集配置层：默认值 < daemon config < 环境变量 < run.metadata
    const layers = runtimeConfigLayers({
      daemonConfig: this.options.config,
      runMetadata: run.metadata,
    });

    // 通过 ConfigMerger 合并所有层并校验
    const { config: mergedConfig, validation } = runtimeConfigMerger.mergeAndValidate(layers);
    logRuntimeConfigValidation(runId, validation);

    // 从合并结果中提取运行时参数
    const permissionMode =
      (mergedConfig.permissionMode as "ask" | "auto" | "full-access" | "plan") ?? "ask";
    // 探索型任务常需多轮读文件；16 偏紧，默认放宽到 32（仍可用 metadata/env 覆盖）
    const maxTurns = (mergedConfig.maxTurns as number) ?? 32;
    const subagentDepth = (mergedConfig.subagentDepth as number) ?? 0;

    const permissionPolicy = new DaemonPermissionPolicy(
      permissionMode
    );

    const mutationCoordinator = this.getWorkspaceMutationCoordinator(run.cwd);
    const backgroundManager = this.backgroundCommandManagerForCwd(run.cwd);
    const contextState = new InMemoryContextState();
    const sessionStore = new JsonlSessionStore(this.sessionStorePath(session.id, run.cwd), {
      mode: "resume-or-create",
    });
    const scopedPromptContext = await buildDaemonScopedPromptContext(
      this.options.scopedContextStore,
      {
        cwd: run.cwd,
        ...(stringMetadata(run.metadata, "workspaceRoot") !== undefined
          ? { workspaceRoot: stringMetadata(run.metadata, "workspaceRoot") }
          : {}),
        ...(stringMetadata(run.metadata, "projectRoot") !== undefined
          ? { projectRoot: stringMetadata(run.metadata, "projectRoot") }
          : {}),
        ...(stringArrayMetadata(run.metadata, "projectMarkers") !== undefined
          ? { projectMarkers: stringArrayMetadata(run.metadata, "projectMarkers") }
          : {}),
        ...(stringArrayMetadata(run.metadata, "projectFiles") !== undefined
          ? { projectFiles: stringArrayMetadata(run.metadata, "projectFiles") }
          : {}),
        ...(stringArrayMetadata(run.metadata, "projectTags") !== undefined
          ? { projectTags: stringArrayMetadata(run.metadata, "projectTags") }
          : {}),
        ...(stringArrayMetadata(run.metadata, "packageNames") !== undefined
          ? { packageNames: stringArrayMetadata(run.metadata, "packageNames") }
          : {}),
        metadata: run.metadata,
      }
    );
    run.metadata = withScopedContextRunMetadata(run.metadata, scopedPromptContext.metadata);
    const mcpTools = await this.startMcpForRun({
      runId,
      sessionId: session.id,
      cwd: run.cwd,
      metadata: run.metadata,
      runMetadataTarget: run,
    });

    return {
      sessionId: session.id,
      cwd: run.cwd,
      systemPrompt: stringMetadata(run.metadata, "systemPrompt"),
      promptContext: {
        stableContext: scopedPromptContext.stableContext,
        volatileContext: scopedPromptContext.volatileContext,
        metadata: scopedPromptContext.metadata,
      },
      provider: await this.providerFactory(runId, run.cwd),
      tools: [
        ...this.createToolsForRun({
          runId,
          sessionId: session.id,
          cwd: run.cwd,
          mutationCoordinator,
          backgroundManager,
          permissionMode,
          subagentDepth,
          maxTurns,
        }),
        ...mcpTools,
      ],
      maxTurns,
      permissionPolicy,
      approvalHandler: new DaemonApprovalHandler(this.options.approvalQueue, runId),
      sessionStore,
      resumeSession: true,
      workspaceMutationCoordinator: mutationCoordinator,
      ...createProductRuntimeDefaults({
        cwd: run.cwd,
        contextWindowTokens: numberMetadata(run.metadata, "contextWindowTokens"),
        thresholdTokens: numberMetadata(run.metadata, "autoCompactAtTokens"),
        preferredWorkingTokens: numberMetadata(run.metadata, "preferredWorkingTokens"),
        contextState,
      }),
    };
  }

  async close(): Promise<void> {
    const managers = [...this.mcpManagers];
    if (managers.length === 0) return;

    await Promise.all(managers.map((manager) => manager.teardown()));
    this.lastMcpStatus = aggregateMcpStatus(managers);
    this.mcpManagers.clear();
    this.sharedMcpManager = undefined;
  }

  private sessionStorePath(sessionId: string, cwd: string): string {
    const root = resolve(this.options.sessionStoreDir ?? ".codex/daemon-runtime-sessions");
    const cwdHash = createHash("sha256").update(workspaceCoordinatorKey(cwd)).digest("hex").slice(0, 16);
    return join(root, `${safePathSegment(sessionId)}-${cwdHash}.jsonl`);
  }

  private createToolsForRun(input: {
    runId: string;
    sessionId: string;
    cwd: string;
    mutationCoordinator: WorkspaceMutationCoordinator;
    backgroundManager: BackgroundCommandManager;
    permissionMode: DaemonPermissionMode;
    subagentDepth: number;
    maxTurns: number;
  }): AgentTool[] {
    const baseTools = (this.toolFactory
      ? this.toolFactory({
          cwd: input.cwd,
          mutationCoordinator: input.mutationCoordinator,
          backgroundManager: input.backgroundManager,
        })
      : []
    ).filter(
      (tool) => tool.name !== "run_subagent"
    );

    const envMaxDepth = process.env.CRISH_MAX_SUBAGENT_DEPTH;
    const parsedEnvMax =
      envMaxDepth !== undefined && envMaxDepth !== "" && Number.isFinite(Number(envMaxDepth))
        ? Number(envMaxDepth)
        : undefined;
    const maxSubagentDepth = resolveMaxSubagentDepth(parsedEnvMax ?? DEFAULT_MAX_SUBAGENT_DEPTH);

    return [
      ...baseTools,
      createDaemonSubagentTool({
        parentRunId: input.runId,
        parentSessionId: input.sessionId,
        cwd: input.cwd,
        depth: input.subagentDepth,
        maxDepth: maxSubagentDepth,
        permissionMode: input.permissionMode,
        maxTurns: input.maxTurns,
        startRun: (request) => this.options.startRun(request),
        cancelRun: (runId, reason) => this.options.cancelRun(runId, reason),
      }),
    ];
  }

  private backgroundCommandManagerForCwd(cwd: string): BackgroundCommandManager {
    return this.options.getBackgroundCommandManager?.(cwd) ?? new BackgroundCommandManager({ workspaceRoot: cwd });
  }

  private async startMcpForRun(input: {
    runId: string;
    sessionId: string;
    cwd: string;
    metadata?: JsonObject;
    runMetadataTarget: { metadata?: JsonObject };
  }): Promise<AgentTool[]> {
    const manager = await this.resolveMcpManager(input);
    if (!manager) return [];

    this.mcpManagers.add(manager);
    try {
      const startResult = await manager.start();
      const status = aggregateMcpStatus([...this.mcpManagers]);
      this.lastMcpStatus = status;
      input.runMetadataTarget.metadata = withMcpRunMetadata(
        input.runMetadataTarget.metadata,
        mcpRunMetadata(startResult, manager.snapshot())
      );
      return startResult.tools;
    } catch (cause) {
      const diagnostic = syntheticMcpDiagnostic(cause, "daemon-mcp");
      const status = mcpStatusFromDiagnostics([diagnostic]);
      this.lastMcpStatus = status;
      input.runMetadataTarget.metadata = withMcpRunMetadata(
        input.runMetadataTarget.metadata,
        {
          configured: true,
          readiness: "degraded",
          readyServers: [],
          degradedServers: [],
          pendingServers: [],
          stoppedServers: [],
          timedOut: false,
          toolCount: 0,
          diagnostics: [mcpDiagnosticToJson(diagnostic)],
          snapshot: status as unknown as JsonObject,
        }
      );
      return [];
    }
  }

  private async resolveMcpManager(input: DaemonMcpLifecycleManagerFactoryInput): Promise<McpLifecycleManager | undefined> {
    if (this.options.mcpLifecycleManagerFactory) {
      return this.options.mcpLifecycleManagerFactory(input);
    }

    if (!this.options.mcpServers || this.options.mcpServers.length === 0) {
      return undefined;
    }

    if (!this.sharedMcpManager) {
      this.sharedMcpManager = new McpLifecycleManager({
        id: "daemon-mcp",
        label: "Daemon MCP",
        servers: this.options.mcpServers,
        startupGateTimeoutMs: this.options.mcpStartupGateTimeoutMs,
      });
    }
    return this.sharedMcpManager;
  }

  private withMcpProviderDiagnostics(status: DaemonProviderStatusSnapshot): DaemonProviderStatusSnapshot {
    const mcpStatus = this.getMcpStatusSnapshot();
    if (!mcpStatus.configured || mcpStatus.diagnostics.length === 0) {
      return status;
    }

    const metadata = compactJsonObject({
      ...(status.lastDiagnostic?.metadata ?? {}),
      mcp: mcpStatus as unknown as JsonObject,
    });
    const lastDiagnostic = status.lastDiagnostic
      ? {
          ...status.lastDiagnostic,
          metadata,
        }
      : {
          code: mcpStatus.readiness === "degraded" ? "mcp_degraded" : "mcp_not_ready",
          message: mcpStatus.readiness === "degraded"
            ? "One or more MCP servers are degraded."
            : "MCP lifecycle is not ready.",
          kind: "mcp",
          updatedAt: mcpStatus.updatedAt,
          metadata,
        };

    return {
      ...status,
      lastDiagnostic,
    };
  }
}

/**
 * 记录 ConfigMerger 运行时参数校验结果（日志输出，不阻断运行时创建）。
 */
function logRuntimeConfigValidation(runId: string, result: ConfigValidationResult): void {
  if (result.errors.length === 0) return;
  const messages = result.errors
    .map((e) => `  [${e.path}] ${e.message}${e.received !== undefined ? ` (received: ${JSON.stringify(e.received)})` : ""}`)
    .join("\n");
  console.warn(`[DaemonRuntimeFactory/${runId}] Runtime config validation warnings:\n${messages}`);
}

// ─── 多层配置合并 ────────────────────────────────────────

type RuntimeConfigSourceName = "default" | "daemon-config" | "env" | "run-metadata";

interface RuntimeConfigLayerSources {
  daemonConfig: DaemonConfig;
  runMetadata?: JsonObject;
}

/**
 * 收集运行时配置层，按优先级从低到高排列：
 * DEFAULT(0) < DAEMON_CONFIG(150) < ENV(300) < RUN_METADATA(400)
 */
function runtimeConfigLayers(sources: RuntimeConfigLayerSources): ConfigSource[] {
  return [
    {
      name: "default",
      priority: CONFIG_SOURCE_PRIORITIES.DEFAULT,
      config: {
        maxTurns: 16,
        permissionMode: "ask",
        subagentDepth: 0,
        timeoutMs: 300_000,
      },
    },
    {
      name: "daemon-config",
      priority: 150 as ConfigSourcePriority,
      config: runtimeConfigFromDaemonConfig(sources.daemonConfig),
    },
    {
      name: "env",
      priority: CONFIG_SOURCE_PRIORITIES.ENV,
      config: runtimeConfigFromEnv(process.env),
    },
    {
      name: "run-metadata",
      priority: 400 as ConfigSourcePriority,
      config: runtimeConfigFromRunMetadata(sources.runMetadata),
    },
  ];
}

/**
 * 从 DaemonConfig 提取运行时参数。
 */
function runtimeConfigFromDaemonConfig(config: DaemonConfig): Record<string, unknown> {
  return {
    maxTurns: config.maxConcurrentRuns > 0 ? undefined : undefined,
  };
}

/**
 * 从环境变量提取运行时参数。
 */
function runtimeConfigFromEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const maxTurns = env.CRISH_MAX_TURNS ?? env.CRISH_MAX_ROUNDS;
  if (maxTurns !== undefined) {
    const parsed = Number(maxTurns);
    if (Number.isFinite(parsed) && parsed > 0) {
      result.maxTurns = parsed;
    }
  }

  const permissionMode = env.CRISH_PERMISSION_MODE ?? env.CRISH_PERMISSION_POLICY;
  if (
    permissionMode !== undefined &&
    ["ask", "auto", "full-access", "plan"].includes(permissionMode)
  ) {
    result.permissionMode = permissionMode;
  }

  const subagentDepth = env.CRISH_SUBAGENT_DEPTH;
  if (subagentDepth !== undefined) {
    const parsed = Number(subagentDepth);
    if (Number.isFinite(parsed) && parsed >= 0) {
      result.subagentDepth = parsed;
    }
  }

  const timeoutMs = env.CRISH_RUN_TIMEOUT_MS;
  if (timeoutMs !== undefined) {
    const parsed = Number(timeoutMs);
    if (Number.isFinite(parsed) && parsed > 0) {
      result.timeoutMs = parsed;
    }
  }

  return result;
}

/**
 * 从 run.metadata 提取运行时参数。
 * 客户端发起 run-task 时传入的 metadata 具有最高优先级。
 */
function runtimeConfigFromRunMetadata(metadata: JsonObject | undefined): Record<string, unknown> {
  if (!metadata) return {};

  const result: Record<string, unknown> = {};

  const maxRounds = numberMetadata(metadata, "maxRounds");
  if (maxRounds !== undefined) result.maxTurns = maxRounds;

  if (
    metadata.permissionMode === "full-access" ||
    metadata.permissionMode === "ask" ||
    metadata.permissionMode === "auto" ||
    metadata.permissionMode === "plan"
  ) {
    result.permissionMode = metadata.permissionMode;
  }

  const depth = numberMetadata(metadata, "subagentDepth");
  if (depth !== undefined) result.subagentDepth = depth;

  const timeout = numberMetadata(metadata, "timeoutMs");
  if (timeout !== undefined) result.timeoutMs = timeout;

  return result;
}

function stringMetadata(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberMetadata(metadata: JsonObject | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayMetadata(metadata: JsonObject | undefined, key: string): string[] | undefined {
  const value = metadata?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function workspaceCoordinatorKey(cwd: string): string {
  const normalized = resolve(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "session";
}

function providerStatusProviderFromFactory(
  factory: DaemonProviderFactory
): (() => DaemonProviderStatusSnapshot) | undefined {
  const candidate = factory as DaemonProviderFactory & {
    getProviderStatusSnapshot?: () => DaemonProviderStatusSnapshot;
  };
  return typeof candidate.getProviderStatusSnapshot === "function"
    ? () => candidate.getProviderStatusSnapshot!()
    : undefined;
}

function unconfiguredProviderStatusSnapshot(): DaemonProviderStatusSnapshot {
  const updatedAt = new Date().toISOString();
  return {
    credentialMode: "auto",
    readiness: "missing",
    providerId: "unconfigured",
    routeId: "unconfigured",
    baseUrl: "",
    model: "",
    upstreamModel: "",
    endpoint: "auto",
    stream: true,
    systemPromptWireMode: "user-prefix",
    apiKey: {
      hasApiKey: false,
      source: "unset",
    },
    hasDirectApiKey: false,
    apiKeySource: "unset",
    gateway: {
      ready: false,
      credentialConfigured: false,
      routeDecision: ["provider_factory_missing"],
    },
    lastDiagnostic: {
      code: "provider_factory_missing",
      message: "Provider factory is not configured.",
      updatedAt,
    },
    updatedAt,
  };
}

function withMcpRunMetadata(metadata: JsonObject | undefined, mcp: JsonObject): JsonObject {
  return {
    ...(metadata ?? {}),
    mcp,
  };
}

function withScopedContextRunMetadata(
  metadata: JsonObject | undefined,
  scopedContext: JsonObject
): JsonObject {
  return {
    ...(metadata ?? {}),
    scopedContext: scopedContext as unknown as JsonValue,
  };
}

function mcpRunMetadata(startResult: McpLifecycleStartResult, snapshot: McpLifecycleSnapshot): JsonObject {
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

function aggregateMcpStatus(managers: McpLifecycleManager[]): DaemonMcpStatusSnapshot {
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

function mcpStatusFromDiagnostics(diagnostics: McpLifecycleDiagnostic[]): DaemonMcpStatusSnapshot {
  const updatedAt = diagnostics.map((diagnostic) => diagnostic.timestamp).sort().at(-1) ?? new Date().toISOString();
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

function idleMcpStatusSnapshot(serverCount: number): DaemonMcpStatusSnapshot {
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
    servers: [],
    updatedAt: new Date().toISOString(),
  };
}

function readinessFromMcpSnapshot(snapshot: McpLifecycleSnapshot): DaemonMcpStatusSnapshot["readiness"] {
  return readinessFromSummary(snapshot.summary);
}

function readinessFromSummary(summary: Record<string, number>): DaemonMcpStatusSnapshot["readiness"] {
  if ((summary.degraded ?? 0) > 0) return "degraded";
  if ((summary.starting ?? 0) > 0 || (summary.discovering ?? 0) > 0 || (summary.reconnecting ?? 0) > 0) {
    return "starting";
  }
  if ((summary.ready ?? 0) > 0) return "ready";
  if ((summary.stopped ?? 0) > 0) return "stopped";
  return "unknown";
}

function mcpLifecycleSnapshotToJson(snapshot: McpLifecycleSnapshot): JsonObject {
  return compactJsonObject({
    summary: snapshot.summary,
    diagnostics: snapshot.diagnostics.map(mcpDiagnosticToJson),
    servers: snapshot.servers.map(mcpServerSnapshotToJson),
  });
}

function mcpServerSnapshotToJson(server: McpLifecycleSnapshot["servers"][number]): JsonObject {
  return compactJsonObject({
    name: server.name,
    label: server.label,
    state: server.state,
    cachedToolCount: server.cachedToolCount,
    liveToolCount: server.liveToolCount,
    availableToolCount: server.availableToolCount,
    diagnosticCount: server.diagnosticCount,
    diagnostics: server.diagnostics.map(mcpDiagnosticToJson),
    diagnostic: server.diagnostic ? mcpDiagnosticToJson(server.diagnostic) : undefined,
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

function syntheticMcpDiagnostic(cause: unknown, server: string): McpLifecycleDiagnostic {
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
