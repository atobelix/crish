/**
 * 智能时光过渡参数纯函数 (solarAdjustments)
 * 拆分来源：services/TokenRuntimeController.ts（行数门禁收口，行为不变）。
 * 由 TokenRuntimeController 与 themeTokenPlan 复用；TokenRuntimeController 保持同名 re-export。
 */

export interface SolarAdjustmentResult {
  brightnessAdjust: number;
  solarWarmthMix: number;
  periodLabel: string;
}

/**
 * 智能时光过渡参数计算纯函数
 */
export function computeDynamicSolarAdjustments(
  mockHour?: number
): SolarAdjustmentResult {
  const now = new Date();
  const currentHour =
    mockHour !== undefined ? mockHour : now.getHours() + now.getMinutes() / 60;

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
