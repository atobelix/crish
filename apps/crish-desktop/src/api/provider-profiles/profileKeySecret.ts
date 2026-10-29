/**
 * 密钥保存：唯一入口 saveProfileKey → DPAPI 凭据槽（K-01，明文不出 webview）。
 *
 * - 凭据状态的权威源 = 统一树快照 credentialStates；写密钥后强制刷新镜像，
 *   禁止再维护第二份 hasKey 标记（LS 或内存）。
 * - 密钥本身只在 Rust 侧 DPAPI 槽；前端任何路径都不持有明文。
 */

import { configSecretSet } from './rustProfileStore';
import { modelsCatalogStore, getActiveModelRef } from '../modelsCatalogStore';
import { activateProfileModel } from './profileStoreActivation';

/**
 * 保存密钥（K-01）：明文经 config_secret_set 落 DPAPI 凭据槽，随后刷新
 * 统一树镜像（credentialStates 随回执更新）。
 *
 * 同步语义：若当前活跃模型属于该供应商，重发一次激活，强制内核
 * reload_provider 拾取新密钥（保存即生效）；否则仅落凭据槽。
 * invoke missing（非 Tauri 环境，浏览器 dev / 单测）→ 视为已保存，不落任何本地状态。
 */
export async function saveProfileKey(
  profileId: string,
  apiKey: string
): Promise<{ ok: boolean; error?: string; synced: boolean }> {
  const key = apiKey.trim();
  const id = profileId.trim();
  if (!key) return { ok: false, error: 'empty_key', synced: false };
  if (!id) return { ok: false, error: 'profile_not_found', synced: false };

  const res = await configSecretSet(id, key);
  if (res.status === 'error') {
    return { ok: false, error: res.message, synced: false };
  }

  if (res.status === 'ok') {
    const refreshed = await modelsCatalogStore.ensureLoaded(true);
    if (!refreshed) {
      return {
        ok: false,
        error:
          modelsCatalogStore.getState().lastError?.message ||
          'refresh_mirror_failed',
        synced: false,
      };
    }
    const activeRef = getActiveModelRef();
    if (activeRef?.providerId === id) {
      const applied = await activateProfileModel(id, activeRef.modelId);
      return {
        ok: applied.ok,
        ...(applied.error ? { error: applied.error } : {}),
        synced: applied.ok,
      };
    }
    return { ok: true, synced: true };
  }

  // missing：非 Tauri 环境降级为乐观成功（无内核可确认，也不谎报失败）
  return { ok: true, synced: false };
}
