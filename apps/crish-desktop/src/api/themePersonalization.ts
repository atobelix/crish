/**
 * 外观主题：个性化应用逻辑。
 * 智能时光温感过渡（getDynamicSolarAdjustments）与皮肤色板注入（applyPersonalization）。
 * 依赖皮肤预设（themePresets）与类型（themeTypes）。
 */
import { applyTextContrastGuard } from './oklchColorGuard';
import { SKIN_PRESETS } from './themePresets';
import type { PersonalizationSettings, UiTheme } from './themeTypes';

/**
 * 根据当前系统时间计算智能时光过渡参数
 * 返回当前对应的自动亮度调节值（themeBrightnessAdjust）以及太阳温度混入比例（solarWarmthMix，0-1之间）
 */
export function getDynamicSolarAdjustments(mockHour?: number): {
  brightnessAdjust: number;
  solarWarmthMix: number; // 暮光色温融入比例，0.0 - 0.2
  periodLabel: string;
} {
  const now = new Date();
  const currentHour = mockHour !== undefined ? mockHour : (now.getHours() + now.getMinutes() / 60);

  // 1. 清晨苏醒 (06:00 - 09:00)：从舒适 0 档过渡到提亮 +1 档
  if (currentHour >= 6 && currentHour < 9) {
    const p = (currentHour - 6) / 3; // 0.0 -> 1.0
    return {
      brightnessAdjust: p >= 0.5 ? 1 : 0,
      solarWarmthMix: 0.05 * (1 - p), // 清晨残留微温逐渐消散
      periodLabel: '🌅 清晨苏醒：正在温和提亮界面，驱散睡意',
    };
  }
  // 2. 耀眼正午 (09:00 - 16:00)：保持在 +1 档清爽明亮
  if (currentHour >= 9 && currentHour < 16) {
    return {
      brightnessAdjust: 1,
      solarWarmthMix: 0,
      periodLabel: '☀️ 耀眼正午：高对比清爽亮白，保持最高专注力',
    };
  }
  // 3. 暮光黄昏 (16:00 - 19:00)：白天 Light 模式下温和降低亮度并调温
  if (currentHour >= 16 && currentHour < 19) {
    const p = (currentHour - 16) / 3; // 0.0 -> 1.0
    // 亮度档位由 0 渐变下降至 -4 档
    const exactAdjust = Math.round(0 - p * 4);
    // 晚霞温色混合比率：0% 渐变上升至 16%
    const warmth = 0.16 * p;
    return {
      brightnessAdjust: exactAdjust,
      solarWarmthMix: warmth,
      periodLabel: '🌇 暮光下沉：正自动下调亮度并调温，呵护视网膜',
    };
  }
  // 4. 正式切换深色模式 (19:00) 后的夜间过渡 (19:00 - 06:00 次日)
  // 夜间直接启用 Dark Theme。随着深夜降临，亮度滑块自动向下微调
  let brightness = -1;
  let periodLabel = '🌙 暮色降临：系统已切换到深色模式';
  if (currentHour >= 21 || currentHour < 2) {
    // 21:00 - 02:00: 逐渐降至最暗 -4 档（曜石黑），保护睡眠
    let p = 0;
    if (currentHour >= 21) {
      p = (currentHour - 21) / 5; // 21:00-02:00 -> 0.0 -> 1.0 (across midnight)
    } else {
      p = (currentHour + 3) / 5;  // 23:00-02:00
    }
    brightness = Math.round(-1 - p * 3);
    periodLabel = '🌌 深夜静谧：已调至极致曜石黑并过滤蓝光，祝您晚安';
  } else if (currentHour >= 2 && currentHour < 6) {
    // 02:00 - 06:00: 维持或缓和回升至 -2
    brightness = -3;
    periodLabel = '🌌 深夜静谧：极暗曜石黑模式运行中';
  }

  return {
    brightnessAdjust: brightness,
    solarWarmthMix: 0,
    periodLabel,
  };
}

export function applyPersonalization(p: PersonalizationSettings, activeTheme: 'default' | 'dark'): void {
  const root = document.documentElement;

  // 1. 应用字体调节
  root.style.setProperty('--font-size-adjust', `${p.fontSizeAdjust}px`);

  // 2. 获取皮肤配置
  let skinConfig = SKIN_PRESETS[p.skin];

  if (p.skin === 'custom') {
    const bg = p.customBg;
    const fg = p.customFg;
    const isDark = activeTheme === 'dark';

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
  }

  // ⏰ 自动时光温感过渡覆盖机制 ⏰
  let currentActiveTheme = activeTheme;
  let adjust = p.themeBrightnessAdjust || 0;
  let solarWarmthMix = 0;
  if (p.themeAutoTimeTransition) {
    const solar = getDynamicSolarAdjustments();
    adjust = solar.brightnessAdjust;
    solarWarmthMix = solar.solarWarmthMix;

    const now = new Date();
    const currentHour = now.getHours() + now.getMinutes() / 60;
    currentActiveTheme = (currentHour >= 19 || currentHour < 6) ? 'dark' : 'default';

    // Synchronize HTML attributes & body classes with currentActiveTheme
    const currentAttr = root.getAttribute('data-theme');
    if (currentAttr !== currentActiveTheme) {
      root.setAttribute('data-theme', currentActiveTheme);
      document.body.setAttribute('data-theme', currentActiveTheme);
      root.classList.toggle('theme-dark', currentActiveTheme === 'dark');
      root.classList.toggle('theme-light', currentActiveTheme !== 'dark');
      document.body.classList.toggle('theme-dark', currentActiveTheme === 'dark');
      document.body.classList.toggle('theme-light', currentActiveTheme !== 'dark');
    }
  }

  // 校验皮肤是否与激活的黑夜/白天模式契合，若预设冲突则做回落
  if (skinConfig && p.skin !== 'custom') {
    const isPresetDark = p.skin.startsWith('dark-') || p.skin === 'deep-night' || p.skin === 'aurora' || p.skin === 'cocoa' || p.skin === 'burgundy' || p.skin === 'cyber' || p.skin === 'obsidian';
    if (currentActiveTheme === 'dark' && !isPresetDark) {
      skinConfig = SKIN_PRESETS['dark-cozy'];
    } else if (currentActiveTheme === 'default' && isPresetDark) {
      skinConfig = SKIN_PRESETS['warm-gray'];
    }
  }

  if (skinConfig) {
    const isDarkPreset = currentActiveTheme === 'dark';

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
    const mixColor = skinConfig.mixColor || (isDarkPreset
      ? 'var(--text-primary)'
      : 'hsl(35, 50%, 20%)');

    // 🌟 提取并构造柔和、高亮度的动态基因色素结晶（vibrantTint），用于浅色模式下的表面和交互反馈，彻底消解刺眼橙色或过度饱和
    let vibrantTint = mixColor;
    if (!isDarkPreset) {
      const hslMatch = mixColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
      if (hslMatch) {
        const h = parseInt(hslMatch[1]!);
        const originalSat = parseInt(hslMatch[2]!);
        let sat = 45;   // 默认极温柔饱和度（如暖灰、奶油、金沙等）
        let light = 90; // 默认极轻盈高明度，防刺眼/发黄
        if (originalSat <= 10) {
          // 极简纸质 / 经典浅灰 等无彩色或超低饱和度的灰系主题
          sat = 0;
          light = 92;   // 保持纯净雅致的浅灰色
        } else if (h >= 30 && h <= 45) {
          // 护眼暖灰 / 杏仁奶油 / 金沙流光
          sat = 45;
          light = 90;
        } else if (h >= 100 && h <= 150) {
          // 抹茶拿铁
          sat = 40;
          light = 91;
        } else if (h >= 160 && h <= 210) {
          // 冰川薄荷
          sat = 45;
          light = 92;
        } else if (h >= 270 && h <= 320) {
          // 落樱微风
          sat = 55;
          light = 92;
        }
        vibrantTint = `hsl(${h}, ${sat}%, ${light}%)`;
      }
    }

    // 🌟 依据白天与黑夜自适应的调节终点，彻底破除死黑 🌟
    let mixTarget = adjust > 0 ? 'hsl(0 0% 100%)' : 'hsl(0 0% 0%)';
    if (p.themeBrightnessVibrant) {
      const tintTarget = `color-mix(in srgb, ${mixColor} 8%, hsl(0 0% 100%))`;
      const shadeTarget = `color-mix(in srgb, ${mixColor} 14%, hsl(0 0% 0%))`;
      mixTarget = adjust > 0 ? tintTarget : shadeTarget;
    }

    // 浅色特有：极富人文温润质感的黄金海岸/暖铜纸温混色终点（30% 饱和度、45% 亮度，彻底消灭阴暗灰色，让调暗充满温馨阳光感，在哪一级都不脏不沉闷！）
    const twilightTarget = `color-mix(in srgb, ${mixColor} 15%, hsl(34, 30%, 45%))`;

    // 💡 自动温感色温融入 (仅在显式开启且非中性预设下生效)
    if (solarWarmthMix > 0 && !isDarkPreset && p.skin !== 'warm-gray' && p.skin !== 'paper' && p.skin !== 'classic-gray') {
      const sunsetTone = 'hsl(30, 40%, 90%)';
      bgPrimary = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgPrimary})`;
      bgSecondary = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgSecondary})`;
      bgTertiary = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgTertiary})`;
      bgCard = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgCard})`;
      bgElevated = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgElevated})`;
      vibrantTint = `color-mix(in srgb, hsl(30, 50%, 65%) ${solarWarmthMix * 100}%, ${vibrantTint})`;
    }

    // 💡 护眼暖灰：100% 纯 HSL 数学公式驱动调色板与 2.4% ~ 8% 亮度微调阶梯
    if (!isDarkPreset && p.skin === 'warm-gray') {
      const lPrimary = Number((95.2 + adjust * 0.6).toFixed(2));
      const lSecondary = Number((lPrimary - 2.4).toFixed(2));
      const lTertiary = Number((lPrimary - 4.8).toFixed(2));

      bgPrimary = `hsl(35 8% ${lPrimary}%)`;
      bgSecondary = `hsl(35 8% ${lSecondary}%)`;
      bgTertiary = `hsl(35 8% ${lTertiary}%)`;
      bgCard = 'hsl(0 0% 100%)';
      bgElevated = 'hsl(0 0% 100%)';
      shellChromeBg = `hsl(35 8% ${lSecondary}%)`;
      borderColor = 'hsl(35 10% 86%)';
      borderSubtle = 'hsl(30 6% 93.8%)';
    } else if (adjust !== 0) {
      if (isDarkPreset) {
        if (adjust > 0) {
          // 深色主题调亮
          const pBase = adjust * 3.5;
          const pSec = adjust * 2.8;
          const pElev = adjust * 2.0; // 越往上层越平缓，防止过曝融为一体
          const pChrome = adjust * 3.0;

          bgPrimary = `color-mix(in srgb, ${bgPrimary} ${100 - pBase}%, ${mixTarget})`;
          bgSecondary = `color-mix(in srgb, ${bgSecondary} ${100 - pSec}%, ${mixTarget})`;
          bgTertiary = `color-mix(in srgb, ${bgTertiary} ${100 - pSec}%, ${mixTarget})`;
          bgCard = `color-mix(in srgb, ${bgCard} ${100 - pElev}%, ${mixTarget})`;
          bgElevated = `color-mix(in srgb, ${bgElevated} ${100 - pElev}%, ${mixTarget})`;
          shellChromeBg = `color-mix(in srgb, ${shellChromeBg} ${100 - pChrome}%, ${mixTarget})`;

          borderColor = `color-mix(in srgb, ${borderColor} ${100 - pSec}%, ${mixTarget})`;
          borderSubtle = `color-mix(in srgb, ${borderSubtle} ${100 - pSec}%, ${mixTarget})`;

          // 对比度补偿：主文本稍许变白，增强辨识度
          textPrimary = `color-mix(in srgb, ${textPrimary} ${100 - adjust * 1.5}%, hsl(0 0% 100%))`;
        } else {
          // 深色主题调暗
          const pBase = Math.abs(adjust) * 3.5; // 基础背景走向极致深邃
          const pSec = Math.abs(adjust) * 2.3;  // 输入框与侧栏降得慢一些，保持轮廓
          const pElev = Math.abs(adjust) * 1.5; // 浮层卡片更慢，凸显高级层次感
          const pChrome = Math.abs(adjust) * 3.0;

          bgPrimary = `color-mix(in srgb, ${bgPrimary} ${100 - pBase}%, ${mixTarget})`;
          bgSecondary = `color-mix(in srgb, ${bgSecondary} ${100 - pSec}%, ${mixTarget})`;
          bgTertiary = `color-mix(in srgb, ${bgTertiary} ${100 - pSec}%, ${mixTarget})`;
          bgCard = `color-mix(in srgb, ${bgCard} ${100 - pElev}%, ${mixTarget})`;
          bgElevated = `color-mix(in srgb, ${bgElevated} ${100 - pElev}%, ${mixTarget})`;
          shellChromeBg = `color-mix(in srgb, ${shellChromeBg} ${100 - pChrome}%, ${mixTarget})`;

          borderColor = `color-mix(in srgb, ${borderColor} ${100 - pSec}%, ${mixTarget})`;
          borderSubtle = `color-mix(in srgb, ${borderSubtle} ${100 - pSec}%, ${mixTarget})`;

          // 对比度补偿：文本跟背景适当柔化，极度舒适护眼
          textPrimary = `color-mix(in srgb, ${textPrimary} ${100 - Math.abs(adjust) * 1.0}%, ${bgPrimary})`;
        }
      } else {
        if (adjust > 0) {
          // 浅色主题调亮：加速拉向纯透高净白
          const pBase = adjust * 4.5;
          const pSec = adjust * 2.5;  // 侧栏与主区拉开倍率差
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
          // 浅色主题调暗：🌟 应用非线性对比拉伸算法，消解发闷 🌟
          const pBase = Math.abs(adjust) * 3.0; // 主背景变暗极温和 (由 3.2 调至 3.0)
          const pSec = Math.abs(adjust) * 4.8;  // 侧栏/次背景变暗 (由 5.8 调至 4.8)，维持更高辨识度轮廓
          const pElev = Math.abs(adjust) * 1.2; // 卡片浮层保持高亮度显眼，极度克制暗化
          const pChrome = Math.abs(adjust) * 3.8;

          bgPrimary = `color-mix(in srgb, ${bgPrimary} ${100 - pBase}%, ${twilightTarget})`;
          bgSecondary = `color-mix(in srgb, ${bgSecondary} ${100 - pSec}%, ${twilightTarget})`;
          bgTertiary = `color-mix(in srgb, ${bgTertiary} ${100 - pSec}%, ${twilightTarget})`;
          bgCard = `color-mix(in srgb, ${bgCard} ${100 - pElev}%, ${twilightTarget})`;
          bgElevated = `color-mix(in srgb, ${bgElevated} ${100 - pElev}%, ${twilightTarget})`;
          shellChromeBg = `color-mix(in srgb, ${shellChromeBg} ${100 - pChrome}%, ${twilightTarget})`;

          borderColor = `color-mix(in srgb, ${borderColor} ${100 - pSec}%, ${twilightTarget})`;
          borderSubtle = `color-mix(in srgb, ${borderSubtle} ${100 - pSec}%, ${twilightTarget})`;

          // 对比度补偿：字色向深色靠拢，增强黑暗下的对比
          textPrimary = `color-mix(in srgb, ${textPrimary} ${100 - Math.abs(adjust) * 1.8}%, hsl(0 0% 7%))`;
        }
      }
    }

    if (!isDarkPreset && p.skin === 'cream') {
      bgCard = `color-mix(in srgb, ${vibrantTint} 6.0%, ${bgCard})`;
      bgElevated = `color-mix(in srgb, ${vibrantTint} 10.0%, ${bgCard})`;
    }

    // --- 🚨 动态注入 Diff/状态高亮色对比度补偿变量 🚨 ---
    let greenLight = 'var(--accent-green-light)';
    let redLight = 'var(--accent-red-light)';
    if (!isDarkPreset) {
      // 🌟 浅色模式下采用极净的高饱和高对比混色：直接混入 `hsl(0 0% 100%)` 纯白，拒绝混合变暗的泥脏底色！ 🌟
      // 增加饱和度比例（绿 15.5%，红 12.5%），确保底色极其清新透亮，在黄色/Cream主题或最暗微调都绝对鲜亮夺目！
      greenLight = `color-mix(in srgb, var(--accent-green, hsl(142 35% 42%)) 15.5%, hsl(0 0% 100%))`;
      redLight = `color-mix(in srgb, var(--accent-red, hsl(0 55% 55%)) 12.5%, hsl(0 0% 100%))`;
    } else {
      // 深色模式默认基于 bgSecondary
      if (adjust < 0) {
        const pct = Math.abs(adjust) * 1.2;
        greenLight = `color-mix(in srgb, var(--accent-green, hsl(142 71% 45%)) ${8 + pct}%, ${bgSecondary})`;
        redLight = `color-mix(in srgb, var(--accent-red, hsl(0 84% 60%)) ${8 + pct}%, ${bgSecondary})`;
      } else {
        greenLight = `color-mix(in srgb, var(--accent-green, hsl(142 71% 45%)) 8%, ${bgPrimary})`;
        redLight = `color-mix(in srgb, var(--accent-red, hsl(0 84% 60%)) 8%, ${bgPrimary})`;
      }
    }
    root.style.setProperty('--accent-green-light-adaptive', greenLight);
    root.style.setProperty('--accent-red-light-adaptive', redLight);

    root.style.setProperty('--bg-primary', bgPrimary);
    root.style.setProperty('--bg-secondary', bgSecondary);
    root.style.setProperty('--bg-tertiary', bgTertiary);
    root.style.setProperty('--bg-card', bgCard);
    root.style.setProperty('--bg-elevated', bgElevated);
    root.style.setProperty('--shell-chrome-bg', shellChromeBg);
    root.style.setProperty('--text-primary', textPrimary);
    root.style.setProperty('--text-secondary', textSecondary);

    const tertiaryMix = isDarkPreset
      ? `color-mix(in srgb, ${textSecondary} 62%, transparent)`
      : `color-mix(in srgb, ${textSecondary} 70%, transparent)`;
    root.style.setProperty('--text-tertiary', tertiaryMix);

    root.style.setProperty('--border-color', borderColor);
    root.style.setProperty('--border-subtle', borderSubtle);

    root.style.setProperty('--bg-workspace', bgPrimary);
    root.style.setProperty('--shell-inset-bg', bgPrimary);

    root.style.setProperty('--control-mix-color', mixColor);

    // --- 🌟 完美的 Opaque 输入框/按钮背景跟随：在浅色模式下采用高饱黄色调作为混色基底，让按钮与 prompt 卡片 hover 时极其轻柔温润，彻底消灭重黑脏色！ 🌟 ---
    // 百分比与 tokens.css 静态真源对齐（light 4/4/8%、dark 5/6.5/9.5%），仅保留皮肤引擎基底差异
    const controlSoftBase = isDarkPreset ? mixColor : vibrantTint;
    const softBgPct = isDarkPreset ? '5%' : '4%';
    const softHoverPct = isDarkPreset ? '6.5%' : '4%';
    const softActivePct = isDarkPreset ? '9.5%' : '8%';
    root.style.setProperty('--control-soft-bg', `color-mix(in srgb, ${controlSoftBase} ${softBgPct}, ${bgSecondary})`);
    root.style.setProperty('--control-soft-bg-hover', `color-mix(in srgb, ${controlSoftBase} ${softHoverPct}, ${bgSecondary})`);
    root.style.setProperty('--control-soft-bg-active', `color-mix(in srgb, ${controlSoftBase} ${softActivePct}, ${bgSecondary})`);

    // --- 🌟 对话输入框背景：浅色模式下始终保持纯净纸面白底 bgCard (hsl(0 0% 100%)) 🌟 ---
    let composerBg = skinConfig.composerBg;
    if (!isDarkPreset) {
      if (!composerBg) {
        composerBg = bgCard || 'hsl(0 0% 100%)';
      }
    } else {
      if (!composerBg) {
        composerBg = bgSecondary;
      }
    }
    root.style.setProperty('--composer-bg', composerBg);

    const termBg = isDarkPreset ? (bgCard || '#0c0c0c') : (bgCard || '#ffffff');
    root.style.setProperty('--terminal-bg', termBg);
    root.style.setProperty('--terminal-fg', textPrimary);
    root.style.setProperty('--terminal-cmd', textPrimary);

    // Dynamic OKLCH contrast guard to automatically enforce WCAG AA contrast ratios
    applyTextContrastGuard(bgPrimary, isDarkPreset, {
      isCustomSkin: p.skin === 'custom',
      explicitTextPrimary: textPrimary,
    });
  } else {
    // 移除属性，使用 tokens.css 默认值
    root.style.removeProperty('--bg-primary');
    root.style.removeProperty('--bg-secondary');
    root.style.removeProperty('--bg-tertiary');
    root.style.removeProperty('--bg-card');
    root.style.removeProperty('--bg-elevated');
    root.style.removeProperty('--shell-chrome-bg');
    root.style.removeProperty('--text-primary');
    root.style.removeProperty('--text-secondary');
    root.style.removeProperty('--text-tertiary');
    root.style.removeProperty('--border-color');
    root.style.removeProperty('--border-subtle');
    root.style.removeProperty('--bg-workspace');
    root.style.removeProperty('--shell-inset-bg');
    root.style.removeProperty('--control-mix-color');
    root.style.removeProperty('--control-soft-bg');
    root.style.removeProperty('--control-soft-bg-hover');
    root.style.removeProperty('--control-soft-bg-active');
    root.style.removeProperty('--composer-bg');
    root.style.removeProperty('--terminal-bg');
    root.style.removeProperty('--terminal-fg');
    root.style.removeProperty('--terminal-cmd');
  }
}
