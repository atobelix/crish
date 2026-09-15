/**
 * 模型目录元数据：启用状态、上下文长度、扫描与连通测试。
 * 与 providerProfiles 配合：提供商上级，模型下级。
 *
 * 纯目录辅助（normalize / dedupe / usable / default pick）不写死远程 vendor 演示 id；
 * 空 catalog 不得回落 mimo 等硬编码默认。
 *
 * 实现已拆分至子模块（hub 仅 re-export，消费方 import 路径不变）：
 * - modelCatalogTypes：类型 / 常量枚举
 * - modelCatalogPure：纯目录辅助（normalize / dedupe / usable / pick / guess / label）
 * - modelCatalogMeta：localStorage 元数据读写
 * - modelCatalogIpc：扫描 / 上送 / 快照拉取 / 连通测试 / Picker 列表
 */

export {
  MODEL_CAPABILITY_OPTIONS,
  type ModelCapabilityKey,
  type ModelCapabilities,
  type ModelMeta,
  type CatalogModelEntry,
  type UsableCatalogOpts,
  type PickDefaultCatalogOpts,
  type ScannedModel,
  type CatalogSnapshotEntryWire,
  type CatalogSnapshotWire,
} from './modelCatalogTypes';

export {
  normalizeModelIdText,
  catalogEntryKey,
  normalizeCatalogEntry,
  normalizeCatalogEntries,
  dedupeCatalogEntries,
  isUsableCatalogEntry,
  filterUsableCatalogEntries,
  pickDefaultCatalogEntry,
  buildCatalogEntriesFromProfiles,
  catalogEntryDisplayLabel,
  formatModelEnabledLabel,
  formatLastTestLabel,
  isEmptyCatalog,
  guessContextLength,
  resetContextLengthCache,
  formatContextLabel,
  formatContextLabelZh,
} from './modelCatalogPure';

export {
  getModelMeta,
} from './modelCatalogMeta';

export {
  scanProviderModels,
  toCatalogCacheSnapshot,
  fetchCatalogSnapshot,
  testProviderModel,
  listPickerProfiles,
  listSettingsProfiles,
  listAvailablePickerModels,
  pickDefaultFromLocalCatalog,
} from './modelCatalogIpc';
