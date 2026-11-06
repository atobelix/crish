// 移动端供应商与模型添加向导视图模型（useProviderWizardVm）：
// 支持全新接入（Step 1 -> 2 -> 3）与既有供应商定向增模（isTargetedMode，跳过 Step 1 进 Step 2）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { localChatStore } from '@/domain/store/localChatStore';
import { isHttpUrl, normalizeBaseUrl } from '@/domain/pure/localChatProtocol';
import { nextId } from '@/domain/pure/id';
import { readTextFromClipboard, sanitizeApiKeyInput } from '@/adapters/platform/clipboard';
import {
  PROVIDER_PRESETS,
  detectVendorKey,
  type LocalModelSpec,
} from '@/adapters/localChat/providerPresets';
import {
  fetchProviderModelsRobust,
  hydrateModelSpec,
  pingProviderEndpoint,
} from '@/adapters/localChat/localChatClient';
import type {
  LocalProviderSpec,
  LocalVendorKey,
} from '@/domain/types/localChat';

export type WizardPingStatus = 'idle' | 'testing' | 'success' | 'error';

export interface ProviderConnectionDraft {
  name: string; baseUrl: string; apiKey: string; vendor: LocalVendorKey;
}

export interface UseProviderWizardVmOptions {
  initialPresetKey?: string | null; targetProviderId?: string | null;
  onSaved?: (providerId: string) => void; onCancel?: () => void;
}

export interface ProviderWizardVm {
  readonly mode: 'new' | 'addModels'; readonly isTargetedMode: boolean;
  readonly targetProviderId: string | null; readonly targetProviderName?: string;
  readonly step: 1 | 2 | 3; readonly setStep: (step: 1 | 2 | 3) => void; readonly presetKey: LocalVendorKey | null;

  readonly connectionDraft: ProviderConnectionDraft;
  readonly name: string; readonly baseUrl: string; readonly apiKey: string; readonly vendor: LocalVendorKey;
  readonly apiKeyPlaceholder: string; readonly isStep1Valid: boolean;
  readonly pingStatus: WizardPingStatus; readonly pinging: boolean; readonly latencyMs: number | null;
  readonly pingResult: { ok: boolean; latencyMs?: number; error?: string } | null;
  setConnectionField: <K extends keyof ProviderConnectionDraft>(k: K, v: ProviderConnectionDraft[K]) => void;
  setName: (name: string) => void; setBaseUrl: (baseUrl: string) => void;
  setApiKey: (apiKey: string) => void; setVendor: (vendor: LocalVendorKey) => void;
  applyPreset: (vendorKey: LocalVendorKey | string) => void; pasteApiKey: () => Promise<string>;
  runPing: () => Promise<boolean>; runPingTest: () => Promise<boolean>;

  readonly availableModels: readonly LocalModelSpec[]; readonly selectedModelIds: ReadonlySet<string>;
  readonly searchQuery: string; readonly filterQuery: string;
  readonly filteredModels: readonly LocalModelSpec[]; readonly fetchingModels: boolean;
  readonly fetchError: string | null; readonly isStep2Valid: boolean;
  setSearchQuery: (query: string) => void; setFilterQuery: (query: string) => void;
  selectAll: () => void; clearAll: () => void;
  toggleModel: (id: string, force?: boolean) => void; toggleModelSelection: (id: string, force?: boolean) => void;
  rangeSelect: (ids: readonly string[], selected?: boolean) => void;
  setSelectedModelIds: (ids: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  addCustomModel: (id: string) => boolean; addCustomModelId: (id: string) => boolean;
  fetchOnlineModels: () => Promise<void>; fetchModels: () => Promise<void>;

  readonly selectedModels: readonly LocalModelSpec[]; readonly activeModelId: string; readonly activeSpecModelId: string;
  readonly currentSpec: LocalModelSpec | null; readonly currentSpecDraft: LocalModelSpec | null;
  setActiveModelId: (id: string) => void; setActiveSpecModelId: (id: string) => void;
  updateCurrentModelSpec: (updater: (prev: LocalModelSpec) => LocalModelSpec) => void;
  applyCurrentSpecToAll: () => void; applyCurrentSpecsToAll: () => void;
  readonly hasUnconfiguredWarning: boolean; readonly unconfiguredWarningOpen: boolean;
  setUnconfiguredWarningOpen: (open: boolean) => void;

  readonly canGoNext: boolean; goToNextStep: () => void; goToPrevStep: () => void;
  finishWizard: (skipWarning?: boolean) => Promise<boolean>; finishSave: (skipWarning?: boolean) => Promise<boolean>;
}

export function useProviderWizardVm(options?: UseProviderWizardVmOptions): ProviderWizardVm {
  const targetProviderId = options?.targetProviderId ?? null;
  const isTargetedMode = Boolean(targetProviderId);
  const providers = useStore(localChatStore, (s) => s.config.providers);
  const targetProvider = targetProviderId ? providers[targetProviderId] : undefined;

  const [step, setStep] = useState<1 | 2 | 3>(isTargetedMode ? 2 : 1);
  const [presetKey, setPresetKey] = useState<LocalVendorKey | null>(() =>
    options?.initialPresetKey ? detectVendorKey(options.initialPresetKey) : null
  );
  const manualVendorRef = useRef(Boolean(options?.initialPresetKey || isTargetedMode));

  const [connectionDraft, setConnectionDraft] = useState<ProviderConnectionDraft>(() => {
    if (isTargetedMode && targetProvider) {
      return {
        name: targetProvider.displayName ?? '', baseUrl: targetProvider.baseUrl ?? '', apiKey: '',
        vendor: targetProvider.vendor ?? detectVendorKey(targetProvider.baseUrl),
      };
    }
    const p = presetKey ? PROVIDER_PRESETS[presetKey] : undefined;
    return {
      name: p?.displayName ?? p?.name ?? '', baseUrl: p?.defaultBaseUrl ?? '', apiKey: '', vendor: p?.vendor ?? 'custom',
    };
  });

  useEffect(() => {
    if (isTargetedMode && targetProvider && !connectionDraft.name) {
      setConnectionDraft({
        name: targetProvider.displayName ?? '', baseUrl: targetProvider.baseUrl ?? '', apiKey: '',
        vendor: targetProvider.vendor ?? detectVendorKey(targetProvider.baseUrl),
      });
    }
  }, [isTargetedMode, targetProvider, connectionDraft.name]);

  const [pingStatus, setPingStatus] = useState<WizardPingStatus>('idle');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [pingResult, setPingResult] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);

  const [availableModels, setAvailableModels] = useState<LocalModelSpec[]>(() => {
    if (isTargetedMode && targetProvider?.models) return [...targetProvider.models];
    return presetKey && PROVIDER_PRESETS[presetKey]?.recommendedModels ? [...PROVIDER_PRESETS[presetKey].recommendedModels] : [];
  });

  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(() =>
    presetKey && PROVIDER_PRESETS[presetKey]?.recommendedModels
      ? new Set(PROVIDER_PRESETS[presetKey].recommendedModels.slice(0, 2).map((m) => m.id))
      : new Set()
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [modelSpecs, setModelSpecs] = useState<Record<string, LocalModelSpec>>(() => {
    const init: Record<string, LocalModelSpec> = {};
    const list = targetProvider?.models ?? (presetKey ? PROVIDER_PRESETS[presetKey]?.recommendedModels : undefined);
    if (list) for (const m of list) init[m.id] = { ...m };
    return init;
  });

  const [activeModelId, setActiveModelId] = useState<string>(
    () => (presetKey ? PROVIDER_PRESETS[presetKey]?.recommendedModels?.[0]?.id : '') ?? ''
  );
  const [modifiedModelIds, setModifiedModelIds] = useState<Set<string>>(new Set());
  const [unconfiguredWarningOpen, setUnconfiguredWarningOpen] = useState(false);

  const ingestModels = useCallback((models: LocalModelSpec[]) => {
    if (!models.length) return;
    setAvailableModels((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      return [...prev, ...models.filter((m) => !seen.has(m.id))];
    });
    setModelSpecs((prev) => {
      const next = { ...prev };
      for (const m of models) if (!next[m.id]) next[m.id] = { ...m };
      return next;
    });
    setSelectedModelIds((prev) => (prev.size === 0 ? new Set(models.slice(0, 2).map((m) => m.id)) : prev));
  }, []);

  useEffect(() => {
    setModelSpecs((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of selectedModelIds) {
        if (!next[id]) {
          const found = availableModels.find((m) => m.id === id);
          next[id] = found ? { ...found } : hydrateModelSpec(id, connectionDraft.vendor);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedModelIds, availableModels, connectionDraft.vendor]);

  useEffect(() => {
    if (selectedModelIds.size === 0) setActiveModelId('');
    else if (!selectedModelIds.has(activeModelId)) setActiveModelId(Array.from(selectedModelIds)[0] ?? '');
  }, [selectedModelIds, activeModelId]);

  const setConnectionField = useCallback(
    <K extends keyof ProviderConnectionDraft>(field: K, value: ProviderConnectionDraft[K]) => {
      if (field === 'vendor') manualVendorRef.current = true;
      setConnectionDraft((prev) => {
        const next = { ...prev, [field]: value };
        if (!manualVendorRef.current && (field === 'baseUrl' || field === 'name')) {
          const det = detectVendorKey({ name: next.name, baseUrl: next.baseUrl });
          if (det !== 'custom' || prev.vendor === 'custom') next.vendor = det;
        }
        return next;
      });
      setPingStatus('idle'); setLatencyMs(null); setPingResult(null);
    },
    []
  );

  const applyPreset = useCallback((key: LocalVendorKey | string) => {
    const vk = (key in PROVIDER_PRESETS ? key : detectVendorKey(key)) as LocalVendorKey;
    const p = PROVIDER_PRESETS[vk];
    if (!p) return;
    manualVendorRef.current = true;
    setPresetKey(vk);
    setConnectionDraft({ name: p.displayName ?? p.name, baseUrl: p.defaultBaseUrl, apiKey: '', vendor: p.vendor });
    setPingStatus('idle'); setLatencyMs(null); setPingResult(null); setFetchError(null); setSearchQuery('');
    if (p.recommendedModels?.length) {
      setAvailableModels([...p.recommendedModels]);
      setSelectedModelIds(new Set(p.recommendedModels.slice(0, 2).map((m) => m.id)));
      setModelSpecs(Object.fromEntries(p.recommendedModels.map((m) => [m.id, { ...m }])));
      setActiveModelId(p.recommendedModels[0]?.id ?? '');
      setModifiedModelIds(new Set());
    }
  }, []);

  const getEffectiveApiKey = useCallback(async (): Promise<string | null> => {
    if (connectionDraft.apiKey.trim()) return connectionDraft.apiKey.trim();
    return targetProviderId ? localChatStore.getState().readApiKey(targetProviderId) : null;
  }, [connectionDraft.apiKey, targetProviderId]);

  const runPing = useCallback(async (): Promise<boolean> => {
    if (!connectionDraft.baseUrl.trim()) {
      setPingStatus('error'); setPingResult({ ok: false, error: 'Base URL 不能为空' });
      return false;
    }
    setPingStatus('testing');
    try {
      const key = await getEffectiveApiKey();
      const res = await pingProviderEndpoint({ baseUrl: connectionDraft.baseUrl, apiKey: key, vendor: connectionDraft.vendor });
      setLatencyMs(res.latencyMs);
      if (res.ok) {
        setPingStatus('success'); setPingResult({ ok: true, latencyMs: res.latencyMs });
        if (res.models) ingestModels(res.models);
        return true;
      }
      setPingStatus('error'); setPingResult({ ok: false, latencyMs: res.latencyMs, error: res.error?.message ?? '连接失败' });
      return false;
    } catch (err) {
      setPingStatus('error'); setPingResult({ ok: false, error: err instanceof Error ? err.message : '网络请求失败' });
      return false;
    }
  }, [connectionDraft.baseUrl, connectionDraft.vendor, getEffectiveApiKey, ingestModels]);

  const pasteApiKey = useCallback(async (): Promise<string> => {
    const clean = sanitizeApiKeyInput(await readTextFromClipboard());
    if (clean) setConnectionField('apiKey', clean);
    return clean;
  }, [setConnectionField]);

  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return q
      ? availableModels.filter(
          (m) => m.id.toLowerCase().includes(q) || m.displayName?.toLowerCase().includes(q) || m.tags?.some((t) => t.toLowerCase().includes(q))
        )
      : availableModels;
  }, [availableModels, searchQuery]);

  const selectAll = useCallback(() => {
    setSelectedModelIds((prev) => new Set([...prev, ...filteredModels.map((m) => m.id)]));
  }, [filteredModels]);

  const clearAll = useCallback(() => setSelectedModelIds(new Set()), []);

  const toggleModel = useCallback((id: string, force?: boolean) => {
    setSelectedModelIds((prev) => {
      const next = new Set(prev);
      if (force !== undefined ? force : !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const rangeSelect = useCallback((ids: readonly string[], selected = true) => {
    setSelectedModelIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (selected) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }
      return next;
    });
  }, []);

  const addCustomModel = useCallback(
    (rawId: string): boolean => {
      const id = rawId.trim();
      if (!id) return false;
      const spec = hydrateModelSpec(id, connectionDraft.vendor);
      setAvailableModels((prev) => (prev.some((m) => m.id === id) ? prev : [spec, ...prev]));
      setModelSpecs((prev) => ({ ...prev, [id]: prev[id] ?? spec }));
      setSelectedModelIds((prev) => new Set(prev).add(id));
      return true;
    },
    [connectionDraft.vendor]
  );

  const fetchOnlineModels = useCallback(async () => {
    if (!connectionDraft.baseUrl.trim()) return;
    setFetchingModels(true); setFetchError(null);
    try {
      const key = await getEffectiveApiKey();
      const list = await fetchProviderModelsRobust({ baseUrl: connectionDraft.baseUrl, apiKey: key, vendor: connectionDraft.vendor });
      ingestModels(list);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : '拉取模型失败');
    } finally {
      setFetchingModels(false);
    }
  }, [connectionDraft.baseUrl, connectionDraft.vendor, getEffectiveApiKey, ingestModels]);

  const selectedModels = useMemo<LocalModelSpec[]>(
    () => Array.from(selectedModelIds).map((id) => modelSpecs[id] ?? { id, enabled: true }),
    [selectedModelIds, modelSpecs]
  );

  const currentSpec = useMemo<LocalModelSpec | null>(
    () => (activeModelId ? modelSpecs[activeModelId] ?? null : null),
    [activeModelId, modelSpecs]
  );

  const updateCurrentModelSpec = useCallback((updater: (prev: LocalModelSpec) => LocalModelSpec) => {
    if (!activeModelId) return;
    setModelSpecs((prev) => ({
      ...prev, [activeModelId]: updater(prev[activeModelId] ?? { id: activeModelId, enabled: true }),
    }));
    setModifiedModelIds((prev) => new Set(prev).add(activeModelId));
  }, [activeModelId]);

  const applyCurrentSpecToAll = useCallback(() => {
    if (!currentSpec || selectedModelIds.size <= 1) return;
    setModelSpecs((prev) => {
      const next = { ...prev };
      for (const id of selectedModelIds) {
        const orig = prev[id] ?? { id, enabled: true };
        next[id] = { ...currentSpec, id: orig.id, displayName: orig.displayName ?? orig.id, tags: orig.tags };
      }
      return next;
    });
    setModifiedModelIds(new Set(selectedModelIds));
  }, [currentSpec, selectedModelIds]);

  const hasUnconfiguredWarning = useMemo(
    () => selectedModelIds.size > 1 && modifiedModelIds.size === 1,
    [selectedModelIds.size, modifiedModelIds.size]
  );

  const isStep1Valid = useMemo(() => {
    const n = connectionDraft.name.trim(); const u = connectionDraft.baseUrl.trim();
    return n !== '' && u !== '' && isHttpUrl(u);
  }, [connectionDraft.name, connectionDraft.baseUrl]);

  const isStep2Valid = selectedModelIds.size > 0;
  const canGoNext = step === 1 ? isStep1Valid : step === 2 ? isStep2Valid : true;

  const goToNextStep = useCallback(() => {
    if (step === 1 && isStep1Valid) {
      setStep(2);
      if (availableModels.length === 0) void fetchOnlineModels();
    } else if (step === 2 && isStep2Valid) setStep(3);
  }, [step, isStep1Valid, isStep2Valid, availableModels.length, fetchOnlineModels]);

  const goToPrevStep = useCallback(() => {
    if (step === 3) setStep(2);
    else if (step === 2 && !isTargetedMode) setStep(1);
    else options?.onCancel?.();
  }, [step, isTargetedMode, options]);

  const finishWizard = useCallback(
    async (skipWarning = false): Promise<boolean> => {
      if (!skipWarning && hasUnconfiguredWarning) {
        setUnconfiguredWarningOpen(true);
        return false;
      }
      if (selectedModelIds.size === 0) return false;
      const specs = Array.from(selectedModelIds).map((id) => modelSpecs[id] ?? { id, enabled: true });

      if (isTargetedMode && targetProviderId) {
        const store = localChatStore.getState();
        const existing = store.config.providers[targetProviderId];
        if (!existing) return false;
        const map = new Map<string, LocalModelSpec>(existing.models.map((m) => [m.id, m]));
        for (const s of specs) map.set(s.id, s);
        const models = Array.from(map.values());
        await store.upsertProvider(targetProviderId, { ...existing, models, defaultModelId: existing.defaultModelId ?? models[0]?.id }, undefined);
        options?.onSaved?.(targetProviderId);
        return true;
      }

      if (!isStep1Valid) return false;
      const providerId = nextId('provider');
      const defaultModelId = activeModelId || specs[0]?.id || '';
      const spec: LocalProviderSpec = {
        protocol: 'openai/chat', vendor: connectionDraft.vendor, displayName: connectionDraft.name.trim(),
        baseUrl: normalizeBaseUrl(connectionDraft.baseUrl), defaultModelId, models: specs,
        latencyMs: latencyMs ?? undefined, latencyUpdatedAt: latencyMs !== null ? Date.now() : undefined,
      };
      const store = localChatStore.getState();
      await store.upsertProvider(providerId, spec, connectionDraft.apiKey.trim() || undefined);
      if (defaultModelId) store.setActiveModel(providerId, defaultModelId);
      options?.onSaved?.(providerId);
      return true;
    },
    [hasUnconfiguredWarning, selectedModelIds, modelSpecs, isTargetedMode, targetProviderId, isStep1Valid, activeModelId, connectionDraft, latencyMs, options]
  );

  const apiKeyPlaceholder = useMemo(
    () => PROVIDER_PRESETS[connectionDraft.vendor]?.apiKeyPlaceholder ?? 'sk-...',
    [connectionDraft.vendor]
  );

  return {
    mode: isTargetedMode ? 'addModels' : 'new',
    isTargetedMode, targetProviderId, targetProviderName: targetProvider?.displayName ?? targetProviderId ?? undefined,
    step, setStep, presetKey,
    connectionDraft,
    name: connectionDraft.name, baseUrl: connectionDraft.baseUrl, apiKey: connectionDraft.apiKey, vendor: connectionDraft.vendor,
    apiKeyPlaceholder, isStep1Valid, pingStatus, pinging: pingStatus === 'testing', latencyMs, pingResult,
    setConnectionField,
    setName: (v: string) => setConnectionField('name', v), setBaseUrl: (v: string) => setConnectionField('baseUrl', v),
    setApiKey: (v: string) => setConnectionField('apiKey', v), setVendor: (v: LocalVendorKey) => setConnectionField('vendor', v),
    applyPreset, pasteApiKey, runPing, runPingTest: runPing,
    availableModels, selectedModelIds, searchQuery, filterQuery: searchQuery, filteredModels, fetchingModels, fetchError, isStep2Valid,
    setSearchQuery, setFilterQuery: setSearchQuery,
    selectAll, clearAll, toggleModel, toggleModelSelection: toggleModel, rangeSelect, setSelectedModelIds,
    addCustomModel, addCustomModelId: addCustomModel, fetchOnlineModels, fetchModels: fetchOnlineModels,
    selectedModels, activeModelId, activeSpecModelId: activeModelId, currentSpec, currentSpecDraft: currentSpec,
    setActiveModelId, setActiveSpecModelId: setActiveModelId, updateCurrentModelSpec, applyCurrentSpecToAll, applyCurrentSpecsToAll: applyCurrentSpecToAll,
    hasUnconfiguredWarning, unconfiguredWarningOpen, setUnconfiguredWarningOpen,
    canGoNext, goToNextStep, goToPrevStep, finishWizard, finishSave: finishWizard,
  };
}
