export { PermissionEngine, DEFAULT_PERMISSION_ENGINE } from "./permission-engine";
export { HardlinePatternRegistry, DEFAULT_HARDLINE_REGISTRY } from "./hardline-patterns";
export type { HardlineEntry } from "./hardline-patterns";
export { classifyCommand, classifyTerminalCommand } from "./command-classifier";
export type { CommandRisk, CommandClassification } from "./command-classifier";
export {
  resolveTrustZone,
  behaviorForMode,
  decideByTrustZone,
  normalizeCommandIntent,
  buildIntentKey,
  TRUST_ZONE_MATRIX,
} from "./trust-zone";
export type {
  TrustZone,
  TrustBehavior,
  TrustPolicyMode,
  TrustZoneResolution,
} from "./trust-zone";
export { HardlineBlockRule } from "./rules/hardline-rule";
export { ConfigMerger } from "./config-merger";
export type {
  MergeStrategy, ConfigFieldPolicy, ConfigSchema,
  ConfigValidationError, ConfigValidationWarning, ConfigValidationResult,
  ConflictReportEntry, MergeResult,
} from "./config-merger";
