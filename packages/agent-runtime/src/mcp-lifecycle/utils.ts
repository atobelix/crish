import type { JsonObject, ToolExecutionContext, ToolOutput } from '@crish/shared-types';
import type { AgentTool } from '../types';
import type {
  McpCachedTool,
  McpLifecycleDiagnostic,
  McpLifecycleDiagnosticCode,
  McpLifecycleDiagnosticSeverity,
  McpLifecyclePhase,
  McpServerConnection,
  McpServerLifecycleState,
} from './types';
import { DEFAULT_MCP_DIAGNOSTIC_LIMIT } from './types';

export function createManagedMcpTool(
  serverName: string,
  tool: McpCachedTool,
  execute: (
    input: JsonObject,
    context: ToolExecutionContext
  ) => Promise<ToolOutput>
): AgentTool {
  const name = toolNameOf(tool);
  const label = typeof tool.label === 'string' ? tool.label : name;
  const concurrency =
    'concurrency' in tool && tool.concurrency ? tool.concurrency : 'parallel';
  return {
    name,
    label,
    description: tool.description,
    category: 'mcp',
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    concurrency,
    isReadOnly(input) {
      if (isAgentTool(tool)) return tool.isReadOnly(input);
      if (typeof tool.readOnly === 'function') return tool.readOnly(input);
      return tool.readOnly ?? false;
    },
    summarize(input) {
      if (isAgentTool(tool)) return tool.summarize(input);
      if (typeof tool.summarize === 'function') return tool.summarize(input);
      if (typeof tool.summarize === 'string') return tool.summarize;
      return `${serverName}/${name}`;
    },
    execute,
  };
}

export function toolNameOf(tool: McpCachedTool): string {
  return tool.name;
}

export function isAgentTool(tool: McpCachedTool): tool is AgentTool {
  return typeof (tool as AgentTool).execute === 'function';
}

export async function closeConnection(
  connection: McpServerConnection | undefined
): Promise<void> {
  if (!connection?.close) return;
  await connection.close();
}

export function createLifecycleDiagnostic(input: {
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
    ...(input.cause ? { cause: input.cause } : {}),
  };
}

export function normalizeDiagnosticLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_MCP_DIAGNOSTIC_LIMIT;
  return Math.max(1, Math.floor(limit));
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        cleanup();
        resolve();
      },
      Math.max(0, ms)
    );
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}
