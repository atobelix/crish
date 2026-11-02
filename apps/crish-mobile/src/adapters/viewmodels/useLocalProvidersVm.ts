// 本地供应商列表视图模型：配置面（localChatStore）的只读投影 + 活动切换/删除。
import { useCallback, useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { localChatStore } from '@/domain/store/localChatStore';
import { providerDefaultModelId } from '@/domain/pure/localChatProtocol';

export interface LocalProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  /** 默认模型（活动模型优先，其次清单首个） */
  defaultModelId: string | null;
  modelCount: number;
  hasKey: boolean;
  isActive: boolean;
}

export interface LocalProvidersVm {
  rows: readonly LocalProviderRow[];
  hydrated: boolean;
  /** 设为当前（活动模型 = 该供应商默认模型） */
  activate: (providerId: string) => void;
  /** 删除供应商（连带密钥与活动选择清理） */
  remove: (providerId: string) => Promise<void>;
}

export function useLocalProvidersVm(): LocalProvidersVm {
  const config = useStore(localChatStore, (s) => s.config);
  const hydrated = useStore(localChatStore, (s) => s.hydrated);
  const keyPresence = useStore(localChatStore, (s) => s.keyPresence);

  useEffect(() => {
    if (!localChatStore.getState().hydrated) {
      void localChatStore.getState().hydrate();
    }
  }, []);

  const rows = useMemo<LocalProviderRow[]>(
    () =>
      Object.entries(config.providers).map(([id, spec]) => ({
        id,
        name: spec.displayName ?? id,
        baseUrl: spec.baseUrl ?? '',
        defaultModelId: providerDefaultModelId(config, id),
        modelCount: spec.models.length,
        hasKey: keyPresence[id] ?? spec.apiKeyRef !== undefined,
        isActive: config.activeModel?.providerId === id,
      })),
    [config, keyPresence]
  );

  const activate = useCallback((providerId: string) => {
    const state = localChatStore.getState();
    const modelId = providerDefaultModelId(state.config, providerId);
    if (modelId !== null) state.setActiveModel(providerId, modelId);
  }, []);

  const remove = useCallback(async (providerId: string) => {
    await localChatStore.getState().deleteProvider(providerId);
  }, []);

  return { rows, hydrated, activate, remove };
}
