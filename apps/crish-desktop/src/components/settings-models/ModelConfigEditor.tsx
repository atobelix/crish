import React from 'react';
import * as Lucide from 'lucide-react';
import {
  addModelToProfile,
  getActiveModelId,
  getActiveProfileId,
  removeModelFromProfile,
  removeProfile,
  saveProfileBaseUrl,
  setProfileEnabled,
  type ProviderProfile,
  upsertProfile,
} from '../../api/providerProfiles';
import {
  formatContextLabel,
  formatModelDisplayName,
  getModelMeta,
  MODEL_CAPABILITY_OPTIONS,
  setModelEnabled,
} from '../../api/modelCatalog';
import { Tooltip } from '../settings/SettingsUI';
import styles from '../ModelsSettingsTab.module.css';
import type { AddDraft, CfgDraft } from './useModelProfilesState';

interface ModelConfigEditorProps {
  selected: ProviderProfile | null;
  profiles: ProviderProfile[];
  selectedLabel: string;
  hasKeySelected: boolean;
  editingName: boolean;
  nameDraft: string;
  setNameDraft: (val: string) => void;
  setEditingName: (val: boolean) => void;
  confirmDeleteId: string | null;
  setConfirmDeleteId: (id: string | null) => void;
  keyDraft: string;
  setKeyDraft: (val: string) => void;
  saveKey: () => Promise<void>;
  runCheck: () => Promise<void>;
  runScan: () => Promise<void>;
  checkBusy: boolean;
  scanBusy: boolean;
  modelFilter: string;
  setModelFilter: (val: string) => void;
  manualOpen: boolean;
  setManualOpen: (val: boolean) => void;
  addDraft: AddDraft;
  setAddDraft: React.Dispatch<React.SetStateAction<AddDraft>>;
  handleManualAdd: () => void;
  emptyAddDraft: () => AddDraft;
  modelsList: string[];
  modelsCount: number;
  configOpenId: string | null;
  cfgDraft: CfgDraft | null;
  setCfgDraft: React.Dispatch<React.SetStateAction<CfgDraft | null>>;
  openConfigFor: (model: string) => void;
  closeConfig: () => void;
  saveConfig: () => void;
  runTest: (model: string) => Promise<void>;
  testBusy: string | null;
  refresh: () => void;
  notify: (ok: boolean, text: string) => void;
  setProfiles: (profiles: ProviderProfile[]) => void;
  setSelectedId: (id: string | null) => void;
}

export const ModelConfigEditor: React.FC<ModelConfigEditorProps> = ({
  selected,
  profiles,
  selectedLabel,
  hasKeySelected,
  editingName,
  nameDraft,
  setNameDraft,
  setEditingName,
  confirmDeleteId,
  setConfirmDeleteId,
  keyDraft,
  setKeyDraft,
  saveKey,
  runCheck,
  runScan,
  checkBusy,
  scanBusy,
  modelFilter,
  setModelFilter,
  manualOpen,
  setManualOpen,
  addDraft,
  setAddDraft,
  handleManualAdd,
  emptyAddDraft,
  modelsList,
  modelsCount,
  configOpenId,
  cfgDraft,
  setCfgDraft,
  openConfigFor,
  closeConfig,
  saveConfig,
  runTest,
  testBusy,
  refresh,
  notify,
  setProfiles,
  setSelectedId,
}) => {
  return (
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
                <div style={{ position: 'relative' }}>
                  {confirmDeleteId === selected.id ? (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        background: 'var(--bg-primary)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: '8px',
                        padding: '4px 8px',
                        whiteSpace: 'nowrap',
                        zIndex: 'var(--z-card-footer)',
                      }}
                    >
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>确定删除？</span>
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary ui-btn-sm"
                        style={{ height: '24px', padding: '0 8px', fontSize: '11px', borderRadius: '5px' }}
                        onClick={() => {
                          const next = removeProfile(selected.id);
                          setProfiles(next);
                          setSelectedId(next[0]?.id || null);
                          setConfirmDeleteId(null);
                        }}
                      >
                        确认
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm"
                        style={{ height: '24px', padding: '0 8px', fontSize: '11px', borderRadius: '5px' }}
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <Tooltip content={`删除「${selectedLabel}」`}>
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm"
                        style={{ padding: '0 6px', height: '28px', color: 'var(--text-tertiary)' }}
                        onClick={() => setConfirmDeleteId(selected.id)}
                      >
                        <Lucide.Trash2 size={14} />
                      </button>
                    </Tooltip>
                  )}
                </div>
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
                  onClick={() => void runCheck()}
                  style={{ height: '28px', width: '28px', padding: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  aria-label="检查连通性"
                >
                  {checkBusy ? <Lucide.Loader2 size={13} className={styles.loadingSpinner} /> : <Lucide.Wifi size={13} />}
                </button>
              </Tooltip>
              <Tooltip content="自动获取服务商模型列表">
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-sm"
                  disabled={scanBusy}
                  onClick={() => void runScan()}
                  style={{ height: '28px', width: '28px', padding: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  aria-label="自动获取"
                >
                  {scanBusy ? <Lucide.Loader2 size={13} className={styles.loadingSpinner} /> : <Lucide.RefreshCw size={13} />}
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
                      {meta.capabilities?.tools && <span className={`${styles.mrdCapTag} mrd-cap-tag`} aria-label="支持工具调用"><Lucide.Wrench size={10} /></span>}
                      {meta.capabilities?.vision && <span className={`${styles.mrdCapTag} mrd-cap-tag`} aria-label="支持视觉"><Lucide.Eye size={10} /></span>}
                      {meta.capabilities?.reasoning && <span className={`${styles.mrdCapTag} mrd-cap-tag`} aria-label="支持思考"><Lucide.BrainCircuit size={10} /></span>}
                    </div>
                  </div>
                  <div className={`${styles.mrdModelActions} mrd-model-actions`}>
                    <Tooltip content={off ? '已停用，点击启用' : '点击停用'}>
                      <button
                        type="button"
                        className={`${styles.modelRowToggle} ${!off ? styles.active : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setModelEnabled(selected.id, m, off);
                          refresh();
                        }}
                        aria-label={off ? '启用模型' : '停用模型'}
                      >
                        <span className={styles.toggleThumb} />
                      </button>
                    </Tooltip>
                    <Tooltip content="配置">
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm"
                        style={{ padding: '0 5px', height: '26px', color: expanded ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}
                        onClick={(e) => { e.stopPropagation(); if (expanded) closeConfig(); else openConfigFor(m); }}
                      >
                        <Lucide.SlidersHorizontal size={13} />
                      </button>
                    </Tooltip>
                    <Tooltip content="删除">
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm mrd-delete-btn"
                        style={{ padding: '0 5px', height: '26px', color: 'var(--text-tertiary)' }}
                        onClick={(e) => { e.stopPropagation(); removeModelFromProfile(selected.id, m); if (configOpenId === m) closeConfig(); refresh(); }}
                      >
                        <Lucide.Trash2 size={13} />
                      </button>
                    </Tooltip>
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
                          <Tooltip content="测试连通性">
                            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={testBusy === tKey} onClick={() => void runTest(m)}>
                              {testBusy === tKey ? <Lucide.Loader2 size={13} className={styles.loadingSpinner} /> : <Lucide.Wifi size={13} />}
                            </button>
                          </Tooltip>
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
  );
};
