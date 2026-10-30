/**
 * OAuth 档案轨（LS）：统一树无法表达的供应商身份信息（authType、
 * oauthConfig、oauthToken、subscriptionPlan）持久化在这里。
 *
 * 单轨口径：
 * - 供应商/模型目录、启用态、活跃模型、apiKey 凭据状态 → 统一树
 *   （modelsCatalogStore，models.yaml）。本模块不存储、不镜像这些字段。
 * - localStorage `crish_provider_profiles_v1` 仅承载 OAuth/订阅档案；
 *   明文密钥迁移守卫（PE-07 T07.4-B）保留——迁移完成前禁止写回，
 *   防止「剥离明文时未落 DPAPI」造成密钥丢失。
 */

import { emitUiEvent } from '../uiEvents';
import type { ProviderProfile } from './profileCatalog';
import {
  normalizeProviderProfile,
  normalizeProviderProfiles,
  stripLegacySeedModels,
} from './profileValidation';
import {
  ensureLegacyProfilesMigration,
  LEGACY_MIGRATION_FLAG_KEY,
} from './migrateLegacyProfiles';
import { recordPendingContextState } from './contextStatePending';

const PROFILES_KEY = 'crish_provider_profiles_v1';

export function saveProfiles(list: ProviderProfile[]) {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify(list.map((p) => normalizeProviderProfile(p)))
  );
  try {
    emitUiEvent('profiles-changed');
  } catch {
    /* swallow-ok: 变更事件分发失败不影响已落盘的 profile */
  }
  // I1-α②（扩展点 A）：context-state 感知注入产生器——状态切换（模型/
  // 服务商/权限/思考档位）的快照文本暂存，下一次 run-task 携带排入
  // PendingMessageQueue（group_id=context-state 去重）→ 时间线注入。
  // 17 审计纪律：仅「切换发生」感知进 seq；配置/偏好本身留在配置带。
  recordPendingContextState();
}

export function loadProfiles(): ProviderProfile[] {
  // PE-07 T07.4-B：首次 loadProfiles 前置钩子——幂等标记未置时触发一次性
  // 明文迁移（模块级门控；失败不阻断启动）。迁移完成前不写回 LS，
  // 防止「剥离明文时未落 DPAPI」造成密钥丢失（见下方 changed 写回守卫）。
  void ensureLegacyProfilesMigration();
  const migrationPending = () => {
    try {
      return localStorage.getItem(LEGACY_MIGRATION_FLAG_KEY) !== '1';
    } catch {
      return false;
    }
  };
  const rawHasPlaintextKey = () => {
    try {
      const raw = localStorage.getItem(PROFILES_KEY);
      return Boolean(raw && /"apiKey"\s*:/.test(raw));
    } catch {
      return false;
    }
  };

  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const normalized = normalizeProviderProfiles(arr);
    if (normalized.length === 0) return [];

    let changed = normalized.length !== arr.length;
    const migrated = normalized.map((p) => stripLegacySeedModels(p));
    if (
      migrated.some((p, i) => p.models.length !== normalized[i]!.models.length)
    ) {
      changed = true;
    }
    if (changed) {
      // 明文迁移守卫：存量仍含 apiKey 且未置幂等标记 → 本次写回交给迁移负责
      // （迁移确认 DPAPI 落盘后自行剥离写回），此处跳过防密钥丢失。
      if (!(migrationPending() && rawHasPlaintextKey())) {
        localStorage.setItem(
          PROFILES_KEY,
          JSON.stringify(migrated.map((p) => normalizeProviderProfile(p)))
        );
        try {
          emitUiEvent('profiles-changed');
        } catch {
          /* swallow-ok: 迁移后事件分发失败不影响迁移结果 */
        }
      }
    }
    return migrated;
  } catch {
    return [];
  }
}

export function upsertProfile(profile: ProviderProfile) {
  const list = loadProfiles();
  const next = normalizeProviderProfile(profile);
  const i = list.findIndex((p) => p.id === next.id);
  if (i >= 0) list[i] = next;
  else list.push(next);
  saveProfiles(list);
  return list;
}

/** 删除 OAuth 档案记录（供应商本体的删除走统一树 removeProvider）。 */
export function removeProfile(profileId: string): ProviderProfile[] {
  const next = loadProfiles().filter((p) => p.id !== profileId);
  saveProfiles(next);
  return next;
}
