/**
 * @crish/agent-permissions
 *
 * 运行时信任执行包。职责：审批管线、信任区策略、密钥脱敏。
 *
 * 与 @crish/decision-engine 的边界（ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 12）：
 * - decision-engine 保留 command-classifier.ts（纯决策逻辑：命令分类、风险评估、硬性规则，无状态）。
 * - agent-permissions 从 decision-engine 导入分类结果（classifyCommand / decideByTrustZone），
 *   不自行实现命令分类或风险矩阵。
 * - 禁止两包同时包含 command-classification 副本；agent-permissions 内部代码不重复分类逻辑。
 *
 * 依赖方向（02-FILE-MAPPING.md §9.2）：
 * - agent-permissions → @crish/shared-types（AgentTool / RuntimePermissionPolicy / PermissionDecision 等）
 * - agent-permissions → @crish/decision-engine（decideByTrustZone / classifyTerminalCommand / DEFAULT_HARDLINE_REGISTRY）
 * - agent-permissions → @crish/shared-utils（LruMap，由 secrets-obfuscation 使用）
 * - 不依赖 agent-tools / agent-model / agent-core / agent-context / agent-mcp（leaf 层独立性）
 *
 * 拓扑层（01-OVERVIEW.md §3.2）：Layer 2 (leaf)。
 */

// ─── approval 域 ───
export {
  ApprovalCache,
  type ApprovalCacheOptions,
} from './approval/approval-cache';
export {
  ApprovalPipeline,
  type ApprovalPipelineOptions,
  type ApprovalPipelineRequest,
} from './approval/approval-pipeline';
export {
  ChainApproval,
  type ChainApprovalOptions,
} from './approval/chain-approval';

// ─── permission 域（trust-zone-policy；command-classification 留置 decision-engine） ───
export {
  TrustZonePermissionPolicy,
  createTrustZonePermissionPolicy,
  mapToTrustPolicyMode,
  riskPresentationFromZone,
  type TrustZonePermissionMode,
  type CreatePermissionPolicyMode,
} from './permission/trust-zone-policy';

// ─── secrets-obfuscation 域 ───
export {
  SecretRegistry,
  SecretRedactor,
  createSecretRedactorFromEnv,
  type SecretKind,
  type SecretRegistration,
  type SecretPatternRegistration,
  type SecretRegistryOptions,
  type RegisterSecretOptions,
  type RegisterEnvOptions,
  type RegisterPatternOptions,
  type SecretRedactorOptions,
  type SecretRedactionEntry,
  type SecretRestoreMap,
  type SecretDisplayMap,
  type SecretRedactionState,
  type SecretRedactionResult,
} from './secrets-obfuscation';
