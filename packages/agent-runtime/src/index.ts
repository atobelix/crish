/**
 * @deprecated @crish/agent-runtime is deprecated.
 * Import from @crish/agent-tools, @crish/agent-model, @crish/agent-mcp directly.
 * This shim will be removed in v0.3.0.
 *
 * 共存阶段（guardrails 禁令 23）：被迁移的源文件保留在本包中，
 * 现有 `export *` 暂时指向本地源文件。删除阶段在 Round 5（agent-core 创建后）执行，
 * 届时本 shim 将改为从 @crish/agent-tools / @crish/agent-model / @crish/agent-mcp re-export。
 *
 * @see @crish/agent-tools
 * @see @crish/agent-model
 * @see @crish/agent-mcp
 * @removeWhen Round 5 agent-core 创建后删除本地源文件并改为 re-export
 */

if (typeof console !== 'undefined') {
  console.warn(
    '[deprecated] @crish/agent-runtime is deprecated, import from @crish/agent-tools / @crish/agent-model / @crish/agent-mcp directly'
  );
}

export * from './runtime';
export * from './runtime-defaults';
export * from './runtime-metrics';
export * from './background-command';
export * from './script-wait-policy';
export * from './blob-externalization';
export * from './checkpoints';
export * from './checkpoint-manifest';
export * from './context-compression';
export * from './context-projection';
export * from './context-state';
export * from './conversation-boundary-manifest';
export * from './conversation-rewind-target';
export * from './encoding';
export * from './git-versioning';
export * from './session';
export * from './skills';
export * from './local-tools';
export * from './memory';
export * from './mcp-lifecycle';
export * from './model-routing';
// @deprecated 权限和命令分类已迁移至 @crish/decision-engine @see @crish/decision-engine @removeWhen 所有外部消费者从 @crish/decision-engine 导入
export {
  classifyTerminalCommand,
  getHardlineCommandBlock,
  type CommandRisk,
  type CommandClassification,
} from './permission/command-classification';
export * from './plan-document';
export * from './prompt-context';
export * from './prompt-assembly';
export * from './project-progress-ledger';
export * from './provider-gateway';
export * from './provider-cache-hints';
export * from './provider-openai-compatible';
export * from './provider-anthropic';
export * from './anthropic-request-build';
export * from './anthropic-stream-parse';
export * from './provider-gemini';
export * from './gemini-request-build';
export * from './gemini-stream-parse';
export * from './provider-stream-contract';
export * from './preview-queue';
export * from './plugin-registry';
export type {
  PluginManifest as FsPluginManifest,
  PluginAPI,
} from './plugin-fs-registry';
export {
  PluginRegistry as FsPluginRegistry,
  pluginRegistry,
} from './plugin-fs-registry';
export * from './rich-read';
export * from './resource-uri';
export * from './lsp-tools';
export * from './scoped-context';
export * from './scoped-context-resources';
export * from './secrets-obfuscation';
export * from './snapshots';
export * from './structured-summary';
export * from './subagent-context-pack';
export * from './subagents';
export * from './testing';
export * from './tool-discovery';
export * from './tool-output-budget';
export * from './tool-output-guard';
export * from './goal-disk-oracle';
export * from './response-style';
export * from './tools';
export {
  type ToolDefinition,
  type ToolRegistrationOptions,
  RegisteredTool,
  type LlmToolDefinition,
  ToolRegistry as AdvancedToolRegistry,
} from './tools/index';
export {
  type ToolMiddleware,
  type MiddlewareBeforeResult,
  type MiddlewareAfterResult,
  PermissionMiddleware,
  type PermissionMiddlewareOptions,
  CheckpointMiddleware,
  type CheckpointMiddlewareOptions,
  OutputMaterializationMiddleware,
  type OutputMaterializationMiddlewareOptions,
} from './tools/index';
export * from './types';
export * from './workspace-mutation-coordinator';
export * from './state-machine';
export * from './event-architecture';
export * from './runtime-components';
export * from './provider';
export * from './provider-transport';
export * from './provider-request-machine';
export * from './path-handling';
export * from './rendering';
export * from './config';
// Permission modules moved to @crish/decision-engine in Step 2
export * from './session-store';
export * from './process-lifecycle';
export * from './checkpoint';
export * from './event-queue';
export * from './trace';
export * from './steering';
export * from './hooks';
export * from './control';
export * from './agent-input-queue';
export * from './event-protocol';
