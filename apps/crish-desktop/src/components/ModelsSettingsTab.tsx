/**
 * 设置 · 模型：左供应商列表 + 右详情；+ 添加 OpenAI/Anthropic 模板与预设。
 * 设计系统 v2：settings-page-head + settings-list 行；保留 models-* 功能布局。
 */
import React, { useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  addModelToProfile,
  createCustomProfile,
  loadProfiles,
  removeModelFromProfile,
  removeProfile,
  saveProfileKey,
  type ProviderProfile,
  upsertProfile,
  activateProfileModel,
  getActiveProfileId,
  getActiveModelId,
} from '../api/providerProfiles';
import {
  formatContextLabel,
  getModelMeta,
  scanProviderModels,
  setModelContextLength,
  setModelEnabled,
  testProviderModel,
} from '../api/modelCatalog';
import { estimateCostUsd, loadPrices, upsertPrice } from '../api/pricingStore';

type Props = {
  onShowToast?: (msg: string) => void;
};

const PRESETS: { id: string; name: string; baseUrl: string; models: string[]; format: 'openai' | 'anthropic' }[] = [
  { id: 'preset-openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'], format: 'openai' },
  { id: 'preset-deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-v4-flash'], format: 'openai' },
  { id: 'preset-anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-5'], format: 'anthropic' },
  { id: 'preset-flowbit', name: 'Flowbit', baseUrl: 'https://api.flowbit.me', models: ['mimo-v2.5'], format: 'openai' },
];

function profileHasKey(p: ProviderProfile): boolean {
  return Boolean(p.hasKey || p.apiKey?.trim());
}

export const ModelsSettingsTab: React.FC<Props> = ({ onShowToast }) => {
  const [profiles, setProfiles] = useState<ProviderProfile[]>(() => loadProfiles());
  const [selectedId, setSelectedId] = useState<string | null>(() => getActiveProfileId() || loadProfiles()[0]?.id || null);
  const [keyDraft, setKeyDraft] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [newModel, setNewModel] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [ctxEdit, setCtxEdit] = useState<string | null>(null);
  const [ctxDraft, setCtxDraft] = useState('');
  const [priceIn, setPriceIn] = useState('');
  const [priceOut, setPriceOut] = useState('');
  /** 模型操作状态：始终展示给用户，避免「没反应」 */
  const [actionHint, setActionHint] = useState<{ ok: boolean; text: string } | null>(null);
  /** 当前供应商下的模型列表筛选 */
  const [modelFilter, setModelFilter] = useState('');

  const selected = useMemo(
    () => profiles.find((p) => p.id === selectedId) || null,
    [profiles, selectedId],
  );

  const profileStats = useMemo(() => {
    const total = profiles.length;
    const withKey = profiles.filter(profileHasKey).length;
    return { total, withKey };
  }, [profiles]);

  const filteredModels = useMemo(() => {
    const list = selected?.models || [];
    const q = modelFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((m) => m.toLowerCase().includes(q));
  }, [selected?.models, modelFilter]);

  const refresh = () => setProfiles(loadProfiles());

  const notify = (ok: boolean, text: string) => {
    setActionHint({ ok, text });
    onShowToast?.(text);
  };

  useEffect(() => {
    if (selected) {
      setKeyDraft('');
      setMoreOpen(false);
      setModelFilter('');
    }
  }, [selectedId]);

  const saveKey = async () => {
    if (!selected || !keyDraft.trim()) return;
    const res = await saveProfileKey(selected.id, keyDraft.trim());
    refresh();
    setKeyDraft('');
    onShowToast?.(res.ok ? (res.synced ? '密钥已保存并同步' : '密钥已保存') : `保存失败：${res.error || ''}`);
  };

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      onShowToast?.(`已复制 ${modelId}`);
    } catch {
      onShowToast?.('复制失败');
    }
  };

  const addFromTemplate = (format: 'openai' | 'anthropic') => {
    const p = createCustomProfile({
      name: format === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容',
      baseUrl:
        format === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1',
      models: [],
    });
    refresh();
    setSelectedId(p.id);
    setAddOpen(false);
    onShowToast?.(`已创建 ${p.name}，请填写密钥与地址`);
  };

  const addFromPreset = (preset: (typeof PRESETS)[0]) => {
    const p = createCustomProfile({
      name: preset.name,
      baseUrl: preset.baseUrl,
      models: [...preset.models],
    });
    refresh();
    setSelectedId(p.id);
    setAddOpen(false);
  };

  const runScan = async () => {
    if (!selected) return;
    setScanBusy(true);
    setActionHint({ ok: true, text: '正在获取模型列表…' });
    try {
      // 用本地最新 profile（含密钥）
      const fresh = loadProfiles().find((p) => p.id === selected.id) || selected;
      if (!fresh.apiKey?.trim() && !fresh.hasKey) {
        notify(false, '请先填写并保存 API Key，再获取列表');
        return;
      }
      if (!fresh.apiKey?.trim() && fresh.hasKey) {
        notify(false, '密钥仅有「已保存」标记但未读入，请重新输入密钥并点保存');
        return;
      }
      const r = await scanProviderModels(fresh);
      if (r.ok && r.models?.length) {
        const merged = Array.from(new Set([...(fresh.models || []), ...r.models]));
        upsertProfile({ ...fresh, models: merged });
        refresh();
        notify(true, `已获取 ${r.models.length} 个模型，列表已更新`);
      } else if (r.ok) {
        refresh();
        notify(false, '接口返回空列表。请检查 Base URL，或手动在下方添加模型 id');
      } else {
        notify(false, r.error || '获取失败');
      }
    } catch (e) {
      notify(false, e instanceof Error ? e.message : String(e));
    } finally {
      setScanBusy(false);
    }
  };

  const runTest = async (model: string) => {
    if (!selected) return;
    const key = `${selected.id}::${model}`;
    setTestBusy(key);
    setActionHint({ ok: true, text: `正在测试 ${model}…` });
    try {
      const fresh = loadProfiles().find((p) => p.id === selected.id) || selected;
      const r = await testProviderModel(fresh, model);
      refresh();
      notify(
        r.ok,
        r.ok
          ? `连通成功 · ${model} · ${r.latencyMs ?? '?'}ms`
          : `连通失败 · ${model}：${r.error || '未知错误'}`,
      );
    } catch (e) {
      notify(false, e instanceof Error ? e.message : String(e));
    } finally {
      setTestBusy(null);
    }
  };

  const modelsCount = selected?.models?.length ?? 0;

  return (
    <div className="models-tab">
      <header className="settings-page-head">
        <h2 className="settings-page-title">模型</h2>
        <p className="settings-page-desc">
          配置供应商与模型，供聊天时选择。
          {profileStats.total > 0
            ? ` 共 ${profileStats.total} 个供应商，其中 ${profileStats.withKey} 个已配置密钥。`
            : ' 尚未添加供应商。'}
        </p>
      </header>

      <div className="models-split">
        <aside className="models-rail">
          <div className="models-rail-list">
            {profiles.length === 0 ? (
              <div className="models-empty" style={{ padding: '24px 8px' }}>
                <div className="settings-list-sub">暂无供应商</div>
                <div className="settings-list-sub" style={{ marginTop: 4 }}>
                  点击下方添加
                </div>
              </div>
            ) : (
              profiles.map((p) => {
                const active = p.id === selectedId;
                const live = getActiveProfileId() === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`models-rail-item ${active ? 'is-active' : ''}`}
                    onClick={() => setSelectedId(p.id)}
                  >
                    <span className="models-rail-name">{p.name}</span>
                    <span className="models-rail-meta">
                      {profileHasKey(p) ? '已配置' : '无密钥'}
                      {live ? ' · 当前' : ''}
                    </span>
                    {p.enabled === false ? (
                      <span className="models-rail-badge">关</span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>

          <div className="models-rail-add-wrap">
            <button
              type="button"
              className="models-rail-add"
              onClick={() => setAddOpen((v) => !v)}
            >
              <Lucide.Plus size={16} />
              添加供应商
            </button>
            {addOpen ? (
              <div className="models-add-menu">
                <div className="models-add-label">格式模板</div>
                <button type="button" className="models-add-item" onClick={() => addFromTemplate('openai')}>
                  OpenAI 兼容
                </button>
                <button type="button" className="models-add-item" onClick={() => addFromTemplate('anthropic')}>
                  Anthropic 兼容
                </button>
                <div className="models-add-divider" />
                <div className="models-add-label">预设</div>
                {PRESETS.map((pr) => (
                  <button
                    key={pr.id}
                    type="button"
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

        <section className="models-detail">
          {!selected ? (
            <div className="models-empty">
              <div className="settings-page-desc" style={{ margin: 0, maxWidth: 'none' }}>
                {profiles.length === 0
                  ? '尚未添加供应商。使用左侧「添加供应商」选择格式模板或预设。'
                  : '从左侧选择一个供应商，或添加新的供应商。'}
              </div>
            </div>
          ) : (
            <>
              <div className="models-detail-top">
                <div>
                  <div className="models-detail-name">{selected.name}</div>
                  <div className="models-detail-id">{selected.id}</div>
                </div>
                <div className="models-detail-top-actions">
                  <label className="models-enable">
                    <input
                      type="checkbox"
                      className="settings-switch"
                      checked={selected.enabled !== false}
                      onChange={(e) => {
                        upsertProfile({ ...selected, enabled: e.target.checked });
                        refresh();
                      }}
                    />
                    <span>启用</span>
                  </label>
                  {selected.id.startsWith('custom-') ? (
                    <button
                      type="button"
                      className="models-icon-btn danger"
                      title="删除"
                      onClick={() => {
                        const next = removeProfile(selected.id);
                        setProfiles(next);
                        setSelectedId(next[0]?.id || null);
                      }}
                    >
                      <Lucide.Trash2 size={16} />
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="settings-list">
                <div className="settings-list-row settings-list-row--stack">
                  <div className="settings-list-copy">
                    <div className="settings-list-title">Base URL</div>
                    <div className="settings-list-sub">供应商 API 根地址</div>
                  </div>
                  <div className="settings-list-stack-controls">
                    <input
                      className="settings-field-input"
                      value={selected.baseUrl}
                      spellCheck={false}
                      onChange={(e) => {
                        upsertProfile({ ...selected, baseUrl: e.target.value });
                        refresh();
                      }}
                    />
                  </div>
                </div>

                <div className="settings-list-row settings-list-row--stack">
                  <div className="settings-list-copy">
                    <div className="settings-list-title">API Key</div>
                    <div className="settings-list-sub">
                      {selected.hasKey || selected.apiKey ? '已保存密钥，输入新值可覆盖' : '尚未配置密钥'}
                    </div>
                  </div>
                  <div className="settings-list-stack-controls">
                    <div className="models-key-row">
                      <input
                        className="settings-field-input"
                        type="password"
                        placeholder={selected.hasKey ? '已保存 · 输入新密钥覆盖' : '输入 API Key'}
                        value={keyDraft}
                        onChange={(e) => setKeyDraft(e.target.value)}
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
                  </div>
                </div>
              </div>

              <div className="models-models-head">
                <span>
                  模型
                  {modelsCount > 0 ? (
                    <span className="settings-list-sub" style={{ display: 'inline', marginLeft: 6 }}>
                      {modelFilter.trim()
                        ? `${filteredModels.length} / ${modelsCount}`
                        : modelsCount}
                    </span>
                  ) : null}
                </span>
                <div className="models-models-actions">
                  <button
                    type="button"
                    className="models-btn ghost"
                    disabled={scanBusy}
                    title={
                      selected.hasKey || selected.apiKey
                        ? '从供应商接口拉取模型列表'
                        : '将先检查密钥；无密钥会提示你保存'
                    }
                    onClick={() => void runScan()}
                  >
                    {scanBusy ? '获取中…' : '获取列表'}
                  </button>
                </div>
              </div>

              {modelsCount > 0 ? (
                <div className="models-key-row">
                  <input
                    className="settings-field-input"
                    type="search"
                    placeholder="筛选模型 id…"
                    value={modelFilter}
                    onChange={(e) => setModelFilter(e.target.value)}
                    spellCheck={false}
                    aria-label="筛选模型"
                  />
                </div>
              ) : null}

              {actionHint ? (
                <div
                  className={`models-action-hint ${actionHint.ok ? 'is-ok' : 'is-err'}`}
                  role="status"
                >
                  {actionHint.text}
                </div>
              ) : null}

              <div className="models-model-list">
                {modelsCount === 0 ? (
                  <div className="models-empty" style={{ padding: '20px 0' }}>
                    <div className="settings-list-sub">
                      该供应商暂无模型。可点击「获取列表」，或在下方手动添加模型 id。
                    </div>
                  </div>
                ) : filteredModels.length === 0 ? (
                  <div className="models-empty" style={{ padding: '20px 0' }}>
                    <div className="settings-list-sub">
                      没有匹配「{modelFilter.trim()}」的模型。
                    </div>
                  </div>
                ) : (
                  filteredModels.map((m) => {
                    const meta = getModelMeta(selected.id, m);
                    const off = meta.enabled === false;
                    const tKey = `${selected.id}::${m}`;
                    const editing = ctxEdit === tKey;
                    return (
                      <div key={m} className={`models-model-row ${off ? 'is-off' : ''}`}>
                        <button
                          type="button"
                          className="models-model-main"
                          title="设为当前模型"
                          onClick={() => {
                            void activateProfileModel(selected.id, m).then((r) => {
                              onShowToast?.(r.ok ? `已选用 ${m}` : `切换失败：${r.error || ''}`);
                              refresh();
                            });
                          }}
                        >
                          <span className="models-model-name">{m}</span>
                          {getActiveProfileId() === selected.id && getActiveModelId() === m ? (
                            <span className="models-model-live">当前</span>
                          ) : null}
                        </button>
                        <span className="models-model-ctx">
                          {editing ? (
                            <input
                              className="models-ctx-input"
                              value={ctxDraft}
                              autoFocus
                              onChange={(e) => setCtxDraft(e.target.value)}
                              onBlur={() => {
                                const n = parseInt(ctxDraft.replace(/[^\d]/g, ''), 10);
                                if (Number.isFinite(n) && n > 0) setModelContextLength(selected.id, m, n);
                                setCtxEdit(null);
                                refresh();
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                if (e.key === 'Escape') setCtxEdit(null);
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              className="models-ctx-btn"
                              title="上下文长度"
                              onClick={() => {
                                setCtxEdit(tKey);
                                setCtxDraft(meta.contextLength != null ? String(meta.contextLength) : '');
                              }}
                            >
                              ctx {meta.contextLength ? formatContextLabel(meta.contextLength) : '—'}
                            </button>
                          )}
                        </span>
                        <button
                          type="button"
                          className="models-icon-btn"
                          title="复制模型 id"
                          onClick={() => void copyModelId(m)}
                        >
                          <Lucide.Copy size={14} />
                        </button>
                        <button
                          type="button"
                          className="models-icon-btn"
                          title="测试连通"
                          disabled={testBusy === tKey}
                          onClick={() => void runTest(m)}
                        >
                          {testBusy === tKey ? (
                            <span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
                          ) : (
                            <Lucide.Zap size={14} />
                          )}
                        </button>
                        <button
                          type="button"
                          className="models-icon-btn"
                          title={off ? '启用' : '禁用'}
                          onClick={() => {
                            setModelEnabled(selected.id, m, off);
                            refresh();
                          }}
                        >
                          {off ? <Lucide.EyeOff size={14} /> : <Lucide.Eye size={14} />}
                        </button>
                        <button
                          type="button"
                          className="models-icon-btn danger"
                          title="移除"
                          onClick={() => {
                            removeModelFromProfile(selected.id, m);
                            refresh();
                          }}
                        >
                          <Lucide.Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="models-add-model">
                <input
                  className="settings-field-input"
                  placeholder="添加模型 id…"
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newModel.trim()) {
                      addModelToProfile(selected.id, newModel.trim());
                      setNewModel('');
                      refresh();
                    }
                  }}
                />
                <button
                  type="button"
                  className="models-btn"
                  disabled={!newModel.trim()}
                  onClick={() => {
                    addModelToProfile(selected.id, newModel.trim());
                    setNewModel('');
                    refresh();
                  }}
                >
                  添加
                </button>
              </div>

              <details
                className="models-more"
                open={moreOpen}
                onToggle={(e) => setMoreOpen((e.target as HTMLDetailsElement).open)}
              >
                <summary>更多 · 计费等</summary>
                <div className="models-more-body">
                  <p className="models-more-hint">为当前活动模型配置单价（$/1M tokens），用于用量估算</p>
                  <div className="models-price-row">
                    <input
                      className="settings-field-input"
                      placeholder="输入 $/1M"
                      value={priceIn}
                      onChange={(e) => setPriceIn(e.target.value)}
                    />
                    <input
                      className="settings-field-input"
                      placeholder="输出 $/1M"
                      value={priceOut}
                      onChange={(e) => setPriceOut(e.target.value)}
                    />
                    <button
                      type="button"
                      className="models-btn"
                      onClick={() => {
                        const model = getActiveModelId() || selected.models[0];
                        if (!model) return;
                        const inp = parseFloat(priceIn);
                        const out = parseFloat(priceOut);
                        upsertPrice({
                          model,
                          inputPerMTok: Number.isFinite(inp) ? inp : 0,
                          outputPerMTok: Number.isFinite(out) ? out : 0,
                        });
                        onShowToast?.(`已更新 ${model} 计费`);
                        setPriceIn('');
                        setPriceOut('');
                      }}
                    >
                      保存计费
                    </button>
                  </div>
                  {loadPrices().length > 0 ? (
                    <div className="models-price-list">
                      {loadPrices().slice(0, 6).map((pr) => (
                        <div key={pr.model} className="models-price-item">
                          {pr.model} · in {pr.inputPerMTok} / out {pr.outputPerMTok}
                          <span className="models-price-sample">
                            样例 1k/1k ≈ $
                            {estimateCostUsd(pr.model, 1000, 1000)?.toFixed(4) ?? '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </details>
            </>
          )}
        </section>
      </div>
    </div>
  );
};
