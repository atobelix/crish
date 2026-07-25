import type { JsonObject, ToolExecutionContext, ToolOutput } from '@crish/shared-types';
import type { AgentTool } from '../types';
import { errorMessage, RingBuffer } from '@crish/shared-utils';
import type {
  McpCachedTool,
  McpLifecycleDiagnostic,
  McpLifecycleDiagnosticCode,
  McpLifecyclePhase,
  McpServerAdapter,
  McpServerConnection,
  McpServerDefinition,
  McpServerLifecycleEvent,
  McpServerLifecycleState,
  McpServerOperationResult,
  McpServerSnapshot,
  McpServerLifecycleListener,
} from './types';
import {
  DEFAULT_MCP_WAIT_FOR_READY_TIMEOUT_MS,
  McpLifecycleError,
} from './types';
import {
  closeConnection,
  createManagedMcpTool,
  normalizeDiagnosticLimit,
  nowIso,
  delay,
  toolNameOf,
} from './utils';

export class McpServerController {
  readonly name: string;
  readonly label: string;

  private readonly adapter: McpServerAdapter;
  private readonly cachedTools: McpCachedTool[];
  private readonly listeners = new Set<McpServerLifecycleListener>();
  private readonly diagnosticLimit: number;
  private stateValue: McpServerLifecycleState = 'discovering';
  private connection: McpServerConnection | undefined;
  private liveTools: AgentTool[] | undefined;
  private startupPromise: Promise<McpServerOperationResult> | undefined;
  private reconnectPromise: Promise<McpServerOperationResult> | undefined;
  private refreshPromise: Promise<McpServerOperationResult> | undefined;
  private consecutiveFailures = 0;
  private readonly maxConsecutiveFailures = 3;
  private abortController: AbortController | undefined;
  private generation = 0;
  private attempt = 0;
  private startedAtMs: number | undefined;
  private updatedAtMs = Date.now();
  private lastDiagnostic: McpLifecycleDiagnostic | undefined;
  private diagnostics: RingBuffer<McpLifecycleDiagnostic>;

  constructor(
    definition: McpServerDefinition,
    options: { diagnosticLimit?: number } = {}
  ) {
    this.name = definition.name;
    this.label = definition.label ?? definition.name;
    this.adapter = definition.adapter;
    this.cachedTools = [...(definition.cachedTools ?? [])];
    this.diagnosticLimit = normalizeDiagnosticLimit(options.diagnosticLimit);
    this.diagnostics = new RingBuffer<McpLifecycleDiagnostic>(
      this.diagnosticLimit
    );
  }

  get state(): McpServerLifecycleState {
    return this.stateValue;
  }

  get diagnostic(): McpLifecycleDiagnostic | undefined {
    return this.lastDiagnostic;
  }

  start(
    options: { restartIfStopped?: boolean } = {}
  ): Promise<McpServerOperationResult> {
    if (this.stateValue === 'stopped' && !options.restartIfStopped) {
      return Promise.resolve(this.operationResult(false));
    }
    if (this.stateValue === 'ready')
      return Promise.resolve(this.operationResult(true));
    if (this.stateValue === 'degraded' || this.stateValue === 'reconnecting')
      return this.reconnect();
    if (this.startupPromise) return this.startupPromise;

    this.abortController?.abort();
    const abortController = new AbortController();
    const generation = ++this.generation;
    this.abortController = abortController;
    const startupPromise = this.openConnection(
      generation,
      abortController.signal,
      'starting'
    );
    this.startupPromise = startupPromise.finally(() => {
      if (this.startupPromise === startupPromise)
        this.startupPromise = undefined;
    });
    return this.startupPromise;
  }

  reconnect(): Promise<McpServerOperationResult> {
    if (this.stateValue === 'stopped')
      return this.start({ restartIfStopped: true });
    if (this.stateValue === 'ready' && !this.connection) return this.start();
    if (this.reconnectPromise) return this.reconnectPromise;

    this.abortController?.abort();
    const previousConnection = this.connection;
    this.connection = undefined;
    const abortController = new AbortController();
    const generation = ++this.generation;
    this.abortController = abortController;
    const reconnectPromise = this.reopenConnection(
      generation,
      abortController.signal,
      previousConnection
    );
    this.reconnectPromise = reconnectPromise.finally(() => {
      if (this.reconnectPromise === reconnectPromise)
        this.reconnectPromise = undefined;
    });
    return this.reconnectPromise;
  }

  async waitForReady(timeoutMs?: number, parentSignal?: AbortSignal): Promise<boolean> {
    if (this.stateValue === 'ready') return true;
    if (this.stateValue === 'stopped') return false;

    const operation = this.readyOperation();
    if (timeoutMs === undefined) {
      await operation;
    } else {
      const cancelDelay = new AbortController();
      const onParentAbort = () => cancelDelay.abort(parentSignal?.reason);
      parentSignal?.addEventListener("abort", onParentAbort, { once: true });
      operation.finally(() => {
        cancelDelay.abort();
        parentSignal?.removeEventListener("abort", onParentAbort);
      });
      await Promise.race([
        operation,
        delay(Math.max(1, timeoutMs), cancelDelay.signal),
      ]);
    }
    return this.state === 'ready';
  }

  listTools(): AgentTool[] {
    if (this.stateValue === 'stopped') return [];
    return this.visibleToolMetadata().map((tool) =>
      createManagedMcpTool(this.name, tool, (input, context) =>
        this.executeManagedTool(toolNameOf(tool), input, context)
      )
    );
  }

  refreshTools(): Promise<McpServerOperationResult> {
    if (this.stateValue === 'stopped')
      return Promise.resolve(this.operationResult(false));
    if (this.refreshPromise) return this.refreshPromise;

    const refreshPromise = this.runRefresh();
    this.refreshPromise = refreshPromise.finally(() => {
      if (this.refreshPromise === refreshPromise)
        this.refreshPromise = undefined;
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
    this.transition('stopped');
    const diagnostic = await this.closeConnectionWithDiagnostics(
      connection,
      'teardown'
    );
    return this.operationResult(!diagnostic, diagnostic);
  }

  snapshot(): McpServerSnapshot {
    const liveToolCount = this.liveTools?.length ?? 0;
    const cachedToolCount = this.cachedTools.length;
    const availableToolCount =
      this.stateValue === 'stopped' ? 0 : this.visibleToolMetadata().length;
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
      ...(this.startedAtMs
        ? { startedAt: new Date(this.startedAtMs).toISOString() }
        : {}),
      updatedAt: new Date(this.updatedAtMs).toISOString(),
    };
  }

  subscribe(listener: McpServerLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readyOperation(): Promise<McpServerOperationResult> {
    if (this.stateValue === 'discovering' || this.stateValue === 'starting')
      return this.start();
    if (this.stateValue === 'degraded' || this.stateValue === 'reconnecting')
      return this.reconnect();
    return Promise.resolve(this.operationResult(this.stateValue === 'ready'));
  }

  private async reopenConnection(
    generation: number,
    signal: AbortSignal,
    previousConnection: McpServerConnection | undefined
  ): Promise<McpServerOperationResult> {
    this.transition('reconnecting');
    await this.closeConnectionWithDiagnostics(previousConnection, 'close');
    return this.openConnection(generation, signal, 'reconnecting');
  }

  private async openConnection(
    generation: number,
    signal: AbortSignal,
    openingState: 'starting' | 'reconnecting'
  ): Promise<McpServerOperationResult> {
    this.startedAtMs ??= Date.now();
    this.transition(openingState);

    let connection: McpServerConnection;
    const attempt = ++this.attempt;
    try {
      connection = await this.adapter.connect({
        serverName: this.name,
        signal,
        attempt,
      });
    } catch (cause) {
      if (!this.isActive(generation)) return this.operationResult(false);
      const diagnostic = this.createDiagnostic(
        'MCP_CONNECT_FAILED',
        openingState === 'reconnecting' ? 'reconnect' : 'connect',
        cause,
        true
      );
      this.degrade(diagnostic);
      return this.operationResult(false, diagnostic);
    }

    if (!this.isActive(generation)) {
      const diagnostic = await this.closeConnectionWithDiagnostics(
        connection,
        'close'
      );
      return this.operationResult(false, diagnostic);
    }

    this.connection = connection;
    try {
      await this.refreshFromConnection(connection, signal, generation);
      if (!this.isActive(generation)) return this.operationResult(false);
      this.transition('ready');
      return this.operationResult(true);
    } catch (cause) {
      if (!this.isActive(generation)) return this.operationResult(false);
      this.connection = undefined;
      await this.closeConnectionWithDiagnostics(connection, 'close');
      const diagnostic = this.createDiagnostic(
        'MCP_LIST_TOOLS_FAILED',
        'list-tools',
        cause,
        true
      );
      this.degrade(diagnostic);
      return this.operationResult(false, diagnostic);
    }
  }

  private async runRefresh(): Promise<McpServerOperationResult> {
    const ready = await this.waitForReady(
      DEFAULT_MCP_WAIT_FOR_READY_TIMEOUT_MS
    );
    if (!ready || !this.connection) {
      const diagnostic = this.createDiagnostic(
        'MCP_SERVER_UNAVAILABLE',
        'list-tools',
        `cannot refresh tools because server ${this.name} is ${this.stateValue}`,
        this.stateValue !== 'stopped'
      );
      if (this.stateValue !== 'stopped') this.degrade(diagnostic);
      return this.operationResult(false, diagnostic);
    }

    const connection = this.connection;
    const generation = this.generation;
    const signal = this.abortController?.signal ?? new AbortController().signal;
    try {
      await this.refreshFromConnection(connection, signal, generation);
      if (!this.isActive(generation)) return this.operationResult(false);
      this.transition('ready');
      return this.operationResult(true);
    } catch (cause) {
      if (!this.isActive(generation)) return this.operationResult(false);
      this.connection = undefined;
      await this.closeConnectionWithDiagnostics(connection, 'close');
      const diagnostic = this.createDiagnostic(
        'MCP_LIST_TOOLS_FAILED',
        'list-tools',
        cause,
        true
      );
      this.degrade(diagnostic);
      return this.operationResult(false, diagnostic);
    }
  }

  private async refreshFromConnection(
    connection: McpServerConnection,
    signal: AbortSignal,
    generation: number
  ): Promise<void> {
    const tools = await connection.listTools({
      serverName: this.name,
      signal,
      attempt: this.attempt,
    });
    if (!this.isActive(generation)) return;
    this.liveTools = [...tools];
    this.updatedAtMs = Date.now();
    this.emit({
      type: 'tools-refreshed',
      server: this.name,
      toolCount: this.liveTools.length,
      timestamp: nowIso(),
    });
  }

  private async executeManagedTool(
    toolName: string,
    input: JsonObject,
    context: ToolExecutionContext
  ): Promise<ToolOutput> {
    const ready = await this.waitForReady(
      DEFAULT_MCP_WAIT_FOR_READY_TIMEOUT_MS,
      context.signal
    );
    if (!ready) {
      const diagnostic = this.createDiagnostic(
        'MCP_SERVER_UNAVAILABLE',
        'execute-tool',
        `MCP server ${this.name} is ${this.stateValue}; tool ${toolName} is unavailable`,
        this.stateValue !== 'stopped',
        toolName
      );
      this.recordDiagnostic(diagnostic);
      throw new McpLifecycleError(diagnostic);
    }

    if (context.signal.aborted) {
      throw new McpLifecycleError(this.createDiagnostic(
        'MCP_TOOL_UNAVAILABLE',
        'execute-tool',
        `MCP tool ${this.name}/${toolName} execution aborted`,
        false,
        toolName
      ));
    }

    const tool = this.liveTools?.find(
      (candidate) => candidate.name === toolName
    );
    if (!tool) {
      const diagnostic = this.createDiagnostic(
        'MCP_TOOL_UNAVAILABLE',
        'execute-tool',
        `MCP tool ${this.name}/${toolName} is not available after startup`,
        true,
        toolName
      );
      this.recordDiagnostic(diagnostic);
      throw new McpLifecycleError(diagnostic);
    }
    try {
      const result = await tool.execute(input, context);
      this.consecutiveFailures = 0;
      return result;
    } catch (error) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        const diagnostic = this.createDiagnostic(
          'MCP_TOOL_UNAVAILABLE',
          'execute-tool',
          `MCP tool ${this.name}/${toolName} failed ${this.consecutiveFailures} consecutive times`,
          true,
          toolName
        );
        this.degrade(diagnostic);
      }
      throw error;
    }
  }

  private visibleToolMetadata(): McpCachedTool[] {
    if (this.stateValue === 'stopped') return [];
    if (
      this.liveTools !== undefined &&
      (this.stateValue === 'ready' ||
        this.stateValue === 'degraded' ||
        this.stateValue === 'reconnecting')
    ) {
      return this.liveTools;
    }
    return this.cachedTools;
  }

  private operationResult(
    ok: boolean,
    diagnostic?: McpLifecycleDiagnostic
  ): McpServerOperationResult {
    return {
      ok,
      server: this.name,
      state: this.stateValue,
      tools: this.listTools(),
      timestamp: nowIso(),
      ...(diagnostic ? { diagnostic } : {}),
    };
  }

  private degrade(diagnostic: McpLifecycleDiagnostic): void {
    this.recordDiagnostic(diagnostic);
    this.transition('degraded', diagnostic);
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
      severity: 'error',
      timestamp: nowIso(),
      server: this.name,
      state: this.stateValue,
      ...(toolName ? { toolName } : {}),
      cause: message,
    };
  }

  private recordDiagnostic(diagnostic: McpLifecycleDiagnostic): void {
    this.lastDiagnostic = diagnostic;
    this.diagnostics.pushOverwritingOldest(diagnostic);
    this.emit({
      type: 'server-diagnostic',
      server: this.name,
      diagnostic,
      timestamp: nowIso(),
    });
  }

  private async closeConnectionWithDiagnostics(
    connection: McpServerConnection | undefined,
    phase: 'close' | 'teardown'
  ): Promise<McpLifecycleDiagnostic | undefined> {
    try {
      await closeConnection(connection);
      return undefined;
    } catch (cause) {
      const diagnostic = this.createDiagnostic(
        'MCP_CLOSE_FAILED',
        phase,
        cause,
        false
      );
      this.recordDiagnostic(diagnostic);
      return diagnostic;
    }
  }

  private isActive(generation: number): boolean {
    return generation === this.generation && this.stateValue !== 'stopped';
  }

  private transition(
    state: McpServerLifecycleState,
    diagnostic?: McpLifecycleDiagnostic
  ): void {
    const previousState = this.stateValue;
    this.stateValue = state;
    this.updatedAtMs = Date.now();
    if (previousState === state) return;
    this.emit({
      type: 'server-state',
      server: this.name,
      previousState,
      state,
      ...(diagnostic ? { diagnostic } : {}),
      timestamp: nowIso(),
    });
  }

  private emit(event: McpServerLifecycleEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
