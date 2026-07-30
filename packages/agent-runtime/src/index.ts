/**
 * @deprecated @crish/agent-runtime is deprecated. This shim will be removed in v0.3.0.
 *
 * Import from the split sub-packages directly:
 * - @crish/agent-core        — AgentRuntime, SessionLoop, ControlBus, SteeringCoordinator,
 *                              ErrorClassifier, RecoveryPipeline, Hooks, ContextManager
 * - @crish/agent-subagent    — SubagentDepthGuard, SubagentScheduler, RecursionGuard
 * - @crish/agent-tools       — ToolDefinition, ToolRegistry, ToolMiddleware, local-tools
 * - @crish/agent-model       — Engine, ProviderFactory, ProviderRegistry, provider gateway
 * - @crish/agent-mcp         — McpLifecycleManager, McpServerController
 * - @crish/agent-context     — ContextCompressor, CheckpointManager, SessionStore, session
 * - @crish/agent-permissions — ApprovalPipeline, TrustZonePermissionPolicy, SecretRedactor
 *
 * 依据禁令 24（Legacy Shim 约束）：
 * - 使用显式命名导出，禁止 `export *`（避免符号冲突）
 * - 模块加载时输出一次 deprecation warning
 * - 移除时间表：v0.3.0（删除阶段 R12）
 *
 * @see @crish/agent-core
 * @see @crish/agent-subagent
 * @see @crish/agent-tools
 * @see @crish/agent-model
 * @see @crish/agent-mcp
 * @see @crish/agent-context
 * @see @crish/agent-permissions
 * @removeWhen v0.3.0 — 所有消费者完成 import 路径迁移后删除本 shim（R12 CI 门禁强制）
 */

if (typeof console !== 'undefined') {
  console.warn(
    '[deprecated] @crish/agent-runtime is deprecated. Import from @crish/agent-core / @crish/agent-subagent / @crish/agent-tools / @crish/agent-model / @crish/agent-mcp / @crish/agent-context / @crish/agent-permissions directly. This shim will be removed in v0.3.0.'
  );
}

// ─── agent-core（运行时执行内核） ───
export { type IAgentRuntime, AgentRuntime } from '@crish/agent-core';
export { AgentSessionLoop } from '@crish/agent-core';
export { ControlBus } from '@crish/agent-core';
export { SteeringCoordinator, type SteeringStrategy } from '@crish/agent-core';
export {
  ErrorClassifier,
  type ClassifiedError,
  type ErrorDomain,
} from '@crish/agent-core';
export { type RecoveryPipelineConfig, type PipelineResult } from '@crish/agent-core';
export {
  LifecycleHookRegistry,
  type LifecycleEventType,
} from '@crish/agent-core';

// ─── agent-subagent（子代理调度骨架） ───
export {
  type SubagentDepthGuard,
  type SubagentMode,
  type SubagentStatus,
} from '@crish/agent-subagent';

// ─── agent-tools（工具系统） ───
export {
  type ToolDefinition,
  type ToolRegistrationOptions,
  RegisteredTool,
  type ToolMiddleware,
  ToolRegistry,
} from '@crish/agent-tools';

// ─── agent-model（Provider 系统） ───
export {
  type Engine,
  type ProviderDef,
  ProviderFactory,
  ProviderRegistry,
} from '@crish/agent-model';

// ─── agent-mcp（MCP 生命周期） ───
export {
  McpLifecycleManager,
  type McpServerDefinition,
} from '@crish/agent-mcp';

// ─── agent-context（上下文域） ───
export {
  CheckpointManager,
  type SessionStore,
} from '@crish/agent-context';

// ─── agent-permissions（信任执行） ───
export {
  ApprovalPipeline,
  TrustZonePermissionPolicy,
  SecretRedactor,
} from '@crish/agent-permissions';
