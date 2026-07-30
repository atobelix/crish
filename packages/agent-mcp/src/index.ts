/**
 * @crish/agent-mcp
 *
 * MCP 生命周期管理包。职责：McpLifecycleManager、McpServerController、registerPluginServer 入口。
 *
 * 依赖约束（ROUND-04-split-phase-B.md §3.3）：
 * - 依赖 @crish/shared-types + @crish/shared-utils + @crish/agent-tools。
 * - agent-tools 依赖用于 registerPluginServer 接口的工具注册类型（ToolDefinition / RegisteredTool）。
 *
 * 拓扑层（01-OVERVIEW.md §3.2）：Layer 2 → Layer 3（Round 4 完整化后演进）。
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
  type PluginMcpDeclaration,
} from './register-plugin-server';
