/**
 * 设置 · 外观：状态与副作用逻辑（从 SettingsAppearanceTab 提取）。
 * 封装 4 个 api（clientApi / themeStore / projectStore / hydrateWorkspaceShell）
 * 与 2 个 store 模块（storeAccess.useSettingsField / useLayoutStore）访问，
 * 组件仅渲染。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Settings } from '../../api/clientApi';
import { clientApi } from '../../api/clientApi';
import { getWorkspacePath } from '../../api/projectStore';
import { useSettingsField, useLayoutStore } from '../../store/storeAccess';
import {
  DEFAULT_SHELL_CHROME,
  parseShellChromeMode,
  type ShellChromeMode,
} from '../../api/shellChrome';
import {
  readStoredTheme,
  readStoredPersonalization,
  writeStoredPersonalization,
  applyPersonalization,
  type PersonalizationSettings,
} from '../../api/themeStore';
import { useIsVisible } from '../../hooks/useIsVisible';
import {
  readRestoreLastWorkspace,
  setRestoreLastWorkspace,
} from '../../app/hydrateWorkspaceShell';
import type { SchemaSection } from './SettingsSchemaRenderer';
import { toast } from '../../services/toast/ToastContext';
import { useSkinSettings } from './useSkinSettings';
import { useAppearanceSchema } from './useAppearanceSchema';

export type UiSize = 'small' | 'medium' | 'large';
export type ThemeId = 'default' | 'dark';

const DEFAULT_PERSONALIZATION: PersonalizationSettings = {
  skin: 'warm-gray',
  customBg: '#f4f3f0',
  customFg: '#1a1a1a',
  fontSizeAdjust: 0,
  themeBrightnessAdjust: 0,
  themeBrightnessVibrant: false,
  themeAutoTimeTransition: false,
};

function mergeSettings(
  current: Settings,
  updates: Partial<Settings>
): Settings {
  return {
    ...current,
    ...updates,
    markdown: updates.markdown
      ? { ...(current.markdown || {}), ...updates.markdown }
      : current.markdown,
    fonts: updates.fonts
      ? { ...(current.fonts || {}), ...updates.fonts }
      : current.fonts,
  };
}

function readDomTheme(): ThemeId | null {
  if (typeof document === 'undefined') return null;
  const raw = document.documentElement.getAttribute('data-theme');
  if (raw === 'dark' || raw === 'default') return raw;
  return null;
}

/** 非法值回落标准 */
export function normalizeUiSize(raw: unknown): UiSize {
  if (raw === 'small' || raw === 'large' || raw === 'medium') return raw;
  return 'medium';
}

export function normalizeTheme(raw: unknown): ThemeId {
  return raw === 'dark' ? 'dark' : 'default';
}

/** 代码缩进：仅白名单，防异常 settings 写出非法缩进 */
export function normalizeCodeIndent(raw: unknown): string {
  if (raw === '  ' || raw === '    ' || raw === '\t') return raw;
  return '  ';
}

export interface AppearanceSettingsResult {
  visibilityRef: React.RefObject<HTMLDivElement | null>;
  settings: Settings | null;
  loadError: string | null;
  saving: boolean;
  loadTick: number;
  setLoadError: (v: string | null) => void;
  setLoadTick: React.Dispatch<React.SetStateAction<number>>;
  activeTheme: ThemeId;
  personalization: PersonalizationSettings;
  uiSize: UiSize;
  shellChromeMode: ShellChromeMode;
  skinOptions: { value: string; label: string }[];
  allValues: Record<string, unknown>;
  appearanceSchema: SchemaSection[];
  save: (updates: Partial<Settings>) => Promise<boolean>;
  applyDensity: (size: UiSize) => void;
  applyChrome: (mode: ShellChromeMode) => void;
  updatePersonalization: (
    updates: Partial<PersonalizationSettings>
  ) => void;
  handleSave: (updates: Record<string, unknown>) => void;
  resetAppearance: () => Promise<void>;
}

export function useAppearanceSettings(): AppearanceSettingsResult {
  const cwd = getWorkspacePath() || '__global__';
  const setAppSettings = useSettingsField((s) => s.setAppSettings);
  const [activeTheme, setActiveTheme] = useState<ThemeId>(() =>
    readStoredTheme()
  );
  const [personalization, setPersonalization] =
    useState<PersonalizationSettings>(() => readStoredPersonalization());
  const [visibilityRef] = useIsVisible();

  // 同步黑夜白天主题的变化
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvt = e as CustomEvent<{ theme: ThemeId }>;
      if (customEvt?.detail?.theme) {
        setActiveTheme(customEvt.detail.theme);
      }
    };
    window.addEventListener('crish-theme-changed', handler);
    return () => {
      window.removeEventListener('crish-theme-changed', handler);
    };
  }, []);

  const updatePersonalization = useCallback(
    (updates: Partial<PersonalizationSettings>) => {
      setPersonalization((prev) => {
        const next = { ...prev, ...updates };
        writeStoredPersonalization(next);
        return next;
      });
      const domTheme = readDomTheme();
      if (domTheme) setActiveTheme(domTheme);
    },
    []
  );

  const { skinOptions } = useSkinSettings({
    activeTheme,
    personalization,
    updatePersonalization,
  });

  const uiSize = useLayoutStore((s) => s.uiSize) as UiSize;
  const setUiSize = useLayoutStore((s) => s.setUiSize);
  const shellChromeMode = useLayoutStore((s) => s.shellChromeMode) as ShellChromeMode;
  const setShellChromeMode = useLayoutStore((s) => s.setShellChromeMode);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadTick, setLoadTick] = useState(0);
  const [restoreLastWorkspace, setRestoreLastWorkspaceState] = useState(() =>
    readRestoreLastWorkspace()
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sets = await clientApi.getSettingsEx(cwd);
        if (cancelled || !sets) return;
        // 读盘后尊重当前已生效的真实主题（若磁盘配置陈旧，先以当前主题修复，杜绝陈旧默认值反向触发投影循环）
        const currentActiveTheme = readDomTheme() || readStoredTheme();
        if (currentActiveTheme && sets.theme !== currentActiveTheme) {
          sets.theme = currentActiveTheme;
          void clientApi.saveSettingsEx(cwd, 'global', {
            theme: currentActiveTheme,
          });
        }
        setSettings(sets);
        setLoadError(null);
        setAppSettings(sets);
        if (currentActiveTheme && !cancelled) {
          setActiveTheme(currentActiveTheme);
        }
        if (sets.fonts) {
          try {
            const { applyFontStacks, ensureFontsLoaded, normalizeFontPrefs } =
              await import('../../api/fontStore');
            const prefs = normalizeFontPrefs(sets.fonts);
            await ensureFontsLoaded(prefs);
            applyFontStacks(prefs);
          } catch (fontErr) {
            if (!cancelled) {
              toast.show('字体应用失败：' + String(fontErr));
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          const msg = '读取失败：' + String(err);
          setLoadError(msg);
          toast.show(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, loadTick, setAppSettings]);

  /** @returns 是否写入成功；失败已 toast，不抛给点击处理器 */
  const save = useCallback(
    async (updates: Partial<Settings>): Promise<boolean> => {
      if (!settings) return false;
      const previous = settings;
      const optimistic = mergeSettings(settings, updates);
      setSettings(optimistic);
      setAppSettings(optimistic);
      try {
        const merged = await clientApi.saveSettingsEx(cwd, 'global', updates);
        setSettings(merged);
        setAppSettings(merged);
        // D3：主题不再直调 setTheme——setAppSettings 写入 settingsStore 后，
        // themeProjection 订阅投影自动完成 DOM + crish_theme 缓存同步（单一写端）。
        if (updates.fonts) {
          const { setFontPreferences, normalizeFontPrefs } =
            await import('../../api/fontStore');
          await setFontPreferences(normalizeFontPrefs(updates.fonts));
        }
        return true;
      } catch (err) {
        setSettings(previous);
        setAppSettings(previous);
        toast.show('保存失败：' + String(err));
        return false;
      }
    },
    [cwd, setAppSettings, settings]
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
        toast.show('密度保存失败：' + String(err));
      }
    },
    [setUiSize, uiSize]
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
        toast.show('界面形态保存失败：' + String(err));
      }
    },
    [setShellChromeMode, shellChromeMode]
  );

  const allValues = useMemo<Record<string, unknown>>(() => {
    if (!settings) return {};
    return {
      theme: activeTheme,
      uiSize: normalizeUiSize(uiSize),
      shellChrome: parseShellChromeMode(shellChromeMode),
      codeIndent: normalizeCodeIndent(settings.markdown?.codeBlockIndent),
      skinPreset: personalization.skin,
      accentColor: personalization.customBg,
      customFgColor: personalization.customFg,
      brightness: personalization.themeBrightnessAdjust ?? 0,
      fontSize: 14 + (personalization.fontSizeAdjust ?? 0),
      transitionEnabled: personalization.themeAutoTimeTransition ?? false,
      vibrantMode: personalization.themeBrightnessVibrant ?? false,
      restoreLastWorkspace,
    };
  }, [settings, uiSize, shellChromeMode, personalization, restoreLastWorkspace, activeTheme]);

  const appearanceSchema = useAppearanceSchema({
    activeTheme,
    skinOptions,
    skinPreset: allValues.skinPreset as string,
  });

  const handleSave = useCallback(
    (updates: Record<string, unknown>) => {
      if ('theme' in updates) {
        if (personalization.themeAutoTimeTransition) {
          updatePersonalization({ themeAutoTimeTransition: false });
        }
        void save({ theme: String(updates.theme) });
      }
      if ('uiSize' in updates) applyDensity(updates.uiSize as UiSize);
      if ('shellChrome' in updates)
        applyChrome(updates.shellChrome as ShellChromeMode);
      if ('codeIndent' in updates && settings) {
        const next = normalizeCodeIndent(updates.codeIndent);
        if (next !== normalizeCodeIndent(settings.markdown?.codeBlockIndent)) {
          void save({
            markdown: { ...(settings.markdown || {}), codeBlockIndent: next },
          });
        }
      }
      if ('skinPreset' in updates)
        updatePersonalization({ skin: updates.skinPreset as string });
      if ('accentColor' in updates)
        updatePersonalization({ customBg: updates.accentColor as string });
      if ('customFgColor' in updates)
        updatePersonalization({ customFg: updates.customFgColor as string });
      if ('brightness' in updates)
        updatePersonalization({
          themeBrightnessAdjust: updates.brightness as number,
        });
      if ('fontSize' in updates)
        updatePersonalization({
          fontSizeAdjust: (updates.fontSize as number) - 14,
        });
      if ('transitionEnabled' in updates)
        updatePersonalization({
          themeAutoTimeTransition: updates.transitionEnabled as boolean,
        });
      if ('vibrantMode' in updates)
        updatePersonalization({
          themeBrightnessVibrant: updates.vibrantMode as boolean,
        });
      if ('restoreLastWorkspace' in updates) {
        const next = Boolean(updates.restoreLastWorkspace);
        setRestoreLastWorkspaceState(next);
        setRestoreLastWorkspace(next);
      }
    },
    [
      save,
      applyDensity,
      applyChrome,
      settings,
      updatePersonalization,
      personalization.themeAutoTimeTransition,
    ]
  );

  const resetAppearance = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const { DEFAULT_FONT_PREFS, setFontPreferences } =
        await import('../../api/fontStore');
      updatePersonalization({ ...DEFAULT_PERSONALIZATION });
      applyDensity('medium');
      applyChrome(DEFAULT_SHELL_CHROME);
      const ok = await save({
        theme: 'default',
        markdown: {
          ...(settings.markdown || {}),
          codeBlockIndent: '  ',
        },
        fonts: { ...DEFAULT_FONT_PREFS },
      });
      if (!ok) return;
      await setFontPreferences({ ...DEFAULT_FONT_PREFS });
    } catch (err) {
      toast.show('重置失败：' + String(err));
    } finally {
      setSaving(false);
    }
  }, [settings, save, updatePersonalization, applyDensity, applyChrome]);

  return {
    visibilityRef,
    settings,
    loadError,
    saving,
    loadTick,
    setLoadError,
    setLoadTick,
    activeTheme,
    personalization,
    uiSize,
    shellChromeMode,
    skinOptions,
    allValues,
    appearanceSchema,
    save,
    applyDensity,
    applyChrome,
    updatePersonalization,
    handleSave,
    resetAppearance,
  };
}
