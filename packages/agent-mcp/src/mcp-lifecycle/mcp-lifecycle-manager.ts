import type { AgentTool, ToolSource } from '@crish/shared-types';
import { RingBuffer } from '@crish/shared-utils';
import type {
  McpLifecycleDiagnostic,
  McpLifecycleEvent,
  McpLifecycleListener,
  McpLifecycleManagerOptions,
  McpLifecyclePhase,
  McpLifecycleReconnectResult,
  McpLifecycleRefreshResult,
  McpLifecycleSnapshot,
  McpLifecycleStartResult,
  McpLifecycleTeardownResult,
  McpServerDefinition,
  McpServerLifecycleState,
  McpServerOperationResult,
  McpServerSnapshot,
} from './types';
import { DEFAULT_MCP_STARTUP_GATE_TIMEOUT_MS } from './types';
import { McpServerController } from './mcp-server-controller';
import {
  createLifecycleDiagnostic,
  normalizeDiagnosticLimit,
  nowIso,
  delay,
} from './utils';

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
    this.id = options.id ?? 'mcp-lifecycle';
    this.label = options.label ?? 'MCP lifecycle';
    this.gateTimeoutMs = Math.max(
      1,
      options.startupGateTimeoutMs ?? DEFAULT_MCP_STARTUP_GATE_TIMEOUT_MS
    );
    this.diagnosticLimit = normalizeDiagnosticLimit(options.diagnosticLimit);
    this.diagnostics = new RingBuffer<McpLifecycleDiagnostic>(
      this.diagnosticLimit
    );
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

    const controller = new McpServerController(definition, {
      diagnosticLimit: this.diagnosticLimit,
    });
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
    const results = await Promise.all(
      entries.map(async ([server, controller]) => ({
        server,
        result: await controller.refreshTools(),
      }))
    );
    const refreshedServers: string[] = [];
    const degradedServers: Array<{
      server: string;
      diagnostic: McpLifecycleDiagnostic;
    }> = [];
    const diagnostics: McpLifecycleDiagnostic[] = [];

    for (const { server, result } of results) {
      if (result.ok && result.state === 'ready') {
        refreshedServers.push(server);
      } else {
        const diagnostic =
          result.diagnostic ??
          this.serverUnavailableDiagnostic(server, 'list-tools', result.state);
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
      const diagnostic = this.serverUnavailableDiagnostic(
        name,
        'reconnect',
        'stopped'
      );
      this.recordDiagnostic(diagnostic);
      return {
        ok: false,
        server: name,
        state: 'stopped',
        tools: [],
        timestamp: nowIso(),
        diagnostic,
      };
    }
    return controller.reconnect();
  }

  async startServer(name: string): Promise<{ state: string }> {
    const controller = this.controllers.get(name);
    if (!controller) {
      return { state: 'unknown' };
    }
    this.hasStarted = true;
    const result = await controller.start({ restartIfStopped: true });
    return { state: result.state };
  }

  async stopServer(name: string): Promise<{ state: string }> {
    const controller = this.controllers.get(name);
    if (!controller) {
      return { state: 'unknown' };
    }
    const result = await controller.teardown();
    return { state: result.state };
  }

  async reconnectDegradedServers(): Promise<McpLifecycleReconnectResult> {
    const entries = [...this.controllers.entries()].filter(
      ([, controller]) => controller.state === 'degraded'
    );
    const results = await Promise.all(
      entries.map(async ([server, controller]) => ({
        server,
        result: await controller.reconnect(),
      }))
    );
    const reconnectedServers: string[] = [];
    const degradedServers: Array<{
      server: string;
      diagnostic: McpLifecycleDiagnostic;
    }> = [];
    const diagnostics: McpLifecycleDiagnostic[] = [];

    for (const { server, result } of results) {
      if (result.ok && result.state === 'ready') {
        reconnectedServers.push(server);
      } else {
        const diagnostic =
          result.diagnostic ??
          this.serverUnavailableDiagnostic(server, 'reconnect', result.state);
        degradedServers.push({ server, diagnostic });
        diagnostics.push(diagnostic);
      }
    }

    return { reconnectedServers, degradedServers, diagnostics };
  }

  snapshot(): McpLifecycleSnapshot {
    const servers = [...this.controllers.values()].map((controller) =>
      controller.snapshot()
    );
    const summary: Record<McpServerLifecycleState, number> = {
      discovering: 0,
      starting: 0,
      ready: 0,
      degraded: 0,
      reconnecting: 0,
      stopped: 0,
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
    const results = await Promise.all(
      controllers.map((controller) => controller.teardown())
    );
    this.startPromise = undefined;
    this.hasStarted = false;

    const stoppedServers = results.map((result) => result.server);
    const diagnostics = results.flatMap((result) =>
      result.diagnostic ? [result.diagnostic] : []
    );
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
    const startupTasks = [...this.controllers.values()].map((controller) =>
      controller.start()
    );
    let timedOut = false;

    const cancelDelay = new AbortController();
    const allStarted = Promise.all(startupTasks);
    allStarted.finally(() => cancelDelay.abort());

    await Promise.race([
      allStarted,
      delay(this.gateTimeoutMs, cancelDelay.signal).then(() => {
        timedOut = startupTasks.length > 0 && this.pendingServers().length > 0;
      }),
    ]);

    if (timedOut) {
      const pendingServers = this.pendingServers();
      const diagnostic = createLifecycleDiagnostic({
        code: 'MCP_STARTUP_GATE_TIMEOUT',
        phase: 'startup-gate',
        message: `MCP startup gate timed out after ${this.gateTimeoutMs}ms with ${pendingServers.length} server(s) still pending`,
        retryable: true,
        severity: 'warning',
      });
      this.recordDiagnostic(diagnostic);
      this.emit({
        type: 'startup-gate-timeout',
        timeoutMs: this.gateTimeoutMs,
        pendingServers,
        diagnostic,
        timestamp: nowIso(),
      });
    }

    const result = this.startResult(timedOut);
    this.emit({ type: 'startup-gate-settled', result, timestamp: nowIso() });
    return result;
  }

  private startResult(timedOut: boolean): McpLifecycleStartResult {
    const readyServers: string[] = [];
    const degradedServers: Array<{
      server: string;
      diagnostic: McpLifecycleDiagnostic;
    }> = [];
    const pendingServers: string[] = [];
    const stoppedServers: string[] = [];

    for (const controller of this.controllers.values()) {
      if (controller.state === 'ready') readyServers.push(controller.name);
      if (controller.state === 'degraded') {
        degradedServers.push({
          server: controller.name,
          diagnostic:
            controller.diagnostic ??
            this.serverUnavailableDiagnostic(
              controller.name,
              'connect',
              controller.state
            ),
        });
      }
      if (
        controller.state === 'starting' ||
        controller.state === 'discovering' ||
        controller.state === 'reconnecting'
      ) {
        pendingServers.push(controller.name);
      }
      if (controller.state === 'stopped') stoppedServers.push(controller.name);
    }

    return {
      readyServers,
      degradedServers,
      pendingServers,
      stoppedServers,
      timedOut,
      tools: this.availableTools(),
      diagnostics: this.snapshot().diagnostics,
    };
  }

  private pendingServers(): string[] {
    return [...this.controllers.values()]
      .filter(
        (controller) =>
          controller.state === 'starting' ||
          controller.state === 'discovering' ||
          controller.state === 'reconnecting'
      )
      .map((controller) => controller.name);
  }

  private availableTools(): AgentTool[] {
    return [...this.controllers.values()]
      .flatMap((controller) => controller.listTools())
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private serverUnavailableDiagnostic(
    server: string,
    phase: McpLifecyclePhase,
    state: McpServerLifecycleState
  ): McpLifecycleDiagnostic {
    return createLifecycleDiagnostic({
      code: 'MCP_SERVER_UNAVAILABLE',
      phase,
      message: `MCP server ${server} is ${state}`,
      retryable: state !== 'stopped',
      severity: 'error',
      server,
      state,
    });
  }

  private recordDiagnostic(diagnostic: McpLifecycleDiagnostic): void {
    this.diagnostics.pushOverwritingOldest(diagnostic);
    this.emit({
      type: 'lifecycle-diagnostic',
      diagnostic,
      timestamp: nowIso(),
    });
  }

  private allDiagnostics(
    servers: McpServerSnapshot[]
  ): McpLifecycleDiagnostic[] {
    return [
      ...this.diagnostics.toArray(),
      ...servers.flatMap((server) => server.diagnostics),
    ].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  private emit(event: McpLifecycleEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
