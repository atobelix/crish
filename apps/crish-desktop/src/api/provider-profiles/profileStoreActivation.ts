/**
 * 引擎同步与模型激活（K-01 DPAPI）。
 *
 * 从 profileStore.ts 拆出（T4-11 SR-06-R3）：将指定 profile + 模型
 * 应用到引擎的 activateProfileModel，以及保存 Base URL 后的引擎同步。
 */

import { pushRecentModel } from '../engineConfig';
import { emitUiEvent } from '../uiEvents';
import { configProfileApply } from './rustProfileStore';
import {
  type FlatModelChoice,
  type ProviderProfile,
  type ResolvedModelSelection,
} from './profileCatalog';
import {
  flattenModelChoicesFrom,
  pickDefaultModelSelection,
  profileHasKey,
} from './profileValidation';
import { recordPendingContextState } from './contextStatePending';
import {
  loadProfiles,
  saveProfiles,
  addModelToProfile,
  anyProfileHasKey,
  anyProfileHasModel,
} from './profileStorePersistence';
import {
  getActiveProfileId,
  setActiveProfileId,
  getActiveModelId,
  setActiveModelId,
} from './profileActiveSelection';

/**
 * 保存 Base URL；若该 profile 为当前活动项，同步到引擎（保存即生效）。
 * K-01：同步走 config_profile_apply（密钥由 Rust 从 DPAPI 槽读取），
 * 不再携带明文 key。
 */
export async function saveProfileBaseUrl(
  profileId: string,
  baseUrl: string
): Promise<{ ok: boolean; error?: string; synced: boolean }> {
  const list = loadProfiles();
  const p = list.find((x) => x.id === profileId);
  if (!p) return { ok: false, error: 'profile_not_found', synced: false };

  p.baseUrl = baseUrl.trim();
  saveProfiles(list);

  if (getActiveProfileId() !== profileId) {
    return { ok: true, synced: false };
  }

  const model = (getActiveModelId() || p.models[0] || '').trim();
  const res = await configProfileApply({
    profileId,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    ...(model ? { model } : {}),
  });
  if (res.status !== 'ok' || res.data?.ok !== true) {
    const error =
      res.status === 'missing'
        ? 'engine_unavailable'
        : res.status === 'error'
          ? res.message
          : 'apply_failed';
    return { ok: false, ...(error ? { error } : {}), synced: false };
  }
  return { ok: true, synced: true };
}

/**
 * 本地优先的活动模型解析（对话底栏 / 启动同步共用）。
 */
export function resolvePreferredModelSelection(opts?: {
  engineModel?: string | null;
  requireInList?: boolean;
}): ResolvedModelSelection | null {
  return pickDefaultModelSelection(loadProfiles(), {
    storedProfileId: getActiveProfileId(),
    storedModel: getActiveModelId(),
    engineModel: opts?.engineModel,
    requireInList: opts?.requireInList,
  });
}

/** 展示用：本机活动模型 id（解析后），无则空串 */
export function resolveDisplayModelId(engineModel?: string | null): string {
  const resolved = resolvePreferredModelSelection(
    engineModel !== undefined ? { engineModel } : {}
  );
  if (resolved) return resolved.model;
  return (getActiveModelId() || '').trim();
}

/** 将活动选择写入 Settings.defaultModel/defaultProvider */
async function persistSelectionToAppSettings(
  profileId: string,
  model: string
): Promise<void> {
  try {
    const { clientApi } = await import('../clientApi');
    const merged = await clientApi.updateSettings({
      defaultProvider: profileId,
      defaultModel: model,
    });
    try {
      const { useSettingsStore } = await import('../../store');
      useSettingsStore.getState().setAppSettings(merged);
    } catch {
      /* swallow-ok: store 未就绪时跳过设置同步 */
    }
  } catch {
    /* swallow-ok: settings 写失败不阻断引擎切换 */
  }
}

function notifyModelChanged(profileId: string, model: string) {
  try {
    emitUiEvent('model-changed', { profileId, model });
  } catch {
    /* swallow-ok: 模型切换事件分发失败不影响已切换状态 */
  }
  // I1-α②：模型/服务商切换的 context-state 感知注入（模块级去重 +
  // 引擎 group_id=context-state 去重，连切两次只注入一次）
  recordPendingContextState();
}

/**
 * 将指定 profile + 模型应用到引擎。
 * K-01：密钥由 Rust 从 DPAPI 槽读取（config_profile_apply），
 * webview 不再持有明文（hasLocalKey 仅由 hasKey 标记判定）。
 */
export async function activateProfileModel(
  profileId: string,
  model: string
): Promise<{
  ok: boolean;
  error?: string;
  warning?: 'no_local_key' | 'model_mismatch';
}> {
  const p = loadProfiles().find((x) => x.id === profileId);
  if (!p) return { ok: false, error: 'profile_not_found' };

  const m = model.trim();
  if (!m) return { ok: false, error: 'empty_model' };

  if (!p.models.includes(m)) {
    addModelToProfile(profileId, m);
  }

  const fresh = loadProfiles().find((x) => x.id === profileId) || p;
  const hasLocalKey = profileHasKey(fresh);

  const res = await configProfileApply({
    profileId,
    ...(fresh.baseUrl ? { baseUrl: fresh.baseUrl } : {}),
    model: m,
  });
  if (res.status !== 'ok' || res.data?.ok !== true) {
    const error =
      res.status === 'missing'
        ? 'engine_unavailable'
        : res.status === 'error'
          ? res.message
          : 'apply_failed';
    return { ok: false, ...(error ? { error } : {}) };
  }
  const applied = res.data;

  setActiveProfileId(profileId);
  setActiveModelId(m);
  pushRecentModel(m);
  notifyModelChanged(profileId, m);
  void persistSelectionToAppSettings(profileId, m);
  try {
    const { fetchEngineStatus } = await import('../engineConfig');
    const status = await fetchEngineStatus();
    if (status.ok && status.model && status.model !== m) {
      return { ok: true, warning: 'model_mismatch' };
    }
    if (!hasLocalKey || (status.ok && status.hasApiKey === false)) {
      return {
        ok: true,
        ...(!hasLocalKey ? { warning: 'no_local_key' as const } : {}),
      };
    }
  } catch {
    /* swallow-ok: 引擎状态核验失败时按乐观路径返回，不阻断切换 */
  }
  return {
    ok: true,
    ...(!hasLocalKey ? { warning: 'no_local_key' as const } : {}),
    ...(applied.apiKeyLast4 ? { apiKeyLast4: applied.apiKeyLast4 } : {}),
  };
}

/**
 * 扁平化「真实配置过的」模型。
 */
export function flattenModelChoices(): FlatModelChoice[] {
  return flattenModelChoicesFrom(loadProfiles());
}

/**
 * 首次 / 底栏共用的配置就绪态（本地优先）。
 */
export type ProviderSetupStatus = {
  hasLocalKey: boolean;
  hasEngineKey: boolean;
  hasKey: boolean;
  hasLocalModel: boolean;
  resolvedModel: string | null;
  resolvedProfileId: string | null;
  needsKeySetup: boolean;
  needsModelSetup: boolean;
  showModelPicker: boolean;
};

export function getProviderSetupStatus(opts?: {
  engineHasApiKey?: boolean | null;
  engineModel?: string | null;
  engineOk?: boolean | null;
}): ProviderSetupStatus {
  const hasLocalKey = anyProfileHasKey();
  const engineOk = opts?.engineOk !== false;
  const hasEngineKey = Boolean(engineOk && opts?.engineHasApiKey === true);
  const hasKey = hasLocalKey || hasEngineKey;
  const hasLocalModel = anyProfileHasModel();
  const resolved = resolvePreferredModelSelection({
    ...(opts?.engineModel !== undefined
      ? { engineModel: opts.engineModel }
      : {}),
  });
  const resolvedModel = resolved?.model || null;
  const resolvedProfileId = resolved?.profileId || null;

  const needsKeySetup = !hasKey;
  const needsModelSetup = hasKey && !resolvedModel && !hasLocalModel;

  return {
    hasLocalKey,
    hasEngineKey,
    hasKey,
    hasLocalModel,
    resolvedModel,
    resolvedProfileId,
    needsKeySetup,
    needsModelSetup,
    showModelPicker: hasKey,
  };
}
