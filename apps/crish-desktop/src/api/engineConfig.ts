/**
 * Engine configuration — real daemon get-status / update-config.
 * Also keeps a local recent-models list for the chat picker.
 *
 * 本文件为纯 re-export hub（T4-11 / SR-06-R4 基线清零），保持消费方 import 路径不变。
 * 实现拆分到同目录子模块：
 * - engineConfigTypes.ts：类型定义
 * - engineConfigHelpers.ts：纯函数域（normalize / defaults / validation / readiness / parse）
 * - engineConfigIO.ts：localStorage + daemon I/O
 *
 * Pure helpers (normalize / defaults / endpoint validation / empty-partial)
 * never invent remote vendor demo model ids (e.g. mimo). Empty stays empty.
 */

export {
  type EngineLastErrorEntry,
  type EngineDiagnosticEntry,
  type EngineStatus,
  type EngineConfigUpdate,
  type EngineEndpointKind,
  type EngineCredentialMode,
  type NormalizedEngineConfig,
  type EngineBaseUrlValidation,
  type EngineConfigReadiness,
} from './engineConfigTypes';

export {
  normalizeEngineConfigText,
  normalizeEngineModelId,
  normalizeEngineBaseUrl,
  validateEngineBaseUrl,
  isValidEngineBaseUrl,
  normalizeEngineEndpointKind,
  normalizeEngineCredentialMode,
  normalizeEngineStreamFlag,
  emptyEngineConfig,
  defaultEngineConfigShell,
  normalizeEngineConfigUpdate,
  isEmptyEngineConfigUpdate,
  mergeEngineConfigPartial,
  engineConfigReadiness,
  isEmptyEngineConfig,
  isPartialEngineConfig,
  buildUpdateConfigPayload,
  normalizeRecentModels,
  mergeModelsForPicker,
  parseEngineStatusFromRaw,
} from './engineConfigHelpers';

export {
  loadRecentModels,
  pushRecentModel,
  fetchEngineStatus,
  loadEngineConfig,
  updateEngineConfig,
  modelsForPicker,
} from './engineConfigIO';
