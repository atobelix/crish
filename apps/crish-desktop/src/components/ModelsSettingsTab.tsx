/**
 * 设置 · 模型：选择服务商、配置密钥，并管理可用模型。
 */
import React, { useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import {
  addModelToProfile,
  createCustomProfile,
  isEmptyModelCatalog,
  loadProfiles,
  mergeModelIds,
  normalizeModelIds,
  profileDisplayLabel,
  profileHasKey,
  removeModelFromProfile,
  removeProfile,
  saveProfileKey,
  saveProfileBaseUrl,
  setProfileEnabled,
  type ProviderProfile,
  upsertProfile,
  activateProfileModel,
  getActiveProfileId,
  getActiveModelId,
  truncateProfileLabel,
} from '../api/providerProfiles';
import {
  formatContextLabelZh,
  formatModelDisplayName,
  getModelMeta,
  MODEL_CAPABILITY_OPTIONS,
  scanProviderModels,
  setModelCapability,
  setModelContextLength,
  setModelDisplayName,
  setModelEnabled,
  testProviderModel,
  type ModelCapabilityKey,
} from '../api/modelCatalog';
import { estimateCostUsd, loadPrices, upsertPrice } from '../api/pricingStore';

type Props = {
  onShowToast?: (msg: string) => void;
};

const PRESETS: {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  format: 'openai' | 'anthropic';
}[] = [
  {
    id: 'preset-openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [],
    format: 'openai',
  },
  {
    id: 'preset-deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: [],
    format: 'openai',
  },
  {
    id: 'preset-anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: [],
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

type AddDraft = {
  displayName: string;
  modelId: string;
  contextLength: string;
  caps: Record<ModelCapabilityKey, boolean>;
};

function emptyAddDraft(): AddDraft {
  return {
    displayName: '',
    modelId: '',
    contextLength: '',
    caps: { tools: false, vision: false, reasoning: false },
  };
}

export const ModelsSettingsTab: React.FC<Props> = ({ onShowToast }) => {
  const baseId = useId();
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
  const [scanBusy, setScanBusy] = useState(false);
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [priceIn, setPriceIn] = useState('');
  const [priceOut, setPriceOut] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  /** 展开配置的模型 id */
  const [configOpenId, setConfigOpenId] = useState<string | null>(null);
  /** 手动添加面板 */
  const [manualOpen, setManualOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AddDraft>(() => emptyAddDraft());
  /** 获取列表弹窗（portal） */
  const [fetchOpen, setFetchOpen] = useState(false);
  const [fetchIds, setFetchIds] = useState<string[]>([]);
  const [fetchMsg, setFetchMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** 展开配置草稿（不改模型 id，避免主路径与能力区抢位） */
  const [cfgDraft, setCfgDraft] = useState<{
    displayName: string;
    contextLength: string;
    caps: Record<ModelCapabilityKey, boolean>;
  } | null>(null);

  const selected = useMemo(
    () => profiles.find((p) => p.id === selectedId) || null,
    [profiles, selectedId],
  );

  const profileStats = useMemo(() => {
    const total = profiles.length;
    const withKey = profiles.filter((p) => profileHasKey(p)).length;
    const catalogEmpty = isEmptyModelCatalog(profiles);
    return { total, withKey, catalogEmpty };
  }, [profiles]);

  const refresh = () => {
    try {
      setProfiles(loadProfiles());
    } catch (e) {
      onShowToast?.(`读取服务商失败：${e instanceof Error ? e.message : String(e)}`);
      setProfiles([]);
    }
  };

  /** 成功默认静默；错误走悬浮 toast，不在页内插横幅 */
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
      setMoreOpen(false);
      setModelFilter('');
      setConfigOpenId(null);
      setCfgDraft(null);
      setManualOpen(false);
      setAddDraft(emptyAddDraft());
    }
  }, [selectedId]);


  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (fetchOpen) {
        setFetchOpen(false);
        e.preventDefault();
        return;
      }
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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fetchOpen, addOpen, configOpenId, manualOpen, modelFilter]);

  const saveKey = async () => {
    if (!selected || !keyDraft.trim()) return;
    const res = await saveProfileKey(selected.id, keyDraft.trim());
    refresh();
    setKeyDraft('');
    if (!res.ok) notify(false, `保存失败：${res.error || '未知错误'}`);
  };

  const addFromTemplate = (format: 'openai' | 'anthropic') => {
    const p = createCustomProfile({
      name: format === 'openai' ? 'OpenAI 格式' : 'Anthropic 格式',
      baseUrl:
        format === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1',
      models: [],
    });
    refresh();
    setSelectedId(p.id);
    setAddOpen(false);

  };

  const addFromPreset = (preset: (typeof PRESETS)[0]) => {
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
    },
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
    // 展开模型配置时收起计费区，避免两块内容叠在同一视口
    setMoreOpen(false);
    setManualOpen(false);
    setConfigOpenId(model);
    setCfgDraft({
      displayName: meta.displayName || '',
      contextLength: meta.contextLength != null ? String(meta.contextLength) : '',
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

  const runScan = async () => {
    if (!selected) {
      notify(false, '请先选择服务商');
      return;
    }
    setFetchOpen(true);
    setFetchIds([]);
    setFetchMsg(null);
    setScanBusy(true);
    try {
      const fresh = loadProfiles().find((p) => p.id === selected.id) || selected;
      if (!fresh.apiKey?.trim()) {
        // hasKey 仅标记但无内存密钥：仍无法直连接口，需用户再贴一次
        setFetchMsg({
          ok: false,
          text: fresh.hasKey
            ? '密钥未载入，请重新粘贴并保存后再获取'
            : '请先填写并保存密钥',
        });
        notify(
          false,
          fresh.hasKey
            ? '密钥未载入，请重新粘贴并保存后再获取'
            : '请先填写并保存密钥',
        );
        return;
      }
      const r = await scanProviderModels(fresh);
      if (r.ok && r.models?.length) {
        const merged = mergeModelIds(fresh.models, r.models);
        upsertProfile({ ...fresh, models: merged });
        refresh();
        setFetchIds(r.models);
        setFetchMsg({
          ok: true,
          text: `已获取 ${r.models.length} 个`,
        });

      } else if (r.ok) {
        setFetchIds([]);
        setFetchMsg({
          ok: false,
          text: '没有拉到模型，可检查地址或手动添加',
        });
      } else {
        setFetchIds([]);
        setFetchMsg({ ok: false, text: r.error || '获取失败' });
        notify(false, r.error || '获取失败');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFetchMsg({ ok: false, text: msg });
      notify(false, msg);
    } finally {
      setScanBusy(false);
    }
  };

  const runTest = async (model: string) => {
    if (!selected) return;
    const key = `${selected.id}::${model}`;
    setTestBusy(key);

    try {
      const fresh = loadProfiles().find((p) => p.id === selected.id) || selected;
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

  const activateModel = (model: string) => {
    if (!selected) return;
    void activateProfileModel(selected.id, model).then((r) => {
      if (!r.ok) {
        notify(false, `切换失败：${r.error || '未知错误'}`);
      } else if (r.warning === 'no_local_key') {
        notify(false, '本地没有密钥，请先保存');
      } else if (r.warning === 'model_mismatch') {
        notify(false, '切换未生效，请重试');
      }
      refresh();
    });
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
  }, [selected, modelFilter, profiles]);

  const modelsCount = normalizeModelIds(selected?.models).length;
  const selectedLabel = selected ? profileDisplayLabel(selected) : '';
  const hasKeySelected = selected ? profileHasKey(selected) : false;
  const activeModelId =
    selected && getActiveProfileId() === selected.id ? getActiveModelId() || '' : '';
  const savedPrices = useMemo(() => loadPrices(), [profiles, priceIn, priceOut, moreOpen]);

  const fetchModal =
    fetchOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="settings-dialog-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setFetchOpen(false);
            }}
          >
            <div
              className="settings-dialog settings-dialog--models"
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${baseId}-fetch-title`}
            >
              <div className="settings-dialog-head">
                <div id={`${baseId}-fetch-title`} className="settings-dialog-title">
                  获取模型列表
                  {selectedLabel ? ` · ${selectedLabel}` : ''}
                </div>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  aria-label="关闭"
                  onClick={() => setFetchOpen(false)}
                >
                  <Lucide.X size={16} aria-hidden />
                </button>
              </div>
              <div className="settings-dialog-body">
                <p className="models-fetch-note">
                  这是尝试性拉取：成功后会合并进本供应商列表，但仍需在列表中配置展示名、上下文与能力。
                </p>
                <div className="models-catalog-list" role="list" aria-label="获取结果">
                  {scanBusy && fetchIds.length === 0 ? (
                    <div className="models-empty models-empty--inline" role="status">
                      正在获取模型…
                    </div>
                  ) : !scanBusy && fetchMsg && !fetchMsg.ok && fetchIds.length === 0 ? (
                    <div className="models-empty models-empty--inline models-empty--err" role="alert">
                      {fetchMsg.text}
                    </div>
                  ) : !scanBusy && fetchIds.length === 0 ? (
                    <div className="models-empty models-empty--inline" role="status">
                      没有结果，可手动添加
                    </div>
                  ) : fetchIds.length === 0 ? (
                    <div className="models-empty models-empty--inline" role="status">
                      正在获取模型…
                    </div>
                  ) : (
                    fetchIds.map((m) => (
                      <div key={m} className="models-catalog-row" role="listitem">
                        <span className="models-catalog-name" title={m}>
                          {m}
                        </span>
                        <span className="models-rail-meta">已加入</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="settings-dialog-foot">
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  disabled={scanBusy}
                  onClick={() => void runScan()}
                >
                  {scanBusy ? '获取中…' : '重新获取'}
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() => setFetchOpen(false)}
                >
                  完成
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="models-tab">
      <header className="settings-page-head">
        <div className="models-head-row">
          <h2 className="settings-page-title" id={`${baseId}-title`}>
            模型
          </h2>
          <span className="models-head-stats" role="status" aria-live="polite">
            {profileStats.total > 0
              ? profileStats.withKey < profileStats.total
                ? `${profileStats.total - profileStats.withKey} 个缺密钥`
                : `${profileStats.total} 个服务商`
              : '从左侧添加'}
          </span>
        </div>
      </header>

      <div className="models-split">
        <aside className="models-rail" aria-labelledby={`${baseId}-title`}>
          <div className="models-rail-list" role="list" aria-label="供应商列表">
            {profiles.length === 0 ? (
              <div className="models-empty models-empty--inline" role="status">
                还没有服务商
              </div>
            ) : (
              profiles.map((p) => {
                const active = p.id === selectedId;
                const live = getActiveProfileId() === p.id;
                const label = profileDisplayLabel(p);
                const short = truncateProfileLabel(label, 18);
                const keyOk = profileHasKey(p);
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="listitem"
                    className={`models-rail-item ${active ? 'is-active' : ''}`}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setSelectedId(p.id)}
                  >
                    <span className="models-rail-name" title={label}>
                      {short}
                    </span>
                    <span className="models-rail-meta">
                      {!keyOk ? '缺密钥' : live ? '使用中' : p.enabled === false ? '停用' : ''}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="models-rail-add-wrap">
            <button
              type="button"
              className="models-rail-add"
              aria-expanded={addOpen}
              onClick={() => setAddOpen((v) => !v)}
            >
              <Lucide.Plus size={16} aria-hidden />
              添加服务商
            </button>
            {addOpen ? (
              <div className="models-add-menu" role="menu" aria-label="添加服务商方式">
                <div className="models-add-label">接口类型</div>
                <button
                  type="button"
                  role="menuitem"
                  className="models-add-item"
                  onClick={() => addFromTemplate('openai')}
                >
                  OpenAI 格式
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="models-add-item"
                  onClick={() => addFromTemplate('anthropic')}
                >
                  Anthropic 格式
                </button>
                <div className="models-add-divider" />
                <div className="models-add-label">常用服务</div>
                {PRESETS.map((pr) => (
                  <button
                    key={pr.id}
                    type="button"
                    role="menuitem"
                    className="models-add-item"
                    onClick={() => addFromPreset(pr)}
                  >
                    {pr.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </aside>

        <section
          className="models-detail"
          aria-label={selected ? `服务商 · ${selectedLabel}` : '服务商'}
        >
          {!selected ? (
            <div className="models-empty models-empty--inline" role="status">
              {profiles.length === 0
                ? '从左侧添加服务商'
                : '选择服务商'}
            </div>
          ) : (
            <>
              <div className="models-detail-top">
                <div>
                  <div className="models-detail-name" title={selected.id}>
                    {selectedLabel}
                  </div>
                </div>
                <div className="models-detail-top-actions">
                  <label
                    className="models-switch"
                    htmlFor={`${baseId}-enable`}
                    title={selected.enabled === false ? '已停用' : '已启用'}
                  >
                    <input
                      id={`${baseId}-enable`}
                      type="checkbox"
                      checked={selected.enabled !== false}
                      onChange={(e) => {
                        setProfileEnabled(selected.id, e.target.checked);

                        refresh();
                      }}
                    />
                    <span className="models-switch-ui" aria-hidden />
                    <span className="models-switch-text">启用</span>
                  </label>
                  {selected.id.startsWith('custom-') ? (
                    <button
                      type="button"
                      className="models-icon-btn danger"
                      title="删除服务商"
                      aria-label={`删除服务商 ${selectedLabel}`}
                      onClick={() => {
                        if (
                          !window.confirm(`确定删除「${selectedLabel}」？此操作不可撤销。`)
                        ) {
                          return;
                        }
                        const next = removeProfile(selected.id);
                        setProfiles(next);
                        setSelectedId(next[0]?.id || null);

                      }}
                    >
                      <Lucide.Trash2 size={16} aria-hidden />
                    </button>
                  ) : null}
                </div>
              </div>

              <section className="models-conn" aria-label="连接">
                <label className="models-field-block" htmlFor={`${baseId}-url`}>
                  <span className="models-field-label" id={`${baseId}-url-label`}>
                    接口地址
                  </span>
                  <input
                    id={`${baseId}-url`}
                    className="settings-field-input"
                    value={selected.baseUrl}
                    spellCheck={false}
                    aria-labelledby={`${baseId}-url-label`}
                    placeholder="https://api.example.com/v1"
                    onChange={(e) => {
                      upsertProfile({ ...selected, baseUrl: e.target.value });
                      refresh();
                    }}
                    onBlur={() => {
                      if (!selected) return;
                      void saveProfileBaseUrl(selected.id, selected.baseUrl).then((r) => {
                        if (!r.ok) {
                          notify(false, `地址保存失败：${r.error || '未知错误'}`);
                        } else if (r.synced) {

                        }
                        refresh();
                      });
                    }}
                  />
                </label>
                <label className="models-field-block" htmlFor={`${baseId}-key`}>
                  <span className="models-field-label" id={`${baseId}-key-label`}>
                    密钥
                    {!hasKeySelected ? (
                      <span className="models-inline-badge models-inline-badge--warn">
                        未配置
                      </span>
                    ) : (
                      <span className="models-inline-badge">已保存</span>
                    )}
                  </span>
                  <div className="models-key-row">
                    <input
                      id={`${baseId}-key`}
                      className="settings-field-input"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      aria-labelledby={`${baseId}-key-label`}
                      placeholder={hasKeySelected ? '粘贴新密钥' : '粘贴密钥'}
                      value={keyDraft}
                      onChange={(e) => setKeyDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && keyDraft.trim()) {
                          e.preventDefault();
                          void saveKey();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="models-btn"
                      disabled={!keyDraft.trim()}
                      onClick={() => void saveKey()}
                    >
                      保存
                    </button>
                  </div>
                </label>
              </section>

              <div className="models-summary">
                <div className="models-summary-row">
                  <div className="models-summary-current">
                    <span className="models-summary-label">对话使用</span>
                    <span
                      className="models-summary-value"
                      title={activeModelId || '尚未选用'}
                    >
                      {activeModelId
                        ? formatModelDisplayName(selected.id, activeModelId)
                        : modelsCount > 0
                          ? '未选用'
                          : '暂无模型'}
                    </span>
                    <span className="models-summary-meta">
                      {modelsCount > 0
                        ? `${modelsCount} 个可选`
                        : hasKeySelected
                          ? '可获取或添加'
                          : '先保存密钥'}
                    </span>
                  </div>
                  <div className="models-summary-actions">
                    <button
                      type="button"
                      className="models-btn"
                      disabled={scanBusy || !hasKeySelected}
                      aria-busy={scanBusy}
                      title={
                        hasKeySelected
                          ? '从服务商获取模型'
                          : '请先保存密钥'
                      }
                      onClick={() => void runScan()}
                    >
                      {scanBusy ? '获取中…' : '获取模型'}
                    </button>
                    <button
                      type="button"
                      className="models-btn ghost"
                      onClick={() => {
                        setMoreOpen(false);
                        closeConfig();
                        setManualOpen(true);
                        setAddDraft(emptyAddDraft());
                      }}
                    >
                      <Lucide.Plus size={14} aria-hidden />
                      添加
                    </button>
                  </div>
                </div>
              </div>

              {manualOpen ? (
                <div className="models-config-panel" role="form" aria-label="手动添加模型">
                  <label className="models-config-field models-config-field--full">
                    <span>模型 id（必填）</span>
                    <input
                      className="settings-field-input"
                      value={addDraft.modelId}
                      placeholder="如 deepseek-chat"
                      spellCheck={false}
                      autoFocus
                      onChange={(e) =>
                        setAddDraft((d) => ({ ...d, modelId: e.target.value }))
                      }
                    />
                  </label>
                  <div className="models-config-grid models-config-grid--two">
                    <label className="models-config-field">
                      <span>展示名称</span>
                      <input
                        className="settings-field-input"
                        value={addDraft.displayName}
                        placeholder="可选，如 DeepSeek V3"
                        onChange={(e) =>
                          setAddDraft((d) => ({ ...d, displayName: e.target.value }))
                        }
                      />
                    </label>
                    <label className="models-config-field">
                      <span>上下文长度</span>
                      <input
                        className="settings-field-input"
                        value={addDraft.contextLength}
                        placeholder="如 128000"
                        inputMode="numeric"
                        onChange={(e) =>
                          setAddDraft((d) => ({ ...d, contextLength: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <div className="models-cap-row" role="group" aria-label="支持的能力">
                    {MODEL_CAPABILITY_OPTIONS.map((opt) => (
                      <label
                        key={opt.key}
                        className={`models-cap-chip${addDraft.caps[opt.key] ? ' is-on' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={!!addDraft.caps[opt.key]}
                          onChange={(e) =>
                            setAddDraft((d) => ({
                              ...d,
                              caps: { ...d.caps, [opt.key]: e.target.checked },
                            }))
                          }
                        />
                        <span className="models-cap-chip-ico" aria-hidden>
                          {opt.key === 'tools' ? (
                            <Lucide.Wrench size={13} />
                          ) : opt.key === 'vision' ? (
                            <Lucide.Eye size={13} />
                          ) : (
                            <Lucide.Brain size={13} />
                          )}
                        </span>
                        <span>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                  <div className="models-config-actions">
                    <button
                      type="button"
                      className="models-btn ghost"
                      onClick={() => {
                        setManualOpen(false);
                        setAddDraft(emptyAddDraft());
                      }}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="models-btn"
                      disabled={!addDraft.modelId.trim()}
                      onClick={handleManualAdd}
                    >
                      添加到列表
                    </button>
                  </div>
                </div>
              ) : null}

              <section className="models-list-section" aria-label="模型列表">
                <div className="models-list-head">
                  <span className="models-list-title">模型</span>
                  {modelsCount > 4 ? (
                    <input
                      className="settings-field-input models-filter-input"
                      type="search"
                      placeholder="筛选…"
                      value={modelFilter}
                      onChange={(e) => setModelFilter(e.target.value)}
                      aria-label="筛选模型"
                    />
                  ) : null}
                </div>

                <div className="models-main-list" role="list" aria-label="已配置模型">
                  {modelsCount === 0 ? (
                    <div className="models-empty models-empty--inline" role="status">
                      暂无模型 · 点「获取列表」或「添加」
                    </div>
                  ) : modelsList.length === 0 ? (
                    <div className="models-empty models-empty--inline" role="status">
                      无匹配「{modelFilter.trim()}」
                    </div>
                  ) : (
                    modelsList.map((m) => {
                      const meta = getModelMeta(selected.id, m);
                      const off = meta.enabled === false;
                      const tKey = `${selected.id}::${m}`;
                      const isLive =
                        getActiveProfileId() === selected.id && getActiveModelId() === m;
                      const expanded = configOpenId === m && !!cfgDraft;
                      const display =
                        expanded && cfgDraft?.displayName?.trim()
                          ? cfgDraft.displayName.trim()
                          : formatModelDisplayName(selected.id, m, meta);
                      const liveCtx =
                        expanded && cfgDraft
                          ? (() => {
                              const n = parseInt(
                                cfgDraft.contextLength.replace(/[^\d]/g, ''),
                                10,
                              );
                              return Number.isFinite(n) && n > 0
                                ? formatContextLabelZh(n)
                                : formatContextLabelZh(meta.contextLength);
                            })()
                          : formatContextLabelZh(meta.contextLength);
                      return (
                        <div
                          key={m}
                          className={`models-main-row${off ? ' is-off' : ''}${
                            expanded ? ' is-open' : ''
                          }${isLive ? ' is-live' : ''}`}
                          role="listitem"
                        >
                          <div className="models-main-row-top">
                            <button
                              type="button"
                              className="models-main-row-info models-main-row-info--btn"
                              onClick={() => {
                                if (expanded) closeConfig();
                                else openConfigFor(m);
                              }}
                              aria-expanded={expanded}
                            >
                              <span className="models-main-row-name" title={display}>
                                {display}
                              </span>
                              {liveCtx ? (
                                <span className="models-ctx" title={`上下文 ${liveCtx}`}>
                                  <Lucide.Layers size={12} aria-hidden />
                                  <span>{liveCtx}</span>
                                </span>
                              ) : null}
                            </button>
                            <div className="models-main-row-actions">
                              {isLive ? (
                                <span className="models-pill models-pill--live" title="当前对话使用此模型">
                                  使用中
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="models-btn models-btn--use"
                                  disabled={off}
                                  onClick={() => activateModel(m)}
                                  title={off ? '请先启用此模型' : '用于对话'}
                                >
                                  使用
                                </button>
                              )}
                              <label
                                className={`models-switch${off ? ' is-off' : ' is-on'}`}
                                title={off ? '已停用（对话列表不可选）' : '已启用'}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <input
                                  type="checkbox"
                                  checked={!off}
                                  onChange={(e) => {
                                    setModelEnabled(selected.id, m, e.target.checked);
                                    refresh();
                                  }}
                                />
                                <span className="models-switch-ui" aria-hidden />
                                <span className="sr-only">
                                  {off ? '启用' : '停用'} {display}
                                </span>
                              </label>
                              <button
                                type="button"
                                className={`models-icon-btn${expanded ? ' is-on' : ''}`}
                                title={expanded ? '收起' : '配置'}
                                aria-expanded={expanded}
                                onClick={() => {
                                  if (expanded) closeConfig();
                                  else openConfigFor(m);
                                }}
                              >
                                {expanded ? (
                                  <Lucide.ChevronUp size={15} aria-hidden />
                                ) : (
                                  <Lucide.SlidersHorizontal size={15} aria-hidden />
                                )}
                              </button>
                              <button
                                type="button"
                                className="models-icon-btn danger"
                                title="移除"
                                onClick={() => {
                                  removeModelFromProfile(selected.id, m);
                                  if (configOpenId === m) closeConfig();
                                  refresh();
                                }}
                              >
                                <Lucide.Trash2 size={14} aria-hidden />
                              </button>
                            </div>
                          </div>

                          {expanded && cfgDraft ? (
                            <div
                              className="models-config-panel models-config-panel--inline"
                              role="form"
                              aria-label={`${display} 配置`}
                            >
                              <div className="models-config-grid models-config-grid--two">
                                <label className="models-config-field">
                                  <span>展示名称</span>
                                  <input
                                    className="settings-field-input"
                                    value={cfgDraft.displayName}
                                    placeholder={m}
                                    onChange={(e) =>
                                      setCfgDraft((d) =>
                                        d ? { ...d, displayName: e.target.value } : d,
                                      )
                                    }
                                  />
                                </label>
                                <label className="models-config-field">
                                  <span>上下文长度</span>
                                  <input
                                    className="settings-field-input"
                                    value={cfgDraft.contextLength}
                                    placeholder="如 128000"
                                    inputMode="numeric"
                                    onChange={(e) =>
                                      setCfgDraft((d) =>
                                        d ? { ...d, contextLength: e.target.value } : d,
                                      )
                                    }
                                  />
                                </label>
                              </div>
                              <div className="models-config-idline" title={m}>
                                <span className="models-config-idline-label">id</span>
                                <code className="models-config-idline-value">{m}</code>
                              </div>
                              <div className="models-cap-row" role="group" aria-label="支持的能力">
                                {MODEL_CAPABILITY_OPTIONS.map((opt) => (
                                  <label
                                    key={opt.key}
                                    className={`models-cap-chip${
                                      cfgDraft.caps[opt.key] ? ' is-on' : ''
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={!!cfgDraft.caps[opt.key]}
                                      onChange={(e) =>
                                        setCfgDraft((d) =>
                                          d
                                            ? {
                                                ...d,
                                                caps: {
                                                  ...d.caps,
                                                  [opt.key]: e.target.checked,
                                                },
                                              }
                                            : d,
                                        )
                                      }
                                    />
                                    <span className="models-cap-chip-ico" aria-hidden>
                                      {opt.key === 'tools' ? (
                                        <Lucide.Wrench size={13} />
                                      ) : opt.key === 'vision' ? (
                                        <Lucide.Eye size={13} />
                                      ) : (
                                        <Lucide.Brain size={13} />
                                      )}
                                    </span>
                                    <span>{opt.label}</span>
                                  </label>
                                ))}
                              </div>
                              <div className="models-config-actions">
                                <button
                                  type="button"
                                  className="models-btn ghost"
                                  title="测试连通"
                                  disabled={testBusy === tKey}
                                  onClick={() => void runTest(m)}
                                >
                                  {testBusy === tKey ? '测试中…' : '测试'}
                                </button>
                                <span className="models-config-actions-spacer" aria-hidden />
                                <button
                                  type="button"
                                  className="models-btn ghost"
                                  onClick={closeConfig}
                                >
                                  收起
                                </button>
                                <button
                                  type="button"
                                  className="models-btn"
                                  onClick={saveConfig}
                                >
                                  保存
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              <section className="models-billing" aria-label="计费单价">
                <button
                  type="button"
                  className="models-billing-toggle"
                  aria-expanded={moreOpen}
                  onClick={() => {
                    setMoreOpen((v) => {
                      const next = !v;
                      if (next) closeConfig();
                      return next;
                    });
                  }}
                >
                  <span className="models-billing-title">计费单价</span>
                  <span className="models-billing-toggle-side">
                    {savedPrices.length > 0 ? `${savedPrices.length}` : '—'}
                    <Lucide.ChevronDown
                      size={14}
                      className={`models-billing-chevron${moreOpen ? ' is-open' : ''}`}
                      aria-hidden
                    />
                  </span>
                </button>
                {moreOpen ? (
                  <div className="models-billing-body">
                    <div className="models-price-row">
                      <label className="models-price-field">
                        <span>输入 $/1M</span>
                        <input
                          className="settings-field-input"
                          placeholder="0.27"
                          inputMode="decimal"
                          value={priceIn}
                          onChange={(e) => setPriceIn(e.target.value)}
                        />
                      </label>
                      <label className="models-price-field">
                        <span>输出 $/1M</span>
                        <input
                          className="settings-field-input"
                          placeholder="1.10"
                          inputMode="decimal"
                          value={priceOut}
                          onChange={(e) => setPriceOut(e.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        className="models-btn ghost"
                        onClick={() => {
                          const model =
                            getActiveModelId() || normalizeModelIds(selected.models)[0];
                          if (!model) {
                            notify(false, '无可用模型，请先添加或获取列表');
                            return;
                          }
                          const inp = parseFloat(priceIn);
                          const out = parseFloat(priceOut);
                          upsertPrice({
                            model,
                            inputPerMTok: Number.isFinite(inp) ? inp : 0,
                            outputPerMTok: Number.isFinite(out) ? out : 0,
                          });
                          setPriceIn('');
                          setPriceOut('');

                        }}
                      >
                        保存
                      </button>
                    </div>
                    {savedPrices.length > 0 ? (
                      <ul className="models-price-list" aria-label="已保存单价">
                        {savedPrices.slice(0, 6).map((pr) => (
                          <li key={pr.model} className="models-price-item">
                            <span className="models-price-model" title={pr.model}>
                              {pr.model}
                            </span>
                            <span className="models-price-rates">
                              {pr.inputPerMTok} / {pr.outputPerMTok}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="models-billing-empty" role="status">
                        暂无
                      </div>
                    )}
                  </div>
                ) : null}
              </section>
            </>
          )}
        </section>
      </div>

      {fetchModal}
    </div>
  );
};