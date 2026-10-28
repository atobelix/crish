import { toast } from '../../services/toast/ToastContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createCustomProfile,
  normalizeModelIds,
  profileDisplayLabel,
  profileHasKey,
  saveProfileKey,
  type ProviderProfile,
} from '../../api/providerProfiles';
import {
  getActiveModelRef,
  modelsCatalogStore,
} from '../../api/modelsCatalogStore';
import {
  getLiveModel,
  getLiveProvider,
  listLiveProviders,
  providerHasKey,
} from '../../api/modelsCatalogLive';
import type { IndexedProviderEntry } from '../../api/modelsCatalogTypes';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import {
  emptyAddDraft,
  type AddModelDraft,
  type ConfigDraft,
} from './modelsIpcHelpers';
import { PROTOCOL_TEMPLATES } from './modelsPresets';
import { onUiEvent } from '../../api/uiEvents';
import { editSessionConsumer } from '../../api/chat-bridge/editSessionConsumer';
import {
  pickSettingsSelectedId,
  settingsObjectId,
} from './modelProfilesHelpers';
import { useModelConfigSession } from './useModelConfigSession';
import { useModelProviderActions } from './useModelProviderActions';
import { addDraftToModelInput, ensureProviderShell } from './catalogWriteGate';
import {
  DEFAULT_PROTOCOL,
  thinkingVocabularyDiagnostic,
} from '../../api/modelsNormalize';

export type AddDraft = AddModelDraft;
export type CfgDraft = ConfigDraft;
export {
  emptyAddDraft,
  PROTOCOL_TEMPLATES,
  type AddModelDraft,
  type ConfigDraft,
};

const SELECTED_PROFILE_STORAGE_KEY = 'crish_models_selected_profile_v1';

/** 会话记忆的「上次选中服务商」；读取失败视为无记忆。 */
function readStoredSelectedProfileId(): string | null {
  try {
    return sessionStorage.getItem(SELECTED_PROFILE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 统一树 provider → 设置页与配置编辑器消费的 ProviderProfile 视图。 */
function toSettingsProfile(entry: IndexedProviderEntry): ProviderProfile {
  return {
    id: entry.providerId,
    name: entry.provider.displayName?.trim() || entry.providerId,
    baseUrl: entry.provider.baseUrl ?? '',
    protocol: entry.provider.protocol,
    models: entry.provider.models.map((model) => model.id),
    hasKey: providerHasKey(entry.providerId),
    enabled: entry.provider.enabled !== false,
  };
}

export function useModelProfilesState() {
  const catalogVersion = useModelsCatalogVersion();

  // 服务商名单唯一来源 = 统一树 providers 面（含停用项，保持配置文件顺序）。
  const profiles = useMemo<ProviderProfile[]>(
    () => listLiveProviders().map(toSettingsProfile),
    [catalogVersion]
  );

  const [selectedId, setSelectedIdState] = useState<string>(
    () => readStoredSelectedProfileId() ?? ''
  );

  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id || '');
  }, []);

  // 树变更后收敛选中项：树里不存在的 id 一律丢弃，绝不按展示名改绑。
  useEffect(() => {
    setSelectedIdState((cur) =>
      pickSettingsSelectedId(profiles, cur, readStoredSelectedProfileId())
    );
  }, [profiles]);

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

  // 全局默认模型唯一真源 = 树 activeModel；未加载 / 未设置一律为空。
  const activeModelRef = useMemo(() => getActiveModelRef(), [catalogVersion]);
  const activeProfileId = activeModelRef?.providerId ?? '';
  const globalActiveModelId = activeModelRef?.modelId ?? '';

  // ── R2-a ④ 设置页失效订阅（详案 §1.1-④ + analysis/15 §2.4）──────────────
  // 自身落盘（saveKey/addCustomProvider/handleManualAdd/runScan/saveConfig）经
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
  const notify = useCallback((ok: boolean, msg: string) => {
    if (ok) return;
    toast.show(msg, undefined, { type: 'error' });
  }, []);

  /** 写盘回执后重读统一树，把失效的选中项收敛掉（树是唯一名单源）。 */
  const refresh = useCallback(() => {
    const liveIds = listLiveProviders().map((entry) => ({
      id: entry.providerId,
    }));
    setSelectedIdState((cur) =>
      pickSettingsSelectedId(liveIds, cur, readStoredSelectedProfileId())
    );
  }, []);

  useEffect(() => {
    const onExternal = () => {
      if (localMutationRef.current) return;
      const st = externalChangeStateRef.current;
      if (st.hasUnsaved) {
        notify(false, '配置已被外部修改，请确认后重载或丢弃草稿');
        if (st.configOpenId && st.profileId) {
          editSessionConsumer.invalidate(
            settingsObjectId(st.profileId, st.configOpenId),
            'external'
          );
        }
        return;
      }
      refresh();
    };
    const offProfiles = onUiEvent('profiles-changed', onExternal);
    const offCatalog = onUiEvent('models-catalog-changed', onExternal);
    return () => {
      offProfiles();
      offCatalog();
    };
  }, [refresh, notify]);

  const selected = useMemo(() => {
    return profiles.find((p) => p.id === selectedId) || null;
  }, [profiles, selectedId]);

  /**
   * 选中项「身份」变化时才清空草稿 / 关闭编辑面板。
   *
   * 依赖必须是 `selected?.id`（身份）而非 `selected`（对象）：统一树的
   * `profiles` 是 `catalogVersion` 的派生 `useMemo`，任何一次树版本变化
   * （含**外部变更**）都会重建数组与 `selected` 对象——若以对象为依赖，
   * 外部变更会连带把用户**未保存的草稿静默清空**（回归：invalidation
   * 测试「有未保存草稿 → 提示 + invalidate，不静默覆盖」变红）。
   * 以身份为依赖后：只有真正切换/失去选中项才重置，内容变化不重置。
   */
  const selectedIdentity = selected?.id ?? null;
  useEffect(() => {
    if (selectedId) {
      try {
        sessionStorage.setItem('crish_models_selected_profile_v1', selectedId);
      } catch {
        /* ignore */
      }
    }
    if (selectedIdentity) {
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
  }, [selectedId, selectedIdentity]);

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
    notify,
    runAsLocalMutation,
  });

  // ── 服务商连通性动作子 hook（runTest / runScan / runCheck + busy 状态 + 扫描选择弹窗）──
  const {
    testBusy,
    scanBusy,
    checkBusy,
    runTest,
    runScan,
    runCheck,
    scanModalOpen,
    setScanModalOpen,
    scannedModelsList,
    confirmScannedModels,
  } = useModelProviderActions({
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

  /**
   * 直接添加空白服务商：不预置任何官方/第三方 URL 或厂商名。
   * 点击后立即选中并进入右侧配置（名称/Base URL/密钥/协议由用户填写）。
   */
  const addCustomProvider = useCallback(
    async (params: {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      protocol?: string;
    }) => {
      return await runAsLocalMutation(async () => {
        const p = createCustomProfile({
          name: params.name?.trim() || '自定义服务商',
          ...(params.baseUrl?.trim() ? { baseUrl: params.baseUrl.trim() } : {}),
          models: [],
          protocol:
            (params.protocol as ProviderProfile['protocol']) ||
            DEFAULT_PROTOCOL,
        });
        refresh();
        setSelectedIdState(p.id);
        setAddOpen(false);

        const shell = await ensureProviderShell({
          providerId: p.id,
          displayName: p.name,
          baseUrl: p.baseUrl,
          protocol: p.protocol ?? DEFAULT_PROTOCOL,
        });
        if (!shell.ok) notify(false, shell.error || '写入服务商失败');

        if (params.apiKey?.trim()) {
          const keyRes = await saveProfileKey(p.id, params.apiKey.trim());
          if (!keyRes.ok) {
            notify(false, `API Key 保存失败: ${keyRes.error || '未知错误'}`);
          } else {
            notify(true, '服务商已添加，正在自动扫描可用模型...');
            void runScan();
          }
        }
        refresh();
        return p;
      });
    },
    [refresh, runAsLocalMutation, notify, runScan]
  );

  const handleManualAdd = () => {
    if (!selected) return;
    const id = normalizeModelIds([addDraft.modelId])[0];
    if (!id) {
      notify(false, '请填写模型 id');
      return;
    }
    const snap = { ...addDraft };
    // 词表外键显式诊断（第一防线，plans/09 §4.1）：落盘前校验 thinking 键，阻止透传。
    if (snap.thinkingEnabled === true) {
      const diag = thinkingVocabularyDiagnostic(snap.thinkingMap);
      if (diag) {
        notify(false, diag);
        return;
      }
    }
    void runAsLocalMutation(async () => {
      const shell = await ensureProviderShell({
        providerId: selected.id,
        displayName: selected.name,
        baseUrl: selected.baseUrl,
        protocol: selected.protocol,
      });
      if (!shell.ok) {
        notify(false, shell.error || '写入服务商失败');
        return;
      }
      try {
        const res = await modelsCatalogStore.addModel(
          selected.id,
          addDraftToModelInput(id, snap)
        );
        if (!res.ok) {
          notify(false, res.error || '添加模型失败');
          return;
        }
      } catch (e) {
        notify(false, e instanceof Error ? e.message : String(e));
        return;
      }
      setAddDraft(emptyAddDraft());
      setManualOpen(false);
      await openConfigFor(id);
    });
  };

  // 列表/过滤只读 live 树（含停用，供开关再启用）。凭据壳 models[] 不当能力源。
  const modelsList = useMemo(() => {
    if (!selected) return [] as string[];
    const list = (getLiveProvider(selected.id)?.models ?? []).map((m) => m.id);
    const q = modelFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((m) => {
      const live = getLiveModel(selected.id, m);
      const name = (live?.displayName || '').toLowerCase();
      return m.toLowerCase().includes(q) || name.includes(q);
    });
  }, [selected, modelFilter, catalogVersion]);

  const modelsCount = useMemo(() => {
    if (!selected) return 0;
    return getLiveProvider(selected.id)?.models?.length ?? 0;
  }, [selected, catalogVersion]);
  const selectedLabel = selected ? profileDisplayLabel(selected) : '';
  const hasKeySelected = selected ? profileHasKey(selected) : false;

  return {
    profiles,
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
    runAsLocalMutation,
    saveKey,
    addCustomProvider,
    handleManualAdd,
    openConfigFor,
    closeConfig,
    saveConfig,
    runTest,
    runScan,
    runCheck,
    scanModalOpen,
    setScanModalOpen,
    scannedModelsList,
    confirmScannedModels,
    modelsList,
    modelsCount,
    selectedLabel,
    hasKeySelected,
    activeProfileId,
    globalActiveModelId,
  };
}
