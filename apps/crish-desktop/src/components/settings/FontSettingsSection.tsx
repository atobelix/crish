import { useToast } from '../../services/toast/ToastContext';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  DEFAULT_FONT_PREFS,
  type FontPreferences,
  type MonoFontChoice,
  type UiFontChoice,
  isLocalFontChoice,
  listLocalFonts,
  localFontFamily,
  monoFontOptions,
  platformLabel,
  readStoredFonts,
  setFontPreferences,
  toLocalChoice,
  uiFontOptions,
} from '../../api/fontStore';
import { FontSelectField, type FontSelectOption } from './FontSelectField';
import { SettingsRow } from './SettingsUI';
import { Button, Tooltip } from '../ui';
import styles from './FontSettingsSection.module.css';

interface Props {
  onPersistSettings?: (fonts: FontPreferences) => void | Promise<void>;
}

/** 自定义本机字体名安全边界（过长 / 控制符 / CSS 注入字符） */
const FONT_NAME_MAX = 64;

function sanitizeFontFamilyName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  // eslint-disable-next-line no-control-regex -- 有意剥离 C0 控制字符
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!stripped) {
    return { ok: false, reason: '请输入字体名称' };
  }
  if (/[;{}<>\\]/.test(stripped)) {
    return { ok: false, reason: '字体名称含非法字符' };
  }
  const name = stripped.length > FONT_NAME_MAX ? stripped.slice(0, FONT_NAME_MAX) : stripped;
  if (!name) {
    return { ok: false, reason: '请输入字体名称' };
  }
  return { ok: true, name };
}

function prefsEqual(a: FontPreferences, b: Partial<FontPreferences>): boolean {
  if (b.uiFont !== undefined && a.uiFont !== b.uiFont) return false;
  if (b.monoFont !== undefined && a.monoFont !== b.monoFont) return false;
  if (b.monoLigatures !== undefined && a.monoLigatures !== b.monoLigatures) return false;
  return true;
}

function isDefaultPrefs(p: FontPreferences): boolean {
  return (
    p.uiFont === DEFAULT_FONT_PREFS.uiFont &&
    p.monoFont === DEFAULT_FONT_PREFS.monoFont &&
    !!p.monoLigatures === !!DEFAULT_FONT_PREFS.monoLigatures
  );
}

export const FontSettingsSection: React.FC<Props> = ({ onPersistSettings }) => {
  const { showToast: _showToast } = useToast();
  const [prefs, setPrefs] = useState<FontPreferences>(() => {
    try {
      return readStoredFonts();
    } catch {
      return { ...DEFAULT_FONT_PREFS };
    }
  });
  const [localFonts, setLocalFonts] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [customTarget, setCustomTarget] = useState<'ui' | 'mono'>('ui');

  useEffect(() => {
    try {
      setPrefs(readStoredFonts());
    } catch {
      setPrefs({ ...DEFAULT_FONT_PREFS });
    }
  }, []);

  const apply = useCallback(
    async (partial: Partial<FontPreferences>) => {
      if (prefsEqual(prefs, partial)) return;
      setBusy(true);
      try {
        const next = await setFontPreferences(partial);
        setPrefs(next);
        if (onPersistSettings) {
          try {
            await onPersistSettings(next);
          } catch {
            return;
          }
        }
      } catch (e) {
        showToast(`字体应用失败：${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [onPersistSettings, prefs],
  );

  const scanLocal = useCallback(async () => {
    setScanning(true);
    try {
      const list = await listLocalFonts();
      const names = list.map((f) => f.family);
      setLocalFonts(names);
    } catch (e) {
      showToast(`扫描失败：${String(e)}`);
    } finally {
      setScanning(false);
    }
  }, [showToast]);

  const uiOptions: FontSelectOption[] = useMemo(() => {
    const base: FontSelectOption[] = uiFontOptions().map((o) => ({
      value: o.id,
      label: o.label,
      ...(o.previewFamily !== undefined && { previewFamily: o.previewFamily }),
      ...(o.kind === 'embedded' ? { hint: '内嵌' } : o.kind === 'auto' ? { hint: platformLabel() } : {}),
    }));
    const locals: FontSelectOption[] = localFonts.map((f) => ({
      value: `local:${f}`,
      label: f,
      group: '本机',
      previewFamily: f,
    }));
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

  const monoOptions: FontSelectOption[] = useMemo(() => {
    const base: FontSelectOption[] = monoFontOptions().map((o) => ({
      value: o.id,
      label: o.label,
      ...(o.previewFamily !== undefined && { previewFamily: o.previewFamily }),
      ...(o.kind === 'embedded' ? { hint: '内嵌' } : o.kind === 'auto' ? { hint: platformLabel() } : {}),
    }));
    const locals: FontSelectOption[] = localFonts.map((f) => ({
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
  const atDefault = isDefaultPrefs(prefs);

  const applyCustom = (target: 'ui' | 'mono') => {
    const parsed = sanitizeFontFamilyName(customDraft);
    if (parsed.ok === false) {
      const reason = parsed.reason;
      if (reason === '请输入字体名称' || reason.includes('非法')) {
        showToast(reason);
      }
      return;
    }
    const name = parsed.name;
    const choice = toLocalChoice(name);
    if (target === 'ui') {
      if (prefs.uiFont === choice) {
        setCustomDraft('');
        return;
      }
      setCustomDraft('');
      void apply({ uiFont: choice });
      return;
    }
    if (prefs.monoFont === choice) {
      setCustomDraft('');
      return;
    }
    setCustomDraft('');
    void apply({ monoFont: choice });
  };

  const customHeader = (target: 'ui' | 'mono') => {
    const isCurrentDraft = customTarget === target;
    const hasDraft = isCurrentDraft && customDraft.trim().length > 0;

    return (
      <div
        className={styles.settingsSelectCustomHeaderArea}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
          <Lucide.Search
            size={13}
            style={{
              position: 'absolute',
              left: '8px',
              color: 'var(--text-tertiary)',
              pointerEvents: 'none',
            }}
          />
          <input
            className={styles.settingsSelectCustomInput}
            placeholder="自定义字体名..."
            value={isCurrentDraft ? customDraft : ''}
            disabled={busy}
            maxLength={FONT_NAME_MAX + 8}
            aria-label="自定义字体名称"
            autoComplete="off"
            spellCheck={false}
            style={{
              padding: hasDraft ? '0 26px 0 26px' : '0 8px 0 26px',
            }}
            onFocus={() => setCustomTarget(target)}
            onChange={(e) => {
              setCustomTarget(target);
              const v = e.target.value;
              setCustomDraft(v.length > FONT_NAME_MAX + 8 ? v.slice(0, FONT_NAME_MAX + 8) : v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyCustom(target);
              }
            }}
          />
          {hasDraft && (
            <Tooltip content="应用自定义字体">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.customApplyBtn}
                onClick={() => applyCustom(target)}
              >
                <Lucide.Check size={12} />
              </Button>
            </Tooltip>
          )}
        </div>

        <Tooltip content="扫描本机字体">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.customActionBtn}
            disabled={busy || scanning}
            onClick={() => void scanLocal()}
          >
            {scanning ? <Lucide.Loader2 size={13} className="spin" /> : <Lucide.HardDrive size={13} />}
          </Button>
        </Tooltip>

        <Tooltip content="恢复默认字体">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.customActionBtn}
            disabled={busy || (target === 'mono' ? atDefault : prefs.uiFont === DEFAULT_FONT_PREFS.uiFont)}
            onClick={() => {
              if (target === 'mono') {
                void apply({ ...DEFAULT_FONT_PREFS });
              } else {
                void apply({ uiFont: DEFAULT_FONT_PREFS.uiFont });
              }
            }}
          >
            <Lucide.RotateCcw size={13} />
          </Button>
        </Tooltip>
      </div>
    );
  };

  let uiPreviewFamily: string | undefined;
  let monoPreviewFamily: string | undefined;
  try {
    uiPreviewFamily = isLocalFontChoice(uiValue)
      ? localFontFamily(uiValue)
      : uiFontOptions().find((o) => o.id === uiValue)?.previewFamily;
    monoPreviewFamily = isLocalFontChoice(monoValue)
      ? localFontFamily(monoValue)
      : monoFontOptions().find((o) => o.id === monoValue)?.previewFamily;
  } catch {
    uiPreviewFamily = undefined;
    monoPreviewFamily = undefined;
  }

  return (
    <>
      <SettingsRow
        title="界面字体"
        control={
          <FontSelectField
            value={uiValue || 'auto'}
            options={uiOptions}
            disabled={busy}
            onChange={(v) => {
              if ((v as UiFontChoice) === uiValue) return;
              void apply({ uiFont: v as UiFontChoice });
            }}
            {...(uiPreviewFamily !== undefined && { valuePreviewFamily: uiPreviewFamily })}
            footer={customHeader('ui')}
            maxHeight={320}
          />
        }
      />

      <SettingsRow
        title="代码字体"
        control={
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <label
              className={styles.settingsRowCheck}
              aria-label="启用代码连字（liga / calt）"
            >
              <input
                type="checkbox"
                checked={!!prefs?.monoLigatures}
                disabled={busy}
                aria-label="代码连字"
                onChange={(e) => {
                  const next = e.target.checked;
                  if (next === !!prefs.monoLigatures) return;
                  void apply({ monoLigatures: next });
                }}
              />
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>连字</span>
            </label>
            <FontSelectField
              value={monoValue || 'auto'}
              options={monoOptions}
              disabled={busy}
              onChange={(v) => {
                if ((v as MonoFontChoice) === monoValue) return;
                void apply({ monoFont: v as MonoFontChoice });
              }}
              {...(monoPreviewFamily !== undefined && { valuePreviewFamily: monoPreviewFamily })}
              footer={customHeader('mono')}
              maxHeight={320}
            />
          </div>
        }
      />
    </>
  );
};
