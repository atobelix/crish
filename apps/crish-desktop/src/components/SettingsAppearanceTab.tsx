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
  SKIN_PRESETS,
} from '../api/themeStore';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  Tooltip,
} from './settings/SettingsUI';
import { SettingsSchemaRenderer } from './settings/SettingsSchemaRenderer';
import type { SchemaSection } from './settings/SettingsSchemaRenderer';

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

const skinPresets = Object.entries(SKIN_PRESETS).map(([id, config]) => ({
  id,
  name: config.name,
  preview: config.bgPrimary,
}));

const appearanceSchema: SchemaSection[] = [
  {
    title: '主题与外观',
    properties: [
      { key: 'theme', type: 'toggle-group', title: '主题模式', desc: '切换浅色/深色主题', toggleOptions: [{ value: 'default', label: '浅色' }, { value: 'dark', label: '深色' }] },
      { key: 'uiSize', type: 'toggle-group', title: 'UI 密度', desc: '控制界面元素的紧凑程度', toggleOptions: [{ value: 'small', label: '紧凑' }, { value: 'medium', label: '默认' }, { value: 'large', label: '宽松' }] },
      { key: 'shellChrome', type: 'select', title: '窗口风格', desc: '选择应用窗口的边框样式', options: [{ value: 'classic', label: '经典' }, { value: 'inset', label: '工作台' }] },
      { key: 'codeIndent', type: 'select', title: '代码缩进', desc: '设置代码块中的缩进宽度', options: [{ value: '  ', label: '2 空格' }, { value: '    ', label: '4 空格' }, { value: '\t', label: 'Tab' }] },
    ],
  },
  {
    title: '颜色与皮肤',
    properties: [
      { key: 'skinPreset', type: 'preset-grid', title: '皮肤预设', desc: '快速切换配色方案', presets: skinPresets },
      { key: 'accentColor', type: 'color', title: '自定义颜色', desc: '自定义界面强调颜色' },
      { key: 'brightness', type: 'range', title: '亮度微调', desc: '调整界面整体亮度', min: -5, max: 4, step: 1, showValue: true },
      { key: 'fontSize', type: 'range', title: '界面字号', desc: '调整界面基础字号', min: 12, max: 18, step: 1, unit: 'px', showValue: true },
    ],
  },
  {
    title: '高级',
    properties: [
      { key: 'transitionEnabled', type: 'boolean', title: '智能时光温感过渡', desc: '根据当地日出日落时间，自动调节亮度与色温' },
      { key: 'vibrantMode', type: 'boolean', title: '氛围色彩融合', desc: '调暗时融入暗影，调亮时融入奶霜高光，避免偏灰偏脏' },
    ],
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

  const allValues = React.useMemo<Record<string, any>>(() => {
    if (!settings) return {};
    return {
      theme: normalizeTheme(settings.theme),
      uiSize: normalizeUiSize(uiSize),
      shellChrome: parseShellChromeMode(shellChromeMode),
      codeIndent: normalizeCodeIndent(settings.markdown?.codeBlockIndent),
      skinPreset: personalization.skin,
      accentColor: personalization.customBg,
      brightness: personalization.themeBrightnessAdjust ?? 0,
      fontSize: 14 + (personalization.fontSizeAdjust ?? 0),
      transitionEnabled: personalization.themeAutoTimeTransition ?? false,
      vibrantMode: personalization.themeBrightnessVibrant ?? false,
    };
  }, [settings, uiSize, shellChromeMode, personalization]);

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

  const handleSave = (updates: Record<string, any>) => {
    if ('theme' in updates) void save({ theme: String(updates.theme) });
    if ('uiSize' in updates) applyDensity(updates.uiSize as UiSize);
    if ('shellChrome' in updates) applyChrome(updates.shellChrome as ShellChromeMode);
    if ('codeIndent' in updates && settings) {
      const next = normalizeCodeIndent(updates.codeIndent);
      if (next !== normalizeCodeIndent(settings.markdown?.codeBlockIndent)) {
        void save({ markdown: { ...(settings.markdown || {}), codeBlockIndent: next } });
      }
    }
    if ('skinPreset' in updates) updatePersonalization({ skin: updates.skinPreset });
    if ('accentColor' in updates) updatePersonalization({ customBg: updates.accentColor });
    if ('brightness' in updates) updatePersonalization({ themeBrightnessAdjust: updates.brightness as number });
    if ('fontSize' in updates) updatePersonalization({ fontSizeAdjust: (updates.fontSize as number) - 14 });
    if ('transitionEnabled' in updates) updatePersonalization({ themeAutoTimeTransition: updates.transitionEnabled as boolean });
    if ('vibrantMode' in updates) updatePersonalization({ themeBrightnessVibrant: updates.vibrantMode as boolean });
  };

  return (
    <SettingsPage title="外观">
        <SettingsSchemaRenderer
          schema={appearanceSchema}
          values={allValues}
          onSave={handleSave}
          ready={!saving}
        />

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
