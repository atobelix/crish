/**
 * OAuth 档案轨（门面 / hub re-export）。
 *
 * 单轨口径：供应商/模型目录、启用态、活跃模型、凭据状态全部在统一树
 * （modelsCatalogStore）；本门面只导出 LS 档案轨与激活/就绪态 API：
 * - profileKeySecret.ts        密钥落 DPAPI 凭据槽（唯一写入口）
 * - profileStorePersistence.ts OAuth 档案持久化 + 明文迁移守卫
 * - profileStoreActivation.ts  模型激活（树 CAS）+ 配置就绪态
 */

export { saveProfileKey } from './profileKeySecret';

export {
  saveProfiles,
  loadProfiles,
  upsertProfile,
  removeProfile,
} from './profileStorePersistence';

export {
  activateProfileModel,
  resolveDisplayModelId,
  getProviderSetupStatus,
} from './profileStoreActivation';

export type { ProviderSetupStatus } from './profileStoreActivation';
