/**
 * 外观主题：个性化应用逻辑
 * 统一委托至全仓唯一运行时 Token 注入控制器 TokenRuntimeController
 * 消除多轨并存，明暗判定采用纯布尔逻辑
 */

import type { PersonalizationSettings } from './themeTypes';
import {
  applyTokens,
  computeDynamicSolarAdjustments,
  type SolarAdjustmentResult,
} from '../services/TokenRuntimeController';

/**
 * 根据当前系统时间计算智能时光过渡参数
 */
export function getDynamicSolarAdjustments(mockHour?: number): {
  brightnessAdjust: number;
  solarWarmthMix: number;
  periodLabel: string;
} {
  const res: SolarAdjustmentResult = computeDynamicSolarAdjustments(mockHour);
  return {
    brightnessAdjust: res.brightnessAdjust,
    solarWarmthMix: res.solarWarmthMix,
    periodLabel: res.periodLabel,
  };
}

/**
 * 皮肤色板与个性化注入
 * 全仓唯一委托给 TokenRuntimeController.applyTokens 执行
 */
export function applyPersonalization(
  p: PersonalizationSettings,
  activeTheme: 'default' | 'dark'
): void {
  applyTokens(p, activeTheme);
}
