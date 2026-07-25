import React, { useEffect, useMemo, useState } from 'react';
import { BrainCircuit, Eye, Loader2, Plus, RefreshCw, Search, SlidersHorizontal, Trash2, Wifi, Wrench } from 'lucide-react';
import { profileDisplayLabel, profileHasKey, saveProfileKey, saveProfileBaseUrl, upsertProfile, removeProfile, setProfileEnabled, addModelToProfile, removeModelFromProfile, setModelEnabled, setModelDisplayName, setModelContextLength, setModelCapability, getActiveProfileId, getActiveModelId, activateProfileModel } from '../../../api/providerProfiles';
import { formatContextLabel, formatModelDisplayName, getModelMeta, MODEL_CAPABILITY_OPTIONS, scanProviderModels, mergeModelIds, normalizeModelIds, testProviderModel } from '../../../api/modelCatalog';
import { Tooltip } from '../SettingsUI';
import type { ProviderProfile } from '../../../api/providerProfiles';
import type { ModelCapabilityKey } from '../../../api/modelCatalog';
import styles from '../../ModelsSettingsTab.module.css';

type AddDraft = { displayName: string; modelId: string; contextLength: string; caps: Record<ModelCapabilityKey, boolean> };
function emptyAddDraft(): AddDraft { return { displayName: '', modelId: '', contextLength: '', caps: { tools: false, vision: false, reasoning: false } }; }

interface ModelProviderDetailProps {
  selected: ProviderProfile | null;
  profiles: ProviderProfile[];
  selectedId: string | null;
  onRefresh: () => void;
  onSelect: (id: string | null) => void;
  onNotify: (ok: boolean, text: string) => void;
  onError: (msg: string) => void;
}

export const ModelProviderDetail: React.FC<ModelProviderDetailProps> = React.memo(({
  selected, profiles, selectedId, onRefresh, onSelect, onNotify, onError,
}) => {
  const [keyDraft, setKeyDraft] = useState('');
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [configOpenId, setConfigOpenId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AddDraft>(emptyAddDraft());
  const [cfgDraft, setCfgDraft] = useState<{ displayName: string; contextLength: string; caps: Record<ModelCapabilityKey, boolean> } | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const globalActiveProfileId = getActiveProfileId();
  const globalActiveModelId = getActiveModelId();

  useEffect(() => {
    if (!selected) return;
    setKeyDraft(''); setModelFilter(''); setConfigOpenId(null); setCfgDraft(null);
    setManualOpen(false); setAddDraft(emptyAddDraft()); setEditingName(false); setNameDraft(''); setConfirmDeleteId(null);
  }, [selected?.id]);

  if (!selected) return <div className={`${styles.mrdEmpty} mrd-empty`}>{profiles.length === 0 ? '从左侧添加服务商以开始' : '在左侧选择一个服务商'}</div>;

  const selectedLabel = profileDisplayLabel(selected);
  const hasKeySelected = profileHasKey(selected);
  const modelsList = useMemo(() => {
    const list = normalizeModelIds(selected.models);
    const q = modelFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((m: string) => { const meta = getModelMeta(selected.id, m); const name = (meta.displayName || '').toLowerCase(); return m.toLowerCase().includes(q) || name.includes(q); });
  }, [selected, modelFilter]);

  const saveKey = async () => {
    if (!keyDraft.trim()) return;
    const res = await saveProfileKey(selected.id, keyDraft.trim());
    onRefresh(); setKeyDraft('');
    if (!res.ok) onNotify(false, `保存失败：${res.error || '未知错误'}`);
    else { onNotify(true, '密钥已保存，正在自动扫描服务器可用模型...'); void runScan(); }
  };

  const runScan = async () => {
    setScanBusy(true);
    try {
      const fresh = profiles.find((p) => p.id === selected.id) || selected;
      const r = await scanProviderModels(fresh);
      if (r.ok && r.models?.length) { const merged = mergeModelIds(fresh.models, r.models); upsertProfile({ ...fresh, models: merged }); onRefresh(); onNotify(true, `已自动获取 ${r.models.length} 个模型`); }
      else onNotify(false, r.error || '未能检测到服务器可用模型');
    } catch (e) { onNotify(false, e instanceof Error ? e.message : String(e)); }
    finally { setScanBusy(false); }
  };

  const runCheck = async () => {
    setCheckBusy(true);
    try {
      const fresh = profiles.find((p) => p.id === selected.id) || selected;
      const firstModel = fresh.models[0] || '';
      const r = await testProviderModel(fresh, firstModel);
      if (r.ok) onNotify(true, `服务商连通正常 (${r.latencyMs || 120}ms)`);
      else onNotify(false, `连通检查失败：${r.error || '无法建立握手连接'}`);
    } catch (e) { onNotify(false, e instanceof Error ? e.message : String(e)); }
    finally { setCheckBusy(false); }
  };

  const runTest = async (model: string) => {
    const key = `${selected.id}::${model}`;
    setTestBusy(key);
    try {
      const fresh = profiles.find((p) => p.id === selected.id) || selected;
      const r = await testProviderModel(fresh, model);
      onRefresh();
      if (!r.ok) onNotify(false, `连通失败 · ${model}：${r.error || '未知错误'}`);
    } catch (e) { onNotify(false, e instanceof Error ? e.message : String(e)); }
    finally { setTestBusy(null); }
  };

  const handleManualAdd = () => {
    const id = normalizeModelIds([addDraft.modelId])[0];
    if (!id) { onNotify(false, '请填写模型 id'); return; }
    const snap = { ...addDraft };
    addModelToProfile(selected.id, id);
    if (snap.displayName.trim()) setModelDisplayName(selected.id, id, snap.displayName.trim());
    const n = parseInt(snap.contextLength.replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(n) && n > 0) setModelContextLength(selected.id, id, n);
    for (const opt of MODEL_CAPABILITY_OPTIONS) setModelCapability(selected.id, id, opt.key, !!snap.caps[opt.key]);
    onRefresh(); setAddDraft(emptyAddDraft()); setManualOpen(false);
    const meta = getModelMeta(selected.id, id);
    setConfigOpenId(id); setCfgDraft({ displayName: meta.displayName || snap.displayName || '', contextLength: meta.contextLength != null ? String(meta.contextLength) : snap.contextLength || '', caps: { tools: !!meta.capabilities?.tools, vision: !!meta.capabilities?.vision, reasoning: !!meta.capabilities?.reasoning } });
  };

  const openConfigFor = (model: string) => {
    const meta = getModelMeta(selected.id, model);
    setManualOpen(false); setConfigOpenId(model);
    setCfgDraft({ displayName: meta.displayName || '', contextLength: meta.contextLength != null ? String(meta.contextLength) : '', caps: { tools: !!meta.capabilities?.tools, vision: !!meta.capabilities?.vision, reasoning: !!meta.capabilities?.reasoning } });
  };

  const applyMetaForModel = (modelId: string, draft: typeof cfgDraft) => {
    if (!draft) return;
    if (draft.displayName.trim()) setModelDisplayName(selected.id, modelId, draft.displayName.trim());
    const n = parseInt(draft.contextLength.replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(n) && n > 0) setModelContextLength(selected.id, modelId, n);
    for (const opt of MODEL_CAPABILITY_OPTIONS) setModelCapability(selected.id, modelId, opt.key, !!draft.caps[opt.key]);
  };

  const saveConfig = () => {
    if (!configOpenId || !cfgDraft) return;
    applyMetaForModel(configOpenId, cfgDraft);
    onRefresh();
    openConfigFor(configOpenId);
  };

  const modelsCount = normalizeModelIds(selected.models).length;

  return (
    <div className={`${styles.mrdBody} mrd-body`}>
      <div className="mrd-head">
        <div className="mrd-head-left" style={{ display: 'inline-flex', alignItems: 'center' }}>
          {editingName && selected.id.startsWith('custom-') ? (
            <input className="mrd-title" value={nameDraft} autoFocus onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => { if (nameDraft.trim() && nameDraft.trim() !== selected.name) { upsertProfile({ ...selected, name: nameDraft.trim() }); onRefresh(); } setEditingName(false); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } else if (e.key === 'Escape') setEditingName(false); }}
              style={{ border: 'none', borderBottom: '1px dashed var(--accent-primary)', background: 'transparent', padding: 0, margin: 0, outline: 'none', fontSize: '15px', fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)', fontFamily: 'inherit', height: '27px', lineHeight: '27px' }} />
          ) : (
            <h3 className="mrd-title" onClick={selected.id.startsWith('custom-') ? () => { setEditingName(true); setNameDraft(selected.name); } : undefined}
              style={selected.id.startsWith('custom-') ? { cursor: 'pointer', borderBottom: '1px dashed var(--border-subtle)' } : undefined}>
              {selectedLabel}
            </h3>
          )}
        </div>
        <div className="mrd-head-right" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button type="button" className="ui-btn ui-btn-sm" style={{ height: '26px', padding: '0 10px', fontSize: '12px', fontWeight: 500, borderRadius: '6px', border: selected.enabled !== false ? '1px solid color-mix(in srgb, #22c55e 30%, transparent)' : '1px solid var(--border-subtle)', background: selected.enabled !== false ? 'color-mix(in srgb, #22c55e 12%, transparent)' : 'color-mix(in srgb, var(--text-primary) 4%, transparent)', color: selected.enabled !== false ? '#15803d' : 'var(--text-tertiary)', cursor: 'pointer' }}
            onClick={() => { setProfileEnabled(selected.id, selected.enabled === false); onRefresh(); }}>{selected.enabled !== false ? '已启用' : '已停用'}</button>
          {selected.id.startsWith('custom-') && (
            <div style={{ position: 'relative' }}>
              {confirmDeleteId === selected.id ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '4px 8px', whiteSpace: 'nowrap' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>确定删除？</span>
                  <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" style={{ height: '24px', padding: '0 8px', fontSize: '11px', borderRadius: '5px' }}
                    onClick={() => { const next = removeProfile(selected.id); onRefresh(); onSelect(next[0]?.id || null); setConfirmDeleteId(null); }}>确认</button>
                  <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" style={{ height: '24px', padding: '0 8px', fontSize: '11px', borderRadius: '5px' }}
                    onClick={() => setConfirmDeleteId(null)}>取消</button>
                </div>
              ) : (
                <Tooltip content={`删除「${selectedLabel}」`}>
                  <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" style={{ padding: '0 6px', height: '28px', color: 'var(--text-tertiary)' }}
                    onClick={() => setConfirmDeleteId(selected.id)}><Trash2 size={14} /></button>
                </Tooltip>
              )}
            </div>
          )}
        </div>
      </div>

      {selected.id.startsWith('custom-') && (
        <div className={`${styles.mrdFields} mrd-fields`}>
          <div className={`${styles.mrdField} mrd-field`}>
            <label className={`${styles.mrdFieldLabel} mrd-field-label`}>Base URL</label>
            <input className={`${styles.mrdFieldInput} mrd-field-input`} value={selected.baseUrl} placeholder="https://api.example.com/v1" spellCheck={false}
              onChange={(e) => { upsertProfile({ ...selected, baseUrl: e.target.value }); }}
              onBlur={() => { if (!selected) return; void saveProfileBaseUrl(selected.id, selected.baseUrl).then((r) => { if (!r.ok) onNotify(false, `地址保存失败：${r.error || '未知错误'}`); onRefresh(); }); }} />
          </div>
          <div className={`${styles.mrdField} mrd-field`}>
            <label className={`${styles.mrdFieldLabel} mrd-field-label`}>API Key</label>
            <div className={`${styles.mrdKeyRow} mrd-key-row`}>
              <input className={`${styles.mrdFieldInput} mrd-field-input`} type="password" placeholder={hasKeySelected ? '••••••••••••••••••••' : '粘贴 API Key'} value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && keyDraft.trim()) { e.preventDefault(); void saveKey(); } }} />
              <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" disabled={!keyDraft.trim()} onClick={() => void saveKey()}
                style={{ borderRadius: '7px', height: '34px', padding: '0 14px', flexShrink: 0 }}>保存</button>
            </div>
          </div>
        </div>
      )}

      <div className={`${styles.mrdModelsHead} mrd-models-head`}>
        <span className={`${styles.mrdModelsLabel} mrd-models-label`}>模型列表</span>
        <div className={`${styles.mrdModelsActions} mrd-models-actions`}>
          <Tooltip content="检查服务商连通性"><button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={checkBusy}
            onClick={runCheck} style={{ height: '28px', width: '28px', padding: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            aria-label="检查连通性">{checkBusy ? <Loader2 size={13} className={styles.loadingSpinner} /> : <Wifi size={13} />}</button></Tooltip>
          <Tooltip content="自动获取服务商模型列表"><button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={scanBusy}
            onClick={runScan} style={{ height: '28px', width: '28px', padding: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            aria-label="自动获取">{scanBusy ? <Loader2 size={13} className={styles.loadingSpinner} /> : <RefreshCw size={13} />}</button></Tooltip>
          <div style={{ position: 'relative' }}>
            <Search size={12} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', pointerEvents: 'none' }} />
            <input type="text" placeholder="搜索..." value={modelFilter} onChange={(e) => setModelFilter(e.target.value)}
              className={`${styles.mrdSearch} mrd-search`} spellCheck={false} />
          </div>
          <Tooltip content="手动添加模型"><button type="button" className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={() => { setManualOpen(!manualOpen); setAddDraft(emptyAddDraft()); }}
            style={{ height: '28px', width: '28px', padding: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            aria-label="添加模型"><Plus size={13} /></button></Tooltip>
        </div>
      </div>

      {manualOpen ? (
        <div className={`${styles.mrdAddForm} mrd-add-form`}>
          <div className={`${styles.mrdAddFormFields} mrd-add-form-fields`}>
            <label className={`${styles.mrdAddLabel} mrd-add-label`}><span>模型 ID *</span><input className={`${styles.mrdFieldInput} mrd-field-input`} placeholder="如 deepseek-chat" value={addDraft.modelId} onChange={(e) => setAddDraft((d) => ({ ...d, modelId: e.target.value }))} spellCheck={false} /></label>
            <label className={`${styles.mrdAddLabel} mrd-add-label`}><span>展示名称</span><input className={`${styles.mrdFieldInput} mrd-field-input`} placeholder="可选" value={addDraft.displayName} onChange={(e) => setAddDraft((d) => ({ ...d, displayName: e.target.value }))} /></label>
            <label className={`${styles.mrdAddLabel} mrd-add-label`}><span>上下文长度</span><input className={`${styles.mrdFieldInput} mrd-field-input`} placeholder="128000" value={addDraft.contextLength} onChange={(e) => setAddDraft((d) => ({ ...d, contextLength: e.target.value }))} /></label>
          </div>
          <div className={`${styles.mrdAddFormFooter} mrd-add-form-footer`}>
            <div style={{ display: 'flex', gap: '8px' }}>{MODEL_CAPABILITY_OPTIONS.map((opt) => {
              const on = !!addDraft.caps[opt.key];
              return (<label key={opt.key} className={`${styles.mrdCapPill} mrd-cap-pill ${on ? styles.isOn + ' is-on' : ''}`}><input type="checkbox" style={{ display: 'none' }} checked={on} onChange={(e) => setAddDraft((d) => ({ ...d, caps: { ...d.caps, [opt.key]: e.target.checked } }))} />{opt.label}</label>);
            })}</div>
            <div style={{ display: 'flex', gap: '6px' }}><button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setManualOpen(false)}>取消</button><button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" disabled={!addDraft.modelId.trim()} onClick={handleManualAdd}>添加</button></div>
          </div>
        </div>
      ) : null}

      <div className={`${styles.mrdModelList} mrd-model-list`}>
        {modelsList.map((m: string) => {
          const meta = getModelMeta(selected.id, m);
          const off = meta.enabled === false;
          const tKey = `${selected.id}::${m}`;
          const isLive = globalActiveProfileId === selected.id && globalActiveModelId === m;
          const expanded = configOpenId === m && !!cfgDraft;
          const display = expanded && cfgDraft?.displayName?.trim() ? cfgDraft.displayName.trim() : formatModelDisplayName(selected.id, m, meta);
          const liveCtxVal = expanded && cfgDraft ? (() => { const n = parseInt(cfgDraft.contextLength.replace(/[^\d]/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : meta.contextLength; })() : meta.contextLength;
          const liveCtxLabel = formatContextLabel(liveCtxVal);
          const showCtx = liveCtxLabel && liveCtxLabel !== '—';

          return (
            <div key={m} className={`${styles.mrdModelRow} mrd-model-row ${off ? 'is-off' : ''} ${isLive ? 'is-live' : ''} ${expanded ? 'is-expanded' : ''}`}
              onClick={(e) => { const target = e.target as HTMLElement; if (target.closest('.models-switch') || target.closest('.mrd-delete-btn')) return; if (expanded) setConfigOpenId(null); else openConfigFor(m); }} style={{ cursor: 'pointer' }}>
              <div className={`${styles.mrdModelInfo} mrd-model-info`}>
                <span className={`${styles.mrdModelName} mrd-model-name`}>{display}</span>
                <div className="mrd-model-meta">{showCtx && <span className={`${styles.mrdCtxPill} mrd-ctx-pill`}>{liveCtxLabel}</span>}{meta.capabilities?.tools && <span className={`${styles.mrdCapTag} mrd-cap-tag`} aria-label="支持工具调用"><Wrench size={10} /></span>}{meta.capabilities?.vision && <span className={`${styles.mrdCapTag} mrd-cap-tag`} aria-label="支持视觉"><Eye size={10} /></span>}{meta.capabilities?.reasoning && <span className={`${styles.mrdCapTag} mrd-cap-tag`} aria-label="支持思考"><BrainCircuit size={10} /></span>}</div>
              </div>
              <div className={`${styles.mrdModelActions} mrd-model-actions`}>
                <Tooltip content={off ? '已停用，点击启用' : '点击停用'}>
                  <button type="button" className={`${styles.modelRowToggle} ${!off ? styles.active : ''}`}
                    onClick={(e) => { e.stopPropagation(); setModelEnabled(selected.id, m, off); onRefresh(); }}
                    aria-label={off ? '启用模型' : '停用模型'}><span className={styles.toggleThumb} /></button>
                </Tooltip>
                <Tooltip content="配置"><button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" style={{ padding: '0 5px', height: '26px', color: expanded ? 'var(--accent-primary)' : 'var(--text-tertiary)' }} onClick={(e) => { e.stopPropagation(); if (expanded) setConfigOpenId(null); else openConfigFor(m); }}><SlidersHorizontal size={13} /></button></Tooltip>
                <Tooltip content="删除"><button type="button" className="ui-btn ui-btn-ghost ui-btn-sm mrd-delete-btn" style={{ padding: '0 5px', height: '26px', color: 'var(--text-tertiary)' }} onClick={(e) => { e.stopPropagation(); removeModelFromProfile(selected.id, m); if (configOpenId === m) setConfigOpenId(null); onRefresh(); }}><Trash2 size={13} /></button></Tooltip>
              </div>
              {expanded && cfgDraft && (
                <div className={`${styles.modelConfigPanel} mrd-model-cfg`} onClick={(e) => e.stopPropagation()}>
                  <div className={`${styles.mrdCfgFields} mrd-cfg-fields`}>
                    <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}><span>展示名称</span><input className={`${styles.mrdFieldInput} mrd-field-input`} value={cfgDraft.displayName} placeholder={m} onChange={(e) => setCfgDraft((d) => d ? ({ ...d, displayName: e.target.value }) : null)} /></label>
                    <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}><span>上下文长度</span><input className={`${styles.mrdFieldInput} mrd-field-input`} value={cfgDraft.contextLength} placeholder="如 1000000" onChange={(e) => setCfgDraft((d) => d ? ({ ...d, contextLength: e.target.value }) : null)} /></label>
                  </div>
                  <div className={`${styles.mrdCfgFooter} mrd-cfg-footer`}>
                    <div className={`${styles.mrdCapGroup} mrd-cap-group`}>{MODEL_CAPABILITY_OPTIONS.map((opt) => {
                      const on = !!cfgDraft.caps[opt.key];
                      return (<label key={opt.key} className={`${styles.mrdCapPill} mrd-cap-pill ${on ? styles.isOn + ' is-on' : ''}`}><input type="checkbox" style={{ display: 'none' }} checked={on} onChange={(e) => setCfgDraft((d) => d ? ({ ...d, caps: { ...d.caps, [opt.key]: e.target.checked } }) : null)} />{opt.label}</label>);
                    })}</div>
                    <div className={`${styles.mrdCfgActions} mrd-cfg-actions`}>
                      {meta.lastTest && <Tooltip content={meta.lastTest.error || (meta.lastTest.ok ? '测试成功' : '测试失败')}><span style={{ fontSize: '11px', fontWeight: 500, marginRight: '6px', userSelect: 'none', color: !meta.lastTest.ok ? 'var(--accent-red, #ef4444)' : (meta.lastTest.latencyMs || 0) < 400 ? 'var(--accent-green, #10b981)' : (meta.lastTest.latencyMs || 0) < 1200 ? 'var(--accent-orange, #f59e0b)' : 'var(--accent-red, #ef4444)' }}>{meta.lastTest.ok ? `${meta.lastTest.latencyMs}ms` : meta.lastTest.error?.includes('超时') || meta.lastTest.error?.includes('timeout') ? '超时' : '失败'}</span></Tooltip>}
                      <Tooltip content="测试连通性"><button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={testBusy === tKey} onClick={() => void runTest(m)}>{testBusy === tKey ? <Loader2 size={13} className={styles.loadingSpinner} /> : <Wifi size={13} />}</button></Tooltip>
                      <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setConfigOpenId(null)}>收起</button>
                      <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={saveConfig}>保存</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {modelsCount === 0 && <div className={`${styles.mrdModelEmpty} mrd-model-empty`}>暂无模型 · 点击右上角「+」手动添加</div>}
        {modelsCount > 0 && modelsList.length === 0 && <div className={`${styles.mrdModelEmpty} mrd-model-empty`}>无匹配的「{modelFilter.trim()}」</div>}
      </div>
    </div>
  );
});
