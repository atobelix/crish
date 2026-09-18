/**
 * 运行时 Token 注入控制器 (TokenRuntimeController)
 * 全仓唯一合法的 document.documentElement.style.setProperty 注入权威源。
 * 统一接管原 themeStore.applyTheme、visualThemeController、themePersonalization 与 oklchColorGuard 的 token 注入职责。
 * 明暗判定严格采用纯布尔逻辑 (isDark: boolean)，彻底杜绝依靠字符串比较反推明暗。
 */

import type { PersonalizationSettings, UiTheme } from '../api/themeTypes';
import { SKIN_PRESETS, type SkinPreset } from '../api/themePresets';
import {
  parseColorToOklch,
  computeContrastGuardedTokens,
  setTokenRuntimeSetter,
  type ContrastGuardedTokens,
} from '../api/oklchColorGuard';
import type { UiSize } from '../store/layout-helpers/store-types';

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

export interface SolarAdjustmentResult {
  brightnessAdjust: number;
  solarWarmthMix: number;
  periodLabel: string;
}

/**
 * 智能时光过渡参数计算纯函数
 */
export function computeDynamicSolarAdjustments(mockHour?: number): SolarAdjustmentResult {
  const now = new Date();
  const currentHour = mockHour !== undefined ? mockHour : (now.getHours() + now.getMinutes() / 60);

  if (currentHour >= 6 && currentHour < 9) {
    const p = (currentHour - 6) / 3;
    return {
      brightnessAdjust: p >= 0.5 ? 1 : 0,
      solarWarmthMix: 0.05 * (1 - p),
      periodLabel: '清晨苏醒：正在温和提亮界面，驱散睡意',
    };
  }
  if (currentHour >= 9 && currentHour < 16) {
    return {
      brightnessAdjust: 1,
      solarWarmthMix: 0,
      periodLabel: '耀眼正午：高对比清爽亮白，保持最高专注力',
    };
  }
  if (currentHour >= 16 && currentHour < 19) {
    const p = (currentHour - 16) / 3;
    const exactAdjust = Math.round(0 - p * 4);
    const warmth = 0.16 * p;
    return {
      brightnessAdjust: exactAdjust,
      solarWarmthMix: warmth,
      periodLabel: '暮光下沉：正自动下调亮度并调温，呵护视网膜',
    };
  }

  let brightness = -1;
  let periodLabel = '暮色降临：系统已切换到深色模式';
  if (currentHour >= 21 || currentHour < 2) {
    let p = 0;
    if (currentHour >= 21) {
      p = (currentHour - 21) / 5;
    } else {
      p = (currentHour + 3) / 5;
    }
    brightness = Math.round(-1 - p * 3);
    periodLabel = '深夜静谧：已调至极致曜石黑并过滤蓝光，祝您晚安';
  } else if (currentHour >= 2 && currentHour < 6) {
    brightness = -3;
    periodLabel = '深夜静谧：极暗曜石黑模式运行中';
  }

  return {
    brightnessAdjust: brightness,
    solarWarmthMix: 0,
    periodLabel,
  };
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

    let resolvedTheme: UiTheme = (theme === 'dark' ? 'dark' : 'default');
    let adjust = p.themeBrightnessAdjust || 0;
    let solarWarmthMix = 0;

    if (p.themeAutoTimeTransition) {
      const solar = computeDynamicSolarAdjustments();
      adjust = solar.brightnessAdjust;
      solarWarmthMix = solar.solarWarmthMix;
      const now = new Date();
      const currentHour = now.getHours() + now.getMinutes() / 60;
      resolvedTheme = (currentHour >= 19 || currentHour < 6) ? 'dark' : 'default';
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
          ? `color-mix(in srgb, ${bg} 85%, hsl(0 0% 0%) 15%)`
          : `color-mix(in srgb, ${bg} 95%, hsl(0 0% 100%) 5%)`,
        bgTertiary: `color-mix(in srgb, ${bg} 90%, ${fg} 10%)`,
        bgCard: isDark
          ? `color-mix(in srgb, ${bg} 90%, hsl(0 0% 100%) 10%)`
          : `color-mix(in srgb, ${bg} 96%, hsl(0 0% 100%) 4%)`,
        bgElevated: isDark
          ? `color-mix(in srgb, ${bg} 88%, hsl(0 0% 100%) 12%)`
          : `color-mix(in srgb, ${bg} 96%, hsl(0 0% 100%) 4%)`,
        shellChromeBg: isDark
          ? `color-mix(in srgb, ${bg} 85%, hsl(0 0% 0%) 15%)`
          : `color-mix(in srgb, ${bg} 78%, hsl(38 8% 70%) 22%)`,
        textPrimary: fg,
        textSecondary: `color-mix(in srgb, ${bg} 35%, ${fg} 65%)`,
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
      let bgPrimary = skinConfig.bgPrimary;
      let bgSecondary = skinConfig.bgSecondary;
      let bgTertiary = skinConfig.bgTertiary;
      let bgCard = skinConfig.bgCard;
      let bgElevated = skinConfig.bgElevated;
      let shellChromeBg = skinConfig.shellChromeBg;
      let textPrimary = skinConfig.textPrimary;
      const textSecondary = skinConfig.textSecondary;
      let borderColor = skinConfig.borderColor;
      let borderSubtle = skinConfig.borderSubtle;

      const mixColor = skinConfig.mixColor || (isDark
        ? 'var(--text-primary)'
        : 'hsl(35, 50%, 20%)');

      let vibrantTint = mixColor;
      if (!isDark) {
        const hslMatch = mixColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
        if (hslMatch) {
          const h = parseInt(hslMatch[1]!, 10);
          const originalSat = parseInt(hslMatch[2]!, 10);
          let sat = 45;
          let light = 90;
          if (originalSat <= 10) {
            sat = 0;
            light = 92;
          } else if (h >= 30 && h <= 45) {
            sat = 45;
            light = 90;
          } else if (h >= 100 && h <= 150) {
            sat = 40;
            light = 91;
          } else if (h >= 160 && h <= 210) {
            sat = 45;
            light = 92;
          } else if (h >= 270 && h <= 320) {
            sat = 55;
            light = 92;
          }
          vibrantTint = `hsl(${h}, ${sat}%, ${light}%)`;
        }
      }

      let mixTarget = adjust > 0 ? 'hsl(0 0% 100%)' : 'hsl(0 0% 0%)';
      if (p.themeBrightnessVibrant) {
        const tintTarget = `color-mix(in srgb, ${mixColor} 8%, hsl(0 0% 100%))`;
        const shadeTarget = `color-mix(in srgb, ${mixColor} 14%, hsl(0 0% 0%))`;
        mixTarget = adjust > 0 ? tintTarget : shadeTarget;
      }

      const twilightTarget = `color-mix(in srgb, ${mixColor} 15%, hsl(34, 30%, 45%))`;

      if (solarWarmthMix > 0 && !isDark && skinKey !== 'warm-gray' && skinKey !== 'paper' && skinKey !== 'classic-gray') {
        const sunsetTone = 'hsl(30, 40%, 90%)';
        bgPrimary = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgPrimary})`;
        bgSecondary = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgSecondary})`;
        bgTertiary = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgTertiary})`;
        bgCard = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgCard})`;
        bgElevated = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgElevated})`;
        vibrantTint = `color-mix(in srgb, hsl(30, 50%, 65%) ${solarWarmthMix * 100}%, ${vibrantTint})`;
      }

      if (!isDark && skinKey === 'warm-gray') {
        const lPrimary = Number((95.2 + adjust * 0.6).toFixed(2));
        const lSecondary = Number((95 + adjust * 0.3).toFixed(2));
        const lTertiary = Number((lSecondary - 3).toFixed(2));

        bgPrimary = `hsl(35 8% ${lPrimary}%)`;
        bgSecondary = `hsl(35 8% ${lSecondary}%)`;
        bgTertiary = `hsl(35 8% ${lTertiary}%)`;
        bgCard = 'hsl(0 0% 100%)';
        bgElevated = 'hsl(0 0% 100%)';
        shellChromeBg = `hsl(35 8% ${lSecondary}%)`;
        borderColor = 'hsl(35 10% 86%)';
        borderSubtle = 'hsl(30 6% 93.8%)';
      } else if (adjust !== 0) {
        if (isDark) {
          if (adjust > 0) {
            const pBase = adjust * 3.5;
            const pSec = adjust * 2.8;
            const pElev = adjust * 2.0;
            const pChrome = adjust * 3.0;

            bgPrimary = `color-mix(in srgb, ${bgPrimary} ${100 - pBase}%, ${mixTarget})`;
            bgSecondary = `color-mix(in srgb, ${bgSecondary} ${100 - pSec}%, ${mixTarget})`;
            bgTertiary = `color-mix(in srgb, ${bgTertiary} ${100 - pSec}%, ${mixTarget})`;
            bgCard = `color-mix(in srgb, ${bgCard} ${100 - pElev}%, ${mixTarget})`;
            bgElevated = `color-mix(in srgb, ${bgElevated} ${100 - pElev}%, ${mixTarget})`;
            shellChromeBg = `color-mix(in srgb, ${shellChromeBg} ${100 - pChrome}%, ${mixTarget})`;

            borderColor = `color-mix(in srgb, ${borderColor} ${100 - pSec}%, ${mixTarget})`;
            borderSubtle = `color-mix(in srgb, ${borderSubtle} ${100 - pSec}%, ${mixTarget})`;

            textPrimary = `color-mix(in srgb, ${textPrimary} ${100 - adjust * 1.5}%, hsl(0 0% 100%))`;
          } else {
            const pBase = Math.abs(adjust) * 3.5;
            const pSec = Math.abs(adjust) * 2.3;
            const pElev = Math.abs(adjust) * 1.5;
            const pChrome = Math.abs(adjust) * 3.0;

            bgPrimary = `color-mix(in srgb, ${bgPrimary} ${100 - pBase}%, ${mixTarget})`;
            bgSecondary = `color-mix(in srgb, ${bgSecondary} ${100 - pSec}%, ${mixTarget})`;
            bgTertiary = `color-mix(in srgb, ${bgTertiary} ${100 - pSec}%, ${mixTarget})`;
            bgCard = `color-mix(in srgb, ${bgCard} ${100 - pElev}%, ${mixTarget})`;
            bgElevated = `color-mix(in srgb, ${bgElevated} ${100 - pElev}%, ${mixTarget})`;
            shellChromeBg = `color-mix(in srgb, ${shellChromeBg} ${100 - pChrome}%, ${mixTarget})`;

            borderColor = `color-mix(in srgb, ${borderColor} ${100 - pSec}%, ${mixTarget})`;
            borderSubtle = `color-mix(in srgb, ${borderSubtle} ${100 - pSec}%, ${mixTarget})`;

            textPrimary = `color-mix(in srgb, ${textPrimary} ${100 - Math.abs(adjust) * 1.0}%, ${bgPrimary})`;
          }
        } else {
          if (adjust > 0) {
            const pBase = adjust * 4.5;
            const pSec = adjust * 2.5;
            const pElev = adjust * 4.5;
            const pChrome = adjust * 3.5;

            bgPrimary = `color-mix(in srgb, ${bgPrimary} ${100 - pBase}%, hsl(0 0% 100%))`;
            bgSecondary = `color-mix(in srgb, ${bgSecondary} ${100 - pSec}%, hsl(0 0% 100%))`;
            bgTertiary = `color-mix(in srgb, ${bgTertiary} ${100 - pSec}%, hsl(0 0% 100%))`;
            bgCard = `color-mix(in srgb, ${bgCard} ${100 - pElev}%, hsl(0 0% 100%))`;
            bgElevated = `color-mix(in srgb, ${bgElevated} ${100 - pElev}%, hsl(0 0% 100%))`;
            shellChromeBg = `color-mix(in srgb, ${shellChromeBg} ${100 - pChrome}%, hsl(0 0% 100%))`;

            borderColor = `color-mix(in srgb, ${borderColor} ${100 - pSec}%, hsl(0 0% 100%))`;
            borderSubtle = `color-mix(in srgb, ${borderSubtle} ${100 - pSec}%, hsl(0 0% 100%))`;
          } else {
            const pBase = Math.abs(adjust) * 3.0;
            const pSec = Math.abs(adjust) * 4.8;
            const pElev = Math.abs(adjust) * 1.2;
            const pChrome = Math.abs(adjust) * 3.8;

            bgPrimary = `color-mix(in srgb, ${bgPrimary} ${100 - pBase}%, ${twilightTarget})`;
            bgSecondary = `color-mix(in srgb, ${bgSecondary} ${100 - pSec}%, ${twilightTarget})`;
            bgTertiary = `color-mix(in srgb, ${bgTertiary} ${100 - pSec}%, ${twilightTarget})`;
            bgCard = `color-mix(in srgb, ${bgCard} ${100 - pElev}%, ${twilightTarget})`;
            bgElevated = `color-mix(in srgb, ${bgElevated} ${100 - pElev}%, ${twilightTarget})`;
            shellChromeBg = `color-mix(in srgb, ${shellChromeBg} ${100 - pChrome}%, ${twilightTarget})`;

            borderColor = `color-mix(in srgb, ${borderColor} ${100 - pSec}%, ${twilightTarget})`;
            borderSubtle = `color-mix(in srgb, ${borderSubtle} ${100 - pSec}%, ${twilightTarget})`;

            textPrimary = `color-mix(in srgb, ${textPrimary} ${100 - Math.abs(adjust) * 1.8}%, hsl(0 0% 7%))`;
          }
        }
      }

      if (!isDark && skinKey === 'cream') {
        bgCard = `color-mix(in srgb, ${vibrantTint} 6.0%, ${bgCard})`;
        bgElevated = `color-mix(in srgb, ${vibrantTint} 10.0%, ${bgCard})`;
      }

      let greenLight = 'var(--accent-green-light)';
      let redLight = 'var(--accent-red-light)';
      if (!isDark) {
        greenLight = `color-mix(in srgb, var(--accent-green) 15.5%, hsl(0 0% 100%))`;
        redLight = `color-mix(in srgb, var(--accent-red) 12.5%, hsl(0 0% 100%))`;
      } else {
        if (adjust < 0) {
          const pct = Math.abs(adjust) * 1.2;
          greenLight = `color-mix(in srgb, var(--accent-green) ${8 + pct}%, ${bgSecondary})`;
          redLight = `color-mix(in srgb, var(--accent-red) ${8 + pct}%, ${bgSecondary})`;
        } else {
          greenLight = `color-mix(in srgb, var(--accent-green) 8%, ${bgPrimary})`;
          redLight = `color-mix(in srgb, var(--accent-red) 8%, ${bgPrimary})`;
        }
      }

      if (!isDark) {
        if (skinKey === 'warm-gray' || skinKey === 'paper' || skinKey === 'classic-gray' || skinKey === 'custom') {
          bgCard = 'hsl(0 0% 100%)';
          bgElevated = 'hsl(0 0% 100%)';
        }
      } else {
        if (skinConfig.bgCard) {
          bgCard = skinConfig.bgCard;
        }
        if (skinConfig.bgElevated) {
          bgElevated = skinConfig.bgElevated;
        }
      }

      const isDarkPreset = isDark;
      const controlSoftBase = isDarkPreset ? mixColor : vibrantTint;
      const softBgPct = isDarkPreset ? '5%' : '4%';
      const softHoverPct = isDarkPreset ? '6.5%' : '4%';
      const softActivePct = isDarkPreset ? '9.5%' : '8%';

      // 遵循显式灰阶契约：黑夜模式使用 45% 灰度（55% 亮度），浅色模式使用 55% 灰度（45% 亮度），严禁透明度混色
      const defaultTertiary = isDark ? '#8c8c8c' : '#6b6b6b';
      const tertiaryColor = skinConfig.textTertiary || defaultTertiary;

      const composerBg = skinConfig.composerBg || bgCard;

      let finalFg = textPrimary;
      let finalSec = textSecondary;
      let finalTert = tertiaryColor;

      const contrastGuard = computeContrastGuardedTokens(bgPrimary, isDark, {
        isCustomSkin: skinKey === 'custom',
        explicitTextPrimary: textPrimary,
      });

      if (contrastGuard) {
        finalFg = contrastGuard.textPrimary;
        finalSec = contrastGuard.textSecondary;
        finalTert = contrastGuard.textTertiary;
      }

      tokens['--surface-chrome'] = bgSecondary;
      tokens['--surface-paper'] = bgPrimary;
      tokens['--surface-card'] = bgCard;
      tokens['--surface-elevated'] = bgElevated;
      tokens['--bg-tertiary'] = bgTertiary;
      // T7 别名收敛（2026-09-12）：--bg-primary/--bg-secondary/--bg-card/--bg-elevated/
      // --bg-paper/--bg-workspace/--shell-inset-bg/--terminal-* 已不再由 JS 写入——
      // tokens.css 静态链以 surface-* 为独立源派生它们（--bg-primary: var(--surface-paper) 等），
      // JS 只需写独立侧。同值多写是 a_class_multi_writer 同类问题。
      tokens['--shell-chrome-bg'] = shellChromeBg;
      tokens['--text-primary'] = finalFg;
      tokens['--text-secondary'] = finalSec;
      tokens['--text-tertiary'] = finalTert;
      tokens['--border-color'] = borderColor;
      tokens['--border-subtle'] = borderSubtle;
      tokens['--control-mix-color'] = mixColor;
      tokens['--control-soft-bg'] = `color-mix(in srgb, ${controlSoftBase} ${softBgPct}, ${bgSecondary})`;
      tokens['--control-soft-bg-hover'] = `color-mix(in srgb, ${controlSoftBase} ${softHoverPct}, ${bgSecondary})`;
      tokens['--control-soft-bg-active'] = `color-mix(in srgb, ${controlSoftBase} ${softActivePct}, ${bgSecondary})`;
      tokens['--composer-bg'] = composerBg;
      tokens['--accent-green-light-adaptive'] = greenLight;
      tokens['--accent-red-light-adaptive'] = redLight;
    }

    if (typeof document !== 'undefined') {
      const root = document.documentElement;

      root.setAttribute('data-theme', resolvedTheme);
      if (document.body) {
        document.body.setAttribute('data-theme', resolvedTheme);
      }

      root.classList.toggle('theme-dark', isDark);
      root.classList.toggle('theme-light', !isDark);
      if (document.body) {
        document.body.classList.toggle('theme-dark', isDark);
        document.body.classList.toggle('theme-light', !isDark);
      }

      for (const oldKey of this.currentInjectedKeys) {
        if (!Object.prototype.hasOwnProperty.call(tokens, oldKey) && oldKey !== '--ui-scale') {
          root.style.removeProperty(oldKey);
          this.currentInjectedKeys.delete(oldKey);
        }
      }

      // 全仓唯一合法注入点：显式受控注入，满足 style-contract 静态同源契约与精准应用
      // （T7 别名收敛后只写独立侧：surface-* / text-* / border-* / control-* / composer-bg /
      //   accent-* / bg-tertiary / shell-chrome-bg / font-size-adjust；
      //   bg-primary/secondary/card/elevated/paper/workspace、shell-inset-bg、terminal-*
      //   由 tokens.css 静态链从 surface-* 派生，不再注入）
      if (tokens['--font-size-adjust']) root.style.setProperty('--font-size-adjust', tokens['--font-size-adjust']);
      if (tokens['--surface-chrome']) root.style.setProperty('--surface-chrome', tokens['--surface-chrome']);
      if (tokens['--surface-paper']) root.style.setProperty('--surface-paper', tokens['--surface-paper']);
      if (tokens['--surface-card']) root.style.setProperty('--surface-card', tokens['--surface-card']);
      if (tokens['--surface-elevated']) root.style.setProperty('--surface-elevated', tokens['--surface-elevated']);
      if (tokens['--bg-tertiary']) root.style.setProperty('--bg-tertiary', tokens['--bg-tertiary']);
      if (tokens['--shell-chrome-bg']) root.style.setProperty('--shell-chrome-bg', tokens['--shell-chrome-bg']);
      if (tokens['--text-primary']) root.style.setProperty('--text-primary', tokens['--text-primary']);
      if (tokens['--text-secondary']) root.style.setProperty('--text-secondary', tokens['--text-secondary']);
      if (tokens['--text-tertiary']) root.style.setProperty('--text-tertiary', tokens['--text-tertiary']);
      if (tokens['--border-color']) root.style.setProperty('--border-color', tokens['--border-color']);
      if (tokens['--border-subtle']) root.style.setProperty('--border-subtle', tokens['--border-subtle']);
      if (tokens['--control-mix-color']) root.style.setProperty('--control-mix-color', tokens['--control-mix-color']);
      if (tokens['--control-soft-bg']) root.style.setProperty('--control-soft-bg', tokens['--control-soft-bg']);
      if (tokens['--control-soft-bg-hover']) root.style.setProperty('--control-soft-bg-hover', tokens['--control-soft-bg-hover']);
      if (tokens['--control-soft-bg-active']) root.style.setProperty('--control-soft-bg-active', tokens['--control-soft-bg-active']);
      if (tokens['--composer-bg']) root.style.setProperty('--composer-bg', tokens['--composer-bg']);
      if (tokens['--accent-green-light-adaptive']) root.style.setProperty('--accent-green-light-adaptive', tokens['--accent-green-light-adaptive']);
      if (tokens['--accent-red-light-adaptive']) root.style.setProperty('--accent-red-light-adaptive', tokens['--accent-red-light-adaptive']);

      for (const key of Object.keys(tokens)) {
        this.currentInjectedKeys.add(key);
      }
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
