/**
 * 多服务商配置（门面文件）。
 *
 * 单轨收敛后本门面只保留两块：
 * - LS 档案轨（provider-profiles/*）：OAuth/订阅身份、DPAPI 密钥、模型激活；
 * - 供应商目录纯校验（profileValidation）：LS 档案记录的规范化。
 *
 * 供应商/模型目录、启用态、活跃模型统一在 `modelsCatalogStore`
 * （models.yaml 树）；旧 localStorage 目录/活跃键已清退，勿再引用。
 */

export type {
  AuthType,
  OAuthConfig,
  OAuthTokenData,
  ProviderProfile,
} from './provider-profiles/profileCatalog';

export { normalizeModelIds } from './modelsCatalogTypes';

export {
  normalizeProviderProfile,
  normalizeProviderProfiles,
  profileDisplayLabel,
  profileHasKey,
  truncateProfileLabel,
} from './provider-profiles/profileValidation';

export { saveProfileKey } from './provider-profiles/profileKeySecret';

export {
  ensureLegacyProfilesMigration,
  isLegacyMigrationDone,
  LEGACY_MIGRATION_FLAG_KEY,
  migrateLegacyProfiles,
  resetLegacyMigrationForTests,
  type LegacyMigrationResult,
} from './provider-profiles/migrateLegacyProfiles';

export {
  loadProfiles,
  saveProfiles,
  upsertProfile,
  removeProfile,
} from './provider-profiles/profileStorePersistence';

export {
  activateProfileModel,
  resolveDisplayModelId,
  getProviderSetupStatus,
} from './provider-profiles/profileStoreActivation';

export type { ProviderSetupStatus } from './provider-profiles/profileStoreActivation';
