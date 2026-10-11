/**
 * 运行时 Token 注入控制器 (TokenRuntimeController)
 * 全仓唯一合法的 document.documentElement.style.setProperty 注入权威源。
 * 统一接管原 themeStore.applyTheme、visualThemeController、themePersonalization 与 oklchColorGuard 的 token 注入职责。
 * 明暗判定严格采用纯布尔逻辑 (isDark: boolean)，彻底杜绝依靠字符串比较反推明暗。
 */

import type { PersonalizationSettings, UiTheme } from '../api/themeTypes';
import { SKIN_PRESETS, type SkinPreset } from '../api/themePresets';
import { shiftWarmLayers } from './warmLayerShift';
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

const SCROLLBAR_UP_PATH = "M 2.0 6.2 C 0.6 6.2 0.0 5.3 0.6 4.3 L 3.8 1.4 C 4.4 0.5 5.6 0.5 6.2 1.4 L 9.4 4.3 C 10.0 5.3 9.4 6.2 8.0 6.2 Z";
const SCROLLBAR_DOWN_PATH = "M 2.0 0.8 C 0.6 0.8 0.0 1.7 0.6 2.7 L 3.8 5.6 C 4.4 6.5 5.6 6.5 6.2 5.6 L 9.4 2.7 C 10.0 1.7 9.4 0.8 8.0 0.8 Z";
const SCROLLBAR_LEFT_PATH = "M 6.2 2.0 C 6.2 0.6 5.3 0.0 4.3 0.6 L 1.4 3.8 C 0.5 4.4 0.5 5.6 1.4 6.2 L 4.3 9.4 C 5.3 10.0 6.2 9.4 6.2 8.0 Z";
const SCROLLBAR_RIGHT_PATH = "M 0.8 2.0 C 0.8 0.6 1.7 0.0 2.7 0.6 L 5.6 3.8 C 6.5 4.4 6.5 5.6 5.6 6.2 L 2.7 9.4 C 1.7 10.0 0.8 9.4 0.8 8.0 Z";

function makeScrollbarArrowSvg(pathD: string, viewBox: string, color: string, opacity: string): string {
  const safeColor = color.startsWith('#') ? `%23${color.slice(1)}` : color;
  const svg = `%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='${viewBox}' preserveAspectRatio='none'%3E%3Cpath d='${pathD}' fill='${safeColor}' fill-opacity='${opacity}'/%3E%3C/svg%3E`;
  return `url("data:image/svg+xml,${svg}")`;
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

      let darkLayersShifted = false;
      if (!isDark && skinKey === 'warm-gray') {
        // 从外到内逐层变白（2026-10-10 heson 定稿，刻度 = 100 − HSL 亮度）：
        //   外层/侧栏 3.5（L 96.5%）→ 主界面 2.0（L 98%）→ 输入框/卡片 0（纯白）。
        //   旧值 95% / 95.2%（实测灰度 ≈5.1 / 4.7，两层几乎同色）。
        //   亮度微调 ±5 档沿用原斜率；主界面封顶 99.5%，保证永远略暗于纯白输入框。
        // 2026-10-11 heson 实测定稿（同一暖色调 CMYK C0 M0.4 Y0.8）：外层 K5 #f2f1f0、主层 K2.8 #f8f7f6、输入框 #ffffff。
        // 亮度微调只平移 K（保持 M0.4/Y0.8），三层同步并夹紧，层级不反转、不贴合（review P1-3，见 warmLayerShift.ts）。
        const layers = shiftWarmLayers({ outer: '#f2f1f0', main: '#f8f7f6', input: '#ffffff' }, adjust, false);
        bgPrimary = layers.main;
        bgSecondary = layers.outer;
        bgTertiary = layers.outer;
        bgCard = '#ffffff';
        bgElevated = '#ffffff';
        shellChromeBg = bgSecondary;
        // 与 tokens.css 浅色 --border-color / --border-subtle 同值（review P2-1：单一取值，M0.4/Y0.8）
        borderColor = '#e2e1e0';
        borderSubtle = '#f0efee';
      } else if (isDark && skinKey === 'dark-cozy') {
        // 默认深色皮肤：三层（外层 / 主层 / 输入框）只平移 K、同步移动并夹紧，输入框参与平移，永远最亮（review P1-3）
        const layers = shiftWarmLayers(
          { outer: skinConfig.bgSecondary, main: skinConfig.bgPrimary, input: skinConfig.bgCard },
          adjust,
          true,
        );
        bgPrimary = layers.main;
        bgSecondary = layers.outer;
        bgTertiary = layers.outer;
        shellChromeBg = layers.outer;
        bgCard = layers.input;
        darkLayersShifted = true;
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
      } else if (!darkLayersShifted) {
        if (skinConfig.bgCard) {
          bgCard = skinConfig.bgCard;
        }
        if (skinConfig.bgElevated) {
          bgElevated = skinConfig.bgElevated;
        }
      }

      // 三档底色（2026-10-10）：control-soft-* 不再按皮肤单独注入，统一为 tokens.css 的 --tint-hover/--tint-active 叠加。

      // 遵循显式灰阶契约：黑夜模式使用 45% 灰度（55% 亮度），浅色模式使用 55% 灰度（45% 亮度）
      const defaultTertiary = isDark ? '#8c8c8c' : '#6b6b6b';
      const defaultFaint = isDark ? '#737373' : '#9e9e9e';

      // 皮肤未显式指定时，根据皮肤色相与明暗基底动态调配层级字色，杜绝死灰断层
      const baseTertiary =
        skinConfig.textTertiary ||
        (skinKey === 'warm-gray' || skinKey === 'paper' || skinKey === 'classic-gray'
          ? defaultTertiary
          : isDark
            ? `color-mix(in srgb, ${textPrimary} 65%, ${bgPrimary})`
            : `color-mix(in srgb, ${textPrimary} 60%, hsl(0 0% 100%))`);

      const baseFaint =
        skinConfig.textFaint ||
        (skinKey === 'warm-gray' || skinKey === 'paper' || skinKey === 'classic-gray'
          ? defaultFaint
          : isDark
            ? `color-mix(in srgb, ${textPrimary} 45%, ${bgPrimary})`
            : `color-mix(in srgb, ${textPrimary} 38%, hsl(0 0% 100%))`);

      // 浅色暖灰：输入框必须是纯白（heson 定稿），不受皮肤 composerBg / 亮度微调影响
      const composerBg = !isDark && skinKey === 'warm-gray' ? '#ffffff' : skinConfig.composerBg || bgCard;

      let finalFg = textPrimary;
      let finalSec = textSecondary;
      let finalTert = baseTertiary;
      let finalFaint = baseFaint;

      const contrastGuard = computeContrastGuardedTokens(bgPrimary, isDark, {
        isCustomSkin: skinKey === 'custom',
        explicitTextPrimary: textPrimary,
      });

      if (contrastGuard) {
        finalFg = contrastGuard.textPrimary;
        finalSec = contrastGuard.textSecondary;
        finalTert = contrastGuard.textTertiary;
        finalFaint = isDark
          ? `color-mix(in srgb, ${finalFg} 45%, ${bgPrimary})`
          : `color-mix(in srgb, ${finalFg} 40%, hsl(0 0% 100%))`;
      }

      // 三档底色 SSOT（2026-10-10）：运行时只写三个独立源 —— 外层（侧栏 + 标签栏）/ 主层（聊天区 + 右侧栏 +
      // 卡片/弹层…）/ 输入框。--surface-chrome/paper/card/elevated/sunken、--bg-tertiary、--shell-chrome-bg、
      // --composer-bg 在 tokens.css 中都是这三档的别名，皮肤的 bgTertiary/bgElevated/shellChromeBg/bgCard
      // 不再单独生效（否则会出现第四、五种底色）。输入框取 composerBg（未配置时回落 bgCard）。
      void bgTertiary;
      void bgElevated;
      void shellChromeBg;
      tokens['--surface-outer'] = bgSecondary;
      tokens['--surface-main'] = bgPrimary;
      tokens['--surface-input'] = composerBg;
      // T7 别名收敛（2026-09-12）：--bg-primary/--bg-secondary/--bg-card/--bg-elevated/
      // --bg-paper/--bg-workspace/--shell-inset-bg/--terminal-* 已不再由 JS 写入——
      // tokens.css 静态链以 surface-* 为独立源派生它们（--bg-primary: var(--surface-paper) 等），
      // JS 只需写独立侧。同值多写是 a_class_multi_writer 同类问题。
      tokens['--text-primary'] = finalFg;
      tokens['--text-secondary'] = finalSec;
      tokens['--text-tertiary'] = finalTert;
      tokens['--text-muted'] = finalTert;
      tokens['--text-faint'] = finalFaint;
      tokens['--border-color'] = borderColor;
      tokens['--border-subtle'] = borderSubtle;
      tokens['--control-mix-color'] = mixColor;
      tokens['--accent-green-light-adaptive'] = greenLight;
      tokens['--accent-red-light-adaptive'] = redLight;

      // 滚动条主题色融合：在各类皮肤下自然融入当前主题色相，杜绝孤立突兀的灰白硬块
      if (skinKey === 'warm-gray') {
        // 暖灰皮肤（默认浅色纸温）走 tokens.css 静态权威 SSOT（降低灰度的 #dedddc 与深沉激活态 #6b6a69）
        // 按钮 SVG 同步继承 tokens.css 权威满宽平滑大圆角矢量，不向 root.style 写入内联覆盖
      } else if (isDark) {
        tokens['--scrollbar-thumb-bg'] = `color-mix(in srgb, ${finalFg} 16%, transparent)`;
        tokens['--scrollbar-thumb-active'] = `color-mix(in srgb, ${finalFg} 48%, transparent)`;
      } else {
        tokens['--scrollbar-thumb-bg'] = `color-mix(in srgb, ${finalFg} 13%, transparent)`;
        tokens['--scrollbar-thumb-active'] = `color-mix(in srgb, ${finalFg} 58%, transparent)`;
      }

      // 滚动条微调三角按钮动态 SVG Token 化：在非 warm-gray 自定义皮肤下与当前滑块颜色深度契合
      if (skinKey !== 'warm-gray') {
        const btnNormalOp = isDark ? '0.16' : '0.13';
        const btnActiveOp = isDark ? '0.48' : '0.58';

        tokens['--scrollbar-button-up'] = makeScrollbarArrowSvg(SCROLLBAR_UP_PATH, '0 0 10 7', finalFg, btnNormalOp);
        tokens['--scrollbar-button-down'] = makeScrollbarArrowSvg(SCROLLBAR_DOWN_PATH, '0 0 10 7', finalFg, btnNormalOp);
        tokens['--scrollbar-button-left'] = makeScrollbarArrowSvg(SCROLLBAR_LEFT_PATH, '0 0 7 10', finalFg, btnNormalOp);
        tokens['--scrollbar-button-right'] = makeScrollbarArrowSvg(SCROLLBAR_RIGHT_PATH, '0 0 7 10', finalFg, btnNormalOp);
        tokens['--scrollbar-button-up-active'] = makeScrollbarArrowSvg(SCROLLBAR_UP_PATH, '0 0 10 7', finalFg, btnActiveOp);
        tokens['--scrollbar-button-down-active'] = makeScrollbarArrowSvg(SCROLLBAR_DOWN_PATH, '0 0 10 7', finalFg, btnActiveOp);
        tokens['--scrollbar-button-left-active'] = makeScrollbarArrowSvg(SCROLLBAR_LEFT_PATH, '0 0 7 10', finalFg, btnActiveOp);
        tokens['--scrollbar-button-right-active'] = makeScrollbarArrowSvg(SCROLLBAR_RIGHT_PATH, '0 0 7 10', finalFg, btnActiveOp);
      }
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
      if (tokens['--surface-outer']) root.style.setProperty('--surface-outer', tokens['--surface-outer']);
      if (tokens['--surface-main']) root.style.setProperty('--surface-main', tokens['--surface-main']);
      if (tokens['--surface-input']) root.style.setProperty('--surface-input', tokens['--surface-input']);
      if (tokens['--text-primary']) root.style.setProperty('--text-primary', tokens['--text-primary']);
      if (tokens['--text-secondary']) root.style.setProperty('--text-secondary', tokens['--text-secondary']);
      if (tokens['--text-tertiary']) root.style.setProperty('--text-tertiary', tokens['--text-tertiary']);
      if (tokens['--text-muted']) root.style.setProperty('--text-muted', tokens['--text-muted']);
      if (tokens['--text-faint']) root.style.setProperty('--text-faint', tokens['--text-faint']);
      if (tokens['--border-color']) root.style.setProperty('--border-color', tokens['--border-color']);
      if (tokens['--border-subtle']) root.style.setProperty('--border-subtle', tokens['--border-subtle']);
      if (tokens['--control-mix-color']) root.style.setProperty('--control-mix-color', tokens['--control-mix-color']);
      if (tokens['--accent-green-light-adaptive']) root.style.setProperty('--accent-green-light-adaptive', tokens['--accent-green-light-adaptive']);
      if (tokens['--accent-red-light-adaptive']) root.style.setProperty('--accent-red-light-adaptive', tokens['--accent-red-light-adaptive']);
      if (tokens['--scrollbar-thumb-bg']) root.style.setProperty('--scrollbar-thumb-bg', tokens['--scrollbar-thumb-bg']);
      if (tokens['--scrollbar-thumb-active']) root.style.setProperty('--scrollbar-thumb-active', tokens['--scrollbar-thumb-active']);
      if (tokens['--scrollbar-button-up']) root.style.setProperty('--scrollbar-button-up', tokens['--scrollbar-button-up']);
      if (tokens['--scrollbar-button-down']) root.style.setProperty('--scrollbar-button-down', tokens['--scrollbar-button-down']);
      if (tokens['--scrollbar-button-left']) root.style.setProperty('--scrollbar-button-left', tokens['--scrollbar-button-left']);
      if (tokens['--scrollbar-button-right']) root.style.setProperty('--scrollbar-button-right', tokens['--scrollbar-button-right']);
      if (tokens['--scrollbar-button-up-active']) root.style.setProperty('--scrollbar-button-up-active', tokens['--scrollbar-button-up-active']);
      if (tokens['--scrollbar-button-down-active']) root.style.setProperty('--scrollbar-button-down-active', tokens['--scrollbar-button-down-active']);
      if (tokens['--scrollbar-button-left-active']) root.style.setProperty('--scrollbar-button-left-active', tokens['--scrollbar-button-left-active']);
      if (tokens['--scrollbar-button-right-active']) root.style.setProperty('--scrollbar-button-right-active', tokens['--scrollbar-button-right-active']);

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
