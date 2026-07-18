import type { JsonObject, ToolConcurrency, ToolExecutionContext, ToolOutput } from "@crish/shared-types";
import type { AgentTool, ToolSource } from "./types";
import { errorMessage, RingBuffer } from "@crish/shared-utils";

export const DEFAULT_MCP_STARTUP_GATE_TIMEOUT_MS = 250;
/** waitForReady 默认超时（刷新工具 / 执行工具前等待 ready） */
export const DEFAULT_MCP_WAIT_FOR_READY_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_DIAGNOSTIC_LIMIT = 50;

export type McpServerLifecycleState = "discovering" | "starting" | "ready" | "degraded" | "reconnecting" | "stopped";

export type McpLifecycleDiagnosticSeverity = "warning" | "error";

export type McpLifecycleDiagnosticCode =
  | "MCP_CLOSE_FAILED"
  | "MCP_CONNECT_FAILED"
  | "MCP_LIST_TOOLS_FAILED"
  | "MCP_SERVER_UNAVAILABLE"
  | "MCP_STARTUP_GATE_TIMEOUT"
  | "MCP_TOOL_UNAVAILABLE";

export type McpLifecyclePhase = "close" | "connect" | "execute-tool" | "list-tools" | "reconnect" | "startup-gate" | "teardown";

export interface McpLifecycleDiagnostic {
  code: McpLifecycleDiagnosticCode;
  message: string;
  phase: McpLifecyclePhase;
  severity: McpLifecycleDiagnosticSeverity;
  retryable: boolean;
  timestamp: string;
  server?: string;
  state?: McpServerLifecycleState;
  toolName?: string;
  cause?: string;
}

export class McpLifecycleError extends Error {
  readonly code: McpLifecycleDiagnosticCode;
  readonly diagnostic: McpLifecycleDiagnostic;

  constructor(diagnostic: McpLifecycleDiagnostic) {
    super(diagnostic.message);
    this.name = "McpLifecycleError";
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
  }
}

export interface McpServerStartContext {
  serverName: string;
  signal: AbortSignal;
  attempt: number;
}

export interface McpServerListToolsContext {
  serverName: string;
  signal: AbortSignal;
  attempt: number;
}

export interface McpServerConnection {
  listTools(context: McpServerListToolsContext): Promise<AgentTool[]> | AgentTool[];
  close?(): Promise<void> | void;
}

export interface McpServerAdapter {
  connect(context: McpServerStartContext): Promise<McpServerConnection> | McpServerConnection;
}

export interface McpCachedToolDefinition {
  name: string;
  label?: string;
  description: string;
  inputSchema?: JsonObject;
  concurrency?: ToolConcurrency;
  readOnly?: boolean | ((input: JsonObject) => boolean);
  summarize?: string | ((input: JsonObject) => string);
}

export type McpCachedTool = AgentTool | McpCachedToolDefinition;

export interface McpServerDefinition {
  name: string;
  label?: string;
  adapter: McpServerAdapter;
  cachedTools?: McpCachedTool[];
}

export interface McpServerOperationResult {
  ok: boolean;
  server: string;
  state: McpServerLifecycleState;
  tools: AgentTool[];
  timestamp: string;
  diagnostic?: McpLifecycleDiagnostic;
}

export interface McpServerSnapshot {
  name: string;
  label: string;
  state: McpServerLifecycleState;
  cachedToolCount: number;
  liveToolCount: number;
  availableToolCount: number;
  diagnosticCount: number;
  diagnostics: McpLifecycleDiagnostic[];
  diagnostic?: McpLifecycleDiagnostic;
  startedAt?: string;
  updatedAt: string;
}

export type McpServerLifecycleEvent =
  | {
      type: "server-state";
      server: string;
      previousState: McpServerLifecycleState;
      state: McpServerLifecycleState;
      timestamp: string;
      diagnostic?: McpLifecycleDiagnostic;
    }
  | {
      type: "server-diagnostic";
      server: string;
      diagnostic: McpLifecycleDiagnostic;
      timestamp: string;
    }
  | {
      type: "tools-refreshed";
      server: string;
      toolCount: number;
      timestamp: string;
    };

export type McpLifecycleEvent =
  | McpServerLifecycleEvent
  | {
      type: "lifecycle-diagnostic";
      diagnostic: McpLifecycleDiagnostic;
      timestamp: string;
    }
  | {
      type: "startup-gate-timeout";
      timeoutMs: number;
      pendingServers: string[];
      diagnostic: McpLifecycleDiagnostic;
      timestamp: string;
    }
  | {
      type: "startup-gate-settled";
      result: McpLifecycleStartResult;
      timestamp: string;
    };

export interface McpLifecycleStartResult {
  readyServers: string[];
  degradedServers: Array<{ server: string; diagnostic: McpLifecycleDiagnostic }>;
  pendingServers: string[];
  stoppedServers: string[];
  timedOut: boolean;
  tools: AgentTool[];
  diagnostics: McpLifecycleDiagnostic[];
}

export interface McpLifecycleRefreshResult {
  refreshedServers: string[];
  degradedServers: Array<{ server: string; diagnostic: McpLifecycleDiagnostic }>;
  diagnostics: McpLifecycleDiagnostic[];
}

export interface McpLifecycleReconnectResult {
  reconnectedServers: string[];
  degradedServers: Array<{ server: string; diagnostic: McpLifecycleDiagnostic }>;
  diagnostics: McpLifecycleDiagnostic[];
}

export interface McpLifecycleTeardownResult {
  stoppedServers: string[];
  diagnostics: McpLifecycleDiagnostic[];
}

export interface McpLifecycleSnapshot {
  servers: McpServerSnapshot[];
  summary: Record<McpServerLifecycleState, number>;
  diagnostics: McpLifecycleDiagnostic[];
}

export type McpLifecycleListener = (event: McpLifecycleEvent) => void;
export type McpServerLifecycleListener = (event: McpServerLifecycleEvent) => void;

export interface McpLifecycleManagerOptions {
  id?: string;
  label?: string;
  servers?: McpServerDefinition[];
  startupGateTimeoutMs?: number;
  diagnosticLimit?: number;
}

export class McpServerController {
  readonly name: string;
  readonly label: string;

  private readonly adapter: McpServerAdapter;
  private readonly cachedTools: McpCachedTool[];
  private readonly listeners = new Set<McpServerLifecycleListener>();
  private readonly diagnosticLimit: number;
  private stateValue: McpServerLifecycleState = "discovering";
  private connection: McpServerConnection | undefined;
  private liveTools: AgentTool[] | undefined;
  private startupPromise: Promise<McpServerOperationResult> | undefined;
  private reconnectPromise: Promise<McpServerOperationResult> | undefined;
  private refreshPromise: Promise<McpServerOperationResult> | undefined;
  private abortController: AbortController | undefined;
  private generation = 0;
  private attempt = 0;
  private startedAtMs: number | undefined;
  private updatedAtMs = Date.now();
  private lastDiagnostic: McpLifecycleDiagnostic | undefined;
  private diagnostics: RingBuffer<McpLifecycleDiagnostic>;

  constructor(definition: McpServerDefinition, options: { diagnosticLimit?: number } = {}) {
    this.name = definition.name;
    this.label = definition.label ?? definition.name;
    this.adapter = definition.adapter;
    this.cachedTools = [...(definition.cachedTools ?? [])];
    this.diagnosticLimit = normalizeDiagnosticLimit(options.diagnosticLimit);
    this.diagnostics = new RingBuffer<McpLifecycleDiagnostic>(this.diagnosticLimit);
  }

  get state(): McpServerLifecycleState {
    return this.stateValue;
  }

  get diagnostic(): McpLifecycleDiagnostic | undefined {
    return this.lastDiagnostic;
  }

  start(): Promise<McpServerOperationResult> {
    if (this.stateValue === "stopped") return Promise.resolve(this.operationResult(false));
    if (this.stateValue === "ready") return Promise.resolve(this.operationResult(true));
    if (this.stateValue === "degraded" || this.stateValue === "reconnecting") return this.reconnect();
    if (this.startupPromise) return this.startupPromise;

    this.abortController?.abort();
    const abortController = new AbortController();
    const generation = ++this.generation;
    this.abortController = abortController;
    const startupPromise = this.openConnection(generation, abortController.signal, "starting");
    this.startupPromise = startupPromise.finally(() => {
      if (this.startupPromise === startupPromise) this.startupPromise = undefined;
    });
    return this.startupPromise;
  }

  reconnect(): Promise<McpServerOperationResult> {
    if (this.stateValue === "stopped") return Promise.resolve(this.operationResult(false));
    if (this.stateValue === "ready" && !this.connection) return this.start();
    if (this.reconnectPromise) return this.reconnectPromise;

    this.abortController?.abort();
    const previousConnection = this.connection;
    this.connection = undefined;
    const abortController = new AbortController();
    const generation = ++this.generation;
    this.abortController = abortController;
    const reconnectPromise = this.reopenConnection(generation, abortController.signal, previousConnection);
    this.reconnectPromise = reconnectPromise.finally(() => {
      if (this.reconnectPromise === reconnectPromise) this.reconnectPromise = undefined;
    });
    return this.reconnectPromise;
  }

  async waitForReady(timeoutMs?: number): Promise<boolean> {
    if (this.stateValue === "ready") return true;
    if (this.stateValue === "stopped") return false;

    const operation = this.readyOperation();
    if (timeoutMs === undefined) {
      await operation;
    } else {
      // 用本地 AbortController 取消 delay 定时器：当 operation 先完成时
      // （正常路径 / teardown abort），delay 的 setTimeout 立即被清理，
      // 不再空等剩余 timeoutMs 拖住 Node 事件循环。
      const cancelDelay = new AbortController();
      operation.finally(() => cancelDelay.abort());
      await Promise.race([operation, delay(Math.max(1, timeoutMs), cancelDelay.signal)]);
    }
    return this.state === "ready";
  }

  listTools(): AgentTool[] {
    if (this.stateValue === "stopped") return [];
    return this.visibleToolMetadata().map((tool) =>
      createManagedMcpTool(this.name, tool, (input, context) => this.executeManagedTool(toolNameOf(tool), input, context))
    );
  }

  refreshTools(): Promise<McpServerOperationResult> {
    if (this.stateValue === "stopped") return Promise.resolve(this.operationResult(false));
    if (this.refreshPromise) return this.refreshPromise;

    const refreshPromise = this.runRefresh();
    this.refreshPromise = refreshPromise.finally(() => {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  refreshToolsInBackground(): void {
    void this.refreshTools();
  }

  async teardown(): Promise<McpServerOperationResult> {
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.startupPromise = undefined;
    this.reconnectPromise = undefined;
    this.refreshPromise = undefined;

    const connection = this.connection;
    this.connection = undefined;
    this.liveTools = undefined;
    this.transition("stopped");
    const diagnostic = await this.closeConnectionWithDiagnostics(connection, "teardown");
    return this.operationResult(!diagnostic, diagnostic);
  }

  snapshot(): McpServerSnapshot {
    const liveToolCount = this.liveTools?.length ?? 0;
    const cachedToolCount = this.cachedTools.length;
    const availableToolCount = this.stateValue === "stopped" ? 0 : this.visibleToolMetadata().length;
    return {
      name: this.name,
      label: this.label,
      state: this.stateValue,
      cachedToolCount,
      liveToolCount,
      availableToolCount,
      diagnosticCount: this.diagnostics.size,
      diagnostics: this.diagnostics.toArray(),
      ...(this.lastDiagnostic ? { diagnostic: this.lastDiagnostic } : {}),
      ...(this.startedAtMs ? { startedAt: new Date(this.startedAtMs).toISOString() } : {}),
      updatedAt: new Date(this.updatedAtMs).toISOString()
    };
  }

  subscribe(listener: McpServerLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readyOperation(): Promise<McpServerOperationResult> {
    if (this.stateValue === "discovering" || this.stateValue === "starting") return this.start();
    if (this.stateValue === "degraded" || this.stateValue === "reconnecting") return this.reconnect();
    return Promise.resolve(this.operationResult(this.stateValue === "ready"));
  }

  private async reopenConnection(
    generation: number,
    signal: AbortSignal,
    previousConnection: McpServerConnection | undefined
  ): Promise<McpServerOperationResult> {
    this.transition("reconnecting");
    await this.closeConnectionWithDiagnostics(previousConnection, "close");
    return this.openConnection(generation, signal, "reconnecting");
  }

  private async openConnection(
    generation: number,
    signal: AbortSignal,
    openingState: "starting" | "reconnecting"
  ): Promise<McpServerOperationResult> {
    this.startedAtMs ??= Date.now();
    this.transition(openingState);

    let connection: McpServerConnection;
    const attempt = ++this.attempt;
    try {
      connection = await this.adapter.connect({ serverName: this.name, signal, attempt });
    } catch (cause) {
      if (!this.isActive(generation)) return this.operationResult(false);
      const diagnostic = this.createDiagnostic("MCP_CONNECT_FAILED", openingState === "reconnecting" ? "reconnect" : "connect", cause, true);
      this.degrade(diagnostic);
      return this.operationResult(false, diagnostic);
    }

    if (!this.isActive(generation)) {
      const diagnostic = await this.closeConnectionWithDiagnostics(connection, "close");
      return this.operationResult(false, diagnostic);
    }

    this.connection = connection;
    try {
      await this.refreshFromConnection(connection, signal, generation);
      if (!this.isActive(generation)) return this.operationResult(false);
      this.transition("ready");
      return this.operationResult(true);
    } catch (cause) {
      if (!this.isActive(generation)) return this.operationResult(false);
      this.connection = undefined;
      await this.closeConnectionWithDiagnostics(connection, "close");
      const diagnostic = this.createDiagnostic("MCP_LIST_TOOLS_FAILED", "list-tools", cause, true);
      this.degrade(diagnostic);
      return this.operationResult(false, diagnostic);
    }
  }

  private async runRefresh(): Promise<McpServerOperationResult> {
    // 带超时等待 ready，避免 refresh 无限挂起
    const ready = await this.waitForReady(DEFAULT_MCP_WAIT_FOR_READY_TIMEOUT_MS);
    if (!ready || !this.connection) {
      const diagnostic = this.createDiagnostic(
        "MCP_SERVER_UNAVAILABLE",
        "list-tools",
        `cannot refresh tools because server ${this.name} is ${this.stateValue}`,
        this.stateValue !== "stopped"
      );
      if (this.stateValue !== "stopped") this.degrade(diagnostic);
      return this.operationResult(false, diagnostic);
    }

    const connection = this.connection;
    const generation = this.generation;
    const signal = this.abortController?.signal ?? new AbortController().signal;
    try {
      await this.refreshFromConnection(connection, signal, generation);
      if (!this.isActive(generation)) return this.operationResult(false);
      this.transition("ready");
      return this.operationResult(true);
    } catch (cause) {
      if (!this.isActive(generation)) return this.operationResult(false);
      this.connection = undefined;
      await this.closeConnectionWithDiagnostics(connection, "close");
      const diagnostic = this.createDiagnostic("MCP_LIST_TOOLS_FAILED", "list-tools", cause, true);
      this.degrade(diagnostic);
      return this.operationResult(false, diagnostic);
    }
  }

  private async refreshFromConnection(connection: McpServerConnection, signal: AbortSignal, generation: number): Promise<void> {
    const tools = await connection.listTools({ serverName: this.name, signal, attempt: this.attempt });
    if (!this.isActive(generation)) return;
    this.liveTools = [...tools];
    this.updatedAtMs = Date.now();
    this.emit({ type: "tools-refreshed", server: this.name, toolCount: this.liveTools.length, timestamp: nowIso() });
  }

  private async executeManagedTool(toolName: string, input: JsonObject, context: ToolExecutionContext): Promise<ToolOutput> {
    // 带超时等待 ready，避免工具执行前无限挂起
    const ready = await this.waitForReady(DEFAULT_MCP_WAIT_FOR_READY_TIMEOUT_MS);
    if (!ready) {
      const diagnostic = this.createDiagnostic(
        "MCP_SERVER_UNAVAILABLE",
        "execute-tool",
        `MCP server ${this.name} is ${this.stateValue}; tool ${toolName} is unavailable`,
        this.stateValue !== "stopped",
        toolName
      );
      this.recordDiagnostic(diagnostic);
      throw new McpLifecycleError(diagnostic);
    }

    const tool = this.liveTools?.find((candidate) => candidate.name === toolName);
    if (!tool) {
      const diagnostic = this.createDiagnostic(
        "MCP_TOOL_UNAVAILABLE",
        "execute-tool",
        `MCP tool ${this.name}/${toolName} is not available after startup`,
        true,
        toolName
      );
      this.recordDiagnostic(diagnostic);
      throw new McpLifecycleError(diagnostic);
    }
    return tool.execute(input, context);
  }

  private visibleToolMetadata(): McpCachedTool[] {
    if (this.stateValue === "stopped") return [];
    if (this.liveTools !== undefined && (this.stateValue === "ready" || this.stateValue === "degraded" || this.stateValue === "reconnecting")) {
      return this.liveTools;
    }
    return this.cachedTools;
  }

  private operationResult(ok: boolean, diagnostic?: McpLifecycleDiagnostic): McpServerOperationResult {
    return {
      ok,
      server: this.name,
      state: this.stateValue,
      tools: this.listTools(),
      timestamp: nowIso(),
      ...(diagnostic ? { diagnostic } : {})
    };
  }

  private degrade(diagnostic: McpLifecycleDiagnostic): void {
    this.recordDiagnostic(diagnostic);
    this.transition("degraded", diagnostic);
  }

  private createDiagnostic(
    code: McpLifecycleDiagnosticCode,
    phase: McpLifecyclePhase,
    cause: unknown,
    retryable: boolean,
    toolName?: string
  ): McpLifecycleDiagnostic {
    const message = errorMessage(cause);
    return {
      code,
      message,
      phase,
      retryable,
      severity: "error",
      timestamp: nowIso(),
      server: this.name,
      state: this.stateValue,
      ...(toolName ? { toolName } : {}),
      cause: message
    };
  }

  private recordDiagnostic(diagnostic: McpLifecycleDiagnostic): void {
    this.lastDiagnostic = diagnostic;
    this.diagnostics.pushOverwritingOldest(diagnostic);
    this.emit({ type: "server-diagnostic", server: this.name, diagnostic, timestamp: nowIso() });
  }

  private async closeConnectionWithDiagnostics(
    connection: McpServerConnection | undefined,
    phase: "close" | "teardown"
  ): Promise<McpLifecycleDiagnostic | undefined> {
    try {
      await closeConnection(connection);
      return undefined;
    } catch (cause) {
      const diagnostic = this.createDiagnostic("MCP_CLOSE_FAILED", phase, cause, false);
      this.recordDiagnostic(diagnostic);
      return diagnostic;
    }
  }

  private isActive(generation: number): boolean {
    return generation === this.generation && this.stateValue !== "stopped";
  }

  private transition(state: McpServerLifecycleState, diagnostic?: McpLifecycleDiagnostic): void {
    const previousState = this.stateValue;
    this.stateValue = state;
    this.updatedAtMs = Date.now();
    if (previousState === state) return;
    this.emit({
      type: "server-state",
      server: this.name,
      previousState,
      state,
      ...(diagnostic ? { diagnostic } : {}),
      timestamp: nowIso()
    });
  }

  private emit(event: McpServerLifecycleEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export class McpLifecycleManager implements ToolSource {
  readonly id: string;
  readonly label: string;

  private readonly controllers = new Map<string, McpServerController>();
  private readonly controllerUnsubscribers = new Map<string, () => void>();
  private readonly listeners = new Set<McpLifecycleListener>();
  private readonly gateTimeoutMs: number;
  private readonly diagnosticLimit: number;
  private readonly diagnostics: RingBuffer<McpLifecycleDiagnostic>;
  private startPromise: Promise<McpLifecycleStartResult> | undefined;
  private hasStarted = false;

  constructor(options: McpLifecycleManagerOptions = {}) {
    this.id = options.id ?? "mcp-lifecycle";
    this.label = options.label ?? "MCP lifecycle";
    this.gateTimeoutMs = Math.max(1, options.startupGateTimeoutMs ?? DEFAULT_MCP_STARTUP_GATE_TIMEOUT_MS);
    this.diagnosticLimit = normalizeDiagnosticLimit(options.diagnosticLimit);
    this.diagnostics = new RingBuffer<McpLifecycleDiagnostic>(this.diagnosticLimit);
    for (const server of options.servers ?? []) {
      this.addServer(server);
    }
  }

  get startupGateTimeoutMs(): number {
    return this.gateTimeoutMs;
  }

  addServer(definition: McpServerDefinition): McpServerController {
    if (this.controllers.has(definition.name)) {
      throw new Error(`Duplicate MCP server registered: ${definition.name}`);
    }

    const controller = new McpServerController(definition, { diagnosticLimit: this.diagnosticLimit });
    this.controllers.set(definition.name, controller);
    this.controllerUnsubscribers.set(
      definition.name,
      controller.subscribe((event) => this.emit(event))
    );
    if (this.hasStarted) {
      void controller.start();
    }
    return controller;
  }

  getServer(name: string): McpServerController | undefined {
    return this.controllers.get(name);
  }

  async start(): Promise<McpLifecycleStartResult> {
    if (this.startPromise) return this.startPromise;
    this.hasStarted = true;
    this.startPromise = this.startWithGate();
    return this.startPromise;
  }

  async listTools(): Promise<AgentTool[]> {
    await this.start();
    return this.availableTools();
  }

  async refreshAllTools(): Promise<McpLifecycleRefreshResult> {
    await this.start();
    const entries = [...this.controllers.entries()];
    const results = await Promise.all(entries.map(async ([server, controller]) => ({ server, result: await controller.refreshTools() })));
    const refreshedServers: string[] = [];
    const degradedServers: Array<{ server: string; diagnostic: McpLifecycleDiagnostic }> = [];
    const diagnostics: McpLifecycleDiagnostic[] = [];

    for (const { server, result } of results) {
      if (result.ok && result.state === "ready") {
        refreshedServers.push(server);
      } else {
        const diagnostic = result.diagnostic ?? this.serverUnavailableDiagnostic(server, "list-tools", result.state);
        degradedServers.push({ server, diagnostic });
        diagnostics.push(diagnostic);
      }
    }

    return { refreshedServers, degradedServers, diagnostics };
  }

  refreshAllToolsInBackground(): void {
    for (const controller of this.controllers.values()) {
      controller.refreshToolsInBackground();
    }
  }

  async reconnectServer(name: string): Promise<McpServerOperationResult> {
    const controller = this.controllers.get(name);
    if (!controller) {
      const diagnostic = this.serverUnavailableDiagnostic(name, "reconnect", "stopped");
      this.recordDiagnostic(diagnostic);
      return {
        ok: false,
        server: name,
        state: "stopped",
        tools: [],
        timestamp: nowIso(),
        diagnostic
      };
    }
    return controller.reconnect();
  }

  async reconnectDegradedServers(): Promise<McpLifecycleReconnectResult> {
    const entries = [...this.controllers.entries()].filter(([, controller]) => controller.state === "degraded");
    const results = await Promise.all(entries.map(async ([server, controller]) => ({ server, result: await controller.reconnect() })));
    const reconnectedServers: string[] = [];
    const degradedServers: Array<{ server: string; diagnostic: McpLifecycleDiagnostic }> = [];
    const diagnostics: McpLifecycleDiagnostic[] = [];

    for (const { server, result } of results) {
      if (result.ok && result.state === "ready") {
        reconnectedServers.push(server);
      } else {
        const diagnostic = result.diagnostic ?? this.serverUnavailableDiagnostic(server, "reconnect", result.state);
        degradedServers.push({ server, diagnostic });
        diagnostics.push(diagnostic);
      }
    }

    return { reconnectedServers, degradedServers, diagnostics };
  }

  snapshot(): McpLifecycleSnapshot {
    const servers = [...this.controllers.values()].map((controller) => controller.snapshot());
    const summary: Record<McpServerLifecycleState, number> = {
      discovering: 0,
      starting: 0,
      ready: 0,
      degraded: 0,
      reconnecting: 0,
      stopped: 0
    };
    for (const server of servers) {
      summary[server.state] += 1;
    }
    return { servers, summary, diagnostics: this.allDiagnostics(servers) };
  }

  subscribe(listener: McpLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async teardown(): Promise<McpLifecycleTeardownResult> {
    const controllers = [...this.controllers.values()];
    const results = await Promise.all(controllers.map((controller) => controller.teardown()));
    this.startPromise = undefined;
    this.hasStarted = false;

    const stoppedServers = results.map((result) => result.server);
    const diagnostics = results.flatMap((result) => (result.diagnostic ? [result.diagnostic] : []));
    return { stoppedServers, diagnostics };
  }

  async dispose(): Promise<void> {
    await this.teardown();
    for (const unsubscribe of this.controllerUnsubscribers.values()) {
      unsubscribe();
    }
    this.controllerUnsubscribers.clear();
    this.listeners.clear();
  }

  private async startWithGate(): Promise<McpLifecycleStartResult> {
    const startupTasks = [...this.controllers.values()].map((controller) => controller.start());
    let timedOut = false;

    // 用本地 AbortController 取消 gate 定时器：当所有 startup tasks 先完成时
    // （正常路径），delay 的 setTimeout 立即被清理，不再空等剩余 gateTimeoutMs。
    // teardown 时各 controller 的 abortController 会 abort，startup tasks 随即 resolve，
    // 同样触发 allStarted.finally → cancelDelay.abort()，保证 delay 不会拖住事件循环。
    const cancelDelay = new AbortController();
    const allStarted = Promise.all(startupTasks);
    allStarted.finally(() => cancelDelay.abort());

    await Promise.race([
      allStarted,
      delay(this.gateTimeoutMs, cancelDelay.signal).then(() => {
        timedOut = startupTasks.length > 0 && this.pendingServers().length > 0;
      })
    ]);

    if (timedOut) {
      const pendingServers = this.pendingServers();
      const diagnostic = createLifecycleDiagnostic({
        code: "MCP_STARTUP_GATE_TIMEOUT",
        phase: "startup-gate",
        message: `MCP startup gate timed out after ${this.gateTimeoutMs}ms with ${pendingServers.length} server(s) still pending`,
        retryable: true,
        severity: "warning"
      });
      this.recordDiagnostic(diagnostic);
      this.emit({
        type: "startup-gate-timeout",
        timeoutMs: this.gateTimeoutMs,
        pendingServers,
        diagnostic,
        timestamp: nowIso()
      });
    }

    const result = this.startResult(timedOut);
    this.emit({ type: "startup-gate-settled", result, timestamp: nowIso() });
    return result;
  }

  private startResult(timedOut: boolean): McpLifecycleStartResult {
    const readyServers: string[] = [];
    const degradedServers: Array<{ server: string; diagnostic: McpLifecycleDiagnostic }> = [];
    const pendingServers: string[] = [];
    const stoppedServers: string[] = [];

    for (const controller of this.controllers.values()) {
      if (controller.state === "ready") readyServers.push(controller.name);
      if (controller.state === "degraded") {
        degradedServers.push({
          server: controller.name,
          diagnostic: controller.diagnostic ?? this.serverUnavailableDiagnostic(controller.name, "connect", controller.state)
        });
      }
      if (controller.state === "starting" || controller.state === "discovering" || controller.state === "reconnecting") {
        pendingServers.push(controller.name);
      }
      if (controller.state === "stopped") stoppedServers.push(controller.name);
    }

    return {
      readyServers,
      degradedServers,
      pendingServers,
      stoppedServers,
      timedOut,
      tools: this.availableTools(),
      diagnostics: this.snapshot().diagnostics
    };
  }

  private pendingServers(): string[] {
    return [...this.controllers.values()]
      .filter((controller) => controller.state === "starting" || controller.state === "discovering" || controller.state === "reconnecting")
      .map((controller) => controller.name);
  }

  private availableTools(): AgentTool[] {
    return [...this.controllers.values()]
      .flatMap((controller) => controller.listTools())
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private serverUnavailableDiagnostic(server: string, phase: McpLifecyclePhase, state: McpServerLifecycleState): McpLifecycleDiagnostic {
    return createLifecycleDiagnostic({
      code: "MCP_SERVER_UNAVAILABLE",
      phase,
      message: `MCP server ${server} is ${state}`,
      retryable: state !== "stopped",
      severity: "error",
      server,
      state
    });
  }

  private recordDiagnostic(diagnostic: McpLifecycleDiagnostic): void {
    this.diagnostics.pushOverwritingOldest(diagnostic);
    this.emit({ type: "lifecycle-diagnostic", diagnostic, timestamp: nowIso() });
  }

  private allDiagnostics(servers: McpServerSnapshot[]): McpLifecycleDiagnostic[] {
    return [...this.diagnostics.toArray(), ...servers.flatMap((server) => server.diagnostics)].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp)
    );
  }

  private emit(event: McpLifecycleEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function createManagedMcpTool(
  serverName: string,
  tool: McpCachedTool,
  execute: (input: JsonObject, context: ToolExecutionContext) => Promise<ToolOutput>
): AgentTool {
  const name = toolNameOf(tool);
  const label = typeof tool.label === "string" ? tool.label : name;
  const concurrency = "concurrency" in tool && tool.concurrency ? tool.concurrency : "parallel";
  return {
    name,
    label,
    description: tool.description,
    category: "mcp",
    inputSchema: tool.inputSchema,
    concurrency,
    isReadOnly(input) {
      if (isAgentTool(tool)) return tool.isReadOnly(input);
      if (typeof tool.readOnly === "function") return tool.readOnly(input);
      return tool.readOnly ?? false;
    },
    summarize(input) {
      if (isAgentTool(tool)) return tool.summarize(input);
      if (typeof tool.summarize === "function") return tool.summarize(input);
      if (typeof tool.summarize === "string") return tool.summarize;
      return `${serverName}/${name}`;
    },
    execute
  };
}

function toolNameOf(tool: McpCachedTool): string {
  return tool.name;
}

function isAgentTool(tool: McpCachedTool): tool is AgentTool {
  return typeof (tool as AgentTool).execute === "function";
}

async function closeConnection(connection: McpServerConnection | undefined): Promise<void> {
  if (!connection?.close) return;
  await connection.close();
}

function createLifecycleDiagnostic(input: {
  code: McpLifecycleDiagnosticCode;
  message: string;
  phase: McpLifecyclePhase;
  retryable: boolean;
  severity: McpLifecycleDiagnosticSeverity;
  server?: string;
  state?: McpServerLifecycleState;
  toolName?: string;
  cause?: string;
}): McpLifecycleDiagnostic {
  return {
    code: input.code,
    message: input.message,
    phase: input.phase,
    retryable: input.retryable,
    severity: input.severity,
    timestamp: nowIso(),
    ...(input.server ? { server: input.server } : {}),
    ...(input.state ? { state: input.state } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.cause ? { cause: input.cause } : {})
  };
}


function normalizeDiagnosticLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_MCP_DIAGNOSTIC_LIMIT;
  return Math.max(1, Math.floor(limit));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function nowIso(): string {
  return new Date().toISOString();
}
