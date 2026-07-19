/**
 * 设置 · 外观：主题、密度、字体与阅读相关选项；改完即生效，仅失败提示。
 */
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { Settings } from '../api/clientApi';
import { clientApi } from '../api/clientApi';
import { getWorkspacePath } from '../api/projectStore';
import { useLayoutStore } from '../store/layoutStore';
import {
  parseShellChromeMode,
  type ShellChromeMode,
} from '../api/shellChrome';
import { FontSettingsSection } from './FontSettingsSection';
import { SettingsSelect } from './SettingsSelect';
import styles from './SettingsAppearanceTab.module.css';
import {
  readStoredTheme,
  readStoredPersonalization,
  writeStoredPersonalization,
  applyPersonalization,
  type PersonalizationSettings,
  getDynamicSolarAdjustments,
} from '../api/themeStore';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  Tooltip,
} from './settings/SettingsUI';

type Props = {
  onShowToast: (msg: string) => void;
};

type UiSize = 'small' | 'medium' | 'large';
type ThemeId = 'default' | 'dark';

/** 密度三档 */
const DENSITY_OPTS: {
  id: UiSize;
  label: string;
  /** 控件 title + 辅助说明 */
  hint: string;
}[] = [
  { id: 'small', label: '紧凑', hint: '更省空间' },
  { id: 'medium', label: '标准', hint: '默认' },
  { id: 'large', label: '宽松', hint: '更易阅读' },
];

const THEME_OPTS: { id: ThemeId; label: string; hint: string }[] = [
  { id: 'default', label: '浅色', hint: '浅色' },
  { id: 'dark', label: '深色', hint: '深色' },
];

const INDENT_OPTS = [
  { value: '  ', label: '2 空格' },
  { value: '    ', label: '4 空格' },
  { value: '\t', label: 'Tab' },
] as const;

const CHROME_OPTS: {
  id: ShellChromeMode;
  label: string;
  hint: string;
}[] = [
  {
    id: 'classic',
    label: '经典',
    hint: '传统布局',
  },
  {
    id: 'inset',
    label: '工作台',
    hint: '推荐布局',
  },
];

/** 非法值回落标准 */
function normalizeUiSize(raw: unknown): UiSize {
  if (raw === 'small' || raw === 'large' || raw === 'medium') return raw;
  return 'medium';
}

function normalizeTheme(raw: unknown): ThemeId {
  return raw === 'dark' ? 'dark' : 'default';
}

/** 代码缩进：仅白名单，防异常 settings 写出非法缩进 */
function normalizeCodeIndent(raw: unknown): string {
  if (raw === '  ' || raw === '    ' || raw === '\t') return raw;
  return '  ';
}

export const SettingsAppearanceTab: React.FC<Props> = ({ onShowToast }) => {
  const cwd = getWorkspacePath() || '__global__';
  const skinLabelId = useId();
  const setAppSettings = useLayoutStore((s) => s.setAppSettings);
  const [activeTheme, setActiveTheme] = useState<'default' | 'dark'>(() => readStoredTheme());
  const [personalization, setPersonalization] = useState<PersonalizationSettings>(() => readStoredPersonalization());

  // 同步黑夜白天主题的变化
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvt = e as CustomEvent<{ theme: 'default' | 'dark' }>;
      if (customEvt?.detail?.theme) {
        setActiveTheme(customEvt.detail.theme);
      }
    };
    window.addEventListener('crish-theme-changed', handler);
    return () => {
      window.removeEventListener('crish-theme-changed', handler);
    };
  }, []);

  const updatePersonalization = (updates: Partial<PersonalizationSettings>) => {
    const next = { ...personalization, ...updates };
    setPersonalization(next);
    writeStoredPersonalization(next);
    applyPersonalization(next, activeTheme);
  };

  const skinOptions = useMemo(() => {
    const list = activeTheme === 'dark'
      ? [
          { value: 'dark-cozy', label: '护眼暗灰' },
          { value: 'deep-night', label: '深邃夜空' },
          { value: 'dark-forest', label: '森林绿影' },
          { value: 'aurora', label: '北欧极光' },
          { value: 'cocoa', label: '可可暗香' },
          { value: 'burgundy', label: '暗红丝绒' },
          { value: 'cyber', label: '赛博星空' },
          { value: 'obsidian', label: '黑曜石墨' },
        ]
      : [
          { value: 'warm-gray', label: '护眼暖灰' },
          { value: 'cream', label: '杏仁奶油' },
          { value: 'paper', label: '极简纸质' },
          { value: 'classic-gray', label: '经典浅灰' },
          { value: 'sakura', label: '落樱微风' },
          { value: 'matcha', label: '抹茶拿铁' },
          { value: 'glacier', label: '冰川薄荷' },
          { value: 'pearl', label: '金沙流光' },
        ];

    list.push({ value: 'custom', label: '自定义颜色' });
    return list;
  }, [activeTheme]);
  const uiSize = useLayoutStore((s) => s.uiSize);
  const setUiSize = useLayoutStore((s) => s.setUiSize);
  const shellChromeMode = useLayoutStore((s) => s.shellChromeMode);
  const setShellChromeMode = useLayoutStore((s) => s.setShellChromeMode);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadTick, setLoadTick] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let interval: any = null;
    if (personalization.themeAutoTimeTransition) {
      interval = setInterval(() => {
        setTick((t) => t + 1);
      }, 10000);
    }
    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [personalization.themeAutoTimeTransition]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sets = await clientApi.getSettingsEx(cwd);
        if (cancelled || !sets) return;
        setSettings(sets);
        setLoadError(null);
        // 读盘后立即同步 DOM（主题 / 字体），与 local 独立 key 对齐
        try {
          if (sets.theme) {
            const { applyTheme, normalizeTheme: normTheme } = await import('../api/themeStore');
            applyTheme(normTheme(sets.theme));
          }
          if (sets.fonts) {
            const { applyFontStacks, ensureFontsLoaded, normalizeFontPrefs } = await import(
              '../api/fontStore'
            );
            const prefs = normalizeFontPrefs(sets.fonts);
            await ensureFontsLoaded(prefs);
            applyFontStacks(prefs);
          }
        } catch (applyErr) {
          if (!cancelled) {
            onShowToast('外观应用失败：' + String(applyErr));
          }
        }
      } catch (err) {
        if (!cancelled) {
          const msg = '读取失败：' + String(err);
          setLoadError(msg);
          onShowToast(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, onShowToast, loadTick]);

  /** @returns 是否写入成功；失败已 toast，不抛给点击处理器 */
  const save = useCallback(
    async (updates: Partial<Settings>): Promise<boolean> => {
      if (!settings) return false;
      setSaving(true);
      try {
        const merged = await clientApi.saveSettingsEx(cwd, 'global', updates);
        setSettings(merged);
        setAppSettings(merged);
        if (updates.theme) {
          const { setTheme } = await import('../api/themeStore');
          setTheme(updates.theme);
        }
        // fonts：FontSettingsSection 已 setFontPreferences；此处仅当其它入口写入 fonts 时补 apply
        if (updates.fonts) {
          const { setFontPreferences, normalizeFontPrefs } = await import('../api/fontStore');
          await setFontPreferences(normalizeFontPrefs(updates.fonts));
        }
        // 成功静默：不 toast「已保存」
        return true;
      } catch (err) {
        onShowToast('保存失败：' + String(err));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [cwd, onShowToast, setAppSettings, settings],
  );

  const applyDensity = useCallback(
    (size: UiSize) => {
      try {
        const next = normalizeUiSize(size);
        // 已是目标档：跳过写 LS / DOM，避免无意义回流
        if (normalizeUiSize(uiSize) === next) {
          const cur = document.documentElement.getAttribute('data-ui-size');
          if (cur !== next) {
            document.documentElement.setAttribute('data-ui-size', next);
          }
          return;
        }
        setUiSize(next);
        document.documentElement.setAttribute('data-ui-size', next);
      } catch (err) {
        onShowToast('密度保存失败：' + String(err));
      }
    },
    [onShowToast, setUiSize, uiSize],
  );

  const applyChrome = useCallback(
    (mode: ShellChromeMode) => {
      try {
        const next = parseShellChromeMode(mode);
        if (parseShellChromeMode(shellChromeMode) === next) {
          document.documentElement.setAttribute('data-shell-chrome', next);
          return;
        }
        setShellChromeMode(next);
        document.documentElement.setAttribute('data-shell-chrome', next);
        document.body.setAttribute('data-shell-chrome', next);
      } catch (err) {
        onShowToast('界面形态保存失败：' + String(err));
      }
    },
    [onShowToast, setShellChromeMode, shellChromeMode],
  );

  const applyTheme = useCallback(
    (id: ThemeId) => {
      if (!settings) return;
      if (normalizeTheme(settings.theme) === id) return;
      void save({ theme: id });
    },
    [save, settings],
  );

  if (loadError && !settings) {
    return (
      <SettingsPage title="外观">
        <SettingsSection title="错误">
          <SettingsCard>
            <SettingsRow
              title={<span className="settings-list-empty" role="alert">{loadError}</span>}
              control={
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() => {
                    setLoadError(null);
                    setLoadTick((n) => n + 1);
                  }}
                >
                  重试
                </button>
              }
            />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  if (!settings) {
    return (
      <SettingsPage title="外观">
        <SettingsSection>
          <SettingsCard>
            <SettingsRow title={<span className="settings-list-empty">加载中…</span>} />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  const theme = normalizeTheme(settings.theme);
  const codeIndent = normalizeCodeIndent(settings.markdown?.codeBlockIndent);
  const density = normalizeUiSize(uiSize);
  const chrome = parseShellChromeMode(shellChromeMode);

  return (
    <SettingsPage title="外观">
        <SettingsSection title="主题与阅读">
          <SettingsCard>
            <SettingsRow
              title={<span id="settings-appearance-theme-label">主题</span>}
              control={
                <div
                  className={styles.settingsChoiceGroup}
                  role="group"
                  aria-labelledby="settings-appearance-theme-label"
                >
                  {THEME_OPTS.map((opt) => (
                    <Tooltip key={opt.id} content={opt.hint}>
                      <button
                        type="button"
                        className={`${styles.segmentItem}${theme === opt.id ? ` ${styles.active}` : ''}`}
                        disabled={saving}
                        aria-pressed={theme === opt.id}
                        onClick={() => applyTheme(opt.id)}
                      >
                        {opt.label}
                      </button>
                    </Tooltip>
                  ))}
                </div>
              }
            />

            <SettingsRow
              title={<span id="settings-appearance-density-label">密度</span>}
              control={
                <div
                  className={`${styles.settingsChoiceGroup} ${styles.settingsDensitySegment}`}
                  role="group"
                  aria-labelledby="settings-appearance-density-label"
                >
                  {DENSITY_OPTS.map((opt) => (
                    <Tooltip key={opt.id} content={opt.hint}>
                      <button
                        type="button"
                        className={`${styles.segmentItem}${density === opt.id ? ` ${styles.active}` : ''}`}
                        disabled={saving}
                        aria-pressed={density === opt.id}
                        onClick={() => applyDensity(opt.id)}
                      >
                        {opt.label}
                      </button>
                    </Tooltip>
                  ))}
                </div>
              }
            />

            <SettingsRow
              title={<span id="settings-appearance-chrome-label">界面形态</span>}
              control={
                <div
                  className={styles.settingsChoiceGroup}
                  role="group"
                  aria-labelledby="settings-appearance-chrome-label"
                >
                  {CHROME_OPTS.map((opt) => (
                    <Tooltip key={opt.id} content={opt.hint}>
                      <button
                        type="button"
                        className={`${styles.segmentItem}${chrome === opt.id ? ` ${styles.active}` : ''}`}
                        disabled={saving}
                        aria-pressed={chrome === opt.id}
                        onClick={() => applyChrome(opt.id)}
                      >
                        {opt.label}
                      </button>
                    </Tooltip>
                  ))}
                </div>
              }
            />

          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="代码排版">
          <SettingsCard>
            <SettingsRow
              title={<span id="settings-appearance-indent-label">代码块缩进</span>}
              desc="配置编辑器与预览中代码块默认的缩进字符数"
              control={
                <SettingsSelect
                  value={codeIndent}
                  disabled={saving}
                  options={[...INDENT_OPTS]}
                  onChange={(v) => {
                    const next = normalizeCodeIndent(v);
                    if (next === codeIndent) return;
                    void save({
                      markdown: { ...(settings.markdown || {}), codeBlockIndent: next },
                    });
                  }}
                />
              }
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="预设皮肤与字号">
          <SettingsCard>
            <SettingsRow
              title={<span id={skinLabelId}>预设配色皮肤</span>}
              desc={activeTheme === 'dark' ? '深色模式下可选的高阶主题预设' : '浅色模式下可选的高阶主题预设'}
              control={
                <SettingsSelect
                  className="settings-personalize-select"
                  value={personalization.skin}
                  options={skinOptions}
                  onChange={(v) => updatePersonalization({ skin: v })}
                  disabled={saving}
                  placeholder="选择预设…"
                />
              }
            />

            {personalization.skin === 'custom' && (
              <>
                <SettingsRow
                  title="自定义背景色"
                  control={
                    <input
                      type="color"
                      value={personalization.customBg}
                      onChange={(e) => updatePersonalization({ customBg: e.target.value })}
                      disabled={saving}
                      className={styles.colorInput}
                    />
                  }
                />
                <SettingsRow
                  title="自定义文本色"
                  desc="自适应计算副文本、边框与悬浮文本色"
                  control={
                    <input
                      type="color"
                      value={personalization.customFg}
                      onChange={(e) => updatePersonalization({ customFg: e.target.value })}
                      disabled={saving}
                      className={styles.colorInput}
                    />
                  }
                />
              </>
            )}

            <SettingsRow
              title="主题亮度微调"
              desc={
                personalization.themeAutoTimeTransition
                  ? `已受智能时光过渡控制：${getDynamicSolarAdjustments().periodLabel}`
                  : (personalization.themeBrightnessAdjust || 0) === 0
                    ? '默认亮度（系统预设的温润中值配比）'
                    : `当前微调: ${(personalization.themeBrightnessAdjust || 0) > 0 ? '更亮' : '更暗'} (${Math.abs(personalization.themeBrightnessAdjust || 0)} 档)`
              }
              control={
                <div className={styles.adjustContainer}>
                  <input
                    type="range"
                    min="-5"
                    max="4"
                    step="1"
                    value={
                      personalization.themeAutoTimeTransition
                        ? getDynamicSolarAdjustments().brightnessAdjust
                        : (personalization.themeBrightnessAdjust || 0)
                    }
                    onChange={(e) => updatePersonalization({ themeBrightnessAdjust: parseInt(e.target.value, 10) })}
                    disabled={saving || Boolean(personalization.themeAutoTimeTransition)}
                    className={styles.adjustSlider}
                    style={{
                      opacity: personalization.themeAutoTimeTransition ? 0.45 : 1,
                      cursor: personalization.themeAutoTimeTransition ? 'not-allowed' : 'pointer',
                    }}
                  />
                  <span className={styles.adjustLabel} style={{ opacity: personalization.themeAutoTimeTransition ? 0.5 : 1 }}>
                    {personalization.themeAutoTimeTransition
                      ? (getDynamicSolarAdjustments().brightnessAdjust > 0 ? '+' : '') + getDynamicSolarAdjustments().brightnessAdjust
                      : ((personalization.themeBrightnessAdjust || 0) > 0 ? '+' : '') + (personalization.themeBrightnessAdjust || 0)
                    }
                  </span>
                </div>
              }
            />

            <SettingsRow
              title="智能时光温感过渡"
              desc="根据当地日出日落时间，自动柔和降低白天对比度与亮度并调温，最终自然过渡到深夜深色模式，极致呵护双眼。"
              control={
                <input
                  id="settings-theme-auto-time"
                  type="checkbox"
                  className="settings-switch settings-switch--appearance"
                  style={{ cursor: 'pointer' }}
                  checked={Boolean(personalization.themeAutoTimeTransition)}
                  disabled={saving}
                  onChange={(e) => {
                    updatePersonalization({ themeAutoTimeTransition: e.target.checked });
                  }}
                />
              }
            />

            <SettingsRow
              title="氛围色彩融合"
              desc="调暗时融入暗影，调亮时融入奶霜高光，避免偏灰偏脏"
              control={
                <input
                  id="settings-theme-brightness-vibrant"
                  type="checkbox"
                  className="settings-switch settings-switch--appearance"
                  style={{ cursor: 'pointer' }}
                  checked={Boolean(personalization.themeBrightnessVibrant)}
                  disabled={saving}
                  onChange={(e) => {
                    updatePersonalization({ themeBrightnessVibrant: e.target.checked });
                  }}
                />
              }
            />

            <SettingsRow
              title="界面字号微调"
              desc={`基准字号为 14px，当前字号: ${14 + personalization.fontSizeAdjust}px`}
              control={
                <div className={styles.adjustContainer}>
                  <input
                    type="range"
                    min="-2"
                    max="4"
                    step="1"
                    value={personalization.fontSizeAdjust}
                    onChange={(e) => updatePersonalization({ fontSizeAdjust: parseInt(e.target.value, 10) })}
                    disabled={saving}
                    className={styles.adjustSlider}
                  />
                  <span className={styles.adjustLabel}>
                    {personalization.fontSizeAdjust >= 0 ? '+' : ''}{personalization.fontSizeAdjust}px
                  </span>
                </div>
              }
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="字体">
          <SettingsCard>
            <FontSettingsSection
              onShowToast={onShowToast}
              onPersistSettings={async (fonts) => {
                const ok = await save({ fonts });
                if (!ok) {
                  throw new Error('字体设置未写入 settings');
                }
              }}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="其他">
          <SettingsCard>
            <SettingsRow
              title="重置外观"
              control={
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  disabled={saving}
                  onClick={() => {
                    void (async () => {
                      try {
                        const { DEFAULT_FONT_PREFS, setFontPreferences } = await import(
                          '../api/fontStore'
                        );
                        const ok = await save({
                          theme: 'default',
                          hideThinkingBlock: false,
                          markdown: { ...(settings.markdown || {}), codeBlockIndent: '  ' },
                          fonts: { ...DEFAULT_FONT_PREFS },
                        });
                        if (!ok) return;
                        const { setTheme } = await import('../api/themeStore');
                        setTheme('default');
                        await setFontPreferences({ ...DEFAULT_FONT_PREFS });
                        applyDensity('medium');
                      } catch (err) {
                        onShowToast('重置失败：' + String(err));
                      }
                    })();
                  }}
                >
                  重置
                </button>
              }
            />
        </SettingsCard>
        </SettingsSection>
    </SettingsPage>
  );
};
