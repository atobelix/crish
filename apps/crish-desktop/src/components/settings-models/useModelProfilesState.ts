import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { onUiEvent } from '../../api/uiEvents';
import { editSessionConsumer } from '../../api/chat-bridge/editSessionConsumer';

export type AddDraft = AddModelDraft;
export type CfgDraft = ConfigDraft;
export {
  emptyAddDraft,
  PRESETS,
  type AddModelDraft,
  type ConfigDraft,
  type PresetProvider,
};

/**
 * 设置表单「编辑会话」对象 id：profileId::model（与 modelCatalog metaKey 同形，
 * 跨 profile 隔离，避免 model id 裸串撞车）。
 */
function settingsObjectId(profileId: string, model: string): string {
  return `${profileId}::${model}`;
}

/**
 * CT-01 对齐的模型配置 rev：可编辑字段（displayName/contextLength/caps）的
 * 稳定序列化签名。openConfigFor 时捕获为编辑会话 baseRev；saveConfig 保存前
 * 重算比对——外部已变更（rev 不符）→ 拒绝陈旧覆盖（不静默 LWW）。
 */
function modelMetaRevision(profileId: string, model: string): string {
  const meta = getModelMeta(profileId, model);
  return JSON.stringify([
    meta.displayName ?? '',
    meta.contextLength ?? null,
    meta.capabilities?.tools ?? false,
    meta.capabilities?.vision ?? false,
    meta.capabilities?.reasoning ?? false,
  ]);
}

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

  // ── R2-a ④ 设置页失效订阅（详案 §1.1-④ + analysis/15 §2.4）──────────────
  // 自身落盘（saveKey/addFrom*/handleManualAdd/runScan/saveConfig）经
  // localMutationRef 标记为本地变更，跳过「外部变更」提示；外部变更（其它
  // tab/窗口/Rust 端）命中 profiles-changed 事件时：有未保存草稿 → 提示 +
  // 编辑会话 invalidate（不静默覆盖）；无未保存草稿 → 直接 refresh 重载。
  const localMutationRef = useRef(false);
  const cfgRevRef = useRef<Map<string, string>>(new Map());
  const externalChangeStateRef = useRef({
    profileId: '',
    configOpenId: null as string | null,
    hasUnsaved: false,
  });
  useEffect(() => {
    externalChangeStateRef.current = {
      profileId: selectedId,
      configOpenId,
      hasUnsaved:
        cfgDraft != null ||
        keyDraft.trim() !== '' ||
        editingName ||
        nameDraft.trim() !== '',
    };
  }, [selectedId, configOpenId, cfgDraft, keyDraft, editingName, nameDraft]);

  /**
   * 把「会落盘并触发 profiles-changed」的自身变更体标记为本地变更：
   * 事件在异步落盘（await 之后）才派发，标记须覆盖整个变更体（含 await）。
   */
  const runAsLocalMutation = useCallback(
    async <T>(fn: () => Promise<T> | T): Promise<T> => {
      localMutationRef.current = true;
      try {
        return await fn();
      } finally {
        localMutationRef.current = false;
      }
    },
    []
  );

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

  useEffect(() => {
    return onUiEvent('profiles-changed', () => {
      if (localMutationRef.current) return;
      const st = externalChangeStateRef.current;
      if (st.hasUnsaved) {
        // 有未保存草稿：提示用户，不静默覆盖；编辑会话失效（挂起面）
        notify(false, '配置已被外部修改，请确认后重载或丢弃草稿');
        if (st.configOpenId && st.profileId) {
          editSessionConsumer.invalidate(
            settingsObjectId(st.profileId, st.configOpenId),
            'external'
          );
        }
        return;
      }
      // 无未保存草稿：直接重载最新配置
      refresh();
    });
  }, [refresh, notify]);

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
    await runAsLocalMutation(async () => {
      const res = await saveProfileKey(selected.id, keyDraft.trim());
      refresh();
      setKeyDraft('');
      if (!res.ok) {
        notify(false, `保存失败：${res.error || '未知错误'}`);
        return;
      }
      notify(true, '密钥已保存，正在自动扫描服务器可用模型...');
      void runScan();
    });
  };

  const addFromTemplate = (format: 'openai' | 'anthropic') => {
    void runAsLocalMutation(() => {
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
    });
  };

  const addFromPreset = (preset: PresetProvider) => {
    void runAsLocalMutation(() => {
      const p = createCustomProfile({
        name: preset.name,
        baseUrl: preset.baseUrl,
        models: [],
      });
      refresh();
      setSelectedIdState(p.id);
      setAddOpen(false);
    });
  };

  const handleManualAdd = () => {
    if (!selected) return;
    const id = normalizeModelIds([addDraft.modelId])[0];
    if (!id) {
      notify(false, '请填写模型 id');
      return;
    }
    const snap = { ...addDraft };
    void runAsLocalMutation(() => {
      addModelToProfile(selected.id, id);
      applyMetaForModel(selected.id, id, snap);
      refresh();
      setAddDraft(emptyAddDraft());
      setManualOpen(false);
    });

    window.setTimeout(() => {
      const meta = getModelMeta(selected.id, id);
      // R2-a ④：cfgDraft 挂编辑会话（open；设置 rev 为本地签名，
      // 不进会话数值 rev——CT-01 核对在 saveConfig 本地比对）
      editSessionConsumer.open(settingsObjectId(selected.id, id));
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
    const objectId = settingsObjectId(selected.id, model);
    const rev = modelMetaRevision(selected.id, model);
    // R2-a ④：cfgDraft 挂编辑会话（open；设置 rev 为本地签名，不进会话数值 rev）
    cfgRevRef.current.set(objectId, rev);
    editSessionConsumer.open(objectId);
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
    if (selected && configOpenId) {
      const objectId = settingsObjectId(selected.id, configOpenId);
      // 用户取消：关闭编辑会话（'external' 失效广播）+ 清本地 rev 记账
      editSessionConsumer.invalidate(objectId, 'external');
      cfgRevRef.current.delete(objectId);
    }
    setConfigOpenId(null);
    setCfgDraft(null);
  };

  const saveConfig = () => {
    if (!selected || !configOpenId || !cfgDraft) return;
    const objectId = settingsObjectId(selected.id, configOpenId);
    const draft = cfgDraft;
    // CT-01 rev 核对（对齐 review §11 缓存失效 + analysis/15 §2.4）：
    // 保存前比对「打开时快照 rev」与「当前 meta rev」，外部已变更 →
    // 拒绝陈旧覆盖（不静默 LWW），与 persistence.rs Conflict 语义同构。
    const expectRev = cfgRevRef.current.get(objectId);
    const currentRev = modelMetaRevision(selected.id, configOpenId);
    if (expectRev !== undefined && expectRev !== currentRev) {
      notify(false, '配置已被外部修改，保存已取消，请重新确认');
      editSessionConsumer.invalidate(objectId, 'external');
      return;
    }
    void runAsLocalMutation(() => {
      applyMetaForModel(selected.id, configOpenId, draft);
      refresh();
      // 提交并关闭编辑会话（推进 rev，广播失效）
      editSessionConsumer.commit(objectId);
      cfgRevRef.current.delete(objectId);
      openConfigFor(configOpenId);
    });
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
      await runAsLocalMutation(async () => {
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
      });
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
