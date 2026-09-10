/**
 * 本地与磁盘配置加密读写与引擎同步 Store 机制（门面 / hub re-export）。
 *
 * PE-07 T07.4（K-01）改造：明文 key 下线——
 * - key 读写改走 config_secret_* / config_profile_apply（DPAPI），不再明文落 LS；
 * - 本地仅存 hasKey 布尔标记与元数据；
 * - 展示用 last4 掩码（maskSecretLast4 / rustProfileStore 返回的 apiKeyLast4）。
 *
 * T4-11 SR-06-R3 基线清零：拆为 4 个职责子模块，本文件仅做 hub re-export，
 * 保持消费方 import 路径不变：
 * - profileActiveSelection.ts  活动 profile/model 标记 + 幽灵清洗
 * - profileKeySecret.ts        密钥内存缓存 + DPAPI 写入
 * - profileStorePersistence.ts 列表持久化 + 迁移守卫 + 增删改
 * - profileStoreActivation.ts  引擎同步 + 模型激活 + 配置就绪态
 */

export {
  clearActiveModelId,
  clearActiveProfileId,
  getActiveProfileId,
  setActiveProfileId,
  getActiveModelId,
  setActiveModelId,
  sanitizeGhostActiveModel,
} from './profileActiveSelection';

export {
  getProfileKeyInMemory,
  maskProfileKeyForDisplay,
  setProfileKey,
  saveProfileKey,
} from './profileKeySecret';

export {
  saveProfiles,
  loadProfiles,
  getActiveProfile,
  anyProfileHasKey,
  anyProfileHasModel,
  profileHasConfiguredKey,
  upsertProfile,
  createCustomProfile,
  removeProfile,
  setProfileEnabled,
  addModelToProfile,
  removeModelFromProfile,
  renameModelInProfile,
  renameProfile,
} from './profileStorePersistence';

export {
  saveProfileBaseUrl,
  resolvePreferredModelSelection,
  resolveDisplayModelId,
  activateProfileModel,
  flattenModelChoices,
  getProviderSetupStatus,
} from './profileStoreActivation';

export type { ProviderSetupStatus } from './profileStoreActivation';
