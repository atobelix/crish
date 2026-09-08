/**
 * modelsCatalogLive.ts —— 生产唯一读 API（plans/03 §3.2）
 *
 * 真源 = modelsCatalogStore（yaml 镜像）。禁止 LS / thinkingGear / 预填库。
 * 未加载或找不到 → undefined / [] / false。禁止猜测对象、禁止发明窗口、禁止合成「默认」档。
 * 定位键 (providerId, modelId) 大小写不敏感，与 modelIndex `${normPId}::${normMId}` 一致。
 */

import { modelsCatalogStore, selectModel, selectProvider } from './modelsCatalogStore';
import type {
  IndexedModelEntry,
  ModelSpec,
  ProviderSpec,
  ThinkingWireFormat,
} from './modelsCatalogTypes';

export type LiveThinkingOption = { title: string; wire: string };

export type LiveThinkingHandoff =
  | {
      supported: false;
      providerId: string;
      modelId: string;
      thinking: undefined;
      selectedTitle: null;
      selectedWire: null;
    }
  | {
      supported: true;
      providerId: string;
      modelId: string;
      thinking: Record<string, string>;
      selectedTitle: string;
      selectedWire: string;
      thinkingFormat?: ThinkingWireFormat;
    };

function isCatalogLoaded(): boolean {
  return modelsCatalogStore.getState().loaded === true;
}

function isEnabledFlag(flag: boolean | undefined): boolean {
  return flag !== false;
}

/** 未加载或找不到 → undefined。禁止返回猜测对象。 */
export function getLiveProvider(providerId: string): ProviderSpec | undefined {
  if (!isCatalogLoaded()) return undefined;
  return selectProvider(providerId);
}

/** 未加载或找不到 → undefined。原样交出 thinking / modalities / pricing / protocol。 */
export function getLiveModel(providerId: string, modelId: string): ModelSpec | undefined {
  if (!isCatalogLoaded()) return undefined;
  return selectModel(providerId, modelId);
}

/** 启用中的供应商 × 启用中的模型。顺序 = yaml 对象插入序。未加载 → []。 */
export function listLivePickerEntries(): IndexedModelEntry[] {
  const state = modelsCatalogStore.getState();
  if (state.loaded !== true) return [];

  const out: IndexedModelEntry[] = [];
  for (const [providerId, provider] of Object.entries(state.tree.providers || {})) {
    if (!isEnabledFlag(provider.enabled)) continue;
    for (const model of provider.models || []) {
      if (!isEnabledFlag(model.enabled)) continue;
      if (!(model.id || '').trim()) continue;
      out.push({ providerId, provider, model });
    }
  }
  return out;
}

/**
 * modalities.input 含该模态。
 * modalities 缺省或 input 非数组 → false（闭）。未加载 / 找不到 / 仅 capabilities 布尔 → false。
 */
export function modelAcceptsInput(
  providerId: string,
  modelId: string,
  modality: string
): boolean {
  const spec = getLiveModel(providerId, modelId);
  const input = spec?.modalities?.input;
  if (!Array.isArray(input)) return false;
  return input.includes(modality);
}

/**
 * thinking 为非空字典 → 支持思考。选项 = Object.entries，label=key，wire=value。
 * 无合成「默认」项。空字典 / 缺省 / 未加载 = []。
 */
export function listThinkingOptions(
  providerId: string,
  modelId: string
): LiveThinkingOption[] {
  const thinking = getLiveModel(providerId, modelId)?.thinking;
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) return [];
  return Object.entries(thinking).map(([title, wire]) => ({ title, wire }));
}

function unsupportedHandoff(providerId: string, modelId: string): LiveThinkingHandoff {
  return {
    supported: false,
    providerId,
    modelId,
    thinking: undefined,
    selectedTitle: null,
    selectedWire: null,
  };
}

/**
 * 选中 Title 对当前字典的解析。
 * selectedTitle 不在字典内 → 回落到字典第一项；字典空 → supported=false。
 */
export function resolveThinkingHandoff(
  providerId: string,
  modelId: string,
  selectedTitle: string | null
): LiveThinkingHandoff {
  const spec = getLiveModel(providerId, modelId);
  const thinking = spec?.thinking;
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) {
    return unsupportedHandoff(providerId, modelId);
  }

  const entries = Object.entries(thinking);
  if (entries.length === 0) {
    return unsupportedHandoff(providerId, modelId);
  }

  const hit =
    selectedTitle != null && Object.hasOwn(thinking, selectedTitle)
      ? selectedTitle
      : entries[0]![0];

  const provider = getLiveProvider(providerId);
  const thinkingFormat = (provider?.compat ?? spec.compat)?.thinkingFormat;

  const handoff: Extract<LiveThinkingHandoff, { supported: true }> = {
    supported: true,
    providerId,
    modelId,
    thinking,
    selectedTitle: hit,
    selectedWire: thinking[hit] ?? '',
  };
  if (thinkingFormat !== undefined) {
    handoff.thinkingFormat = thinkingFormat;
  }
  return handoff;
}
