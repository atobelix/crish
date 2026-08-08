import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addModelToProfile,
  createCustomProfile,
  getActiveModelId,
  getActiveProfileId,
  loadProfiles,
  mergeModelIds,
  normalizeModelIds,
  profileDisplayLabel,
  profileHasKey,
  saveProfileKey,
  type ProviderProfile,
  upsertProfile,
} from '../../api/providerProfiles';
import {
  getModelMeta,
  MODEL_CAPABILITY_OPTIONS,
  scanProviderModels,
  setModelCapability,
  setModelContextLength,
  setModelDisplayName,
  testProviderModel,
  type ModelCapabilityKey,
} from '../../api/modelCatalog';

const DEFAULT_PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

export interface PresetProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  format: 'openai' | 'anthropic';
}

export const PRESETS: PresetProvider[] = [
  {
    id: 'preset-opencode-go',
    name: 'OpenCode Go 订阅',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    // 模型取 00-catalog 现行旗舰：GLM-5.2（§4.1）、kimi-k3（§5.1）
    models: ['deepseek-v4-flash', 'glm-5.2', 'kimi-k3'],
    format: 'openai',
  },
  {
    id: 'preset-opencode-zen',
    name: 'OpenCode Zen 订阅',
    baseUrl: 'https://opencode.ai/zen/v1',
    // gemini-3.6-flash（§8.1）、claude-sonnet-5（§1.4）
    models: ['deepseek-v4-flash', 'gemini-3.6-flash', 'claude-sonnet-5'],
    format: 'openai',
  },
  {
    id: 'preset-deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    // 旧 alias deepseek-chat/reasoner 已退役，v4 系为现行（§3.1）
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    format: 'openai',
  },
  {
    id: 'preset-qwen',
    name: '千问 Qwen Portal',
    baseUrl: 'https://portal.qwen.ai/v1',
    // 百炼现行型号（§11.1）
    models: ['qwen3.7-max', 'qwen3.7-plus', 'qwen3-coder-plus'],
    format: 'openai',
  },
  {
    id: 'preset-openai',
    name: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    // gpt-5.x 现行（§2.2）
    models: ['gpt-5.6', 'gpt-5.5'],
    format: 'openai',
  },
  {
    id: 'preset-anthropic',
    name: 'Anthropic 兼容',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-5'],
    format: 'anthropic',
  },
  {
    id: 'preset-flowbit',
    name: 'Flowbit',
    baseUrl: 'https://api.flowbit.me',
    models: [],
    format: 'openai',
  },
];

export type AddDraft = {
  displayName: string;
  modelId: string;
  contextLength: string;
  caps: Record<ModelCapabilityKey, boolean>;
};

export function emptyAddDraft(): AddDraft {
  return {
    displayName: '',
    modelId: '',
    contextLength: '',
    caps: { tools: false, vision: false, reasoning: false },
  };
}

export type CfgDraft = {
  displayName: string;
  contextLength: string;
  caps: Record<ModelCapabilityKey, boolean>;
};

export function useModelProfilesState(onShowToast?: (msg: string) => void) {
  const [profiles, setProfiles] = useState<ProviderProfile[]>(() => {
    try {
      return loadProfiles();
    } catch {
      return [];
    }
  });

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      const remembered =
        typeof sessionStorage !== 'undefined'
          ? sessionStorage.getItem('crish_models_selected_profile_v1')
          : null;
      if (remembered && loadProfiles().some((p) => p.id === remembered)) {
        return remembered;
      }
      return getActiveProfileId() || loadProfiles()[0]?.id || null;
    } catch {
      return null;
    }
  });

  const [keyDraft, setKeyDraft] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [busyState, setBusyState] = useState<{
    testBusy: string | null;
    scanBusy: boolean;
    checkBusy: boolean;
  }>({ testBusy: null, scanBusy: false, checkBusy: false });

  const testBusy = busyState.testBusy;
  const scanBusy = busyState.scanBusy;
  const checkBusy = busyState.checkBusy;

  const setTestBusy = (val: React.SetStateAction<string | null>) =>
    setBusyState((prev) => ({
      ...prev,
      testBusy: typeof val === 'function' ? val(prev.testBusy) : val,
    }));
  const setScanBusy = (val: React.SetStateAction<boolean>) =>
    setBusyState((prev) => ({
      ...prev,
      scanBusy: typeof val === 'function' ? val(prev.scanBusy) : val,
    }));
  const setCheckBusy = (val: React.SetStateAction<boolean>) =>
    setBusyState((prev) => ({
      ...prev,
      checkBusy: typeof val === 'function' ? val(prev.checkBusy) : val,
    }));

  const [modelFilter, setModelFilter] = useState('');
  const [configOpenId, setConfigOpenId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AddDraft>(() => emptyAddDraft());
  const [cfgDraft, setCfgDraft] = useState<CfgDraft | null>(null);

  const [nameEditState, setNameEditState] = useState<{
    editing: boolean;
    draft: string;
  }>({
    editing: false,
    draft: '',
  });

  const editingName = nameEditState.editing;
  const nameDraft = nameEditState.draft;

  const setEditingName = (val: React.SetStateAction<boolean>) =>
    setNameEditState((prev) => ({
      ...prev,
      editing: typeof val === 'function' ? val(prev.editing) : val,
    }));
  const setNameDraft = (val: React.SetStateAction<string>) =>
    setNameEditState((prev) => ({
      ...prev,
      draft: typeof val === 'function' ? val(prev.draft) : val,
    }));

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const selected = useMemo(
    () => profiles.find((p) => p.id === selectedId) || null,
    [profiles, selectedId]
  );

  const refresh = () => {
    try {
      setProfiles(loadProfiles());
    } catch (e) {
      onShowToast?.(
        `读取服务商失败：${e instanceof Error ? e.message : String(e)}`
      );
      setProfiles([]);
    }
  };

  const notify = (ok: boolean, text: string) => {
    if (!ok) onShowToast?.(text);
  };

  useEffect(() => {
    if (selectedId) {
      try {
        sessionStorage.setItem('crish_models_selected_profile_v1', selectedId);
      } catch {
        /* ignore */
      }
    }
    if (selected) {
      setKeyDraft('');
      setModelFilter('');
      setConfigOpenId(null);
      setCfgDraft(null);
      setManualOpen(false);
      setAddDraft(emptyAddDraft());
      setEditingName(false);
      setNameDraft('');
      setConfirmDeleteId(null);
    }
  }, [selectedId, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (addOpen) {
        setAddOpen(false);
        e.preventDefault();
        return;
      }
      if (configOpenId) {
        setConfigOpenId(null);
        setCfgDraft(null);
        e.preventDefault();
        return;
      }
      if (manualOpen) {
        setManualOpen(false);
        e.preventDefault();
        return;
      }
      if (modelFilter.trim()) {
        setModelFilter('');
        e.preventDefault();
        return;
      }
      if (confirmDeleteId) {
        setConfirmDeleteId(null);
        e.preventDefault();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addOpen, configOpenId, manualOpen, modelFilter, confirmDeleteId]);

  const addRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) {
        setAddOpen(false);
      }
    };
    const onScroll = () => {
      setAddOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [addOpen]);

  const saveKey = async () => {
    if (!selected || !keyDraft.trim()) return;
    const res = await saveProfileKey(selected.id, keyDraft.trim());
    refresh();
    setKeyDraft('');
    if (!res.ok) {
      notify(false, `保存失败：${res.error || '未知错误'}`);
      return;
    }
    notify(true, '密钥已保存，正在自动扫描服务器可用模型...');
    void runScan();
  };

  const addFromTemplate = (format: 'openai' | 'anthropic') => {
    const p = createCustomProfile({
      name: format === 'openai' ? 'OpenAI 格式' : 'Anthropic 格式',
      ...(DEFAULT_PROVIDER_BASE_URLS[format] !== undefined && {
        baseUrl: DEFAULT_PROVIDER_BASE_URLS[format],
      }),
      models: [],
    });
    refresh();
    setSelectedId(p.id);
    setAddOpen(false);
  };

  const addFromPreset = (preset: PresetProvider) => {
    const p = createCustomProfile({
      name: preset.name,
      baseUrl: preset.baseUrl,
      models: [],
    });
    refresh();
    setSelectedId(p.id);
    setAddOpen(false);
  };

  const applyMetaForModel = (
    profileId: string,
    modelId: string,
    draft: {
      displayName: string;
      contextLength: string;
      caps: Record<ModelCapabilityKey, boolean>;
    }
  ) => {
    if (draft.displayName.trim()) {
      setModelDisplayName(profileId, modelId, draft.displayName.trim());
    }
    const n = parseInt(draft.contextLength.replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(n) && n > 0) {
      setModelContextLength(profileId, modelId, n);
    }
    for (const opt of MODEL_CAPABILITY_OPTIONS) {
      setModelCapability(profileId, modelId, opt.key, !!draft.caps[opt.key]);
    }
  };

  const handleManualAdd = () => {
    if (!selected) return;
    const id = normalizeModelIds([addDraft.modelId])[0];
    if (!id) {
      notify(false, '请填写模型 id');
      return;
    }
    const snap = { ...addDraft };
    addModelToProfile(selected.id, id);
    applyMetaForModel(selected.id, id, snap);
    refresh();
    setAddDraft(emptyAddDraft());
    setManualOpen(false);

    window.setTimeout(() => {
      const meta = getModelMeta(selected.id, id);
      setConfigOpenId(id);
      setCfgDraft({
        displayName: meta.displayName || snap.displayName || '',
        contextLength:
          meta.contextLength != null
            ? String(meta.contextLength)
            : snap.contextLength || '',
        caps: {
          tools: !!meta.capabilities?.tools,
          vision: !!meta.capabilities?.vision,
          reasoning: !!meta.capabilities?.reasoning,
        },
      });
    }, 0);
  };

  const openConfigFor = (model: string) => {
    if (!selected) return;
    const meta = getModelMeta(selected.id, model);
    setManualOpen(false);
    setConfigOpenId(model);
    setCfgDraft({
      displayName: meta.displayName || '',
      contextLength:
        meta.contextLength != null ? String(meta.contextLength) : '',
      caps: {
        tools: !!meta.capabilities?.tools,
        vision: !!meta.capabilities?.vision,
        reasoning: !!meta.capabilities?.reasoning,
      },
    });
  };

  const closeConfig = () => {
    setConfigOpenId(null);
    setCfgDraft(null);
  };

  const saveConfig = () => {
    if (!selected || !configOpenId || !cfgDraft) return;
    applyMetaForModel(selected.id, configOpenId, cfgDraft);
    refresh();
    openConfigFor(configOpenId);
  };

  const runTest = async (model: string) => {
    if (!selected) return;
    const key = `${selected.id}::${model}`;
    setTestBusy(key);

    try {
      const fresh =
        loadProfiles().find((p) => p.id === selected.id) || selected;
      const r = await testProviderModel(fresh, model);
      refresh();
      if (!r.ok) {
        notify(false, `连通失败 · ${model}：${r.error || '未知错误'}`);
      }
    } catch (e) {
      notify(false, e instanceof Error ? e.message : String(e));
    } finally {
      setTestBusy(null);
    }
  };

  const runScan = async () => {
    if (!selected) return;
    setScanBusy(true);
    try {
      const fresh =
        loadProfiles().find((p) => p.id === selected.id) || selected;
      const r = await scanProviderModels(fresh);
      if (r.ok && r.models?.length) {
        const merged = mergeModelIds(fresh.models, r.models);
        upsertProfile({ ...fresh, models: merged });
        refresh();
        notify(true, `已自动获取 ${r.models.length} 个模型`);
      } else {
        notify(false, r.error || '未能检测到服务器可用模型');
      }
    } catch (e) {
      notify(false, e instanceof Error ? e.message : String(e));
    } finally {
      setScanBusy(false);
    }
  };

  const runCheck = async () => {
    if (!selected) return;
    setCheckBusy(true);
    try {
      const fresh =
        loadProfiles().find((p) => p.id === selected.id) || selected;
      const firstModel = fresh.models[0] || '';
      const r = await testProviderModel(fresh, firstModel);
      if (r.ok) {
        notify(true, `服务商连通正常 (${r.latencyMs || 120}ms)`);
      } else {
        notify(false, `连通检查失败：${r.error || '无法建立握手连接'}`);
      }
    } catch (e) {
      notify(false, e instanceof Error ? e.message : String(e));
    } finally {
      setCheckBusy(false);
    }
  };

  const modelsList = useMemo(() => {
    if (!selected) return [] as string[];
    const list = normalizeModelIds(selected.models);
    const q = modelFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((m) => {
      const meta = getModelMeta(selected.id, m);
      const name = (meta.displayName || '').toLowerCase();
      return m.toLowerCase().includes(q) || name.includes(q);
    });
  }, [selected, modelFilter]);

  const modelsCount = selected?.models
    ? (normalizeModelIds(selected.models) || []).length
    : 0;
  const selectedLabel = selected ? profileDisplayLabel(selected) : '';
  const hasKeySelected = selected ? profileHasKey(selected) : false;
  const activeProfileId = getActiveProfileId();
  const globalActiveModelId = getActiveModelId();

  return {
    profiles,
    setProfiles,
    selectedId,
    setSelectedId,
    selected,
    keyDraft,
    setKeyDraft,
    addOpen,
    setAddOpen,
    testBusy,
    scanBusy,
    checkBusy,
    modelFilter,
    setModelFilter,
    configOpenId,
    setConfigOpenId,
    manualOpen,
    setManualOpen,
    addDraft,
    setAddDraft,
    cfgDraft,
    setCfgDraft,
    editingName,
    setEditingName,
    nameDraft,
    setNameDraft,
    confirmDeleteId,
    setConfirmDeleteId,
    refresh,
    notify,
    saveKey,
    addFromTemplate,
    addFromPreset,
    handleManualAdd,
    openConfigFor,
    closeConfig,
    saveConfig,
    runTest,
    runScan,
    runCheck,
    modelsList,
    modelsCount,
    selectedLabel,
    hasKeySelected,
    activeProfileId,
    globalActiveModelId,
    addRef,
  };
}
