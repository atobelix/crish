import { useCallback, useEffect, useMemo, useState } from 'react';
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
  scanProviderModels,
  testProviderModel,
} from '../../api/modelCatalog';
import {
  applyMetaForModel,
  emptyAddDraft,
  type AddModelDraft,
  type ConfigDraft,
} from './modelsIpcHelpers';
import {
  DEFAULT_PROVIDER_BASE_URLS,
  PRESETS,
  type PresetProvider,
} from './modelsPresets';

export type AddDraft = AddModelDraft;
export type CfgDraft = ConfigDraft;
export {
  emptyAddDraft,
  PRESETS,
  type AddModelDraft,
  type ConfigDraft,
  type PresetProvider,
};

export function useModelProfilesState(
  onShowToast?: ((ok: boolean, msg: string) => void) | ((msg: string) => void)
) {
  const [profiles, setProfiles] = useState<ProviderProfile[]>(() =>
    loadProfiles()
  );
  const [selectedId, setSelectedIdState] = useState<string>(() => {
    try {
      const s = sessionStorage.getItem('crish_models_selected_profile_v1');
      if (s && loadProfiles().some((p) => p.id === s)) return s;
    } catch {
      /* ignore */
    }
    const act = getActiveProfileId();
    if (act && loadProfiles().some((p) => p.id === act)) return act;
    return loadProfiles()[0]?.id || '';
  });

  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id || '');
  }, []);

  const [keyDraft, setKeyDraft] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [configOpenId, setConfigOpenId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AddDraft>(() => emptyAddDraft());
  const [cfgDraft, setCfgDraft] = useState<CfgDraft | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const notify = useCallback(
    (ok: boolean, msg: string) => {
      if (onShowToast) {
        if (onShowToast.length === 1) {
          (onShowToast as (msg: string) => void)(msg);
        } else {
          (onShowToast as (ok: boolean, msg: string) => void)(ok, msg);
        }
      }
    },
    [onShowToast]
  );

  const refresh = useCallback(() => {
    const list = loadProfiles();
    setProfiles(list);
    setSelectedIdState((cur) => {
      if (cur && list.some((p) => p.id === cur)) return cur;
      return list[0]?.id || '';
    });
  }, []);

  const selected = useMemo(() => {
    return profiles.find((p) => p.id === selectedId) || null;
  }, [profiles, selectedId]);

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
    setSelectedIdState(p.id);
    setAddOpen(false);
  };

  const addFromPreset = (preset: PresetProvider) => {
    const p = createCustomProfile({
      name: preset.name,
      baseUrl: preset.baseUrl,
      models: [],
    });
    refresh();
    setSelectedIdState(p.id);
    setAddOpen(false);
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
          tools: Boolean(meta.capabilities?.tools),
          vision: Boolean(meta.capabilities?.vision),
          reasoning: Boolean(meta.capabilities?.reasoning),
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
        tools: Boolean(meta.capabilities?.tools),
        vision: Boolean(meta.capabilities?.vision),
        reasoning: Boolean(meta.capabilities?.reasoning),
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
  };
}
