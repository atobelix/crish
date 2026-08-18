/**
 * clientApi — localStorage-backed client preferences.
 *
 * 正式路径（保留实现）：
 * - Settings：getSettings / updateSettings / getSettingsEx / saveSettingsEx
 *   → SettingsPanel / SettingsRulesTab / SkillsSettingsTab / App / ChatCard
 * - subscribeTelemetry：正式安静 no-op
 *
 * T03.7：cron / MCP demo 方法（getScheduledTasks / getMcpServers 等）显式不可用——
 * Rust 侧无 list-workflows / cron.* / list|start|stop-mcp-server 命令，直接返回空表。
 *
 * 实现已拆分至子模块（hub 仅 re-export，消费方 import 路径不变）：
 * - clientApi.types：类型契约（Settings / ResponseStyle / CronJob / McpServer 等）
 * - clientApiNormalize：纯规范化（normalize* / parseSettingsJson / deepMergeSettings / DEFAULT_SETTINGS）
 * - clientApiSettings：localStorage 持久化 + clientApi 方法对象
 */

export {
  type CompactionSettings,
  type BranchSummarySettings,
  type ProviderRetrySettings,
  type RetrySettings,
  type TerminalSettings,
  type ImageSettings,
  type ThinkingBudgetsSettings,
  type MarkdownSettings,
  type WarningSettings,
  type PackageSource,
  type Settings,
  type ResponseStyle,
  type ThinkingLevel,
  type ProviderInfo,
  type CronJob,
  type McpServer,
} from './clientApi.types';

export {
  RESPONSE_STYLE_IDS,
  RESPONSE_STYLE_OPTIONS,
  normalizeSettingsText,
  normalizeResponseStyle,
  normalizeThinkingLevel,
  normalizeSettingsBool,
  normalizeCustomRules,
  parseSettingsJson,
  normalizeSettingsPartial,
  deepMergeSettings,
  getDefaultSettings,
  normalizeSettingsPayload,
} from './clientApiNormalize';

export { clientApi } from './clientApiSettings';
