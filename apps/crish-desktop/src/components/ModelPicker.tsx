/**
 * 对话底栏模型选择：提供商为上级，模型为下级。
 * 含扫描发现、连通测试、上下文长度、启用/禁用、增删。
 * 不设「系统默认模型」——选中即用户当前偏好。
 */
import React, { useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import './ModelPicker.css';
import {
  addModelToProfile,
  getActiveModelId,
  getActiveProfileId,
  removeModelFromProfile,
  setActiveProfileId as setStoredProfileId,
  upsertProfile,
  type ProviderProfile,
} from '../api/providerProfiles';
import {
  formatContextLabel,
  getModelMeta,
  listPickerProfiles,
  scanProviderModels,
  setModelContextLength,
  setModelEnabled,
  testProviderModel,
} from '../api/modelCatalog';

type Props = {
  open: boolean;
  onClose: () => void;
  engineModel?: string | null;
  busy?: boolean;
  error?: string;
  onSelect: (profileId: string, model: string) => void;
  onOpenSettings: () => void;
  onToast?: (msg: string) => void;
};

export const ModelPicker: React.FC<Props> = ({
  open,
  onClose,
  engineModel,
  busy,
  error,
  onSelect,
  onOpenSettings,
  onToast,
}) => {
  const [tick, setTick] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [scanBusy, setScanBusy] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState<Record<string, string>>({});
  const [ctxEdit, setCtxEdit] = useState<string | null>(null);
  const [ctxDraft, setCtxDraft] = useState('');

  const activeProfileId = getActiveProfileId();
  const activeModel = engineModel || getActiveModelId() || '';

  const profiles = useMemo(() => {
    void tick;
    return listPickerProfiles();
  }, [tick]);

  useEffect(() => {
    if (!open) return;
    // 默认展开当前活动提供商
    const id = getActiveProfileId();
    if (id) setExpanded((e) => ({ ...e, [id]: true }));
    setTick((n) => n + 1);
  }, [open]);

  if (!open) return null;

  const refresh = () => setTick((n) => n + 1);

  const toggleProvider = (id: string) => {
    setExpanded((e) => ({ ...e, [id]: !e[id] }));
  };

  const toggleProviderEnabled = (p: ProviderProfile) => {
    upsertProfile({ ...p, enabled: p.enabled === false });
    refresh();
    onToast?.(p.enabled === false ? `已启用 ${p.name}` : `已禁用 ${p.name}`);
  };

  const handleScan = async (p: ProviderProfile) => {
    if (scanBusy) return;
    setScanBusy(p.id);
    try {
      const res = await scanProviderModels(p);
      if (!res.ok) {
        onToast?.(res.error || '扫描失败');
        return;
      }
      if (res.models.length === 0) {
        onToast?.('未发现模型');
        return;
      }
      // 合并进 profile，不删用户已有
      const next = Array.from(new Set([...(p.models || []), ...res.models]));
      upsertProfile({ ...p, models: next });
      setExpanded((e) => ({ ...e, [p.id]: true }));
      refresh();
      onToast?.(`发现 ${res.models.length} 个模型，已合并`);
    } finally {
      setScanBusy(null);
    }
  };

  const handleTest = async (p: ProviderProfile, model: string) => {
    const key = `${p.id}::${model}`;
    if (testBusy) return;
    setTestBusy(key);
    try {
      const res = await testProviderModel(p, model);
      refresh();
      if (res.ok) {
        onToast?.(`连通正常 · ${res.latencyMs ?? '?'}ms`);
      } else {
        onToast?.(res.error || '测试失败');
      }
    } finally {
      setTestBusy(null);
    }
  };

  const handleAddModel = (profileId: string) => {
    const name = (addDraft[profileId] || '').trim();
    if (!name) return;
    addModelToProfile(profileId, name);
    setAddDraft((d) => ({ ...d, [profileId]: '' }));
    refresh();
  };

  const configured = profiles.filter((p) => p.hasKey || Boolean(p.apiKey?.trim()));

  return (
    <div className="mpick" role="listbox" aria-label="选择模型" onClick={(e) => e.stopPropagation()}>
      {error ? <div className="mpick-error">{error}</div> : null}

      <div className="mpick-scroll">
        {configured.length === 0 ? (
          <div className="mpick-empty">
            尚未配置可用服务商
            <button type="button" className="mpick-link-btn" onClick={onOpenSettings}>
              去配置
            </button>
          </div>
        ) : (
          configured.map((p) => {
            const isOpen = Boolean(expanded[p.id]);
            const hasKey = p.hasKey || Boolean(p.apiKey?.trim());
            const providerDisabled = p.enabled === false;
            const models = p.models || [];
            const activeHere = activeProfileId === p.id;

            return (
              <div
                key={p.id}
                className={`mpick-provider ${activeHere ? 'is-active' : ''} ${providerDisabled ? 'is-disabled' : ''}`}
              >
                <div className="mpick-provider-row">
                  <button
                    type="button"
                    className="mpick-provider-main"
                    onClick={() => toggleProvider(p.id)}
                    disabled={busy}
                  >
                    <Lucide.ChevronRight
                      size={14}
                      className={`mpick-chev ${isOpen ? 'open' : ''}`}
                    />
                    <Lucide.Server size={14} className="mpick-provider-ico" />
                    <span className="mpick-provider-text">
                      <span className="mpick-provider-name">{p.name}</span>
                      <span className="mpick-provider-meta">
                        {models.length} 个模型
                        {!hasKey ? ' · 无密钥' : ''}
                        {providerDisabled ? ' · 已禁用' : ''}
                      </span>
                    </span>
                  </button>
                  <div className="mpick-provider-actions">
                    <button
                      type="button"
                      className="mpick-icon-btn"
                      title="扫描发现模型"
                      disabled={!hasKey || scanBusy === p.id || providerDisabled}
                      onClick={() => void handleScan(p)}
                    >
                      {scanBusy === p.id ? (
                        <span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
                      ) : (
                        <Lucide.Radar size={13} />
                      )}
                    </button>
                    <button
                      type="button"
                      className="mpick-icon-btn"
                      title={providerDisabled ? '启用提供商' : '禁用提供商'}
                      onClick={() => toggleProviderEnabled(p)}
                    >
                      {providerDisabled ? <Lucide.EyeOff size={13} /> : <Lucide.Eye size={13} />}
                    </button>
                  </div>
                </div>

                {isOpen ? (
                  <div className="mpick-models">
                    {models.length === 0 ? (
                      <div className="mpick-empty-models">暂无模型 · 可扫描或手动添加</div>
                    ) : (
                      models.map((m) => {
                        const meta = getModelMeta(p.id, m);
                        const selected = activeHere && activeModel === m;
                        const modelOff = meta.enabled === false || providerDisabled;
                        const testKey = `${p.id}::${m}`;
                        const editingCtx = ctxEdit === testKey;

                        return (
                          <div
                            key={m}
                            className={`mpick-model ${selected ? 'is-selected' : ''} ${modelOff ? 'is-off' : ''}`}
                          >
                            <button
                              type="button"
                              className="mpick-model-main"
                              disabled={busy || modelOff || !hasKey}
                              onClick={() => {
                                if (modelOff || !hasKey) return;
                                setStoredProfileId(p.id);
                                onSelect(p.id, m);
                              }}
                            >
                              <span className="mpick-model-name" title={m}>
                                {m}
                              </span>
                              <span className="mpick-model-ctx" title="上下文长度">
                                {editingCtx ? null : formatContextLabel(meta.contextLength)}
                              </span>
                              {selected ? (
                                <Lucide.Check size={13} className="mpick-check" />
                              ) : null}
                            </button>
                            <div className="mpick-model-actions">
                              {editingCtx ? (
                                <input
                                  className="mpick-ctx-input"
                                  value={ctxDraft}
                                  autoFocus
                                  placeholder="如 128000"
                                  onChange={(e) => setCtxDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      const n = parseInt(ctxDraft.replace(/[^\d]/g, ''), 10);
                                      setModelContextLength(
                                        p.id,
                                        m,
                                        Number.isFinite(n) && n > 0 ? n : undefined,
                                      );
                                      setCtxEdit(null);
                                      refresh();
                                    }
                                    if (e.key === 'Escape') setCtxEdit(null);
                                  }}
                                  onBlur={() => {
                                    const n = parseInt(ctxDraft.replace(/[^\d]/g, ''), 10);
                                    if (Number.isFinite(n) && n > 0) {
                                      setModelContextLength(p.id, m, n);
                                      refresh();
                                    }
                                    setCtxEdit(null);
                                  }}
                                />
                              ) : (
                                <button
                                  type="button"
                                  className="mpick-icon-btn"
                                  title="设置上下文长度"
                                  onClick={() => {
                                    setCtxEdit(testKey);
                                    setCtxDraft(
                                      meta.contextLength != null ? String(meta.contextLength) : '',
                                    );
                                  }}
                                >
                                  <Lucide.Ruler size={12} />
                                </button>
                              )}
                              <button
                                type="button"
                                className="mpick-icon-btn"
                                title={
                                  meta.lastTest
                                    ? meta.lastTest.ok
                                      ? `上次成功 ${meta.lastTest.latencyMs ?? '?'}ms`
                                      : `上次失败：${meta.lastTest.error || ''}`
                                    : '测试连通'
                                }
                                disabled={!hasKey || testBusy === testKey || modelOff}
                                onClick={() => void handleTest(p, m)}
                              >
                                {testBusy === testKey ? (
                                  <span
                                    className="loading-spinner"
                                    style={{ width: 11, height: 11, borderWidth: 1.5 }}
                                  />
                                ) : meta.lastTest?.ok ? (
                                  <Lucide.Activity size={12} />
                                ) : (
                                  <Lucide.Zap size={12} />
                                )}
                              </button>
                              <button
                                type="button"
                                className="mpick-icon-btn"
                                title={meta.enabled === false ? '启用模型' : '禁用模型'}
                                onClick={() => {
                                  setModelEnabled(p.id, m, meta.enabled === false);
                                  refresh();
                                }}
                              >
                                {meta.enabled === false ? (
                                  <Lucide.ToggleLeft size={14} />
                                ) : (
                                  <Lucide.ToggleRight size={14} />
                                )}
                              </button>
                              <button
                                type="button"
                                className="mpick-icon-btn danger"
                                title="从列表移除"
                                onClick={() => {
                                  removeModelFromProfile(p.id, m);
                                  refresh();
                                }}
                              >
                                <Lucide.Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}

                    <div className="mpick-add-row">
                      <input
                        value={addDraft[p.id] || ''}
                        onChange={(e) =>
                          setAddDraft((d) => ({ ...d, [p.id]: e.target.value }))
                        }
                        placeholder="手动添加模型 id…"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleAddModel(p.id);
                        }}
                      />
                      <button
                        type="button"
                        className="mpick-add-btn"
                        disabled={!(addDraft[p.id] || '').trim()}
                        onClick={() => handleAddModel(p.id)}
                      >
                        添加
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div className="mpick-footer">
        <button
          type="button"
          className="mpick-footer-btn"
          onClick={() => {
            onClose();
            onOpenSettings();
          }}
        >
          <Lucide.Settings size={13} />
          管理服务商与密钥
        </button>
      </div>
    </div>
  );
};
