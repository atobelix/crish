import { useEffect, useState } from 'react';
import { preferencesClient } from '../api/preferences/preferencesClient';
import {
  normalizeTheme,
  persistTheme,
  writeStoredPersonalization,
  type PersonalizationSettings,
  type UiTheme,
} from '../api/themeStore';
import {
  normalizeFontPrefs,
  persistFonts,
  applyFontStacks,
  ensureFontsLoaded,
  type FontPreferences,
} from '../api/fontStore';
import { TokenRuntimeController } from '../services/TokenRuntimeController';
import { useLayoutStore } from '../store/layoutStore';
import { logger, toErrMeta } from '../services/LoggerService';

export interface UsePreferencesHydrationResult {
  isHydrated: boolean;
  error: Error | null;
}

/**
 * 启动首帧偏好水合钩子 (SSOT N5/N6)
 *
 * 挂载时从 preferencesClient.getAllPreferences() 一次性精准拉取权威偏好数据，
 * 同步灌入 themeStore, fontStore, layoutStore 并委托 TokenRuntimeController
 * 注入 CSS 变量与外观 Token，确保首屏无闪烁与状态一致。
 */
export function usePreferencesHydration(): UsePreferencesHydrationResult {
  const [isHydrated, setIsHydrated] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;

    async function hydrate() {
      try {
        const allPrefs = await preferencesClient.getAllPreferences();
        if (!mounted) return;

        // 1. 同步 themeStore
        const theme: UiTheme = normalizeTheme(allPrefs.theme);
        const personalization: PersonalizationSettings = {
          skin: allPrefs.theme_skin || 'warm-gray',
          customBg: allPrefs.theme_custom_bg || '',
          customFg: allPrefs.theme_custom_fg || '',
          fontSizeAdjust:
            typeof allPrefs.font_size_adjust === 'number'
              ? allPrefs.font_size_adjust
              : 0,
          themeBrightnessAdjust:
            typeof allPrefs.theme_brightness_adjust === 'number'
              ? allPrefs.theme_brightness_adjust
              : 0,
          themeBrightnessVibrant: Boolean(allPrefs.theme_brightness_vibrant),
          themeAutoTimeTransition: Boolean(allPrefs.theme_brightness_auto_time),
        };

        persistTheme(theme);
        writeStoredPersonalization(personalization);

        // 2. 注入 Token 确保首屏无闪烁
        TokenRuntimeController.getInstance().applyTokens(personalization, theme);

        if (allPrefs.ui_size) {
          TokenRuntimeController.getInstance().setUiScale(allPrefs.ui_size);
        }

        if (typeof window !== 'undefined') {
          try {
            window.dispatchEvent(
              new CustomEvent('crish-theme-changed', { detail: { theme } })
            );
          } catch {
            /* swallow-ok: 极端环境下事件派发失败不影响 Token 注入 */
          }
        }

        // 3. 同步 fontStore
        if (allPrefs.fonts) {
          const fontPrefs: FontPreferences = normalizeFontPrefs(allPrefs.fonts);
          persistFonts(fontPrefs);
          applyFontStacks(fontPrefs);
          void ensureFontsLoaded(fontPrefs).then(() => {
            if (mounted) {
              applyFontStacks(fontPrefs);
            }
          });
          if (typeof window !== 'undefined') {
            try {
              window.dispatchEvent(
                new CustomEvent('crish-fonts-changed', { detail: fontPrefs })
              );
            } catch {
              /* swallow-ok: 字体变更通知失败不阻断水合流程 */
            }
          }
        }

        // 4. 同步 layoutStore 布局偏好
        try {
          const layout = useLayoutStore.getState();
          if (
            typeof allPrefs.sidebar_collapsed === 'boolean' &&
            layout.sidebarCollapsed !== allPrefs.sidebar_collapsed
          ) {
            layout.setSidebarCollapsed(allPrefs.sidebar_collapsed);
          }
          if (
            typeof allPrefs.tab_mode_enabled === 'boolean' &&
            layout.tabModeEnabled !== allPrefs.tab_mode_enabled
          ) {
            layout.setTabModeEnabled(allPrefs.tab_mode_enabled);
          }
        } catch {
          /* swallow-ok: 布局状态同步异常不阻断全局偏好水合 */
        }

        if (mounted) {
          setIsHydrated(true);
        }
      } catch (err) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        logger.warn('[usePreferencesHydration] 首帧偏好水合异常，保留现有兜底状态', {
          module: 'preferencesHydration',
          err: toErrMeta(errObj),
        });
        if (mounted) {
          setError(errObj);
          // 容错处理：记录错误并解除挂起，避免 UI 永久处于未水合阻塞态
          setIsHydrated(true);
        }
      }
    }

    void hydrate();

    return () => {
      mounted = false;
    };
  }, []);

  return { isHydrated, error };
}
