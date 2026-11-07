// 既有供应商综合管理视图模型：配置查看、基础信息维护、实测测速、已存模型列表与级联删除。
// 遵循 AGENTS.md 规范与 06-navigation-routing-and-vms.md 契约，单文件行数严格 <= 250。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { localChatStore } from '@/domain/store/localChatStore';
import {
  deriveProviderName,
  normalizeBaseUrl,
  providerDefaultModelId,
} from '@/domain/pure/localChatProtocol';
import type {
  LocalModelSpec,
  LocalProviderSpec,
  LocalThinkingSpec,
  LocalVendorKey,
} from '@/domain/types/localChat';
import {
  pingProviderEndpoint,
  type ProviderPingResult,
} from '@/adapters/localChat/localChatClient';
import { detectVendorKey } from '@/adapters/localChat/providerPresets';

export type ModalitySlotKind = 'text' | 'image' | 'file' | 'video' | 'audio';

export interface StoredModelRowItem {
  readonly id: string;
  readonly displayName?: string;
  readonly isDefault: boolean;
  readonly contextWindow?: number;
  readonly contextText: string;
  readonly maxOutputTokens?: number;
  readonly thinking?: LocalThinkingSpec;
  readonly thinkingTierText: string;
  readonly supportedModalities: ReadonlySet<ModalitySlotKind>;
  readonly raw: LocalModelSpec;
}

export interface ProviderDetailVm {
  readonly providerId: string;
  readonly provider: LocalProviderSpec | null;
  readonly isNotFound: boolean;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly newApiKey: string;
  readonly hasStoredKey: boolean;
  readonly vendor: LocalVendorKey;
  readonly models: readonly StoredModelRowItem[];
  readonly storedModels: readonly StoredModelRowItem[];
  readonly pinging: boolean;
  readonly pingResult: ProviderPingResult | null;
  readonly saved: boolean;
  setName: (name: string) => void;
  setBaseUrl: (baseUrl: string) => void;
  setApiKey: (key: string) => void;
  setNewApiKey: (key: string) => void;
  setVendor: (vendor: LocalVendorKey) => void;
  clearStoredKey: () => Promise<void>;
  setDefaultModel: (modelId: string) => Promise<void>;
  removeModel: (modelId: string) => Promise<void>;
  runPing: () => Promise<void>;
  testPing: () => Promise<void>;
  save: () => Promise<boolean>;
  saveChanges: () => Promise<boolean>;
  remove: () => Promise<void>;
  deleteProvider: () => Promise<void>;
}

export function extractSupportedModalities(
  spec: LocalModelSpec
): ReadonlySet<ModalitySlotKind> {
  const result = new Set<ModalitySlotKind>();
  for (const m of [
    ...(spec.modalities?.input ?? []),
    ...(spec.modalities?.output ?? []),
  ]) {
    const s = m.toLowerCase();
    if (s === 'text') result.add('text');
    else if (s === 'image' || s === 'vision') result.add('image');
    else if (s === 'file' || s === 'document') result.add('file');
    else if (s === 'video') result.add('video');
    else if (s === 'audio' || s === 'voice') result.add('audio');
  }
  if (result.size === 0) result.add('text');
  return result;
}

export function formatContextWindow(tokens?: number): string {
  if (!tokens || tokens <= 0) return '';
  if (tokens >= 1024 * 1024)
    return `${Number.isInteger(tokens / 1048576) ? tokens / 1048576 : (tokens / 1048576).toFixed(1)}M`;
  if (tokens >= 1000)
    return `${Number.isInteger(tokens / 1024) ? tokens / 1024 : Math.round(tokens / 1024)}k`;
  return `${tokens}`;
}

export function formatThinkingTierText(thinking?: LocalThinkingSpec): string {
  if (!thinking || !thinking.supported || thinking.defaultTier === 'off')
    return '关闭';
  const labels: Record<string, string> = {
    off: '关闭',
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '极限',
  };
  return labels[thinking.defaultTier] ?? thinking.defaultTier;
}

export function useProviderDetailVm(providerId: string): ProviderDetailVm {
  const config = useStore(localChatStore, (s) => s.config);
  const keyPresence = useStore(localChatStore, (s) => s.keyPresence);
  const provider = config.providers[providerId] ?? null;

  const [name, setName] = useState(() => provider?.displayName ?? '');
  const [baseUrl, setBaseUrl] = useState(() => provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [vendor, setVendor] = useState<LocalVendorKey>(
    () =>
      provider?.vendor ??
      detectVendorKey({
        name: provider?.displayName,
        baseUrl: provider?.baseUrl,
      })
  );
  const [hasStoredKey, setHasStoredKey] = useState(() =>
    Boolean(keyPresence[providerId] ?? provider?.apiKeyRef !== undefined)
  );
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<ProviderPingResult | null>(null);
  const [saved, setSaved] = useState(false);

  const lastLoadedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!provider) return;
    if (lastLoadedIdRef.current !== providerId) {
      lastLoadedIdRef.current = providerId;
      setName(provider.displayName ?? '');
      setBaseUrl(provider.baseUrl ?? '');
      setApiKey('');
      setVendor(
        provider.vendor ??
          detectVendorKey({
            name: provider.displayName,
            baseUrl: provider.baseUrl,
          })
      );
    }
    setHasStoredKey(
      Boolean(keyPresence[providerId] ?? provider.apiKeyRef !== undefined)
    );
  }, [providerId, provider, keyPresence]);

  const defaultModelId = useMemo(() => {
    if (!provider) return null;
    return (
      providerDefaultModelId(config, providerId) ??
      provider.defaultModelId ??
      provider.models[0]?.id ??
      null
    );
  }, [config, provider, providerId]);

  const models = useMemo<readonly StoredModelRowItem[]>(() => {
    if (!provider) return [];
    return provider.models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      isDefault: m.id === defaultModelId,
      contextWindow: m.contextWindow,
      contextText: formatContextWindow(m.contextWindow),
      maxOutputTokens: m.maxOutputTokens,
      thinking: m.thinking,
      thinkingTierText: formatThinkingTierText(m.thinking),
      supportedModalities: extractSupportedModalities(m),
      raw: m,
    }));
  }, [provider, defaultModelId]);

  const clearStoredKey = useCallback(async () => {
    const p = localChatStore.getState().config.providers[providerId];
    if (p) await localChatStore.getState().upsertProvider(providerId, p, null);
    setHasStoredKey(false);
    setApiKey('');
  }, [providerId]);

  const setDefaultModel = useCallback(
    async (modelId: string) => {
      const s = localChatStore.getState();
      const p = s.config.providers[providerId];
      if (!p) return;
      await s.upsertProvider(providerId, { ...p, defaultModelId: modelId });
      if (s.config.activeModel?.providerId === providerId)
        s.setActiveModel(providerId, modelId);
    },
    [providerId]
  );

  const removeModel = useCallback(
    async (modelId: string) => {
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
    },
    [providerId]
  );

  const runPing = useCallback(async () => {
    if (pinging) return;
    const targetUrl = baseUrl.trim() || provider?.baseUrl || '';
    if (!targetUrl) return;
    setPinging(true);
    setPingResult(null);
    try {
      const key =
        apiKey.trim() ||
        (hasStoredKey
          ? await localChatStore.getState().readApiKey(providerId)
          : null);
      const res = await pingProviderEndpoint({
        baseUrl: targetUrl,
        apiKey: key,
        vendor,
      });
      setPingResult(res);
      localChatStore
        .getState()
        .updateProviderLatency(providerId, res.ok ? res.latencyMs : null);
    } finally {
      setPinging(false);
    }
  }, [
    pinging,
    baseUrl,
    provider?.baseUrl,
    apiKey,
    hasStoredKey,
    providerId,
    vendor,
  ]);

  const save = useCallback(async (): Promise<boolean> => {
    const s = localChatStore.getState();
    const p = s.config.providers[providerId];
    if (!p || !baseUrl.trim()) return false;
    const normUrl = normalizeBaseUrl(baseUrl.trim());
    const dispName = name.trim() || deriveProviderName(normUrl);
    const keyArg = apiKey.trim() !== '' ? apiKey.trim() : undefined;
    await s.upsertProvider(
      providerId,
      { ...p, displayName: dispName, baseUrl: normUrl, vendor },
      keyArg
    );
    setApiKey('');
    if (keyArg !== undefined) setHasStoredKey(true);
    setSaved(true);
    return true;
  }, [providerId, name, baseUrl, vendor, apiKey]);

  const remove = useCallback(async () => {
    await localChatStore.getState().deleteProvider(providerId);
  }, [providerId]);

  return {
    providerId,
    provider,
    isNotFound: provider === null,
    name,
    baseUrl,
    apiKey,
    newApiKey: apiKey,
    hasStoredKey,
    vendor,
    models,
    storedModels: models,
    pinging,
    pingResult,
    saved,
    setName,
    setBaseUrl,
    setApiKey,
    setNewApiKey: setApiKey,
    setVendor,
    clearStoredKey,
    setDefaultModel,
    removeModel,
    runPing,
    testPing: runPing,
    save,
    saveChanges: save,
    remove,
    deleteProvider: remove,
  };
}
