import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  DEFAULT_FONT_PREFS,
  type FontPreferences,
  type MonoFontChoice,
  type UiFontChoice,
  describeActiveMono,
  describeActiveUi,
  isLocalFontChoice,
  listLocalFonts,
  localFontFamily,
  monoFontOptions,
  platformLabel,
  readStoredFonts,
  setFontPreferences,
  toLocalChoice,
  uiFontOptions,
} from '../api/fontStore';

interface Props {
  onShowToast?: (msg: string) => void;
  onPersistSettings?: (fonts: FontPreferences) => void | Promise<void>;
}

/**
 * 紧凑字体设置：主行用下拉，本机字体收进可展开细节面板。
 */
export const FontSettingsSection: React.FC<Props> = ({ onShowToast, onPersistSettings }) => {
  const [prefs, setPrefs] = useState<FontPreferences>(() => readStoredFonts());
  const [localFonts, setLocalFonts] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [customUi, setCustomUi] = useState('');
  const [customMono, setCustomMono] = useState('');
  const [busy, setBusy] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);

  useEffect(() => {
    const p = readStoredFonts();
    setPrefs(p);
    if (isLocalFontChoice(p.uiFont)) {
      setCustomUi(localFontFamily(p.uiFont));
      setLocalOpen(true);
    }
    if (isLocalFontChoice(p.monoFont)) {
      setCustomMono(localFontFamily(p.monoFont));
      setLocalOpen(true);
    }
  }, []);

  const apply = useCallback(
    async (partial: Partial<FontPreferences>) => {
      setBusy(true);
      try {
        const next = await setFontPreferences(partial);
        setPrefs(next);
        if (onPersistSettings) await onPersistSettings(next);
      } catch (e) {
        onShowToast?.(`字体应用失败：${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [onPersistSettings, onShowToast],
  );

  const scanLocal = useCallback(async () => {
    setScanning(true);
    try {
      const list = await listLocalFonts();
      const names = list.map((f) => f.family);
      setLocalFonts(names);
      if (!names.length) onShowToast?.('未扫描到本机字体（可手动输入）');
      else onShowToast?.(`已扫描 ${names.length} 个字体`);
    } catch (e) {
      onShowToast?.(`扫描失败：${String(e)}`);
    } finally {
      setScanning(false);
    }
  }, [onShowToast]);

  const uiSelectValue = useMemo(() => {
    if (isLocalFontChoice(prefs.uiFont)) return '__local__';
    return prefs.uiFont;
  }, [prefs.uiFont]);

  const monoSelectValue = useMemo(() => {
    if (isLocalFontChoice(prefs.monoFont)) return '__local__';
    return prefs.monoFont;
  }, [prefs.monoFont]);

  const onUiSelect = (v: string) => {
    if (v === '__local__') {
      setLocalOpen(true);
      if (customUi.trim()) void apply({ uiFont: toLocalChoice(customUi) });
      return;
    }
    void apply({ uiFont: v as UiFontChoice });
  };

  const onMonoSelect = (v: string) => {
    if (v === '__local__') {
      setLocalOpen(true);
      if (customMono.trim()) void apply({ monoFont: toLocalChoice(customMono) });
      return;
    }
    void apply({ monoFont: v as MonoFontChoice });
  };

  return (
    <div className="font-settings font-settings--compact">
      <div className="font-settings-head">
        <label className="settings-field-label">字体</label>
        <span className="font-settings-hint">
          {platformLabel()} · {describeActiveUi(prefs)} / {describeActiveMono(prefs)}
        </span>
      </div>

      {/* 主行：界面 + 代码 + 连字 */}
      <div className="font-settings-row">
        <label className="font-field">
          <span className="font-field-label">界面</span>
          <select
            className="settings-field-input font-field-select"
            value={uiSelectValue}
            disabled={busy}
            onChange={(e) => onUiSelect(e.target.value)}
          >
            {uiFontOptions().map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
            <option value="__local__">本机字体…</option>
          </select>
        </label>

        <label className="font-field">
          <span className="font-field-label">代码</span>
          <select
            className="settings-field-input font-field-select"
            value={monoSelectValue}
            disabled={busy}
            onChange={(e) => onMonoSelect(e.target.value)}
          >
            {monoFontOptions().map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
            <option value="__local__">本机字体…</option>
          </select>
        </label>

        <label className="font-ligature-toggle" title="代码连字">
          <input
            type="checkbox"
            checked={!!prefs.monoLigatures}
            disabled={busy}
            onChange={(e) => void apply({ monoLigatures: e.target.checked })}
          />
          <span>连字</span>
        </label>

        <button
          type="button"
          className="font-link-btn"
          disabled={busy}
          onClick={() => {
            setCustomUi('');
            setCustomMono('');
            void apply({ ...DEFAULT_FONT_PREFS });
            onShowToast?.('已恢复默认字体');
          }}
        >
          默认
        </button>
      </div>

      {/* 预览：单行 */}
      <div className="font-preview-inline">
        <span style={{ fontFamily: 'var(--font-sans)' }}>界面 Ag 中文</span>
        <span className="font-preview-sep">·</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{'const x = 1'}</span>
      </div>

      {/* 本机：折叠细节 */}
      <details
        className="font-local-details"
        open={localOpen}
        onToggle={(e) => setLocalOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="font-local-summary">
          <Lucide.HardDrive size={14} />
          <span>本机字体</span>
          {(isLocalFontChoice(prefs.uiFont) || isLocalFontChoice(prefs.monoFont)) && (
            <span className="font-local-badge">使用中</span>
          )}
          <Lucide.ChevronDown size={14} className="font-local-chev" />
        </summary>
        <div className="font-local-panel">
          <div className="font-local-actions">
            <button
              type="button"
              className="settings-secondary-btn"
              disabled={scanning || busy}
              onClick={() => void scanLocal()}
            >
              {scanning ? '扫描中…' : '扫描本机'}
            </button>
            {localFonts.length > 0 ? (
              <span className="font-settings-hint">{localFonts.length} 个可用</span>
            ) : (
              <span className="font-settings-hint">或直接输入字体族名</span>
            )}
          </div>
          <div className="font-local-grid">
            <label className="font-field font-field--stack">
              <span className="font-field-label">界面本机</span>
              <div className="font-local-inputs">
                {localFonts.length > 0 ? (
                  <select
                    className="settings-field-input"
                    value={isLocalFontChoice(prefs.uiFont) ? localFontFamily(prefs.uiFont) : ''}
                    disabled={busy}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      setCustomUi(v);
                      void apply({ uiFont: toLocalChoice(v) });
                    }}
                  >
                    <option value="">选择…</option>
                    {localFonts.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                ) : null}
                <input
                  className="settings-field-input"
                  placeholder="如 Segoe UI"
                  value={customUi}
                  disabled={busy}
                  onChange={(e) => setCustomUi(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customUi.trim()) {
                      void apply({ uiFont: toLocalChoice(customUi) });
                    }
                  }}
                />
                <button
                  type="button"
                  className="settings-secondary-btn"
                  disabled={busy || !customUi.trim()}
                  onClick={() => void apply({ uiFont: toLocalChoice(customUi) })}
                >
                  应用
                </button>
              </div>
            </label>
            <label className="font-field font-field--stack">
              <span className="font-field-label">代码本机</span>
              <div className="font-local-inputs">
                {localFonts.length > 0 ? (
                  <select
                    className="settings-field-input"
                    value={isLocalFontChoice(prefs.monoFont) ? localFontFamily(prefs.monoFont) : ''}
                    disabled={busy}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      setCustomMono(v);
                      void apply({ monoFont: toLocalChoice(v) });
                    }}
                  >
                    <option value="">选择…</option>
                    {localFonts.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                ) : null}
                <input
                  className="settings-field-input"
                  placeholder="如 Consolas"
                  value={customMono}
                  disabled={busy}
                  onChange={(e) => setCustomMono(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customMono.trim()) {
                      void apply({ monoFont: toLocalChoice(customMono) });
                    }
                  }}
                />
                <button
                  type="button"
                  className="settings-secondary-btn"
                  disabled={busy || !customMono.trim()}
                  onClick={() => void apply({ monoFont: toLocalChoice(customMono) })}
                >
                  应用
                </button>
              </div>
            </label>
          </div>
        </div>
      </details>
    </div>
  );
};
