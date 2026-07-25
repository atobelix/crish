/**
 * 多服务商配置（门面文件）。
 *
 * 保持 100% 向后兼容，重导出 provider-profiles 子模块中所有类型与公共 API。
 * 文件体精简为 ≤250 行的门面。
 */

export type {
  AuthType,
  FlatModelChoice,
  OAuthConfig,
  OAuthTokenData,
  PickDefaultModelOptions,
  ProviderProfile,
  ResolvedModelSelection,
} from './provider-profiles/profileCatalog';

export {
  DEFAULT_PROFILES,
  getDefaultProviderProfiles,
  KNOWN_PROFILE_LABELS,
  LEGACY_SEED_MODEL_ID_SET,
  LEGACY_SEED_MODELS,
  UNNAMED_PROFILE_LABEL,
} from './provider-profiles/profileCatalog';

export {
  flattenModelChoicesFrom,
  isEmptyModelCatalog,
  isLegacySeedModelId,
  mergeModelIds,
  normalizeModelIds,
  normalizeProfileLabelText,
  normalizeProviderProfile,
  normalizeProviderProfiles,
  pickDefaultModelId,
  pickDefaultModelSelection,
  profileDisplayLabel,
  profileHasKey,
  profileHasUsableModels,
  sameModelSet,
  stripLegacySeedModels,
  truncateProfileLabel,
} from './provider-profiles/profileValidation';

export type { ProviderSetupStatus } from './provider-profiles/profileStore';

export {
  activateProfileModel,
  addModelToProfile,
  anyProfileHasKey,
  anyProfileHasModel,
  clearActiveModelId,
  clearActiveProfileId,
  createCustomProfile,
  flattenModelChoices,
  getActiveModelId,
  getActiveProfile,
  getActiveProfileId,
  getProviderSetupStatus,
  loadProfiles,
  removeModelFromProfile,
  removeProfile,
  renameModelInProfile,
  renameProfile,
  resolveDisplayModelId,
  resolvePreferredModelSelection,
  sanitizeGhostActiveModel,
  saveProfileBaseUrl,
  saveProfileKey,
  saveProfiles,
  setActiveModelId,
  setActiveProfileId,
  setProfileEnabled,
  setProfileKey,
  syncActiveProfileToEngine,
  upsertProfile,
} from './provider-profiles/profileStore';

// Model meta helpers re-exported from modelCatalog for backward compatibility
export {
  formatModelDisplayName,
  setModelCapability,
  setModelContextLength,
  setModelDisplayName,
  setModelEnabled,
} from './modelCatalog';
