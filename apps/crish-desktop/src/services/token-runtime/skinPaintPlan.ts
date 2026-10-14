/**
 * apps/crish-desktop/src/services/token-runtime/skinPaintPlan.ts
 *
 * 皮肤表面色 / 亮度微调 / 字色层级 / composer 底色的纯派生计划（skin paint plan）。
 * 拆分来源：services/TokenRuntimeController.ts 的 applyTokens（行数门禁收口，行为不变）。
 */

import type { SkinPreset } from '../../api/themePresets';
import { shiftWarmLayers } from '../warmLayerShift';
import { computeContrastGuardedTokens } from '../../api/oklchColorGuard';

export interface SkinPaintInput {
  skinConfig: SkinPreset;
  skinKey: string;
  isDark: boolean;
  adjust: number;
  solarWarmthMix: number;
  vibrant: boolean;
}

export interface SkinPaintPlan {
  bgPrimary: string;
  bgSecondary: string;
  composerBg: string;
  mixColor: string;
  borderColor: string;
  borderSubtle: string;
  finalFg: string;
  finalSec: string;
  finalTert: string;
  finalFaint: string;
}

/** 由皮肤配置派生一整套表面/文字注入计划（纯函数，行为与内联段逐行等价） */
export function deriveSkinPaintPlan(input: SkinPaintInput): SkinPaintPlan {
  const { skinConfig, skinKey, isDark, adjust, solarWarmthMix, vibrant } =
    input;

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

  const mixColor =
    skinConfig.mixColor ||
    (isDark ? 'var(--text-primary)' : 'hsl(35, 50%, 20%)');

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
  if (vibrant) {
    const tintTarget = `color-mix(in srgb, ${mixColor} 8%, hsl(0 0% 100%))`;
    const shadeTarget = `color-mix(in srgb, ${mixColor} 14%, hsl(0 0% 0%))`;
    mixTarget = adjust > 0 ? tintTarget : shadeTarget;
  }

  const twilightTarget = `color-mix(in srgb, ${mixColor} 15%, hsl(34, 30%, 45%))`;

  if (
    solarWarmthMix > 0 &&
    !isDark &&
    skinKey !== 'warm-gray' &&
    skinKey !== 'paper' &&
    skinKey !== 'classic-gray'
  ) {
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
    const layers = shiftWarmLayers(
      { outer: '#f2f1f0', main: '#f8f7f6', input: '#ffffff' },
      adjust,
      false
    );
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
      {
        outer: skinConfig.bgSecondary,
        main: skinConfig.bgPrimary,
        input: skinConfig.bgCard,
      },
      adjust,
      true
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

  if (!isDark) {
    if (
      skinKey === 'warm-gray' ||
      skinKey === 'paper' ||
      skinKey === 'classic-gray' ||
      skinKey === 'custom'
    ) {
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

  // 遵循显式灰阶契约：黑夜模式与浅色模式四档拉开清晰梯度（与 tokens.css 静态定义严格同值）
  const defaultTertiary = isDark ? '#8c8c8c' : '#666666';
  const defaultFaint = isDark ? '#666666' : '#969696';
  const isNeutralPreset =
    skinKey === 'warm-gray' ||
    skinKey === 'paper' ||
    skinKey === 'classic-gray' ||
    skinKey === 'dark-cozy';

  // 皮肤未显式指定时，根据皮肤色相与明暗基底动态调配层级字色，杜绝死灰断层
  const baseTertiary =
    skinConfig.textTertiary ||
    (isNeutralPreset
      ? defaultTertiary
      : isDark
        ? `color-mix(in srgb, ${textPrimary} 58%, ${bgPrimary})`
        : `color-mix(in srgb, ${textPrimary} 56%, hsl(0 0% 100%))`);

  const baseFaint =
    skinConfig.textFaint ||
    (isNeutralPreset
      ? defaultFaint
      : isDark
        ? `color-mix(in srgb, ${textPrimary} 38%, ${bgPrimary})`
        : `color-mix(in srgb, ${textPrimary} 35%, hsl(0 0% 100%))`);

  // 浅色暖灰：输入框必须是纯白（heson 定稿），不受皮肤 composerBg / 亮度微调影响
  const composerBg =
    !isDark && skinKey === 'warm-gray'
      ? '#ffffff'
      : skinConfig.composerBg || bgCard;

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
      ? `color-mix(in srgb, ${finalFg} 38%, ${bgPrimary})`
      : `color-mix(in srgb, ${finalFg} 36%, hsl(0 0% 100%))`;
  }

  // 只写不读的中间量（与主文件原 void 段等价）
  void bgTertiary;
  void bgElevated;
  void shellChromeBg;
  return {
    bgPrimary,
    bgSecondary,
    composerBg,
    mixColor,
    borderColor,
    borderSubtle,
    finalFg,
    finalSec,
    finalTert,
    finalFaint,
  };
}
