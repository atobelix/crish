/** 生产模型读取只消费已确认目录，绝不借助旧存储或预填数据补配。 */
import {
  modelsCatalogStore,
  selectModel,
  selectProvider,
  selectEffectiveCompat,
  listCatalogModels,
  listCatalogProviders,
} from './modelsCatalogStore';
import {
  THINKING_VOCABULARY,
  THINKING_VOCABULARY_LABELS,
} from './modelsNormalize';
import type {
  IndexedModelEntry,
  IndexedProviderEntry,
  ModelSpec,
  ProviderSpec,
  ThinkingLevelTitle,
  ThinkingMap,
  ThinkingWireFormat,
} from './modelsCatalogTypes';

export type LiveThinkingOption = {
  title: ThinkingLevelTitle;
  wire: string;
  label: string;
};
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
      thinking: ThinkingMap;
      selectedTitle: ThinkingLevelTitle | null;
      selectedWire: string | null;
      thinkingFormat?: ThinkingWireFormat;
    };

export function getLiveProvider(providerId: string): ProviderSpec | undefined {
  return selectProvider(providerId);
}

export function getLiveModel(
  providerId: string,
  modelId: string
): ModelSpec | undefined {
  return selectModel(providerId, modelId);
}

/** 只列已启用条目；相同顺序值维持配置中的稳定顺序。 */
export function listLivePickerEntries(): IndexedModelEntry[] {
  return listCatalogModels()
    .filter(({ provider, model }) => provider.enabled && model.enabled)
    .sort(
      (a, b) =>
        (a.provider.order ?? 0) - (b.provider.order ?? 0) ||
        (a.providerId === b.providerId
          ? (a.model.order ?? 0) - (b.model.order ?? 0)
          : 0)
    );
}

/** 服务商名单（含停用）只来自已确认镜像；顺序即配置文件顺序。 */
export function listLiveProviders(): IndexedProviderEntry[] {
  return listCatalogProviders();
}

/** 密钥状态权威源 = 快照 credentialStates；无记录视为无密钥，不回落旧存储。 */
export function providerHasKey(providerId: string): boolean {
  const id = providerId.trim();
  if (!id) return false;
  return modelsCatalogStore.getState().credentialStates[id]?.hasKey === true;
}

export function modelAcceptsInput(
  providerId: string,
  modelId: string,
  modality: string
): boolean {
  const provider = getLiveProvider(providerId);
  const model = getLiveModel(providerId, modelId);
  return Boolean(
    provider?.enabled &&
    model?.enabled &&
    model.modalities?.input.includes(modality)
  );
}

/** 保存的档位以规范词表顺序呈现，wire 保持原文。 */
export function listThinkingOptions(
  providerId: string,
  modelId: string
): LiveThinkingOption[] {
  const thinking = getLiveModel(providerId, modelId)?.thinking;
  if (!thinking) return [];
  return THINKING_VOCABULARY.flatMap((title) => {
    const wire = thinking[title];
    return wire === undefined
      ? []
      : [{ title, wire, label: THINKING_VOCABULARY_LABELS[title] }];
  });
}

export function isThinkingLevelAvailable(
  selectedLevel: string | null | undefined,
  availableLevels: readonly string[]
): boolean {
  return (
    selectedLevel != null &&
    selectedLevel !== '' &&
    THINKING_VOCABULARY.some((level) => level === selectedLevel) &&
    availableLevels.includes(selectedLevel)
  );
}

/** 未选择与明确请求一个不可用档位不同；后者不能静默省略出站参数。 */
export function resolveThinkingHandoff(
  providerId: string,
  modelId: string,
  selectedTitle: string | null
): LiveThinkingHandoff {
  const model = getLiveModel(providerId, modelId);
  const options = listThinkingOptions(providerId, modelId);
  if (!model || options.length === 0) {
    if (selectedTitle) throw new Error('当前模型未声明所选思考档位');
    return {
      supported: false,
      providerId,
      modelId,
      thinking: undefined,
      selectedTitle: null,
      selectedWire: null,
    };
  }
  const option = selectedTitle
    ? options.find((entry) => entry.title === selectedTitle)
    : undefined;
  if (selectedTitle && !option)
    throw new Error(`当前模型不支持思考档位：${selectedTitle}`);
  const thinking = model.thinking!;
  const thinkingFormat = selectEffectiveCompat(
    providerId,
    modelId
  )?.thinkingFormat;
  return {
    supported: true,
    providerId,
    modelId,
    thinking,
    selectedTitle: option?.title ?? null,
    selectedWire: option?.wire ?? null,
    ...(thinkingFormat !== undefined ? { thinkingFormat } : {}),
  };
}

/**
 * UI / 呈现层安全解析（不向外抛出异常，未命中或模型不支持时平滑回落）：
 * - 当模型未加载或不支持思考时，返回 supported: false，selectedTitle: null
 * - 当模型支持思考但未命中传入的 selectedTitle 时，返回 supported: true，selectedTitle: null（引导用户重选）
 */
export function resolveThinkingHandoffSafe(
  providerId: string,
  modelId: string,
  selectedTitle: string | null
): LiveThinkingHandoff {
  try {
    return resolveThinkingHandoff(providerId, modelId, selectedTitle);
  } catch {
    const model = getLiveModel(providerId, modelId);
    const options = listThinkingOptions(providerId, modelId);
    if (!model || options.length === 0 || !model.thinking) {
      return {
        supported: false,
        providerId,
        modelId,
        thinking: undefined,
        selectedTitle: null,
        selectedWire: null,
      };
    }
    const thinkingFormat = selectEffectiveCompat(
      providerId,
      modelId
    )?.thinkingFormat;
    return {
      supported: true,
      providerId,
      modelId,
      thinking: model.thinking,
      selectedTitle: null,
      selectedWire: null,
      ...(thinkingFormat !== undefined ? { thinkingFormat } : {}),
    };
  }
}
