/**
 * @crish/agent-tools — 工具系统（Layer 3 middle）
 *
 * 导出工具定义、中间件、注册表、本地工具实现。
 *
 * 拓扑层（01-OVERVIEW.md §3.2）：Layer 3 (middle)。
 * 依赖约束：依赖 shared-types / shared-utils / agent-context / agent-permissions / logger，
 * 不依赖 agent-model / agent-core / agent-mcp。
 */

// ─── 工具系统核心（tools/tool-definition.ts）──────────────────
export {
  type ToolDefinition,
  type ToolRegistrationOptions,
  type LlmToolDefinition,
  RegisteredTool,
  ToolRegistry,
} from './tools/tool-definition';

// ─── 工具中间件（tools/tool-middleware.ts，3-Hook，禁令 7）─────
export {
  type ToolMiddleware,
  type MiddlewareBeforeResult,
  type MiddlewareAfterResult,
  type PermissionMiddlewareOptions,
  PermissionMiddleware,
  type CheckpointMiddlewareOptions,
  CheckpointMiddleware,
  type OutputMaterializationMiddlewareOptions,
  type ContextManagerLike,
  OutputMaterializationMiddleware,
} from './tools/tool-middleware';

// ─── 工具预设（tools/tool-preset-registry.ts）──────────────────
export {
  type ToolMode,
  type ToolPreset,
  ToolPresetRegistry,
} from './tools/tool-preset-registry';

// ─── 工具发现（tool-discovery.ts）──────────────────────────────
export {
  type ToolDiscoveryField,
  type ToolDiscoveryFieldScores,
  type ToolDiscoveryToolMetadata,
  type ToolDiscoveryToolInput,
  type ToolDiscoveryMetadataSource,
  type ToolDiscoverySearchOptions,
  type ToolDiscoveryIndexOptions,
  type ToolDiscoverySearchResult,
  type DeferredToolSourceOptions,
  type DeferredToolSearchOptions,
  type DeferredToolActivationResult,
  ToolDiscoveryIndex,
  DeferredToolSource,
  tokenizeToolDiscoveryText,
} from './tool-discovery';

// ─── 工具输出预算（tool-output-budget.ts）──────────────────────
export {
  type ToolOutputBudgetOptions,
  type BudgetedText,
  budgetTextForContext,
  budgetToolOutputForContext,
  stringifyToolOutput,
  asJsonValue,
} from './tool-output-budget';

// ─── 工具输出守卫（tool-output-guard.ts）───────────────────────
export {
  type ToolOutputGuardOptions,
  stripPseudoInstructions,
  wrapUntrustedToolOutput,
  guardToolOutputForContext,
} from './tool-output-guard';

// ─── 全局工具注册表（tool-registry.ts）─────────────────────────
export {
  ToolRegistry as GlobalToolRegistry,
  globalToolRegistry,
} from './tool-registry';

// ─── 工具创建与验证（tools.ts barrel）──────────────────────────
export {
  defineTool,
  type ToolInputRepairResult,
  repairToolInput,
  validateToolInput,
  type TextToolOptions,
  defineTextTool,
  ToolRegistry as ToolsToolRegistry,
  allowAllPermissionPolicy,
  denyAllPermissionPolicy,
  askForMutatingToolsPolicy,
  createPermissionPolicy,
  type CreatePermissionPolicyMode,
} from './tools';

// ─── 本地工具（local-tools/index.ts）──────────────────────────
export {
  createTerminalCommandTool,
  createListDirectoryTool,
  createReadFileTool,
  createReadTool,
  createApplyWorkspaceEditsTool,
  createEditTool,
  createWriteFileTool,
  createSearchFilesTool,
  createRestoreFileSnapshotTool,
  createRestoreWorkspaceCheckpointTool,
  createWorkspaceCheckpointTool,
  createLocalWorkspaceTools,
} from './local-tools/index';

// ─── 本地工具 fs-edit 子模块（local-tools/fs-edit-tools/index.ts）─
export {
  createApplyWorkspaceEditsTool as fsEditApplyWorkspaceEditsTool,
  createEditTool as fsEditEditTool,
} from './local-tools/fs-edit-tools/index';

// ─── 大文件工具 ────────────────────────────────────────────────
export {
  BackgroundCommandManager,
  createBackgroundCommandTools,
  createBackgroundCommandToolsLegacy,
} from './background-command';

export {
  WorkspaceMutationLeaseError,
  WorkspaceMutationCoordinator,
  type NormalizedLeaseScope,
  scopesConflict,
} from './workspace-mutation-coordinator';

export {
  createLspDiagnosticsTool,
  createLspDefinitionTool,
  createLspReferencesTool,
  createLspRenameTool,
} from './lsp-tools';

export {
  type RichReadToolOptions,
  type RichReadProvider,
  createRichReadTool,
  createWorkspaceRichReadProvider,
  createArtifactRichReadProvider,
} from './rich-read';

export {
  INTERNAL_RESOURCE_SCHEMES,
  ResourceUriParseError,
  ResourceUnsupportedError,
  ResourceNotFoundError,
  ResourceIntegrityError,
  ResourceResolverRegistry,
  isInternalResourceScheme,
  isInternalResourceUri,
  tryParseResourceUri,
  parseResourceUri,
  formatResourceUri,
  agentResourceUri,
  artifactResourceUri,
  memoryResourceUri,
  skillResourceUri,
  createToolArtifactResourceResolver,
  createBlobResourceResolver,
  createRichReadArtifactResolver,
  isResourceNotFoundError,
  isResourceUnsupportedError,
} from './resource-uri';

export { GitCliVersioningService } from './git-versioning/git-service';
export type { GitVersioningService } from './git-versioning/git-types';

export { formatSkillInvocation } from './skills';

// ─── Git 版本控制工具函数（git-versioning/git-patch-ops.ts）────
export {
  DEFAULT_REF_NAMESPACE,
  CHECKPOINT_METADATA_VERSION,
  CHECKPOINT_MARKER,
  parseStatus,
  isConflictedStatus,
  parseNameStatus,
  parseCheckpointMetadata,
  isCheckpointMetadata,
  isWorkspaceStatus,
  commitMessage,
  trimRequired,
  normalizeRefNamespace,
  safeRefSegment,
  normalizeRepositoryPath,
  assertInside,
  normalizeForCompare,
  normalizeGitPath,
  assertExpectedChangedPaths,
  uniqueSorted,
  isAbsolutePath,
  isStringArray,
} from './git-versioning/git-patch-ops';
