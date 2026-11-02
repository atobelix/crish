// 本地供应商编辑视图模型：草稿态 + 保存（校验→写配置/密钥）+ 拉取模型
// + 连通性自检（均以草稿现值实测，未保存也可测；密钥留空时用已存密钥）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { localChatStore } from '@/domain/store/localChatStore';
import {
  mergeModelIds,
  providerSpecFromDraft,
  validateProviderDraft,
} from '@/domain/pure/localChatProtocol';
import { nextId } from '@/domain/pure/id';
import type {
  LocalChatError,
  LocalConnectivityResult,
  LocalProviderDraft,
  ProviderDraftIssue,
} from '@/domain/types/localChat';
import { getLocalChatClient } from '@/adapters/localChat/localChatWiring';

export interface LocalProviderEditVm {
  /** 编辑目标（null = 新建） */
  providerId: string | null;
  isNew: boolean;
  draft: LocalProviderDraft;
  /** 既有供应商已存密钥（编辑时密钥框留空 = 不改） */
  hasStoredKey: boolean;
  issues: readonly ProviderDraftIssue[];
  canSave: boolean;
  fetchingModels: boolean;
  fetchError: LocalChatError | null;
  checking: boolean;
  checkResult: LocalConnectivityResult | null;
  saved: boolean;
  setName: (v: string) => void;
  setBaseUrl: (v: string) => void;
  setApiKey: (v: string) => void;
  setDefaultModelId: (v: string) => void;
  addModel: (id: string) => void;
  removeModel: (id: string) => void;
  fetchModels: () => Promise<void>;
  checkConnectivity: () => Promise<void>;
  save: () => Promise<boolean>;
  clearStoredKey: () => Promise<void>;
}

export function useLocalProviderEditVm(
  providerId: string | null
): LocalProviderEditVm {
  const isNew = providerId === null;
  const idRef = useRef<string>(providerId ?? nextId('provider'));
  const [draft, setDraft] = useState<LocalProviderDraft>({
    name: '',
    baseUrl: '',
    apiKey: '',
    modelIds: [],
    defaultModelId: '',
  });
  const [loaded, setLoaded] = useState(isNew);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<LocalChatError | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] =
    useState<LocalConnectivityResult | null>(null);
  const [saved, setSaved] = useState(false);

  // 编辑既有供应商：从配置回填草稿（密钥不回填明文，只记存在性）
  useEffect(() => {
    if (isNew || loaded) return;
    const state = localChatStore.getState();
    const spec = state.config.providers[providerId];
    if (spec) {
      const modelIds = spec.models.map((m) => m.id);
      setDraft({
        name: spec.displayName ?? '',
        baseUrl: spec.baseUrl ?? '',
        apiKey: '',
        modelIds,
        defaultModelId:
          state.config.activeModel?.providerId === providerId
            ? state.config.activeModel.modelId
            : (modelIds[0] ?? ''),
      });
      setHasStoredKey(
        state.keyPresence[providerId] ?? spec.apiKeyRef !== undefined
      );
    }
    setLoaded(true);
  }, [isNew, loaded, providerId]);

  const issues = useMemo(() => validateProviderDraft(draft), [draft]);
  const canSave = issues.length === 0;

  const patch = useCallback((p: Partial<LocalProviderDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setSaved(false);
  }, []);

  /** 自检/拉取用的有效密钥：草稿填了用草稿的，否则用已存的 */
  const effectiveApiKey = useCallback(async (): Promise<string | null> => {
    if (draft.apiKey.trim() !== '') return draft.apiKey.trim();
    if (isNew) return null;
    return localChatStore.getState().readApiKey(idRef.current);
  }, [draft.apiKey, isNew]);

  const fetchModels = useCallback(async () => {
    if (draft.baseUrl.trim() === '' || fetchingModels) return;
    setFetchingModels(true);
    setFetchError(null);
    try {
      const apiKey = await effectiveApiKey();
      const ids = await getLocalChatClient().fetchProviderModels({
        baseUrl: draft.baseUrl,
        apiKey,
      });
      setDraft((d) => ({
        ...d,
        modelIds: mergeModelIds(d.modelIds, ids),
        defaultModelId:
          d.defaultModelId !== '' ? d.defaultModelId : (ids[0] ?? ''),
      }));
    } catch (err) {
      setFetchError(err as LocalChatError);
    } finally {
      setFetchingModels(false);
    }
  }, [draft.baseUrl, effectiveApiKey, fetchingModels]);

  const checkConnectivity = useCallback(async () => {
    const model = draft.defaultModelId.trim() || draft.modelIds[0] || '';
    if (draft.baseUrl.trim() === '' || model === '' || checking) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const apiKey = await effectiveApiKey();
      const result = await getLocalChatClient().checkConnectivity({
        baseUrl: draft.baseUrl,
        apiKey,
        model,
      });
      setCheckResult(result);
    } finally {
      setChecking(false);
    }
  }, [draft, checking, effectiveApiKey]);

  const save = useCallback(async (): Promise<boolean> => {
    if (validateProviderDraft(draft).length > 0) return false;
    const spec = providerSpecFromDraft(draft);
    const id = idRef.current;
    const existing = localChatStore.getState().config.providers[id];
    if (existing?.apiKeyRef !== undefined) {
      spec.apiKeyRef = existing.apiKeyRef;
    }
    const keyArg: string | null | undefined =
      draft.apiKey.trim() !== '' ? draft.apiKey.trim() : undefined;
    await localChatStore.getState().upsertProvider(id, spec, keyArg);
    // 设默认模型为活动（编辑的正是当前供应商或尚无活动选择时由 store 归一；
    // 这里显式落位默认模型，保证「保存即生效」口径清晰）
    const modelId = draft.defaultModelId.trim() || spec.models[0]?.id;
    if (modelId) {
      const state = localChatStore.getState();
      if (
        state.config.activeModel?.providerId === id ||
        isNew ||
        state.config.activeModel === null
      ) {
        state.setActiveModel(id, modelId);
      }
    }
    setHasStoredKey(
      draft.apiKey.trim() !== '' || existing?.apiKeyRef !== undefined
    );
    setSaved(true);
    return true;
  }, [draft, isNew]);

  const clearStoredKey = useCallback(async () => {
    const id = idRef.current;
    const existing = localChatStore.getState().config.providers[id];
    if (!existing) return;
    await localChatStore.getState().upsertProvider(id, existing, null);
    setHasStoredKey(false);
  }, []);

  return {
    providerId: isNew ? null : providerId,
    isNew,
    draft,
    hasStoredKey,
    issues,
    canSave,
    fetchingModels,
    fetchError,
    checking,
    checkResult,
    saved,
    setName: (v) => patch({ name: v }),
    setBaseUrl: (v) => patch({ baseUrl: v }),
    setApiKey: (v) => patch({ apiKey: v }),
    setDefaultModelId: (v) => patch({ defaultModelId: v }),
    addModel: (id) =>
      setDraft((d) => ({ ...d, modelIds: mergeModelIds(d.modelIds, [id]) })),
    removeModel: (id) =>
      setDraft((d) => ({
        ...d,
        modelIds: d.modelIds.filter((m) => m !== id),
        defaultModelId: d.defaultModelId === id ? '' : d.defaultModelId,
      })),
    fetchModels,
    checkConnectivity,
    save,
    clearStoredKey,
  };
}
