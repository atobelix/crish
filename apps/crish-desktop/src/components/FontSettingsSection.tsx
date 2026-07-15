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
import { SettingsSelect, type SettingsSelectOption } from './SettingsSelect';

interface Props {
  onShowToast?: (msg: string) => void;
  onPersistSettings?: (fonts: FontPreferences) => void | Promise<void>;
}

/**
 * 字体：每项一行；展开列表含内置 + 本机；扫描为行内图标。
 */
export const FontSettingsSection: React.FC<Props> = ({ onShowToast, onPersistSettings }) => {
  const [prefs, setPrefs] = useState<FontPreferences>(() => readStoredFonts());
  const [localFonts, setLocalFonts] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /** 自定义输入目标：ui | mono */
  const [customTarget, setCustomTarget] = useState<'ui' | 'mono'>('ui');

  useEffect(() => {
    setPrefs(readStoredFonts());
    // 首次静默尝试列本机（失败忽略）
    void listLocalFonts()
      .then((list) => setLocalFonts(list.map((f) => f.family)))
      .catch(() => undefined);
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
      if (!names.length) onShowToast?.('未扫描到本机字体');
      else onShowToast?.(`已加载 ${names.length} 个本机字体`);
    } catch (e) {
      onShowToast?.(`扫描失败：${String(e)}`);
    } finally {
      setScanning(false);
    }
  }, [onShowToast]);

  const uiOptions: SettingsSelectOption[] = useMemo(() => {
    const base: SettingsSelectOption[] = uiFontOptions().map((o) => ({
      value: o.id,
      label: o.label,
      group: '推荐',
      previewFamily: o.previewFamily,
      hint: o.kind === 'embedded' ? '内嵌' : o.kind === 'auto' ? platformLabel() : undefined,
    }));
    const locals: SettingsSelectOption[] = localFonts.map((f) => ({
      value: `local:${f}`,
      label: f,
      group: '本机',
      previewFamily: f,
    }));
    // 当前已选本机但不在列表里时补上
    if (isLocalFontChoice(prefs.uiFont)) {
      const fam = localFontFamily(prefs.uiFont);
      if (fam && !localFonts.includes(fam)) {
        locals.unshift({
          value: prefs.uiFont,
          label: fam,
          group: '本机',
          previewFamily: fam,
        });
      }
    }
    return [...base, ...locals];
  }, [localFonts, prefs.uiFont]);

  const monoOptions: SettingsSelectOption[] = useMemo(() => {
    const base: SettingsSelectOption[] = monoFontOptions().map((o) => ({
      value: o.id,
      label: o.label,
      group: '推荐',
      previewFamily: o.previewFamily,
      hint: o.kind === 'embedded' ? '内嵌' : o.kind === 'auto' ? platformLabel() : undefined,
    }));
    const locals: SettingsSelectOption[] = localFonts.map((f) => ({
      value: `local:${f}`,
      label: f,
      group: '本机',
      previewFamily: f,
    }));
    if (isLocalFontChoice(prefs.monoFont)) {
      const fam = localFontFamily(prefs.monoFont);
      if (fam && !localFonts.includes(fam)) {
        locals.unshift({
          value: prefs.monoFont,
          label: fam,
          group: '本机',
          previewFamily: fam,
        });
      }
    }
    return [...base, ...locals];
  }, [localFonts, prefs.monoFont]);

  const uiValue = prefs.uiFont;
  const monoValue = prefs.monoFont;

  const applyCustom = (target: 'ui' | 'mono') => {
    const name = customDraft.trim();
    if (!name) return;
    if (target === 'ui') void apply({ uiFont: toLocalChoice(name) });
    else void apply({ monoFont: toLocalChoice(name) });
    setCustomDraft('');
  };

  const scanBtn = (
    <button
      type="button"
      className="settings-select-icon-btn"
      title={scanning ? '扫描中…' : '扫描本机字体'}
      disabled={busy || scanning}
      onClick={(e) => {
        e.stopPropagation();
        void scanLocal();
      }}
    >
      {scanning ? <Lucide.Loader2 size={14} className="spin" /> : <Lucide.HardDrive size={14} />}
    </button>
  );

  const customFooter = (target: 'ui' | 'mono') => (
    <div className="settings-select-custom">
      <input
        className="settings-select-custom-input"
        placeholder="输入本机字体名后回车"
        value={customTarget === target ? customDraft : ''}
        disabled={busy}
        onFocus={() => setCustomTarget(target)}
        onChange={(e) => {
          setCustomTarget(target);
          setCustomDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            applyCustom(target);
          }
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );

  return (
    <>
      <div className="settings-row">
        <div className="settings-row-label">
          <span className="settings-row-title">界面字体</span>
        </div>
        <div className="settings-row-control">
          <SettingsSelect
            value={uiValue}
            options={uiOptions}
            disabled={busy}
            onChange={(v) => void apply({ uiFont: v as UiFontChoice })}
            valuePreviewFamily={
              isLocalFontChoice(uiValue)
                ? localFontFamily(uiValue)
                : uiFontOptions().find((o) => o.id === uiValue)?.previewFamily
            }
            trailing={scanBtn}
            footer={customFooter('ui')}
            maxHeight={320}
          />
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-label">
          <span className="settings-row-title">代码字体</span>
        </div>
        <div className="settings-row-control">
          <label className="settings-row-check" title="代码连字">
            <input
              type="checkbox"
              checked={!!prefs.monoLigatures}
              disabled={busy}
              onChange={(e) => void apply({ monoLigatures: e.target.checked })}
            />
            <span>连字</span>
          </label>
          <SettingsSelect
            value={monoValue}
            options={monoOptions}
            disabled={busy}
            onChange={(v) => void apply({ monoFont: v as MonoFontChoice })}
            valuePreviewFamily={
              isLocalFontChoice(monoValue)
                ? localFontFamily(monoValue)
                : monoFontOptions().find((o) => o.id === monoValue)?.previewFamily
            }
            trailing={scanBtn}
            footer={customFooter('mono')}
            maxHeight={320}
          />
          <button
            type="button"
            className="settings-row-text-btn"
            disabled={busy}
            title="恢复默认字体"
            onClick={() => {
              void apply({ ...DEFAULT_FONT_PREFS });
              onShowToast?.('已恢复默认字体');
            }}
          >
            默认
          </button>
        </div>
      </div>

      <div className="settings-row settings-row--preview">
        <div className="settings-row-label">
          <span className="settings-row-meta">
            {platformLabel()} · {describeActiveUi(prefs)} / {describeActiveMono(prefs)}
          </span>
        </div>
        <div className="settings-row-control settings-row-preview-text">
          <span style={{ fontFamily: 'var(--font-sans)' }}>Ag 中文</span>
          <span className="font-preview-sep">·</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{'const x = 1'}</span>
        </div>
      </div>
    </>
  );
};
