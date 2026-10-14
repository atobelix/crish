/**
 * @crish/plugin-import-claude-codex 官方插件入口。
 *
 * 生态链路（E3）：manifest 声明（能力清单）→ activate（observe 观察）→
 * 纯函数工具（parse / map / detect）→ 宿主接线（apps/crish-desktop 消费本包，
 * 替代原 api/import 纯函数层；ImportFs 等宿主能力经注入面接入）。
 */

export {
  manifest,
  PLUGIN_ID,
  TOOL_PARSE_CLAUDE_CODE,
  TOOL_PARSE_CODEX_ROLLOUT,
} from './manifest';
export type {
  ImportPluginManifest,
  ImportPluginToolDeclaration,
} from './manifest';
export { activate, SESSION_START_USAGE_NOTE } from './activate';
export type { PluginActivateApi } from './activate';
export {
  parseClaudeCodeTool,
  parseCodexRolloutTool,
  parseClaudeCodeConversation,
  parseCodexRolloutConversation,
  getToolDeclarations,
  toolInputSchema,
} from './tools';
export type {
  ParseClaudeCodeToolInput,
  ParseCodexRolloutToolInput,
} from './tools';
export { parseClaudeCodeJsonl } from './parse/claude-code';
export type { ParseClaudeCodeOptions } from './parse/claude-code';
export { parseCodexRolloutJsonl } from './parse/codex';
export type { ParseCodexRolloutOptions } from './parse/codex';
export { mapToCrishSession, folderFromCwd, pickTitle } from './map';
export {
  detectExternalSessions,
  resolveDefaultImportRoots,
  joinImportPath,
  mungeProjectPath,
  extractJsonStringField,
  extractClaudeTitlePreview,
  extractCodexTitlePreview,
  truncatePreview,
  estimateLineCount,
} from './detect';
export { stripBoilerplate, isPureBoilerplate } from './boilerplate';
export { externalSourceLabel } from './types';
export type {
  ExternalSessionSource,
  ImportSource,
  NormalizedImportTurn,
  ParsedExternalConversation,
  ImportMessageDraft,
  ImportToolCallDraft,
  MapToCrishSessionOptions,
  SessionImportPayload,
  ImportPathEnv,
  ExternalImportRoots,
  ImportDirEntry,
  ImportFs,
  ExternalSessionMeta,
  DetectExternalSessionsOptions,
  DetectExternalSessionsResult,
} from './types';
