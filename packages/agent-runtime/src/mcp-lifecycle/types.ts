import type { JsonObject, ToolConcurrency } from '@crish/shared-types';
import type { AgentTool } from '../types';

export const DEFAULT_MCP_STARTUP_GATE_TIMEOUT_MS = 250;
export const DEFAULT_MCP_WAIT_FOR_READY_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_DIAGNOSTIC_LIMIT = 50;

export type McpServerLifecycleState =
  | 'discovering'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'reconnecting'
  | 'stopped';

export type McpLifecycleDiagnosticSeverity = 'warning' | 'error';

export type McpLifecycleDiagnosticCode =
  | 'MCP_CLOSE_FAILED'
  | 'MCP_CONNECT_FAILED'
  | 'MCP_LIST_TOOLS_FAILED'
  | 'MCP_SERVER_UNAVAILABLE'
  | 'MCP_STARTUP_GATE_TIMEOUT'
  | 'MCP_TOOL_UNAVAILABLE';

export type McpLifecyclePhase =
  | 'close'
  | 'connect'
  | 'execute-tool'
  | 'list-tools'
  | 'reconnect'
  | 'startup-gate'
  | 'teardown';

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
    this.name = 'McpLifecycleError';
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
  listTools(
    context: McpServerListToolsContext
  ): Promise<AgentTool[]> | AgentTool[];
  close?(): Promise<void> | void;
}

export interface McpServerAdapter {
  connect(
    context: McpServerStartContext
  ): Promise<McpServerConnection> | McpServerConnection;
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
      type: 'server-state';
      server: string;
      previousState: McpServerLifecycleState;
      state: McpServerLifecycleState;
      timestamp: string;
      diagnostic?: McpLifecycleDiagnostic;
    }
  | {
      type: 'server-diagnostic';
      server: string;
      diagnostic: McpLifecycleDiagnostic;
      timestamp: string;
    }
  | {
      type: 'tools-refreshed';
      server: string;
      toolCount: number;
      timestamp: string;
    };

export type McpLifecycleEvent =
  | McpServerLifecycleEvent
  | {
      type: 'lifecycle-diagnostic';
      diagnostic: McpLifecycleDiagnostic;
      timestamp: string;
    }
  | {
      type: 'startup-gate-timeout';
      timeoutMs: number;
      pendingServers: string[];
      diagnostic: McpLifecycleDiagnostic;
      timestamp: string;
    }
  | {
      type: 'startup-gate-settled';
      result: McpLifecycleStartResult;
      timestamp: string;
    };

export interface McpLifecycleStartResult {
  readyServers: string[];
  degradedServers: Array<{
    server: string;
    diagnostic: McpLifecycleDiagnostic;
  }>;
  pendingServers: string[];
  stoppedServers: string[];
  timedOut: boolean;
  tools: AgentTool[];
  diagnostics: McpLifecycleDiagnostic[];
}

export interface McpLifecycleRefreshResult {
  refreshedServers: string[];
  degradedServers: Array<{
    server: string;
    diagnostic: McpLifecycleDiagnostic;
  }>;
  diagnostics: McpLifecycleDiagnostic[];
}

export interface McpLifecycleReconnectResult {
  reconnectedServers: string[];
  degradedServers: Array<{
    server: string;
    diagnostic: McpLifecycleDiagnostic;
  }>;
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
export type McpServerLifecycleListener = (
  event: McpServerLifecycleEvent
) => void;

export interface McpLifecycleManagerOptions {
  id?: string;
  label?: string;
  servers?: McpServerDefinition[];
  startupGateTimeoutMs?: number;
  diagnosticLimit?: number;
}
