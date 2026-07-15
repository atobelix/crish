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
  /** 同步到 settings.fonts（可选） */
  onPersistSettings?: (fonts: FontPreferences) => void | Promise<void>;
}

export const FontSettingsSection: React.FC<Props> = ({ onShowToast, onPersistSettings }) => {
  const [prefs, setPrefs] = useState<FontPreferences>(() => readStoredFonts());
  const [localFonts, setLocalFonts] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [customUi, setCustomUi] = useState('');
  const [customMono, setCustomMono] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const p = readStoredFonts();
    setPrefs(p);
    if (isLocalFontChoice(p.uiFont)) setCustomUi(localFontFamily(p.uiFont));
    if (isLocalFontChoice(p.monoFont)) setCustomMono(localFontFamily(p.monoFont));
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
      if (names.length === 0) {
        onShowToast?.('未扫描到本机字体（可手动输入字体名）');
      } else {
        onShowToast?.(`已扫描 ${names.length} 个本机字体`);
      }
    } catch (e) {
      onShowToast?.(`扫描失败：${String(e)}`);
    } finally {
      setScanning(false);
    }
  }, [onShowToast]);

  const uiSelected = prefs.uiFont;
  const monoSelected = prefs.monoFont;

  const localSelectValueUi = useMemo(() => {
    if (isLocalFontChoice(uiSelected)) return localFontFamily(uiSelected);
    return '';
  }, [uiSelected]);

  const localSelectValueMono = useMemo(() => {
    if (isLocalFontChoice(monoSelected)) return localFontFamily(monoSelected);
    return '';
  }, [monoSelected]);

  return (
    <div className="font-settings" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label className="settings-field-label">字体</label>
        <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>
          默认按 {platformLabel()} 使用系统优化字体；也可选内嵌免费字体或本机字体。界面字重统一为常规，不额外加粗。
        </p>
      </div>

      {/* UI font */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="settings-field-label">界面字体</div>
        <div className="font-option-grid">
          {uiFontOptions().map((opt) => {
            const isActive =
              !isLocalFontChoice(uiSelected) && uiSelected === (opt.id as UiFontChoice);
            return (
              <button
                key={opt.id}
                type="button"
                className={`font-option-card ${isActive ? 'is-active' : ''}`}
                disabled={busy}
                onClick={() => void apply({ uiFont: opt.id as UiFontChoice })}
              >
                <span
                  className="font-option-preview"
                  style={{ fontFamily: opt.previewFamily || 'var(--font-sans)' }}
                >
                  Ag 中文
                </span>
                <span className="font-option-label">{opt.label}</span>
                {opt.desc ? <span className="font-option-desc">{opt.desc}</span> : null}
              </button>
            );
          })}
        </div>

        <div className="font-local-row">
          <div className="settings-field-label" style={{ marginBottom: 4 }}>
            本机界面字体
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <select
              className="settings-field-input"
              style={{ maxWidth: 280 }}
              value={localSelectValueUi}
              disabled={busy || (localFonts.length === 0 && !localSelectValueUi)}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                setCustomUi(v);
                void apply({ uiFont: toLocalChoice(v) });
              }}
            >
              <option value="">
                {localFonts.length ? '从本机列表选择…' : '先扫描或手动输入'}
              </option>
              {localSelectValueUi && !localFonts.includes(localSelectValueUi) ? (
                <option value={localSelectValueUi}>{localSelectValueUi}</option>
              ) : null}
              {localFonts.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <input
              className="settings-field-input"
              style={{ maxWidth: 200 }}
              placeholder="字体族名，如 Segoe UI"
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
          {isLocalFontChoice(uiSelected) ? (
            <p className="font-active-hint">当前：本机 · {localFontFamily(uiSelected)}</p>
          ) : null}
        </div>
      </div>

      {/* Mono font */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="settings-field-label">代码字体</div>
        <div className="font-option-grid">
          {monoFontOptions().map((opt) => {
            const isActive =
              !isLocalFontChoice(monoSelected) && monoSelected === (opt.id as MonoFontChoice);
            return (
              <button
                key={opt.id}
                type="button"
                className={`font-option-card ${isActive ? 'is-active' : ''}`}
                disabled={busy}
                onClick={() => void apply({ monoFont: opt.id as MonoFontChoice })}
              >
                <span
                  className="font-option-preview font-option-preview--mono"
                  style={{ fontFamily: opt.previewFamily || 'var(--font-mono)' }}
                >
                  {'const x = 1'}
                </span>
                <span className="font-option-label">{opt.label}</span>
                {opt.desc ? <span className="font-option-desc">{opt.desc}</span> : null}
              </button>
            );
          })}
        </div>

        <div className="font-local-row">
          <div className="settings-field-label" style={{ marginBottom: 4 }}>
            本机代码字体
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <select
              className="settings-field-input"
              style={{ maxWidth: 280 }}
              value={localSelectValueMono}
              disabled={busy || (localFonts.length === 0 && !localSelectValueMono)}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                setCustomMono(v);
                void apply({ monoFont: toLocalChoice(v) });
              }}
            >
              <option value="">
                {localFonts.length ? '从本机列表选择…' : '先扫描或手动输入'}
              </option>
              {localSelectValueMono && !localFonts.includes(localSelectValueMono) ? (
                <option value={localSelectValueMono}>{localSelectValueMono}</option>
              ) : null}
              {localFonts.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <input
              className="settings-field-input"
              style={{ maxWidth: 200 }}
              placeholder="字体族名，如 Consolas"
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
          {isLocalFontChoice(monoSelected) ? (
            <p className="font-active-hint">当前：本机 · {localFontFamily(monoSelected)}</p>
          ) : null}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <button
          type="button"
          className="settings-secondary-btn"
          disabled={scanning || busy}
          onClick={() => void scanLocal()}
        >
          {scanning ? (
            <>
              <Lucide.Loader2 size={16} className="spin" style={{ marginRight: 6 }} />
              扫描中…
            </>
          ) : (
            <>
              <Lucide.HardDrive size={16} style={{ marginRight: 6 }} />
              扫描本机字体
            </>
          )}
        </button>
        <label className="settings-toggle-row" style={{ flex: 1, minWidth: 200, margin: 0 }}>
          <div>
            <div className="settings-toggle-title">代码连字</div>
            <div className="settings-toggle-desc">部分等宽字体的 ligatures（==&gt; 等）</div>
          </div>
          <input
            type="checkbox"
            checked={!!prefs.monoLigatures}
            disabled={busy}
            onChange={(e) => void apply({ monoLigatures: e.target.checked })}
          />
        </label>
        <button
          type="button"
          className="settings-secondary-btn"
          disabled={busy}
          onClick={() => {
            setCustomUi('');
            setCustomMono('');
            void apply({ ...DEFAULT_FONT_PREFS });
            onShowToast?.('已恢复默认字体');
          }}
        >
          恢复默认
        </button>
      </div>

      {/* Live preview */}
      <div className="font-preview-box">
        <div className="font-preview-meta">
          界面：{describeActiveUi(prefs)} · 代码：{describeActiveMono(prefs)}
        </div>
        <div className="font-preview-ui" style={{ fontFamily: 'var(--font-sans)' }}>
          会话列表与按钮文字预览 — The quick brown fox 中英文混排 14px
        </div>
        <pre className="font-preview-mono" style={{ fontFamily: 'var(--font-mono)' }}>
          {`function greet(name: string) {\n  return \`你好, \${name}\`;\n}`}
        </pre>
      </div>
    </div>
  );
};
