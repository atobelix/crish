/**
 * 密钥内存缓存与 DPAPI 写入（K-01 明文下线）。
 *
 * 从 profileStore.ts 拆出（T4-11 SR-06-R3）：会话内密钥内存缓存、
 * 展示用掩码、以及密钥落 DPAPI 凭据槽的 setProfileKey。
 */

import { maskSecretLast4 } from '@crish/shared-utils';
import { configSecretClear, configSecretSet } from './rustProfileStore';
import { profileHasKey } from './profileValidation';
import type { ProviderProfile } from './profileCatalog';
import { saveProfiles, loadProfiles } from './profileStorePersistence';
import { selectProvider } from '../modelsCatalogStore';
import { providerHasKey as catalogProviderHasKey } from '../modelsCatalogLive';

/**
 * 会话内密钥内存缓存（K-01 明文下线的唯一例外持有面）：
 * 仅用户主动输入密钥（saveProfileKey / setProfileKey）时写入，
 * 供模型扫描 / 连通测试（modelCatalog）使用；永不落 localStorage。
 */
const profileKeyCache = new Map<string, string>();

/** 读取会话内密钥内存缓存（无 → undefined；仅限模型扫描/连通测试等必需场景） */
export function getProfileKeyInMemory(profileId: string): string | undefined {
  return profileKeyCache.get(profileId);
}

/** 展示用密钥掩码（last4 风格；无密钥 → 空串） */
export function maskProfileKeyForDisplay(apiKeyLast4?: string | null): string {
  const last = (apiKeyLast4 || '').trim();
  if (!last) return '';
  return maskSecretLast4(`sk-...${last}`);
}

/**
 * 保存密钥（K-01）：明文经 config_secret_set 落 DPAPI 凭据槽，
 * 本地仅写 hasKey 标记（不再写 p.apiKey 明文）；
 * 会话内同时写入内存缓存（模型扫描/连通测试用）。
 * 返回：DPAPI 结果 ok → hasKey=true；invoke missing（非 Tauri 环境）→
 * 降级为本地草稿标记（不落明文）；invoke 错误 → hasKey=false（不谎报已保存）。
 */
export async function setProfileKey(
  profileId: string,
  apiKey: string
): Promise<ProviderProfile[]> {
  const key = apiKey.trim();
  const list = loadProfiles();
  const p = list.find((x) => x.id === profileId);

  if (key) profileKeyCache.set(profileId, key);
  else profileKeyCache.delete(profileId);

  const res = key
    ? await configSecretSet(profileId, key)
    : await configSecretClear(profileId);
  if (p) {
    if (res.status === 'ok') {
      p.hasKey = Boolean(res.data?.hasKey);
    } else if (res.status === 'missing') {
      // 非 Tauri 环境（浏览器 dev）：降级为本地草稿标记（25-audit 允许）
      p.hasKey = Boolean(key);
    } else {
      p.hasKey = false;
    }
    saveProfiles(list);
  }
  return list;
}

/**
 * 保存密钥；若该 profile 已是活动项（或尚无活动项），同步到引擎。
 * K-01：密钥落 DPAPI（setProfileKey），同步走 config_profile_apply，
 * 全程无明文经 webview。
 */
export async function saveProfileKey(
  profileId: string,
  apiKey: string,
  opts?: { activateModel?: string }
): Promise<{ ok: boolean; error?: string; synced: boolean }> {
  const key = apiKey.trim();
  if (!key) return { ok: false, error: 'empty_key', synced: false };

  const list = await setProfileKey(profileId, key);
  const profile = list.find((p) => p.id === profileId);
  const inUnifiedStore = selectProvider(profileId);
  if (!profile && !inUnifiedStore)
    return { ok: false, error: 'profile_not_found', synced: false };

  const hasKey =
    catalogProviderHasKey(profileId) ||
    Boolean(profile?.hasKey) ||
    Boolean(getProfileKeyInMemory(profileId));
  if (!hasKey) return { ok: false, error: 'key_save_failed', synced: false };

  // 延迟导入避免与 profileStoreActivation 形成静态循环
  const { getActiveProfileId } = await import('./profileActiveSelection');
  const { activateProfileModel } = await import('./profileStoreActivation');

  const activeId = getActiveProfileId();
  const shouldSync =
    activeId === profileId || !activeId || Boolean(opts?.activateModel);

  if (!shouldSync) {
    return { ok: true, synced: false };
  }

  const { getActiveModelId } = await import('./profileActiveSelection');
  const model = (
    opts?.activateModel ||
    getActiveModelId() ||
    profile?.models?.[0] ||
    inUnifiedStore?.models?.[0]?.id ||
    ''
  ).trim();
  if (!model) {
    const { configProfileApply } = await import('./rustProfileStore');
    const baseUrl = profile?.baseUrl || inUnifiedStore?.baseUrl;
    const res = await configProfileApply({
      profileId,
      ...(baseUrl ? { baseUrl } : {}),
    });
    if (res.status === 'ok' && res.data?.ok === true) {
      const { setActiveProfileId } = await import('./profileActiveSelection');
      setActiveProfileId(profileId);
      return { ok: true, synced: true };
    }
    const error =
      res.status === 'missing'
        ? 'engine_unavailable'
        : res.status === 'error'
          ? res.message
          : 'apply_failed';
    return { ok: false, ...(error ? { error } : {}), synced: false };
  }

  const res = await activateProfileModel(profileId, model);
  return {
    ok: res.ok,
    ...(res.error ? { error: res.error } : {}),
    synced: res.ok,
  };
}

/** @internal 兼容旧内部名（profileStorePersistence / activation 共用） */
/** profileHasKey 透传（activation / setup-status 共用） */
export { profileHasKey };
