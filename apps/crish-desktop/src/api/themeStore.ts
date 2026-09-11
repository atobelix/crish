import { TokenRuntimeController } from '../services/TokenRuntimeController';
import { preferencesClient } from './preferences/preferencesClient';
import { withThemeTransitionFreeze } from './themeTransitionLatch';
import type { PersonalizationSettings, UiTheme } from './themeTypes';

/**
 * 外观主题：应用 DOM 变量与后端偏好持久化。
 * 全面物理切除 localStorage 孤岛，统一使用 preferencesClient 与后端 SQLite 交互。
 * 运行时 CSS Token 注入统一委托给 TokenRuntimeController.getInstance().applyTokens。
 */

// re-export 类型与皮肤预设，保持消费方 import 路径不变
export type { UiTheme, PersonalizationSettings } from './themeTypes';
export { SKIN_PRESETS, type SkinPreset } from './themePresets';
export { withThemeTransitionFreeze } from './themeTransitionLatch';

const DEFAULT_PERSONALIZATION: PersonalizationSettings = {
  skin: 'warm-gray',
  customBg: '#f4f3f0',
  customFg: '#1a1a1a',
  fontSizeAdjust: 0,
  themeBrightnessAdjust: 0,
  themeBrightnessVibrant: false,
  themeAutoTimeTransition: false,
};

let currentTheme: UiTheme = 'default';
let currentPersonalization: PersonalizationSettings = { ...DEFAULT_PERSONALIZATION };

/**
 * 规范化主题标识符
 */
export function normalizeTheme(raw: unknown): UiTheme {
  if (raw === 'dark') return 'dark';
  return 'default';
}

/**
 * 读取当前生效的主题（内存单真源）
 */
export function readStoredTheme(): UiTheme {
  return currentTheme;
}

/**
 * 读取当前生效的个性化配置快照
 */
export function readStoredPersonalization(): PersonalizationSettings {
  return { ...currentPersonalization };
}

/**
 * 重置主题内存状态（主要用于单元测试隔离）
 */
export function resetThemeStore(): void {
  currentTheme = 'default';
  currentPersonalization = { ...DEFAULT_PERSONALIZATION };
}

/**
 * 持久化主题到后端 SQLite（无 localStorage 写入）
 */
export function persistTheme(theme: UiTheme): void {
  const t = normalizeTheme(theme);
  currentTheme = t;
  try {
    void preferencesClient.setPreference('theme', t).catch(() => {
      /* swallow-ok: 偏好异步持久化失败回退内存态 */
    });
  } catch {
    /* swallow-ok: 偏好异步持久化失败回退内存态 */
  }
}

/**
 * 统一委托至 TokenRuntimeController.getInstance().applyTokens 应用主题
 */
export function applyTheme(theme: UiTheme | string): UiTheme {
  return withThemeTransitionFreeze(() => {
    const t = normalizeTheme(theme);
    currentTheme = t;
    try {
      TokenRuntimeController.getInstance().applyTokens(
        currentPersonalization,
        currentTheme
      );
    } catch {
      /* swallow-ok: early boot 或 SSR 环境无 DOM 时跳过个性化应用 */
    }
    return t;
  });
}

/**
 * 个性化应用逻辑：委托至 TokenRuntimeController 注入
 */
export function applyPersonalization(
  p: PersonalizationSettings,
  activeTheme: UiTheme | string
): void {
  const t = normalizeTheme(activeTheme);
  currentPersonalization = { ...p };
  currentTheme = t;
  TokenRuntimeController.getInstance().applyTokens(
    currentPersonalization,
    currentTheme
  );
}

/**
 * 切换皮肤预设并异步持久化到后端 SQLite
 */
export function setSkin(skin: string): string {
  currentPersonalization = {
    ...currentPersonalization,
    skin,
  };
  TokenRuntimeController.getInstance().applyTokens(
    currentPersonalization,
    currentTheme
  );

  try {
    void preferencesClient.setPreference('theme_skin', skin).catch(() => {
      /* swallow-ok: 偏好异步持久化失败保持内存态 */
    });
  } catch {
    /* swallow-ok: 偏好异步持久化失败保持内存态 */
  }

  return skin;
}

/**
 * 写入个性化设置，自动应用并异步持久化到后端 SQLite
 */
export function setPersonalization(
  updates: Partial<PersonalizationSettings>
): PersonalizationSettings {
  currentPersonalization = {
    ...currentPersonalization,
    ...updates,
  };

  TokenRuntimeController.getInstance().applyTokens(
    currentPersonalization,
    currentTheme
  );

  const safePersist = <K extends Parameters<typeof preferencesClient.setPreference>[0]>(
    key: K,
    val: Parameters<typeof preferencesClient.setPreference>[1]
  ) => {
    try {
      void preferencesClient.setPreference(key, val as any).catch(() => {
        /* swallow-ok: 偏好异步持久化失败保持内存态 */
      });
    } catch {
      /* swallow-ok: 偏好异步持久化失败保持内存态 */
    }
  };

  if (updates.skin !== undefined) {
    safePersist('theme_skin', currentPersonalization.skin);
  }
  if (updates.customBg !== undefined) {
    safePersist('theme_custom_bg', currentPersonalization.customBg);
  }
  if (updates.customFg !== undefined) {
    safePersist('theme_custom_fg', currentPersonalization.customFg);
  }
  if (updates.fontSizeAdjust !== undefined) {
    safePersist('font_size_adjust', currentPersonalization.fontSizeAdjust);
  }
  if (updates.themeBrightnessAdjust !== undefined) {
    safePersist(
      'theme_brightness_adjust',
      currentPersonalization.themeBrightnessAdjust ?? 0
    );
  }
  if (updates.themeBrightnessVibrant !== undefined) {
    safePersist(
      'theme_brightness_vibrant',
      !!currentPersonalization.themeBrightnessVibrant
    );
  }
  if (updates.themeAutoTimeTransition !== undefined) {
    safePersist(
      'theme_brightness_auto_time',
      !!currentPersonalization.themeAutoTimeTransition
    );
  }

  return currentPersonalization;
}

/**
 * 兼容旧版写入接口（内部委托给 setPersonalization）
 */
export function writeStoredPersonalization(p: PersonalizationSettings): void {
  setPersonalization(p);
}

let solarIntervalMounted = false;

/**
 * 读偏好并应用；返回生效主题。
 * 首屏同步应用 Token 杜绝 FOUC，随后异步从后端 SQLite 水合最新偏好。
 */
export function bootstrapTheme(): UiTheme {
  TokenRuntimeController.getInstance().applyTokens(
    currentPersonalization,
    currentTheme
  );

  try {
    void preferencesClient.getAllPreferences().then((prefs) => {
      let changed = false;
      if (
        prefs.theme &&
        (prefs.theme === 'dark' || prefs.theme === 'default') &&
        prefs.theme !== currentTheme
      ) {
        currentTheme = prefs.theme;
        changed = true;
      }

      const newSkin = prefs.theme_skin || currentPersonalization.skin;
      const newCustomBg =
        prefs.theme_custom_bg !== undefined
          ? prefs.theme_custom_bg
          : currentPersonalization.customBg;
      const newCustomFg =
        prefs.theme_custom_fg !== undefined
          ? prefs.theme_custom_fg
          : currentPersonalization.customFg;
      const newFontSize =
        prefs.font_size_adjust !== undefined
          ? prefs.font_size_adjust
          : currentPersonalization.fontSizeAdjust;
      const newBrightness =
        prefs.theme_brightness_adjust !== undefined
          ? prefs.theme_brightness_adjust
          : currentPersonalization.themeBrightnessAdjust;
      const newVibrant =
        prefs.theme_brightness_vibrant !== undefined
          ? prefs.theme_brightness_vibrant
          : currentPersonalization.themeBrightnessVibrant;
      const newAutoTime =
        prefs.theme_brightness_auto_time !== undefined
          ? prefs.theme_brightness_auto_time
          : currentPersonalization.themeAutoTimeTransition;

      if (
        newSkin !== currentPersonalization.skin ||
        newCustomBg !== currentPersonalization.customBg ||
        newCustomFg !== currentPersonalization.customFg ||
        newFontSize !== currentPersonalization.fontSizeAdjust ||
        newBrightness !== currentPersonalization.themeBrightnessAdjust ||
        newVibrant !== currentPersonalization.themeBrightnessVibrant ||
        newAutoTime !== currentPersonalization.themeAutoTimeTransition
      ) {
        currentPersonalization = {
          skin: newSkin,
          customBg: newCustomBg,
          customFg: newCustomFg,
          fontSizeAdjust: newFontSize,
          themeBrightnessAdjust: newBrightness,
          themeBrightnessVibrant: newVibrant,
          themeAutoTimeTransition: newAutoTime,
        };
        changed = true;
      }

      if (changed) {
        TokenRuntimeController.getInstance().applyTokens(
          currentPersonalization,
          currentTheme
        );
      }
    }).catch(() => {
      /* swallow-ok: 后端偏好读取失败时保持当前内存态 */
    });
  } catch {
    /* swallow-ok: 环境不支持异步请求时静默保持 */
  }

  // 开启时光过渡的后台 60 秒轮询 Tick 守护定时器，确保无感平滑自愈
  if (typeof window !== 'undefined' && !solarIntervalMounted) {
    solarIntervalMounted = true;
    setInterval(() => {
      if (currentPersonalization.themeAutoTimeTransition) {
        TokenRuntimeController.getInstance().applyTokens(
          currentPersonalization,
          currentTheme
        );
      }
    }, 60000);
  }

  return currentTheme;
}

/**
 * 切换主题并持久化（单真源写端入口）
 */
export function setTheme(theme: UiTheme | string): UiTheme {
  return withThemeTransitionFreeze(() => {
    const t = normalizeTheme(theme);
    currentTheme = t;
    TokenRuntimeController.getInstance().applyTokens(
      currentPersonalization,
      currentTheme
    );

    try {
      window.dispatchEvent(
        new CustomEvent('crish-theme-changed', { detail: { theme: t } })
      );
    } catch {
      /* swallow-ok: 主题变更事件分发失败不影响已应用样式 */
    }

    // 异步持久化到后端 SQLite
    try {
      void preferencesClient.setPreference('theme', t).catch(() => {
        /* swallow-ok: 异步持久化在非 Tauri 或测试环境中静默忽略 */
      });
    } catch {
      /* swallow-ok: 异步持久化尽力而为 */
    }

    // 异步同步至 settingsStore 与磁盘持久化，保证全局单真源一致，消除旧值覆盖
    try {
      void import('../store/settingsStore').then(({ useSettingsStore }) => {
        const current = useSettingsStore.getState().appSettings;
        if (current && current.theme !== t) {
          useSettingsStore.getState().setAppSettings({ ...current, theme: t });
        }
      });
      void import('./clientApi').then(({ clientApi }) => {
        void clientApi.saveSettingsEx('__global__', 'global', { theme: t });
      });
    } catch {
      /* swallow-ok: 异步持久化尽力而为 */
    }

    return t;
  });
}
