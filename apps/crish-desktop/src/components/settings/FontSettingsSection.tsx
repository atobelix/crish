/**
 * 设置页字体配置面板
 * 连接 scanSystemFonts 双引擎与 FontSelectField 原生内嵌搜索
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../services/toast/ToastContext';
import {
  DEFAULT_FONT_PREFS,
  type FontPreferences,
  type MonoFontChoice,
  type UiFontChoice,
  isLocalFontChoice,
  localFontFamily,
  monoFontOptions,
  platformLabel,
  readStoredFonts,
  setFontPreferences,
  toLocalChoice,
  uiFontOptions,
} from '../../api/fontStore';
import { scanSystemFonts } from './internal/fontStoreScan';
import { sanitizeFontFamilyNameStrict } from './internal/fontPinyinMatcher';
import { FontSelectField, type FontSelectOption } from './FontSelectField';
import { SettingsRow } from './SettingsUI';
import styles from './FontSettingsSection.module.css';

interface Props {
  onPersistSettings?: (fonts: FontPreferences) => void | Promise<void>;
}

function prefsEqual(a: FontPreferences, b: Partial<FontPreferences>): boolean {
  if (b.uiFont !== undefined && a.uiFont !== b.uiFont) return false;
  if (b.monoFont !== undefined && a.monoFont !== b.monoFont) return false;
  if (b.monoLigatures !== undefined && a.monoLigatures !== b.monoLigatures) return false;
  return true;
}

export const FontSettingsSection: React.FC<Props> = ({ onPersistSettings }) => {
  const { showToast } = useToast();
  const [prefs, setPrefs] = useState<FontPreferences>(() => {
    try {
      return readStoredFonts();
    } catch {
      return { ...DEFAULT_FONT_PREFS };
    }
  });

  const [localFonts, setLocalFonts] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);

  // 初始化静默加载系统字体（优先读取内存/磁盘缓存）
  useEffect(() => {
    let unmounted = false;
    void scanSystemFonts(false).then((res) => {
      if (!unmounted && res.fonts.length > 0) {
        setLocalFonts(res.fonts.map((f) => f.family));
      }
    });
    return () => {
      unmounted = true;
    };
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
            // swallow persist error
          }
        }
      } catch (e) {
        showToast(`字体应用失败：${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [onPersistSettings, prefs, showToast]
  );

  const handleScanLocal = useCallback(async () => {
    setScanning(true);
    try {
      const res = await scanSystemFonts(true);
      const names = res.fonts.map((f) => f.family);
      setLocalFonts(names);
      showToast(`扫描成功，发现 ${res.totalCount} 款系统字体`);
    } catch (e) {
      showToast(`扫描失败：${String(e)}`);
    } finally {
      setScanning(false);
    }
  }, [showToast]);

  const handleApplyCustom = useCallback(
    (target: 'ui' | 'mono', customDraft: string) => {
      const parsed = sanitizeFontFamilyNameStrict(customDraft);
      if (!parsed.ok) {
        showToast(parsed.reason);
        return;
      }
      const choice = toLocalChoice(parsed.name);
      if (target === 'ui') {
        void apply({ uiFont: choice as UiFontChoice });
      } else {
        void apply({ monoFont: choice as MonoFontChoice });
      }
    },
    [apply, showToast]
  );

  const uiOptions: FontSelectOption[] = useMemo(() => {
    const base: FontSelectOption[] = uiFontOptions().map((o) => ({
      value: o.id,
      label: o.label,
      group: '预设',
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
      group: '预设',
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

  let uiPreviewFamily: string | undefined;
  let monoPreviewFamily: string | undefined;
  try {
    uiPreviewFamily = isLocalFontChoice(prefs.uiFont)
      ? localFontFamily(prefs.uiFont)
      : uiFontOptions().find((o) => o.id === prefs.uiFont)?.previewFamily;
    monoPreviewFamily = isLocalFontChoice(prefs.monoFont)
      ? localFontFamily(prefs.monoFont)
      : monoFontOptions().find((o) => o.id === prefs.monoFont)?.previewFamily;
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
            value={prefs.uiFont || 'auto'}
            options={uiOptions}
            disabled={busy}
            onChange={(v) => void apply({ uiFont: v as UiFontChoice })}
            {...(uiPreviewFamily !== undefined && { valuePreviewFamily: uiPreviewFamily })}
            onScanLocal={handleScanLocal}
            isScanning={scanning}
            onResetDefault={() => void apply({ uiFont: DEFAULT_FONT_PREFS.uiFont })}
            isDefault={prefs.uiFont === DEFAULT_FONT_PREFS.uiFont}
            onApplyCustom={(name) => handleApplyCustom('ui', name)}
            maxHeight={340}
          />
        }
      />

      <SettingsRow
        title="代码字体"
        control={
          <div className={styles.monoControlRow}>
            <label className={styles.settingsRowCheck} aria-label="启用代码连字（liga / calt）">
              <input
                type="checkbox"
                checked={!!prefs.monoLigatures}
                disabled={busy}
                onChange={(e) => void apply({ monoLigatures: e.target.checked })}
              />
              <span>连字</span>
            </label>
            <FontSelectField
              value={prefs.monoFont || 'auto'}
              options={monoOptions}
              disabled={busy}
              onChange={(v) => void apply({ monoFont: v as MonoFontChoice })}
              {...(monoPreviewFamily !== undefined && { valuePreviewFamily: monoPreviewFamily })}
              onScanLocal={handleScanLocal}
              isScanning={scanning}
              onResetDefault={() => void apply({ monoFont: DEFAULT_FONT_PREFS.monoFont })}
              isDefault={prefs.monoFont === DEFAULT_FONT_PREFS.monoFont}
              onApplyCustom={(name) => handleApplyCustom('mono', name)}
              maxHeight={340}
            />
          </div>
        }
      />
    </>
  );
};
