/**
 * 活动 profile / model 的 localStorage 标记读写与幽灵清洗。
 *
 * 从 profileStore.ts 拆出（T4-11 SR-06-R3）：仅负责本机活动选择标记
 * 的存取与「幽灵活动模型」清洗，不含 profile 列表持久化或引擎同步。
 */

import { isLegacySeedModelId, normalizeModelIds } from './profileValidation';
import type { ProviderProfile } from './profileCatalog';

const ACTIVE_PROFILE_KEY = 'crish_active_profile_id';
const ACTIVE_MODEL_KEY = 'crish_active_model_id';

/** 清空本机活动模型 id（删除/禁用/迁移后防幽灵展示） */
export function clearActiveModelId(): void {
  try {
    localStorage.removeItem(ACTIVE_MODEL_KEY);
  } catch {
    /* swallow-ok: 活跃模型标记清理失败仅影响重启默认选中 */
  }
}

/** 清空本机活动 profile id */
export function clearActiveProfileId(): void {
  try {
    localStorage.removeItem(ACTIVE_PROFILE_KEY);
  } catch {
    /* swallow-ok: 活跃 profile 标记清理失败仅影响重启默认选中 */
  }
}

export function getActiveProfileId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROFILE_KEY);
  } catch {
    return null;
  }
}

export function setActiveProfileId(id: string) {
  localStorage.setItem(ACTIVE_PROFILE_KEY, id);
}

export function getActiveModelId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_MODEL_KEY);
  } catch {
    return null;
  }
}

export function setActiveModelId(model: string) {
  localStorage.setItem(ACTIVE_MODEL_KEY, model.trim());
}

/**
 * 清除「幽灵」活动 model：已知旧种子/演示 id，且当前未出现在任何启用供应商的 models 列表中。
 * - 用户通过 activate / 扫描把 mimo 等写进列表 → 保留（真实选择）
 * - 列表已空或已剥离种子，但 LS 仍挂着 mimo-v2.5 → 清掉，避免空 catalog 手填路径冒充已就绪
 * 返回是否清除了 active model。
 */
export function sanitizeGhostActiveModel(
  profiles: readonly ProviderProfile[] | null | undefined
): boolean {
  const mid = (getActiveModelId() || '').trim();
  if (!mid || !isLegacySeedModelId(mid)) return false;
  const listed = (profiles || []).some(
    (p) => p && p.enabled !== false && normalizeModelIds(p.models).includes(mid)
  );
  if (listed) return false;
  clearActiveModelId();
  return true;
}
