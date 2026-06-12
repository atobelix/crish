/**
 * 配置统一系统 - 公共导出
 */

export {
  ConfigMerger,
  RUNTIME_CONFIG_SCHEMA,
  PROVIDER_CONFIG_SCHEMA,
  CONFIG_SOURCE_PRIORITIES,
} from "./config-merger";

export type {
  MergeStrategy,
  ConfigFieldPolicy,
  ConfigSourcePriority,
  ConfigSource,
  ConfigValidationResult,
  ConfigValidationError,
  ConfigValidationWarning,
  ConfigSchema,
} from "./config-merger";
