// 单模型深度规格配置与检查 ViewModel：
// 集成 useModelSpecDraft 通用规格草稿，负责默认模型提升、规格保存落盘与模型剔除自愈。
// 遵循 AGENTS.md 规范与 06-navigation-routing-and-vms.md 契约，单文件行数严格 <= 250。
import { useCallback, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { localChatStore } from '@/domain/store/localChatStore';
import type {
  LocalCurrencyKind,
  LocalModelSpec,
  LocalPricingSpec,
  LocalProviderSpec,
  LocalThinkingSpec,
  LocalThinkingTier,
} from '@/domain/types/localChat';
import { useModelSpecDraft, type ModelSpecDraftVm } from './useModelSpecDraft';

export interface ModelDetailVm {
  readonly providerId: string;
  readonly modelId: string;
  readonly provider: LocalProviderSpec | null;
  readonly model: LocalModelSpec | null;
  readonly isNotFound: boolean;
  readonly isDefault: boolean;
  readonly saved: boolean;

  // 深度规格草稿集成
  readonly draft: ModelSpecDraftVm;
  readonly spec: LocalModelSpec;
  readonly contextWindowText: string;
  readonly maxOutputTokensText: string;
  readonly thinkingTiers: readonly LocalThinkingTier[];
  readonly thinkingBadgeText: string;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly currency: LocalCurrencyKind;
  readonly pricingInput: string;
  readonly pricingOutput: string;

  // 规格修改快捷方法
  setContextWindow: (tokens: number | undefined) => void;
  setMaxOutputTokens: (tokens: number | undefined) => void;
  setThinking: (thinking: LocalThinkingSpec | undefined) => void;
  setThinkingTiers: (tiers: LocalThinkingTier[]) => void;
  setInputModalities: (mods: string[]) => void;
  setOutputModalities: (mods: string[]) => void;
  setPricing: (pricing: LocalPricingSpec | undefined) => void;

  // 领域与持久化操作
  setAsDefault: () => Promise<void>;
  setDefault: () => Promise<void>;
  removeModelFromProvider: () => Promise<void>;
  removeModel: () => Promise<void>;
  save: () => Promise<boolean>;
}

export function useModelDetailVm(
  providerId: string,
  modelId: string
): ModelDetailVm {
  const config = useStore(localChatStore, (s) => s.config);
  const activeModel = config.activeModel;
  const provider = config.providers[providerId] ?? null;

  const model = useMemo(
    () => provider?.models.find((m) => m.id === modelId) ?? null,
    [provider, modelId]
  );

  const isDefaultModel = useMemo(() => {
    if (!provider) return false;
    if (
      activeModel?.providerId === providerId &&
      activeModel.modelId === modelId
    )
      return true;
    return (provider.defaultModelId ?? provider.models[0]?.id) === modelId;
  }, [provider, activeModel, providerId, modelId]);

  const draft = useModelSpecDraft({
    initialSpec: model ?? { id: modelId, enabled: true },
    isDefault: isDefaultModel,
  });

  const [saved, setSaved] = useState(false);

  const setAsDefault = useCallback(async () => {
    draft.setIsDefault(true);
    const s = localChatStore.getState();
    const p = s.config.providers[providerId];
    if (!p) return;
    await s.upsertProvider(providerId, { ...p, defaultModelId: modelId });
    if (s.config.activeModel?.providerId === providerId) {
      s.setActiveModel(providerId, modelId);
    }
  }, [draft, providerId, modelId]);

  const removeModelFromProvider = useCallback(async () => {
    const s = localChatStore.getState();
    const p = s.config.providers[providerId];
    if (!p) return;
    const remaining = p.models.filter((m) => m.id !== modelId);
    const nextDefault =
      p.defaultModelId === modelId ? remaining[0]?.id : p.defaultModelId;
    await s.upsertProvider(providerId, {
      ...p,
      defaultModelId: nextDefault,
      models: remaining,
    });
    if (
      s.config.activeModel?.providerId === providerId &&
      s.config.activeModel.modelId === modelId &&
      nextDefault
    ) {
      s.setActiveModel(providerId, nextDefault);
    }
  }, [providerId, modelId]);

  const save = useCallback(async (): Promise<boolean> => {
    const s = localChatStore.getState();
    const p = s.config.providers[providerId];
    if (!p) return false;

    const currentModels = p.models;
    const exists = currentModels.some((m) => m.id === modelId);
    const updatedModels = exists
      ? currentModels.map((m) =>
          m.id === modelId ? { ...draft.spec, id: modelId } : m
        )
      : [...currentModels, { ...draft.spec, id: modelId }];

    let nextDefault = p.defaultModelId;
    if (draft.isDefault) {
      nextDefault = modelId;
    } else if (nextDefault === modelId) {
      nextDefault = updatedModels.find((m) => m.id !== modelId)?.id ?? modelId;
    }

    const updatedProvider: LocalProviderSpec = {
      ...p,
      defaultModelId: nextDefault,
      models: updatedModels,
    };

    await s.upsertProvider(providerId, updatedProvider);
    if (draft.isDefault && s.config.activeModel?.providerId === providerId) {
      s.setActiveModel(providerId, modelId);
    }
    setSaved(true);
    return true;
  }, [providerId, modelId, draft.spec, draft.isDefault]);

  return {
    providerId,
    modelId,
    provider,
    model,
    isNotFound: provider === null || model === null,
    isDefault: draft.isDefault,
    saved,
    draft,
    spec: draft.spec,
    contextWindowText: draft.contextWindowText,
    maxOutputTokensText: draft.maxOutputTokensText,
    thinkingTiers: draft.thinkingTiers,
    thinkingBadgeText: draft.thinkingBadgeText,
    inputModalities: draft.inputModalities,
    outputModalities: draft.outputModalities,
    currency: draft.currency,
    pricingInput: draft.pricingInput,
    pricingOutput: draft.pricingOutput,
    setContextWindow: draft.setContextWindow,
    setMaxOutputTokens: draft.setMaxOutputTokens,
    setThinking: draft.setThinking,
    setThinkingTiers: draft.setThinkingTiers,
    setInputModalities: draft.setInputModalities,
    setOutputModalities: draft.setOutputModalities,
    setPricing: draft.setPricing,
    setAsDefault,
    setDefault: setAsDefault,
    removeModelFromProvider,
    removeModel: removeModelFromProvider,
    save,
  };
}
