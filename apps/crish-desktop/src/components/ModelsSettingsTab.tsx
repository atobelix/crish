/**
 * 设置 · 模型：选择服务商、配置密钥，并管理可用模型。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import {
  addModelToProfile,
  createCustomProfile,
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
} from '../api/providerProfiles';
import {
  formatContextLabel,
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

import styles from './ModelsSettingsTab.module.css';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  Tooltip,
} from './settings/SettingsUI';

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


interface ModelsCascadeSelectProps {
  profiles: ProviderProfile[];
  activeProfileId: string;
  activeModelId: string;
  onChange: (profileId: string, modelId: string) => void;
}

const ModelsCascadeSelect: React.FC<ModelsCascadeSelectProps> = ({
  profiles,
  activeProfileId,
  activeModelId,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [flyProfileId, setFlyProfileId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number; width: number } | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const place = () => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({
      top: r.bottom + 4,
      right: window.innerWidth - r.right,
      width: Math.max(r.width, 220),
    });
  };

  React.useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
      setFlyProfileId(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setFlyProfileId(null);
      }
    };
    const onReposition = (e?: Event) => {
      if (e?.target && menuRef.current?.contains(e.target as Node)) {
        return;
      }
      if (!triggerRef.current) return;
      const r = triggerRef.current.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) {
        setOpen(false);
        setFlyProfileId(null);
      } else {
        place();
      }
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, pos]);

  const enabledProfiles = useMemo(() => {
    return profiles.filter((p) => p.enabled !== false && p.models.length > 0);
  }, [profiles]);

  const activeProfile = enabledProfiles.find((p) => p.id === activeProfileId);
  const activeLabel =
    activeProfile && activeModelId
      ? `${profileDisplayLabel(activeProfile).replace(/\s*\/\s*默认$/, '')} · ${formatModelDisplayName(
          activeProfile.id,
          activeModelId
        )}`
      : '请选择默认模型...';

  const flyProfile = enabledProfiles.find((p) => p.id === flyProfileId);

  return (
    <div className={`settings-select ${open ? 'is-open' : ''}`} style={{ display: 'inline-block' }}>
      <button
        ref={triggerRef}
        type="button"
        className="settings-select-trigger"
        onClick={() => setOpen((prev) => !prev)}
        style={{ minWidth: '220px', justifyContent: 'space-between' }}
      >
        <span
          className="settings-select-value"
          style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}
        >
          {activeLabel}
        </span>
        <Lucide.ChevronDown size={14} style={{ opacity: 0.6, flexShrink: 0 }} />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="sort-filter-menu open"
          style={{
            position: 'fixed',
            top: pos.top,
            right: pos.right,
            width: pos.width,
            overflow: 'visible',
            zIndex: 100000,
          }}
          onMouseLeave={() => setFlyProfileId(null)}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="sort-filter-menu-title">选择服务商与模型</div>
          {enabledProfiles.length === 0 ? (
            <div className="sort-filter-option" style={{ color: 'var(--text-tertiary)', cursor: 'default' }}>
              暂无已启用的可用模型
            </div>
          ) : (
            enabledProfiles.map((p) => {
              const isFly = flyProfileId === p.id;
              const isCurrentActive = p.id === activeProfileId;
              const cleanLabel = profileDisplayLabel(p).replace(/\s*\/\s*默认$/, '');

              return (
                <div
                  key={p.id}
                  className={`sort-filter-row ${isFly ? 'is-open' : ''}`}
                  onMouseEnter={() => setFlyProfileId(p.id)}
                  style={{ position: 'relative', cursor: 'pointer' }}
                >
                  <span
                    className="sort-filter-row-label"
                    style={{ fontWeight: isCurrentActive ? '500' : 'normal' }}
                  >
                    {cleanLabel}
                  </span>
                  <Lucide.ChevronRight size={14} className="sort-filter-chev" />

                  {isFly && flyProfile && flyProfile.id === p.id && (
                    <div
                      className="sort-filter-flyout"
                      style={{
                        position: 'absolute',
                        right: 'calc(100% + 6px)',
                        top: 0,
                        minWidth: '180px',
                        maxHeight: '280px',
                        overflowY: 'auto',
                        overscrollBehavior: 'contain',
                        zIndex: 100001,
                      }}
                      onWheel={(e) => e.stopPropagation()}
                    >
                      {flyProfile.models.map((m) => {
                        const selected =
                          p.id === activeProfileId && m === activeModelId;
                        return (
                          <button
                            key={m}
                            type="button"
                            className={`sort-filter-option ${selected ? 'is-on' : ''}`}
                            onClick={() => {
                              onChange(p.id, m);
                              setOpen(false);
                              setFlyProfileId(null);
                            }}
                          >
                            <span
                              style={{
                                textOverflow: 'ellipsis',
                                overflow: 'hidden',
                                whiteSpace: 'nowrap',
                                flex: 1,
                              }}
                            >
                              {formatModelDisplayName(p.id, m)}
                            </span>
                            {selected && (
                              <Lucide.Check size={14} className="sort-filter-check" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>,
        document.body
      )}
    </div>
  );
};

export const ModelsSettingsTab: React.FC<Props> = ({ onShowToast }) => {
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
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  /** 展开配置的模型 id */
  const [configOpenId, setConfigOpenId] = useState<string | null>(null);
  /** 手动添加面板 */
  const [manualOpen, setManualOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AddDraft>(() => emptyAddDraft());
  /** 展开配置草稿（不改模型 id，避免主路径与能力区抢位） */
  const [cfgDraft, setCfgDraft] = useState<{
    displayName: string;
    contextLength: string;
    caps: Record<ModelCapabilityKey, boolean>;
  } | null>(null);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const selected = useMemo(
    () => profiles.find((p) => p.id === selectedId) || null,
    [profiles, selectedId],
  );



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
      setModelFilter('');
      setConfigOpenId(null);
      setCfgDraft(null);
      setManualOpen(false);
      setAddDraft(emptyAddDraft());
      setEditingName(false);
      setNameDraft('');
    }
  }, [selectedId]);


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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addOpen, configOpenId, manualOpen, modelFilter]);

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
  const runScan = async () => {
    if (!selected) return;
    setScanBusy(true);
    try {
      const fresh = loadProfiles().find((p) => p.id === selected.id) || selected;
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
      const fresh = loadProfiles().find((p) => p.id === selected.id) || selected;
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
  }, [selected, modelFilter, profiles]);

  const modelsCount = normalizeModelIds(selected?.models).length;
  const selectedLabel = selected ? profileDisplayLabel(selected) : '';
  const hasKeySelected = selected ? profileHasKey(selected) : false;



  const addRef = React.useRef<HTMLDivElement>(null);
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

  const headerMeta = (
    <div ref={addRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="settings-select-trigger"
        onClick={() => setAddOpen((v) => !v)}
      >
        <Lucide.Plus size={13} style={{ opacity: 0.75 }} />
        <span>添加服务商</span>
      </button>

      {addOpen && (
        <div
          className="sort-filter-menu open"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            minWidth: '180px',
            zIndex: 10000,
          }}
          role="menu"
          aria-label="添加服务商"
        >
          <div className="sort-filter-menu-title">接口类型</div>
          <button
            type="button"
            role="menuitem"
            className="sort-filter-option"
            onClick={() => {
              addFromTemplate('openai');
              setAddOpen(false);
            }}
          >
            OpenAI 格式
          </button>
          <button
            type="button"
            role="menuitem"
            className="sort-filter-option"
            onClick={() => {
              addFromTemplate('anthropic');
              setAddOpen(false);
            }}
          >
            Anthropic 格式
          </button>

          <div className="sort-filter-menu-title" style={{ marginTop: '4px' }}>常用服务</div>
          {PRESETS.map((pr) => (
            <button
              key={pr.id}
              type="button"
              role="menuitem"
              className="sort-filter-option"
              onClick={() => {
                addFromPreset(pr);
                setAddOpen(false);
              }}
            >
              {pr.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const activeProfileId = getActiveProfileId();
  const globalActiveModelId = getActiveModelId();

  return (
    <SettingsPage title="模型" meta={headerMeta}>
      {/* Default model */}
      <SettingsSection title="默认模型">
        <SettingsCard>
          <SettingsRow
            title="全局默认模型"
            desc="新建对话时使用此模型"
            control={
              <ModelsCascadeSelect
                profiles={profiles}
                activeProfileId={activeProfileId || ''}
                activeModelId={globalActiveModelId || ''}
                onChange={(pId, mId) => {
                  activateProfileModel(pId, mId);
                }}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      {/* Provider split layout */}
      <div className={`${styles.modelsSplit} models-split`}>
        {/* Left rail */}
        <aside className={`${styles.modelsRail} models-rail`} aria-label="服务商列表">
          {/* Rail header */}
          <div className={`${styles.mrlHeader} mrl-header`}>
            <h3 className="settings-ui-section-title">AI 服务商</h3>
          </div>

          {/* Provider list */}
          <div className={`${styles.mrlList} mrl-list`} role="list">
            {profiles.length === 0 ? (
              <div className={`${styles.mrlEmpty} mrl-empty`}>还没有服务商</div>
            ) : (
              profiles.map((p) => {
                const isActive = p.id === selectedId;
                const label = profileDisplayLabel(p);
                const keyOk = profileHasKey(p);
                const enabled = p.enabled !== false;

                return (
                  <button
                    key={p.id}
                    type="button"
                    role="listitem"
                    className={`${styles.mrlItem} mrl-item ${isActive ? styles.isActive + ' is-active' : ''}`}
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => setSelectedId(p.id)}
                  >
                    <div className={`${styles.mrlItemRowTop} mrl-item-row-top`}>
                      <span className={`${styles.mrlItemName} mrl-item-name`} title={label}>{label}</span>
                      <span
                        className={`${styles.mrlItemDot} mrl-item-dot`}
                        title={!keyOk ? '缺少密钥' : !enabled ? '已停用' : '已配置并启用'}
                        style={{
                          background: !keyOk ? '#e6a817' : !enabled ? 'var(--text-tertiary)' : '#22c55e',
                          opacity: !enabled ? 0.6 : 1,
                        }}
                      />
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Right detail */}
        <section className={`${styles.modelsDetail} models-detail`} aria-label={selected ? `服务商 · ${selectedLabel}` : '服务商'}>
          {!selected ? (
            <div className={`${styles.mrdEmpty} mrd-empty`}>
              {profiles.length === 0 ? '从左侧添加服务商以开始' : '在左侧选择一个服务商'}
            </div>
          ) : (
            <div className={`${styles.mrdBody} mrd-body`}>
              {/* Detail header */}
              <div className="mrd-head">
                <div className="mrd-head-left" style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {editingName && selected.id.startsWith('custom-') ? (
                    <input
                      className="mrd-title"
                      value={nameDraft}
                      autoFocus
                      onChange={(e) => setNameDraft(e.target.value)}
                      onBlur={() => {
                        if (nameDraft.trim() && nameDraft.trim() !== selected.name) {
                          upsertProfile({ ...selected, name: nameDraft.trim() });
                          refresh();
                        }
                        setEditingName(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.currentTarget.blur();
                        } else if (e.key === 'Escape') {
                          setEditingName(false);
                        }
                      }}
                      style={{
                        border: 'none',
                        borderBottom: '1px dashed var(--accent-primary)',
                        background: 'transparent',
                        padding: '0',
                        margin: '0',
                        outline: 'none',
                        fontSize: '15px',
                        fontWeight: 600,
                        letterSpacing: '-0.015em',
                        color: 'var(--text-primary)',
                        fontFamily: 'inherit',
                        height: '27px',
                        lineHeight: '27px',
                      }}
                    />
                  ) : selected.id.startsWith('custom-') ? (
                    <Tooltip content="点击重命名服务商">
                      <h3
                        className="mrd-title"
                        onClick={() => {
                          setEditingName(true);
                          setNameDraft(selected.name);
                        }}
                        style={{
                          cursor: 'pointer',
                          borderBottom: '1px dashed var(--border-subtle)',
                          transition: 'border-color 0.15s ease',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = 'var(--text-secondary)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = 'var(--border-subtle)';
                        }}
                      >
                        {selectedLabel}
                      </h3>
                    </Tooltip>
                  ) : (
                    <h3 className="mrd-title">{selectedLabel}</h3>
                  )}
                </div>
                <div className="mrd-head-right" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm"
                    style={{
                      height: '26px',
                      padding: '0 10px',
                      fontSize: '12px',
                      fontWeight: 500,
                      borderRadius: '6px',
                      border: selected.enabled !== false ? '1px solid color-mix(in srgb, #22c55e 30%, transparent)' : '1px solid var(--border-subtle)',
                      background: selected.enabled !== false ? 'color-mix(in srgb, #22c55e 12%, transparent)' : 'color-mix(in srgb, var(--text-primary) 4%, transparent)',
                      color: selected.enabled !== false ? '#15803d' : 'var(--text-tertiary)',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                    onClick={() => { setProfileEnabled(selected.id, selected.enabled === false); refresh(); }}
                  >
                    {selected.enabled !== false ? '已启用' : '已停用'}
                  </button>

                  {selected.id.startsWith('custom-') && (
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      style={{ padding: '0 6px', height: '28px', color: 'var(--text-tertiary)' }}
                      title={`删除「${selectedLabel}」`}
                      onClick={() => {
                        if (!window.confirm(`确定删除服务商「${selectedLabel}」？此操作不可撤销。`)) return;
                        const next = removeProfile(selected.id);
                        setProfiles(next);
                        setSelectedId(next[0]?.id || null);
                      }}
                    >
                      <Lucide.Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>

              {/* Credentials */}
              {selected.id.startsWith('custom-') && (
                <div className={`${styles.mrdFields} mrd-fields`}>
                  <div className={`${styles.mrdField} mrd-field`}>
                    <label className={`${styles.mrdFieldLabel} mrd-field-label`}>Base URL</label>
                    <input
                      className={`${styles.mrdFieldInput} mrd-field-input`}
                      value={selected.baseUrl}
                      placeholder="https://api.example.com/v1"
                      spellCheck={false}
                      onChange={(e) => { upsertProfile({ ...selected, baseUrl: e.target.value }); refresh(); }}
                      onBlur={() => {
                        if (!selected) return;
                        void saveProfileBaseUrl(selected.id, selected.baseUrl).then((r) => {
                          if (!r.ok) notify(false, `地址保存失败：${r.error || '未知错误'}`);
                          refresh();
                        });
                      }}
                    />
                  </div>
                  <div className={`${styles.mrdField} mrd-field`}>
                    <label className={`${styles.mrdFieldLabel} mrd-field-label`}>API Key</label>
                    <div className={`${styles.mrdKeyRow} mrd-key-row`}>
                      <input
                        className={`${styles.mrdFieldInput} mrd-field-input`}
                        type="password"
                        placeholder={hasKeySelected ? '••••••••••••••••••••' : '粘贴 API Key'}
                        value={keyDraft}
                        onChange={(e) => setKeyDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && keyDraft.trim()) { e.preventDefault(); void saveKey(); } }}
                      />
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary ui-btn-sm"
                        disabled={!keyDraft.trim()}
                        onClick={() => void saveKey()}
                        style={{ borderRadius: '7px', height: '34px', padding: '0 14px', flexShrink: 0 }}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Model list header */}
              <div className={`${styles.mrdModelsHead} mrd-models-head`}>
                <span className={`${styles.mrdModelsLabel} mrd-models-label`}>模型列表</span>
                <div className={`${styles.mrdModelsActions} mrd-models-actions`}>
                  <Tooltip content="检查服务商连通性">
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      disabled={checkBusy}
                      onClick={runCheck}
                      style={{ height: '28px', width: '28px', padding: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                      aria-label="检查连通性"
                    >
                      {checkBusy ? <Lucide.Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Lucide.Wifi size={13} />}
                    </button>
                  </Tooltip>
                  <Tooltip content="自动获取服务商模型列表">
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      disabled={scanBusy}
                      onClick={runScan}
                      style={{ height: '28px', width: '28px', padding: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                      aria-label="自动获取"
                    >
                      {scanBusy ? <Lucide.Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Lucide.RefreshCw size={13} />}
                    </button>
                  </Tooltip>
                  <div style={{ position: 'relative' }}>
                    <Lucide.Search size={12} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', pointerEvents: 'none' }} />
                    <input
                      type="text"
                      placeholder="搜索..."
                      value={modelFilter}
                      onChange={(e) => setModelFilter(e.target.value)}
                      className={`${styles.mrdSearch} mrd-search`}
                      spellCheck={false}
                    />
                  </div>
                  <Tooltip content="手动添加模型">
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      onClick={() => { setManualOpen(!manualOpen); setAddDraft(emptyAddDraft()); }}
                      style={{ height: '28px', width: '28px', padding: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                      aria-label="添加模型"
                    >
                      <Lucide.Plus size={13} />
                    </button>
                  </Tooltip>
                </div>
              </div>

              {/* Manual add form */}
              {manualOpen && (
                <div className={`${styles.mrdAddForm} mrd-add-form`}>
                  <div className={`${styles.mrdAddFormFields} mrd-add-form-fields`}>
                    <label className={`${styles.mrdAddLabel} mrd-add-label`}>
                      <span>模型 ID *</span>
                      <input className={`${styles.mrdFieldInput} mrd-field-input`} placeholder="如 deepseek-chat" value={addDraft.modelId} onChange={(e) => setAddDraft((d) => ({ ...d, modelId: e.target.value }))} spellCheck={false} />
                    </label>
                    <label className={`${styles.mrdAddLabel} mrd-add-label`}>
                      <span>展示名称</span>
                      <input className={`${styles.mrdFieldInput} mrd-field-input`} placeholder="可选" value={addDraft.displayName} onChange={(e) => setAddDraft((d) => ({ ...d, displayName: e.target.value }))} />
                    </label>
                    <label className={`${styles.mrdAddLabel} mrd-add-label`}>
                      <span>上下文长度</span>
                      <input className={`${styles.mrdFieldInput} mrd-field-input`} placeholder="128000" value={addDraft.contextLength} onChange={(e) => setAddDraft((d) => ({ ...d, contextLength: e.target.value }))} />
                    </label>
                  </div>
                  <div className={`${styles.mrdAddFormFooter} mrd-add-form-footer`}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {MODEL_CAPABILITY_OPTIONS.map((opt) => {
                        const on = !!addDraft.caps[opt.key];
                        return (
                          <label key={opt.key} className={`${styles.mrdCapPill} mrd-cap-pill ${on ? styles.isOn + ' is-on' : ''}`}>
                            <input type="checkbox" style={{ display: 'none' }} checked={on} onChange={(e) => setAddDraft((d) => ({ ...d, caps: { ...d.caps, [opt.key]: e.target.checked } }))} />
                            {opt.label}
                          </label>
                        );
                      })}
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setManualOpen(false)}>取消</button>
                      <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" disabled={!addDraft.modelId.trim()} onClick={handleManualAdd}>添加</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Model rows */}
              <div className={`${styles.mrdModelList} mrd-model-list`}>
                {modelsList.map((m) => {
                  const meta = getModelMeta(selected.id, m);
                  const off = meta.enabled === false;
                  const tKey = `${selected.id}::${m}`;
                  const isLive = getActiveProfileId() === selected.id && getActiveModelId() === m;
                  const expanded = configOpenId === m && !!cfgDraft;
                  const display = expanded && cfgDraft?.displayName?.trim()
                    ? cfgDraft.displayName.trim()
                    : formatModelDisplayName(selected.id, m, meta);
                  const liveCtxVal = expanded && cfgDraft
                    ? (() => { const n = parseInt(cfgDraft.contextLength.replace(/[^\d]/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : meta.contextLength; })()
                    : meta.contextLength;
                  const liveCtxLabel = formatContextLabel(liveCtxVal);
                  const showCtx = liveCtxLabel && liveCtxLabel !== '—';

                  return (
                    <div
                      key={m}
                      className={`${styles.mrdModelRow} mrd-model-row ${off ? 'is-off' : ''} ${isLive ? 'is-live' : ''} ${expanded ? 'is-expanded' : ''}`}
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.closest('.models-switch') || target.closest('.mrd-delete-btn')) {
                          return;
                        }
                        if (expanded) closeConfig();
                        else openConfigFor(m);
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      <div className={`${styles.mrdModelInfo} mrd-model-info`}>
                        <span className={`${styles.mrdModelName} mrd-model-name`}>{display}</span>
                        <div className="mrd-model-meta">
                          {showCtx && <span className={`${styles.mrdCtxPill} mrd-ctx-pill`}>{liveCtxLabel}</span>}
                          {meta.capabilities?.tools && <span className={`${styles.mrdCapTag} mrd-cap-tag`} title="支持工具调用"><Lucide.Wrench size={10} /></span>}
                          {meta.capabilities?.vision && <span className={`${styles.mrdCapTag} mrd-cap-tag`} title="支持视觉"><Lucide.Eye size={10} /></span>}
                          {meta.capabilities?.reasoning && <span className={`${styles.mrdCapTag} mrd-cap-tag`} title="支持思考"><Lucide.BrainCircuit size={10} /></span>}
                        </div>
                      </div>
                      <div className={`${styles.mrdModelActions} mrd-model-actions`}>
                        <button
                          type="button"
                          className={`${styles.modelRowToggle} ${!off ? styles.active : ''}`}
                          title={off ? '已停用，点击启用' : '点击停用'}
                          onClick={(e) => {
                            e.stopPropagation();
                            setModelEnabled(selected.id, m, off);
                            refresh();
                          }}
                          aria-label={off ? '启用模型' : '停用模型'}
                        >
                          <span className={styles.toggleThumb} />
                        </button>
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          style={{ padding: '0 5px', height: '26px', color: expanded ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}
                          title="配置"
                          onClick={(e) => { e.stopPropagation(); if (expanded) closeConfig(); else openConfigFor(m); }}
                        >
                          <Lucide.SlidersHorizontal size={13} />
                        </button>
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm mrd-delete-btn"
                          style={{ padding: '0 5px', height: '26px', color: 'var(--text-tertiary)' }}
                          title="删除"
                          onClick={(e) => { e.stopPropagation(); removeModelFromProfile(selected.id, m); if (configOpenId === m) closeConfig(); refresh(); }}
                        >
                          <Lucide.Trash2 size={13} />
                        </button>
                      </div>

                      {/* Expanded config sub-panel */}
                      {expanded && cfgDraft && (
                        <div className={`${styles.modelConfigPanel} mrd-model-cfg`} onClick={(e) => e.stopPropagation()}>
                          <div className={`${styles.mrdCfgFields} mrd-cfg-fields`}>
                            <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
                              <span>展示名称</span>
                              <input className={`${styles.mrdFieldInput} mrd-field-input`} value={cfgDraft.displayName} placeholder={m} onChange={(e) => setCfgDraft((d) => d ? ({ ...d, displayName: e.target.value }) : null)} />
                            </label>
                            <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
                              <span>上下文长度</span>
                              <input className={`${styles.mrdFieldInput} mrd-field-input`} value={cfgDraft.contextLength} placeholder="如 1000000" onChange={(e) => setCfgDraft((d) => d ? ({ ...d, contextLength: e.target.value }) : null)} />
                            </label>
                          </div>
                          <div className={`${styles.mrdCfgFooter} mrd-cfg-footer`}>
                            <div className={`${styles.mrdCapGroup} mrd-cap-group`}>
                              {MODEL_CAPABILITY_OPTIONS.map((opt) => {
                                const on = !!cfgDraft.caps[opt.key];
                                return (
                                  <label key={opt.key} className={`${styles.mrdCapPill} mrd-cap-pill ${on ? styles.isOn + ' is-on' : ''}`}>
                                    <input type="checkbox" style={{ display: 'none' }} checked={on} onChange={(e) => setCfgDraft((d) => d ? ({ ...d, caps: { ...d.caps, [opt.key]: e.target.checked } }) : null)} />
                                    {opt.label}
                                  </label>
                                );
                              })}
                            </div>
                            <div className={`${styles.mrdCfgActions} mrd-cfg-actions`}>
                              {meta.lastTest && (
                                <span
                                  style={{
                                    fontSize: '11px',
                                    fontWeight: 500,
                                    marginRight: '6px',
                                    userSelect: 'none',
                                    color: !meta.lastTest.ok
                                      ? 'var(--accent-red, #ef4444)'
                                      : (meta.lastTest.latencyMs || 0) < 400
                                      ? 'var(--accent-green, #10b981)'
                                      : (meta.lastTest.latencyMs || 0) < 1200
                                      ? 'var(--accent-orange, #f59e0b)'
                                      : 'var(--accent-red, #ef4444)'
                                  }}
                                  title={meta.lastTest.error || (meta.lastTest.ok ? '测试成功' : '测试失败')}
                                >
                                  {meta.lastTest.ok
                                    ? `${meta.lastTest.latencyMs}ms`
                                    : meta.lastTest.error?.includes('超时') || meta.lastTest.error?.includes('timeout')
                                    ? '超时'
                                    : '失败'}
                                </span>
                              )}
                              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={testBusy === tKey} onClick={() => void runTest(m)} title="测试连通性">
                                {testBusy === tKey ? <Lucide.Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Lucide.Wifi size={13} />}
                              </button>
                              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={closeConfig}>收起</button>
                              <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={saveConfig}>保存</button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {modelsCount === 0 && (
                  <div className={`${styles.mrdModelEmpty} mrd-model-empty`}>暂无模型 · 点击右上角「+」手动添加</div>
                )}
                {modelsCount > 0 && modelsList.length === 0 && (
                  <div className={`${styles.mrdModelEmpty} mrd-model-empty`}>无匹配的「{modelFilter.trim()}」</div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </SettingsPage>
  );
};