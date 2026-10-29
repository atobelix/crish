/**
 * 激活模型与展示解析：唯一真源 = 统一树 activeModel（modelsCatalogStore）。
 *
 * - 活跃模型只有一条写路径：modelsCatalogStore.setActiveModel（CAS 提交，
 *   内核落盘后自动 reload_provider，引擎侧无需再单独 apply）。
 * - 本模块不再读写任何「本机活跃选择」标记；OAuth 档案轨（LS）只承载身份，
 *   不承载选择。
 * - 密钥状态权威源 = 树快照 credentialStates（DPAPI 凭据槽回执）。
 */

import { pushRecentModel } from '../engineConfig';
import { emitUiEvent } from '../uiEvents';
import { modelsCatalogStore, getActiveModelRef } from '../modelsCatalogStore';
import {
  getLiveModel,
  getLiveProvider,
  listLivePickerEntries,
  providerHasKey,
} from '../modelsCatalogLive';
import { recordPendingContextState } from './contextStatePending';

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
 * 将指定供应商的模型置为全局活跃模型（树 CAS，一次冲突重试）。
 * 修订冲突先重读真源再重试一次，仍失败则显式报错，绝不静默吞掉。
 */
export async function activateProfileModel(
  profileId: string,
  model: string
): Promise<{
  ok: boolean;
  error?: string;
  warning?: 'no_local_key' | 'model_mismatch';
}> {
  const m = model.trim();
  const id = profileId.trim();
  if (!m) return { ok: false, error: 'empty_model' };
  if (!getLiveProvider(id)) return { ok: false, error: 'profile_not_found' };
  if (!getLiveModel(id, m)) return { ok: false, error: 'model_not_found' };

  const ref = { providerId: id, modelId: m };
  const first = await modelsCatalogStore.setActiveModel(ref);
  if (!first.ok) {
    const reloaded = await modelsCatalogStore.ensureLoaded(true);
    if (!reloaded) return { ok: false, error: first.error };
    const retry = await modelsCatalogStore.setActiveModel(ref);
    if (!retry.ok) return { ok: false, error: retry.error };
  }

  pushRecentModel(m, id);
  notifyModelChanged(id, m);

  try {
    const { fetchEngineStatus } = await import('../engineConfig');
    const status = await fetchEngineStatus();
    if (status.ok && status.model && status.model !== m) {
      return { ok: true, warning: 'model_mismatch' };
    }
  } catch {
    /* swallow-ok: 引擎状态核验失败时按乐观路径返回，不阻断切换 */
  }
  return {
    ok: true,
    ...(!providerHasKey(id) ? { warning: 'no_local_key' as const } : {}),
  };
}

/** 展示用：本机活动模型 id（树 activeModel），无则回落引擎模型，再无则空串 */
export function resolveDisplayModelId(engineModel?: string | null): string {
  return (getActiveModelRef()?.modelId || engineModel || '').trim();
}

/**
 * 首次 / 底栏共用的配置就绪态。
 * 密钥与名单只读统一树；引擎状态由调用方注入（engineOk / hasApiKey / model）。
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
  /** 模型选择器视图骨架常驻性（100% 恒定渲染为 true，不随未配 Key 坍塌） */
  showModelPicker: boolean;
};

export function getProviderSetupStatus(opts?: {
  engineHasApiKey?: boolean | null;
  engineModel?: string | null;
  engineOk?: boolean | null;
}): ProviderSetupStatus {
  const available = listLivePickerEntries();
  const hasLocalKey = available.some(({ providerId }) =>
    providerHasKey(providerId)
  );
  const engineOk = opts?.engineOk !== false;
  const hasEngineKey = Boolean(engineOk && opts?.engineHasApiKey === true);
  const hasKey = hasLocalKey || hasEngineKey;
  const hasLocalModel = available.length > 0;
  const activeRef = getActiveModelRef();

  const needsKeySetup = !hasKey;
  const needsModelSetup = hasKey && !activeRef && !hasLocalModel;

  return {
    hasLocalKey,
    hasEngineKey,
    hasKey,
    hasLocalModel,
    resolvedModel: activeRef?.modelId ?? null,
    resolvedProfileId: activeRef?.providerId ?? null,
    needsKeySetup,
    needsModelSetup,
    // 模型选择器作为输入坞核心第一公民，100% 恒定渲染，不随未配 Key 而消失
    showModelPicker: true,
  };
}
