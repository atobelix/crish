/**
 * 运行时 Token 注入控制器 (TokenRuntimeController)
 * 全仓唯一合法的 document.documentElement.style.setProperty 注入权威源。
 * 统一接管原 themeStore.applyTheme、visualThemeController、themePersonalization 与 oklchColorGuard 的 token 注入职责。
 * 明暗判定严格采用纯布尔逻辑 (isDark: boolean)，彻底杜绝依靠字符串比较反推明暗。
 */

import type { PersonalizationSettings, UiTheme } from '../api/themeTypes';
import { SKIN_PRESETS, type SkinPreset } from '../api/themePresets';
import { setTokenRuntimeSetter } from '../api/oklchColorGuard';
import type { UiSize } from '../store/layout-helpers/store-types';
import {
  computeDynamicSolarAdjustments,
  type SolarAdjustmentResult,
} from './token-runtime/solarAdjustments';
import { buildScrollbarTokens } from './token-runtime/scrollbarIcons';
import { deriveSkinPaintPlan } from './token-runtime/skinPaintPlan';
import { injectRootTokens } from './token-runtime/injectRootTokens';

export { computeDynamicSolarAdjustments };
export type { SolarAdjustmentResult };

export type AllowedUiSize = UiSize | 'compact' | 'normal' | 'spacious';

export const UI_SCALE_MAP: Record<AllowedUiSize, string> = {
  small: '0.9',
  medium: '1.0',
  large: '1.1',
  compact: '0.9',
  normal: '1.0',
  spacious: '1.1',
};

export interface TokenApplyResult {
  isDark: boolean;
  theme: UiTheme;
  preferences: PersonalizationSettings;
  tokens: Record<string, string>;
}

export const DEFAULT_PERSONALIZATION: PersonalizationSettings = {
  skin: 'warm-gray',
  customBg: '#f4f3f0',
  customFg: '#1a1a1a',
  fontSizeAdjust: 0,
  themeBrightnessAdjust: 0,
  themeBrightnessVibrant: false,
  themeAutoTimeTransition: false,
};

export class TokenRuntimeController {
  private static instance: TokenRuntimeController | null = null;
  private currentInjectedKeys: Set<string> = new Set();
  private lastAppliedResult: TokenApplyResult | null = null;

  public static getInstance(): TokenRuntimeController {
    if (!TokenRuntimeController.instance) {
      TokenRuntimeController.instance = new TokenRuntimeController();
    }
    return TokenRuntimeController.instance;
  }

  public getLastAppliedResult(): TokenApplyResult | null {
    return this.lastAppliedResult;
  }

  /**
   * 唯一合法的 style.setProperty 调用底层
   */
  public setCustomProperty(name: string, value: string): void {
    if (typeof document === 'undefined') return;
    document.documentElement.style.setProperty(name, value);
    this.currentInjectedKeys.add(name);
  }

  /**
   * 唯一合法的 style.removeProperty 调用底层
   */
  public removeCustomProperty(name: string): void {
    if (typeof document === 'undefined') return;
    document.documentElement.style.removeProperty(name);
    this.currentInjectedKeys.delete(name);
  }

  /**
   * 接管 visualThemeController 的 UI Scale 注入
   */
  public setUiScale(size: AllowedUiSize): void {
    const scale = UI_SCALE_MAP[size] || '1.0';
    this.setCustomProperty('--ui-scale', scale);
  }

  /**
   * 统一接管全仓主题与个性化 Token 的注入
   * 作为全仓唯一合法的 document.documentElement.style.setProperty 调用点
   */
  public applyTokens(
    preferences?: Partial<PersonalizationSettings> | null,
    theme?: UiTheme | string | null
  ): TokenApplyResult {
    const p: PersonalizationSettings = {
      ...DEFAULT_PERSONALIZATION,
      ...(preferences || {}),
    };

    let resolvedTheme: UiTheme = theme === 'dark' ? 'dark' : 'default';
    let adjust = p.themeBrightnessAdjust || 0;
    let solarWarmthMix = 0;

    if (p.themeAutoTimeTransition) {
      const solar = computeDynamicSolarAdjustments();
      adjust = solar.brightnessAdjust;
      solarWarmthMix = solar.solarWarmthMix;
      const now = new Date();
      const currentHour = now.getHours() + now.getMinutes() / 60;
      resolvedTheme = currentHour >= 19 || currentHour < 6 ? 'dark' : 'default';
    }

    const isDark: boolean = resolvedTheme === 'dark';

    let skinKey = p.skin || 'warm-gray';
    let skinConfig: SkinPreset | undefined;

    if (skinKey === 'custom') {
      const bg = p.customBg;
      const fg = p.customFg;
      skinConfig = {
        name: '自定义颜色',
        bgPrimary: bg,
        bgSecondary: isDark
          ? `color-mix(in srgb, ${bg} 82%, hsl(0 0% 100%) 18%)`
          : `color-mix(in srgb, ${bg} 95%, hsl(0 0% 100%) 5%)`,
        bgTertiary: `color-mix(in srgb, ${bg} 90%, ${fg} 10%)`,
        bgCard: isDark
          ? `color-mix(in srgb, ${bg} 95%, hsl(0 0% 100%) 5%)`
          : `color-mix(in srgb, ${bg} 96%, hsl(0 0% 100%) 4%)`,
        bgElevated: isDark
          ? `color-mix(in srgb, ${bg} 82%, hsl(0 0% 100%) 18%)`
          : `color-mix(in srgb, ${bg} 96%, hsl(0 0% 100%) 4%)`,
        shellChromeBg: isDark
          ? `color-mix(in srgb, ${bg} 82%, hsl(0 0% 100%) 18%)`
          : `color-mix(in srgb, ${bg} 88%, hsl(38 8% 70%) 12%)`,
        textPrimary: fg,
        textSecondary: `color-mix(in srgb, ${bg} 22%, ${fg} 78%)`,
        borderColor: `color-mix(in srgb, ${bg} 82%, ${fg} 18%)`,
        borderSubtle: `color-mix(in srgb, ${bg} 92%, ${fg} 8%)`,
      };
    } else {
      const isPresetDark =
        skinKey.startsWith('dark-') ||
        skinKey === 'deep-night' ||
        skinKey === 'dark-forest' ||
        skinKey === 'aurora' ||
        skinKey === 'cocoa' ||
        skinKey === 'burgundy' ||
        skinKey === 'cyber' ||
        skinKey === 'obsidian';

      if (isDark && !isPresetDark) {
        skinKey = 'dark-cozy';
      } else if (!isDark && isPresetDark) {
        skinKey = 'warm-gray';
      }
      skinConfig = SKIN_PRESETS[skinKey] || SKIN_PRESETS['warm-gray'];
    }

    const tokens: Record<string, string> = {};

    tokens['--font-size-adjust'] = `${p.fontSizeAdjust || 0}px`;

    if (skinConfig) {
      const paint = deriveSkinPaintPlan({
        skinConfig,
        skinKey,
        isDark,
        adjust,
        solarWarmthMix,
        vibrant: !!p.themeBrightnessVibrant,
      });

      // 三档底色 SSOT（2026-10-10）：运行时只写三个独立源 —— 外层（侧栏 + 标签栏）/ 主层（聊天区 +
      // 卡片/弹层…）/ 输入框，其余别名链（--surface-chrome/paper/card/elevated/sunken、--bg-tertiary、
      // --shell-chrome-bg、--composer-bg 等）由 tokens.css 静态派生。
      // T-BLK-07b 参数化：独立侧也改为 --user-* 参数名（B 类登记），A 类
      // --surface-*/--text-*/--border-*/--control-mix-color 由 tokens.css
      // var(--user-*, 静态兜底) 派生，JS 不再直写 A 类设计 token。
      tokens['--user-surface-outer'] = paint.bgSecondary;
      tokens['--user-surface-main'] = paint.bgPrimary;
      tokens['--user-surface-input'] = paint.composerBg;
      // T7 别名收敛（2026-09-12）：--bg-primary/--bg-secondary/--bg-card/--bg-elevated/
      // --bg-paper/--bg-workspace/--shell-inset-bg/--terminal-* 不再由 JS 写入，只写独立侧。
      tokens['--user-text-primary'] = paint.finalFg;
      tokens['--user-text-secondary'] = paint.finalSec;
      tokens['--user-text-tertiary'] = paint.finalTert;
      tokens['--user-text-faint'] = paint.finalFaint;
      tokens['--user-border-color'] = paint.borderColor;
      tokens['--user-border-subtle'] = paint.borderSubtle;
      tokens['--user-control-mix-color'] = paint.mixColor;

      // 滚动条主题色与微调按钮 SVG（warm-gray 皮肤走 tokens.css 静态 SSOT，不注入）
      Object.assign(
        tokens,
        buildScrollbarTokens({ skinKey, isDark, finalFg: paint.finalFg })
      );
    }

    if (typeof document !== 'undefined') {
      injectRootTokens({
        tokens,
        resolvedTheme,
        isDark,
        injectedKeys: this.currentInjectedKeys,
      });
    }

    const result: TokenApplyResult = {
      isDark,
      theme: resolvedTheme,
      preferences: p,
      tokens,
    };

    this.lastAppliedResult = result;

    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(
          new CustomEvent('crish-theme-changed', {
            detail: { theme: resolvedTheme, isDark, tokens },
          })
        );
        window.dispatchEvent(
          new CustomEvent('crish-tokens-updated', {
            detail: { theme: resolvedTheme, isDark, tokens },
          })
        );
        window.dispatchEvent(
          new CustomEvent('crish-canvas-recolor', {
            detail: { isDark, tokens },
          })
        );
      } catch {
        // swallow-ok: 事件分发在无 DOM/测试环境失败静默跳过
      }
    }

    return result;
  }
}

export const tokenRuntimeController = TokenRuntimeController.getInstance();

setTokenRuntimeSetter((name, value) => {
  tokenRuntimeController.setCustomProperty(name, value);
});

export function applyTokens(
  preferences?: Partial<PersonalizationSettings> | null,
  theme?: UiTheme | string | null
): TokenApplyResult {
  return tokenRuntimeController.applyTokens(preferences, theme);
}
