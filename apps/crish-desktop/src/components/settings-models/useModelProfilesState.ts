import { toast } from '../../services/toast/ToastContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addModelToProfile,
  createCustomProfile,
  findProfileByDisplayName,
  getActiveModelId,
  getActiveProfileId,
  loadProfiles,
  normalizeModelIds,
  profileDisplayLabel,
  profileHasKey,
  saveProfileKey,
  type ProviderProfile,
} from '../../api/providerProfiles';
import { getModelMeta } from '../../api/modelCatalog';
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
import {
  foldSettingsProfiles,
  pickSettingsSelectedId,
  settingsObjectId,
} from './modelProfilesHelpers';
import { useModelConfigSession } from './useModelConfigSession';
import { useModelProviderActions } from './useModelProviderActions';

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
  onShowToast?: (ok: boolean, msg: string) => void,
) {
  const [profiles, setProfilesState] = useState<ProviderProfile[]>(() =>
    foldSettingsProfiles(loadProfiles())
  );
  const [selectedId, setSelectedIdState] = useState<string>(() => {
    const raw = loadProfiles();
    const folded = foldSettingsProfiles(raw);
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem('crish_models_selected_profile_v1');
    } catch {
      /* ignore */
    }
    return pickSettingsSelectedId(folded, raw, stored, getActiveProfileId());
  });

  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id || '');
  }, []);

  const [keyDraft, setKeyDraft] = useState('');
  const [addOpen, setAddOpen] = useState(false);
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

  /** 成功静默（含「已自动获取 N 个模型」）；失败才进 Toast，并带 error 皮。 */
  const notify = useCallback(
    (ok: boolean, msg: string) => {
      if (onShowToast) {
        onShowToast(ok, msg);
        return;
      }
      if (ok) return;
      toast.show(msg, undefined, { type: 'error' });
    },
    [onShowToast],
  );

  const setProfiles = useCallback((raw: ProviderProfile[]) => {
    const folded = foldSettingsProfiles(raw);
    setProfilesState(folded);
    setSelectedIdState((cur) =>
      pickSettingsSelectedId(folded, raw, cur, getActiveProfileId())
    );
  }, []);

  const refresh = useCallback(() => {
    setProfiles(loadProfiles());
  }, [setProfiles]);

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

  // ── 配置编辑会话子 hook（openConfigFor / closeConfig / saveConfig）──────
  const { openConfigFor, closeConfig, saveConfig } = useModelConfigSession({
    selected,
    configOpenId,
    cfgDraft,
    setConfigOpenId,
    setCfgDraft,
    setManualOpen,
    refresh,
    notify,
    runAsLocalMutation,
  });

  // ── 服务商连通性动作子 hook（runTest / runScan / runCheck + busy 状态）──
  const { testBusy, scanBusy, checkBusy, runTest, runScan, runCheck } =
    useModelProviderActions({
      selected,
      refresh,
      notify,
      runAsLocalMutation,
    });

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
      const raw = loadProfiles();
      const existing = findProfileByDisplayName(raw, preset.name);
      if (existing) {
        setProfiles(raw);
        setSelectedIdState(existing.id);
        setAddOpen(false);
        return;
      }
      const p = createCustomProfile({
        name: preset.name,
        baseUrl: preset.baseUrl,
        models: [],
      });
      setProfiles(loadProfiles());
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
