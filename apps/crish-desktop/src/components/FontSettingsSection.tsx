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

/** 自定义本机字体名安全边界（过长 / 控制符 / CSS 注入字符） */
const FONT_NAME_MAX = 64;

/**
 * 清洗用户输入的字体族名：去控制符、trim、长度钳制；非法返回 null。
 * 成功不 toast；由调用方决定提示方式。
 */
function sanitizeFontFamilyName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!stripped) {
    return { ok: false, reason: '请输入字体名称' };
  }
  // 拒绝明显 CSS/标记注入，避免写入 --font-* 栈时破坏声明
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

/**
 * 字体：每项一行（settings-list-row）；展开列表含内置 + 本机；扫描为行内图标。
 * 成功静默；失败 toast（含「失败」关键字以符合 toast 策略）。
 * 扫描结果与校验提示走行内 meta，禁止成功 toast 刷屏。
 */
export const FontSettingsSection: React.FC<Props> = ({ onShowToast, onPersistSettings }) => {
  const [prefs, setPrefs] = useState<FontPreferences>(() => {
    try {
      return readStoredFonts();
    } catch {
      return { ...DEFAULT_FONT_PREFS };
    }
  });
  const [localFonts, setLocalFonts] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanHint, setScanHint] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /** 自定义输入目标：ui | mono */
  const [customTarget, setCustomTarget] = useState<'ui' | 'mono'>('ui');

  useEffect(() => {
    try {
      setPrefs(readStoredFonts());
    } catch {
      setPrefs({ ...DEFAULT_FONT_PREFS });
    }
    // 不在挂载时扫描，避免多余工作；用户点扫描图标再列本机字体
  }, []);

  const apply = useCallback(
    async (partial: Partial<FontPreferences>) => {
      // 与当前一致则跳过，减少 DOM / 持久化抖动
      if (prefsEqual(prefs, partial)) return;
      setBusy(true);
      try {
        const next = await setFontPreferences(partial);
        setPrefs(next);
        // 立即生效（DOM CSS 变量已在 setFontPreferences 内 apply）
        if (onPersistSettings) {
          try {
            await onPersistSettings(next);
          } catch {
            // 父级 save 已 toast「保存失败」；本地字体栈仍已生效，避免重复 toast
            return;
          }
        }
        // 成功静默
      } catch (e) {
        onShowToast?.(`字体应用失败：${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [onPersistSettings, onShowToast, prefs],
  );

  const scanLocal = useCallback(async () => {
    setScanning(true);
    setScanHint(null);
    try {
      const list = await listLocalFonts();
      const names = list.map((f) => f.family);
      setLocalFonts(names);
      // 空列表 / 成功列表：行内提示即可（禁止 toast 成功/提示类）
      if (!names.length) {
        setScanHint('未扫描到本机字体');
      } else {
        setScanHint(`已列出 ${names.length} 个本机字体`);
      }
    } catch (e) {
      setScanHint(null);
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
  const atDefault = isDefaultPrefs(prefs);

  const applyCustom = (target: 'ui' | 'mono') => {
    const parsed = sanitizeFontFamilyName(customDraft);
    if (parsed.ok === false) {
      // 校验失败：行内提示 + 必要 toast（策略允许「请输入…」类）；禁止伪成功
      const reason = parsed.reason;
      setScanHint(reason);
      if (reason === '请输入字体名称' || reason.includes('非法')) {
        onShowToast?.(reason);
      }
      return;
    }
    const name = parsed.name;
    const choice = toLocalChoice(name);
    if (target === 'ui') {
      if (prefs.uiFont === choice) {
        setScanHint(`界面字体已是「${name}」`);
        setCustomDraft('');
        return;
      }
      setCustomDraft('');
      // 行内反馈在 apply 成功路径外先给预期；失败由 apply toast「字体应用失败」
      setScanHint(`已应用本机字体「${name}」`);
      void apply({ uiFont: choice });
      return;
    }
    if (prefs.monoFont === choice) {
      setScanHint(`代码字体已是「${name}」`);
      setCustomDraft('');
      return;
    }
    setCustomDraft('');
    setScanHint(`已应用本机字体「${name}」`);
    void apply({ monoFont: choice });
  };

  const renderScanBtn = (scope: 'ui' | 'mono') => (
    <button
      type="button"
      className="settings-select-icon-btn"
      title={scanning ? '扫描中…' : '扫描本机字体'}
      aria-label={
        scanning
          ? '正在扫描本机字体'
          : scope === 'ui'
            ? '扫描本机界面字体'
            : '扫描本机代码字体'
      }
      aria-busy={scanning || undefined}
      disabled={busy || scanning}
      onClick={(e) => {
        e.stopPropagation();
        void scanLocal();
      }}
    >
      {scanning ? <Lucide.Loader2 size={14} className="spin" aria-hidden /> : <Lucide.HardDrive size={14} aria-hidden />}
    </button>
  );

  const customFooter = (target: 'ui' | 'mono') => (
    <div className="settings-select-custom">
      <input
        className="settings-select-custom-input"
        placeholder="输入本机字体名后回车"
        value={customTarget === target ? customDraft : ''}
        disabled={busy}
        maxLength={FONT_NAME_MAX + 8}
        aria-label={target === 'ui' ? '自定义界面字体名称' : '自定义代码字体名称'}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setCustomTarget(target)}
        onChange={(e) => {
          setCustomTarget(target);
          // 输入阶段轻度钳制，防止粘贴超长垃圾
          const v = e.target.value;
          setCustomDraft(v.length > FONT_NAME_MAX + 8 ? v.slice(0, FONT_NAME_MAX + 8) : v);
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

  let previewMeta = '';
  try {
    previewMeta = `${platformLabel()} · ${describeActiveUi(prefs)} / ${describeActiveMono(prefs)}`;
  } catch {
    previewMeta = '字体预览暂不可用';
  }

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

  const metaText = scanHint || previewMeta;

  return (
    <>
      <div className="settings-list-row settings-list-row--single settings-font-row" title="界面正文字体">
        <div className="settings-list-copy">
          <div className="settings-list-title" id="settings-font-ui-label">
            界面字体
          </div>
        </div>
        <div className="settings-list-control settings-font-control">
          <SettingsSelect
            value={uiValue || 'auto'}
            options={uiOptions}
            disabled={busy}
            onChange={(v) => {
              if ((v as UiFontChoice) === uiValue) return;
              void apply({ uiFont: v as UiFontChoice });
            }}
            valuePreviewFamily={uiPreviewFamily}
            trailing={renderScanBtn('ui')}
            footer={customFooter('ui')}
            maxHeight={320}
          />
        </div>
      </div>

      <div className="settings-list-row settings-list-row--single settings-font-row" title="代码与等宽字体">
        <div className="settings-list-copy">
          <div className="settings-list-title" id="settings-font-mono-label">
            代码字体
          </div>
        </div>
        <div className="settings-list-control settings-font-control">
          <label className="settings-row-check" title="启用代码连字（liga / calt）">
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
            <span>连字</span>
          </label>
          <SettingsSelect
            value={monoValue || 'auto'}
            options={monoOptions}
            disabled={busy}
            onChange={(v) => {
              if ((v as MonoFontChoice) === monoValue) return;
              void apply({ monoFont: v as MonoFontChoice });
            }}
            valuePreviewFamily={monoPreviewFamily}
            trailing={renderScanBtn('mono')}
            footer={customFooter('mono')}
            maxHeight={320}
          />
          <button
            type="button"
            className="settings-row-text-btn"
            disabled={busy || atDefault}
            title={atDefault ? '已是默认字体' : '恢复默认字体（自动 + 关闭连字）'}
            aria-label="恢复默认字体"
            onClick={() => {
              if (atDefault) return;
              void apply({ ...DEFAULT_FONT_PREFS });
              setScanHint('已恢复默认字体');
            }}
          >
            默认
          </button>
        </div>
      </div>

      <div
        className="settings-list-row settings-list-row--single settings-font-row settings-font-row--preview"
        aria-label="字体预览"
      >
        <div className="settings-list-copy">
          <span
            className="settings-row-meta"
            title={previewMeta}
            role="status"
            aria-live="polite"
          >
            {metaText}
          </span>
        </div>
        <div className="settings-list-control settings-row-preview-text" aria-hidden={false}>
          <span style={{ fontFamily: 'var(--font-sans)' }} title="界面字体预览">
            Ag 中文
          </span>
          <span className="font-preview-sep" aria-hidden>
            ·
          </span>
          <span style={{ fontFamily: 'var(--font-mono)' }} title="代码字体预览">
            {'const x = 1'}
          </span>
        </div>
      </div>
    </>
  );
};
