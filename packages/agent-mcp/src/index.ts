/**
 * @crish/agent-mcp
 *
 * MCP 生命周期管理包。职责：McpLifecycleManager、McpServerController、registerPluginServer 入口。
 *
 * 依赖约束（02-FILE-MAPPING.md 禁令 23）：
 * - 仅依赖 @crish/shared-types + @crish/shared-utils。
 * - 不依赖 agent-tools / agent-model（依赖最小化）。
 *
 * 拓扑层（01-OVERVIEW.md §3.2）：Layer 2 (leaf)。
 */

export {
  DEFAULT_MCP_STARTUP_GATE_TIMEOUT_MS,
  DEFAULT_MCP_WAIT_FOR_READY_TIMEOUT_MS,
  DEFAULT_MCP_DIAGNOSTIC_LIMIT,
  McpLifecycleError,
  McpLifecycleManager,
  McpServerController,
} from './mcp-lifecycle';

export type {
  McpCachedTool,
  McpCachedToolDefinition,
  McpLifecycleDiagnostic,
  McpLifecycleDiagnosticCode,
  McpLifecycleDiagnosticSeverity,
  McpLifecycleEvent,
  McpLifecycleListener,
  McpLifecycleManagerOptions,
  McpLifecyclePhase,
  McpLifecycleReconnectResult,
  McpLifecycleRefreshResult,
  McpLifecycleSnapshot,
  McpLifecycleStartResult,
  McpLifecycleTeardownResult,
  McpServerAdapter,
  McpServerConnection,
  McpServerDefinition,
  McpServerLifecycleEvent,
  McpServerLifecycleListener,
  McpServerLifecycleState,
  McpServerListToolsContext,
  McpServerOperationResult,
  McpServerSnapshot,
  McpServerStartContext,
} from './mcp-lifecycle';

export {
  registerPluginServer,
  type PluginMcpServerDeclaration,
} from './plugin-server';
