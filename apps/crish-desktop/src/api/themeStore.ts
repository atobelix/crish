import { applyTextContrastGuard } from './oklchColorGuard';

/**
 * 外观主题：应用 DOM + 本地记忆。
 * - 独立 key `crish_theme`，启动时立刻读，不依赖 settings 异步
 * - 同步写入 settings.theme，设置页与其它入口一致
 */

export type UiTheme = 'default' | 'dark';

const THEME_KEY = 'crish_theme';
const SETTINGS_KEY = 'crish_settings';
const SETTINGS_KEY_LEGACY = 'conex_pi_settings';

export function normalizeTheme(raw: unknown): UiTheme {
  if (raw === 'dark') return 'dark';
  // light / default / 其它一律浅色
  return 'default';
}

export function readStoredTheme(): UiTheme {
  try {
    const direct = localStorage.getItem(THEME_KEY);
    if (direct === 'dark' || direct === 'default' || direct === 'light') {
      return normalizeTheme(direct === 'light' ? 'default' : direct);
    }
  } catch {
    /* ignore */
  }
  try {
    const raw =
      localStorage.getItem(SETTINGS_KEY) || localStorage.getItem(SETTINGS_KEY_LEGACY);
    if (raw) {
      const parsed = JSON.parse(raw) as { theme?: string };
      if (parsed?.theme) return normalizeTheme(parsed.theme);
    }
  } catch {
    /* ignore */
  }
  return 'default';
}

/** 写独立 key + 合并进 settings JSON */
export function persistTheme(theme: UiTheme): void {
  const t = normalizeTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
  try {
    const raw =
      localStorage.getItem(SETTINGS_KEY) || localStorage.getItem(SETTINGS_KEY_LEGACY);
    const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    current.theme = t;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
}

/**
 * 应用到 html（变量源）+ body（兼容旧选择器）。
 * 必须在首屏 paint 前或切换时同步调用。
 */
export function applyTheme(theme: UiTheme | string): UiTheme {
  const t = normalizeTheme(theme);
  const html = document.documentElement;
  html.setAttribute('data-theme', t);
  document.body.setAttribute('data-theme', t);
  // 同步 class，便于排查与扩展
  html.classList.toggle('theme-dark', t === 'dark');
  html.classList.toggle('theme-light', t !== 'dark');
  document.body.classList.toggle('theme-dark', t === 'dark');
  document.body.classList.toggle('theme-light', t !== 'dark');

  // Automatically apply stored personalization to prevent styling loss
  try {
    const p = readStoredPersonalization();
    applyPersonalization(p, t);
  } catch {
    /* ignore during early boot or SSR */
  }

  return t;
}

export interface PersonalizationSettings {
  skin: string;
  customBg: string;
  customFg: string;
  fontSizeAdjust: number;
  themeBrightnessAdjust?: number; // 范围从 -5 到 +5
  themeBrightnessVibrant?: boolean; // 是否开启氛围色彩融合模式（有色高光/暗影）
  themeAutoTimeTransition?: boolean; // 新增：是否开启智能时光温感过渡模式
}

export function readStoredPersonalization(): PersonalizationSettings {
  try {
    const skin = localStorage.getItem('crish_theme_skin') || 'warm-gray';
    const customBg = localStorage.getItem('crish_theme_custom_bg') || '#f4f3f0';
    const customFg = localStorage.getItem('crish_theme_custom_fg') || '#111111';
    const fsAdjustRaw = localStorage.getItem('crish_font_size_adjust');
    const fontSizeAdjust = fsAdjustRaw ? parseInt(fsAdjustRaw, 10) : 0;
    const brightnessRaw = localStorage.getItem('crish_theme_brightness_adjust');
    const themeBrightnessAdjust = brightnessRaw ? parseInt(brightnessRaw, 10) : 0;
    const vibrantRaw = localStorage.getItem('crish_theme_brightness_vibrant');
    const themeBrightnessVibrant = vibrantRaw === 'true';
    const autoTimeRaw = localStorage.getItem('crish_theme_brightness_auto_time');
    const themeAutoTimeTransition = autoTimeRaw === 'true';
    return { skin, customBg, customFg, fontSizeAdjust, themeBrightnessAdjust, themeBrightnessVibrant, themeAutoTimeTransition };
  } catch {
    return { skin: 'warm-gray', customBg: '#f4f3f0', customFg: '#111111', fontSizeAdjust: 0, themeBrightnessAdjust: 0, themeBrightnessVibrant: false, themeAutoTimeTransition: false };
  }
}

export function writeStoredPersonalization(p: PersonalizationSettings): void {
  try {
    localStorage.setItem('crish_theme_skin', p.skin);
    localStorage.setItem('crish_theme_custom_bg', p.customBg);
    localStorage.setItem('crish_theme_custom_fg', p.customFg);
    localStorage.setItem('crish_font_size_adjust', String(p.fontSizeAdjust));
    localStorage.setItem('crish_theme_brightness_adjust', String(p.themeBrightnessAdjust ?? 0));
    localStorage.setItem('crish_theme_brightness_vibrant', p.themeBrightnessVibrant ? 'true' : 'false');
    localStorage.setItem('crish_theme_brightness_auto_time', p.themeAutoTimeTransition ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

export const SKIN_PRESETS: Record<string, {
  name: string;
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgCard: string;
  bgElevated: string;
  shellChromeBg: string;
  textPrimary: string;
  textSecondary: string;
  borderColor: string;
  borderSubtle: string;
  mixColor?: string;
  composerBg?: string;
}> = {
  'warm-gray': {
    name: '护眼暖灰',
    bgPrimary: 'hsl(35, 12%, 95.0%)',
    bgSecondary: 'hsl(35, 12%, 92.0%)',
    bgTertiary: 'hsl(35, 12%, 89.0%)',
    bgCard: 'hsl(35, 10%, 96.5%)',
    bgElevated: 'hsl(35, 8%, 98.5%)',
    shellChromeBg: 'color-mix(in srgb, hsl(35, 12%, 92.0%) 92%, hsl(35, 20%, 80%) 8%)',
    textPrimary: '#111111',
    textSecondary: '#555555',
    borderColor: 'hsl(35, 10%, 86.0%)',
    borderSubtle: 'hsl(35, 8%, 91.0%)',
    mixColor: 'hsl(35, 40%, 30%)',
  },
  'cream': {
    name: '杏仁奶油',
    bgPrimary: 'color-mix(in srgb, var(--accent-orange) 8%, #ffffff)',
    bgSecondary: 'color-mix(in srgb, var(--accent-orange) 12%, #ffffff)',
    bgTertiary: 'color-mix(in srgb, var(--accent-orange) 15%, #ffffff)',
    bgCard: 'color-mix(in srgb, var(--accent-orange) 6%, #ffffff)',
    bgElevated: 'color-mix(in srgb, var(--accent-orange) 10%, #ffffff)',
    shellChromeBg: 'color-mix(in srgb, var(--accent-orange) 18%, #ffffff)',
    textPrimary: '#2a2415',
    textSecondary: '#6b5f45',
    borderColor: 'color-mix(in srgb, var(--accent-orange) 12%, #e5dfcf)',
    borderSubtle: 'color-mix(in srgb, var(--accent-orange) 6%, #efeada)',
    mixColor: 'hsl(30, 45%, 32%)',
    composerBg: 'color-mix(in srgb, var(--accent-orange) 5.5%, #ffffff)',
  },
  'paper': {
    name: '极简纸质',
    bgPrimary: '#f5f5f5',
    bgSecondary: '#fafafa',
    bgTertiary: '#ebebeb',
    bgCard: '#fafafa',
    bgElevated: '#fafafa',
    shellChromeBg: 'color-mix(in srgb, #fafafa 82%, #d0d0d0 18%)',
    textPrimary: '#1a1a1a',
    textSecondary: '#606060',
    borderColor: '#e0e0e0',
    borderSubtle: '#eeeeee',
    mixColor: 'hsl(0, 0%, 25%)',
  },
  'classic-gray': {
    name: '经典浅灰',
    bgPrimary: '#f1f3f5',
    bgSecondary: '#f8f9fa',
    bgTertiary: '#e9ecef',
    bgCard: '#f8f9fa',
    bgElevated: '#f8f9fa',
    shellChromeBg: 'color-mix(in srgb, #f8f9fa 82%, #ced4da 18%)',
    textPrimary: '#212529',
    textSecondary: '#495057',
    borderColor: '#dee2e6',
    borderSubtle: '#e9ecef',
    mixColor: 'hsl(210, 10%, 30%)',
  },
  'sakura': {
    name: '落樱微风',
    bgPrimary: 'color-mix(in srgb, var(--accent-orange) 1.5%, color-mix(in srgb, #9d4edd 3.5%, #ffffff))',
    bgSecondary: 'color-mix(in srgb, var(--accent-orange) 2%, color-mix(in srgb, #9d4edd 7%, #ffffff))',
    bgTertiary: 'color-mix(in srgb, var(--accent-orange) 3%, color-mix(in srgb, #9d4edd 10%, #ffffff))',
    bgCard: 'color-mix(in srgb, #9d4edd 2%, #ffffff)',
    bgElevated: '#ffffff',
    shellChromeBg: 'color-mix(in srgb, #9d4edd 14%, #ffffff)',
    textPrimary: '#3c1642',
    textSecondary: '#7a528a',
    borderColor: 'color-mix(in srgb, #9d4edd 9%, #e8e0ec)',
    borderSubtle: 'color-mix(in srgb, #9d4edd 4%, #f4eff8)',
    mixColor: 'hsl(285, 30%, 35%)',
    composerBg: 'color-mix(in srgb, #9d4edd 1.5%, #ffffff)',
  },
  'matcha': {
    name: '抹茶拿铁',
    bgPrimary: 'color-mix(in srgb, var(--accent-orange) 2.5%, color-mix(in srgb, #2ec4b6 3.5%, #ffffff))',
    bgSecondary: 'color-mix(in srgb, var(--accent-orange) 3%, color-mix(in srgb, #2ec4b6 7%, #ffffff))',
    bgTertiary: 'color-mix(in srgb, var(--accent-orange) 4%, color-mix(in srgb, #2ec4b6 11%, #ffffff))',
    bgCard: 'color-mix(in srgb, #2ec4b6 2.5%, #ffffff)',
    bgElevated: '#ffffff',
    shellChromeBg: 'color-mix(in srgb, #2ec4b6 14%, #ffffff)',
    textPrimary: '#1b3022',
    textSecondary: '#4f6d55',
    borderColor: 'color-mix(in srgb, #2ec4b6 10%, #dfede2)',
    borderSubtle: 'color-mix(in srgb, var(--accent-orange) 5%, #eff6f1)',
    mixColor: 'hsl(120, 20%, 30%)',
    composerBg: 'color-mix(in srgb, #2ec4b6 1.5%, #ffffff)',
  },
  'glacier': {
    name: '冰川薄荷',
    bgPrimary: 'color-mix(in srgb, #00f5d4 2%, #f5fafb)',
    bgSecondary: 'color-mix(in srgb, #00f5d4 5%, #eff6f8)',
    bgTertiary: 'color-mix(in srgb, #00f5d4 8%, #e3eff2)',
    bgCard: 'color-mix(in srgb, #00f5d4 2.5%, #ffffff)',
    bgElevated: '#ffffff',
    shellChromeBg: 'color-mix(in srgb, #00f5d4 12%, #f0f7f9)',
    textPrimary: '#0a2e2b',
    textSecondary: '#3d706c',
    borderColor: 'color-mix(in srgb, #00f5d4 8%, #d8e6e8)',
    borderSubtle: 'color-mix(in srgb, #00f5d4 4%, #e9f2f4)',
    mixColor: 'hsl(175, 30%, 30%)',
    composerBg: 'color-mix(in srgb, #00f5d4 1.5%, #ffffff)',
  },
  'pearl': {
    name: '金沙流光',
    bgPrimary: 'color-mix(in srgb, var(--accent-orange) 3.5%, color-mix(in srgb, #ffe5ec 1.5%, #faf6f0))',
    bgSecondary: 'color-mix(in srgb, var(--accent-orange) 6%, color-mix(in srgb, #ffe5ec 2.5%, #f4eee2))',
    bgTertiary: 'color-mix(in srgb, var(--accent-orange) 9%, color-mix(in srgb, #ffe5ec 3.5%, #ebe2d3))',
    bgCard: 'color-mix(in srgb, var(--accent-orange) 3%, #ffffff)',
    bgElevated: '#ffffff',
    shellChromeBg: 'color-mix(in srgb, var(--accent-orange) 11%, #f0e6d6)',
    textPrimary: '#332516',
    textSecondary: '#7c6553',
    borderColor: 'color-mix(in srgb, var(--accent-orange) 7%, #e5dbc9)',
    borderSubtle: 'color-mix(in srgb, var(--accent-orange) 3.5%, #f2ebdf)',
    mixColor: 'hsl(30, 35%, 28%)',
    composerBg: 'color-mix(in srgb, var(--accent-orange) 2.5%, #ffffff)',
  },
  'dark-cozy': {
    name: '护眼暗灰',
    bgPrimary: '#1b1b1b',
    bgSecondary: '#242424',
    bgTertiary: '#1e1e1e',
    bgCard: '#242424',
    bgElevated: '#242424',
    shellChromeBg: '#151515',
    textPrimary: '#dddddd',
    textSecondary: '#aaaaaa',
    borderColor: '#333333',
    borderSubtle: '#2a2a2a',
    mixColor: 'hsl(0, 0%, 75%)',
  },
  'deep-night': {
    name: '深邃夜空',
    bgPrimary: '#0f172a',
    bgSecondary: '#1e293b',
    bgTertiary: '#131c2e',
    bgCard: '#1e293b',
    bgElevated: '#1e293b',
    shellChromeBg: '#0b0f19',
    textPrimary: '#f1f5f9',
    textSecondary: '#94a3b8',
    borderColor: '#334155',
    borderSubtle: '#1e293b',
    mixColor: 'hsl(217, 30%, 75%)',
  },
  'dark-forest': {
    name: '森林绿影',
    bgPrimary: '#121c17',
    bgSecondary: '#1a2720',
    bgTertiary: '#15211b',
    bgCard: '#1a2720',
    bgElevated: '#1f2e26',
    shellChromeBg: '#0d1511',
    textPrimary: '#e2f0e9',
    textSecondary: '#8da399',
    borderColor: '#263a30',
    borderSubtle: '#1d2e25',
    mixColor: 'hsl(145, 20%, 75%)',
  },
  'aurora': {
    name: '北欧极光',
    bgPrimary: '#0a1a1b',
    bgSecondary: '#132627',
    bgTertiary: '#0e2021',
    bgCard: '#132627',
    bgElevated: '#173132',
    shellChromeBg: '#071314',
    textPrimary: '#e2f4f5',
    textSecondary: '#7ba0a2',
    borderColor: '#1b3a3b',
    borderSubtle: '#132e2f',
    mixColor: 'hsl(180, 25%, 70%)',
  },
  'cocoa': {
    name: '可可暗香',
    bgPrimary: '#1a1615',
    bgSecondary: '#241e1c',
    bgTertiary: '#1d1917',
    bgCard: '#241e1c',
    bgElevated: '#2d2522',
    shellChromeBg: '#120e0d',
    textPrimary: '#f4efe9',
    textSecondary: '#ab9b95',
    borderColor: '#382d29',
    borderSubtle: '#2b221f',
    mixColor: 'hsl(25, 25%, 70%)',
  },
  'burgundy': {
    name: '暗红丝绒',
    bgPrimary: '#1a0f12',
    bgSecondary: '#25171b',
    bgTertiary: '#1e1215',
    bgCard: '#25171b',
    bgElevated: '#2d1e23',
    shellChromeBg: '#12090b',
    textPrimary: '#faecf0',
    textSecondary: '#b59da2',
    borderColor: '#3e282c',
    borderSubtle: '#2f1d21',
    mixColor: 'hsl(345, 20%, 72%)',
  },
  'cyber': {
    name: '赛博星空',
    bgPrimary: '#110f1c',
    bgSecondary: '#1a172a',
    bgTertiary: '#141221',
    bgCard: '#1a172a',
    bgElevated: '#221f36',
    shellChromeBg: '#0a0812',
    textPrimary: '#f1effa',
    textSecondary: '#9b95b8',
    borderColor: '#2d2747',
    borderSubtle: '#1f1b32',
    mixColor: 'hsl(255, 25%, 72%)',
  },
  'obsidian': {
    name: '黑曜石墨',
    bgPrimary: '#151718',
    bgSecondary: '#1e2022',
    bgTertiary: '#191a1c',
    bgCard: '#1e2022',
    bgElevated: '#25272a',
    shellChromeBg: '#0e1011',
    textPrimary: '#f1f2f3',
    textSecondary: '#9ea1a3',
    borderColor: '#2c2e30',
    borderSubtle: '#212325',
    mixColor: 'hsl(200, 5%, 75%)',
  },
};

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
        ? `color-mix(in srgb, ${bg} 85%, #000 15%)` 
        : `color-mix(in srgb, ${bg} 95%, #fff 5%)`,
      bgTertiary: `color-mix(in srgb, ${bg} 90%, ${fg} 10%)`,
      bgCard: isDark
        ? `color-mix(in srgb, ${bg} 90%, #fff 10%)`
        : `color-mix(in srgb, ${bg} 96%, #fff 4%)`,
      bgElevated: isDark
        ? `color-mix(in srgb, ${bg} 88%, #fff 12%)`
        : `color-mix(in srgb, ${bg} 96%, #fff 4%)`,
      shellChromeBg: isDark
        ? `color-mix(in srgb, ${bg} 85%, #000 15%)`
        : `color-mix(in srgb, ${bg} 78%, #b8b4ac 22%)`,
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
  let solarLabel = '';

  if (p.themeAutoTimeTransition) {
    const solar = getDynamicSolarAdjustments();
    adjust = solar.brightnessAdjust;
    solarWarmthMix = solar.solarWarmthMix;
    solarLabel = solar.periodLabel;

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
    const isDarkPreset = p.skin.startsWith('dark-') || p.skin === 'deep-night' || p.skin === 'aurora' || p.skin === 'cocoa' || p.skin === 'burgundy' || p.skin === 'cyber' || p.skin === 'obsidian' || currentActiveTheme === 'dark';
    
    let bgPrimary = skinConfig.bgPrimary;
    let bgSecondary = skinConfig.bgSecondary;
    let bgTertiary = skinConfig.bgTertiary;
    let bgCard = skinConfig.bgCard;
    let bgElevated = skinConfig.bgElevated;
    let shellChromeBg = skinConfig.shellChromeBg;
    let textPrimary = skinConfig.textPrimary;
    let textSecondary = skinConfig.textSecondary;
    let borderColor = skinConfig.borderColor;
    let borderSubtle = skinConfig.borderSubtle;
    let mixColor = skinConfig.mixColor || (isDarkPreset 
      ? 'var(--text-primary)' 
      : 'hsl(35, 50%, 20%)');

    // 🌟 提取并构造柔和、高亮度的动态基因色素结晶（vibrantTint），用于浅色模式下的表面和交互反馈，彻底消解刺眼橙色或过度饱和
    let vibrantTint = mixColor;
    if (!isDarkPreset) {
      const hslMatch = mixColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
      if (hslMatch) {
        const h = parseInt(hslMatch[1]);
        const originalSat = parseInt(hslMatch[2]);
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
    let mixTarget = adjust > 0 ? '#ffffff' : '#000000';
    if (p.themeBrightnessVibrant) {
      const tintTarget = `color-mix(in srgb, ${mixColor} 8%, #ffffff)`;
      const shadeTarget = `color-mix(in srgb, ${mixColor} 14%, #000000)`;
      mixTarget = adjust > 0 ? tintTarget : shadeTarget;
    }

    // 浅色特有：极富人文温润质感的黄金海岸/暖铜纸温混色终点（30% 饱和度、45% 亮度，彻底消灭阴暗灰色，让调暗充满温馨阳光感，在哪一级都不脏不沉闷！）
    const twilightTarget = `color-mix(in srgb, ${mixColor} 15%, hsl(34, 30%, 45%))`;

    // 💡 自动温感色温融入 (仅浅色模式下生效)
    if (solarWarmthMix > 0 && !isDarkPreset) {
      const sunsetTone = 'hsl(30, 40%, 90%)';
      bgPrimary = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgPrimary})`;
      bgSecondary = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgSecondary})`;
      bgTertiary = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgTertiary})`;
      bgCard = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgCard})`;
      bgElevated = `color-mix(in srgb, ${sunsetTone} ${solarWarmthMix * 100}%, ${bgElevated})`;
      vibrantTint = `color-mix(in srgb, hsl(30, 50%, 65%) ${solarWarmthMix * 100}%, ${vibrantTint})`;
    }

    // 💡 默认 0 档“完全保真”显示原有预设样式，展现最净朗的原汁原味色调（不叠加任何灰色或变暗叠加）

    if (adjust !== 0) {
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
          textPrimary = `color-mix(in srgb, ${textPrimary} ${100 - adjust * 1.5}%, #ffffff)`;
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

          bgPrimary = `color-mix(in srgb, ${bgPrimary} ${100 - pBase}%, #ffffff)`;
          bgSecondary = `color-mix(in srgb, ${bgSecondary} ${100 - pSec}%, #ffffff)`;
          bgTertiary = `color-mix(in srgb, ${bgTertiary} ${100 - pSec}%, #ffffff)`;
          bgCard = `color-mix(in srgb, ${bgCard} ${100 - pElev}%, #ffffff)`;
          bgElevated = `color-mix(in srgb, ${bgElevated} ${100 - pElev}%, #ffffff)`;
          shellChromeBg = `color-mix(in srgb, ${shellChromeBg} ${100 - pChrome}%, #ffffff)`;
          
          borderColor = `color-mix(in srgb, ${borderColor} ${100 - pSec}%, #ffffff)`;
          borderSubtle = `color-mix(in srgb, ${borderSubtle} ${100 - pSec}%, #ffffff)`;
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
          textPrimary = `color-mix(in srgb, ${textPrimary} ${100 - Math.abs(adjust) * 1.8}%, #111111)`;
        }
      }
    }

    if (!isDarkPreset && p.skin !== 'cream') {
      // 🌟 浅色模式表面层级重塑：
      // 1. 卡片背景（bgCard）混入 10.0% 的温润色彩结晶，呈现极为素雅高级的轻暖白。
      // 2. 下拉/级联选择面板（bgElevated）混入 16.0% 的温润色彩结晶到 bgCard 基础中！
      bgCard = `color-mix(in srgb, ${vibrantTint} 10.0%, ${bgCard})`;
      bgElevated = `color-mix(in srgb, ${vibrantTint} 16.0%, ${bgCard})`;
    }

    // --- 🚨 动态注入 Diff/状态高亮色对比度补偿变量 🚨 ---
    let greenLight = 'var(--accent-green-light)';
    let redLight = 'var(--accent-red-light)';
    if (!isDarkPreset) {
      // 🌟 浅色模式下采用极净的高饱和高对比混色：直接混入 `#ffffff` 纯白，拒绝混合变暗的泥脏底色！ 🌟
      // 增加饱和度比例（绿 15.5%，红 12.5%），确保底色极其清新透亮，在黄色/Cream主题或最暗微调都绝对鲜亮夺目！
      greenLight = `color-mix(in srgb, var(--accent-green, #16a34a) 15.5%, #ffffff)`;
      redLight = `color-mix(in srgb, var(--accent-red, #dc2626) 12.5%, #ffffff)`;
    } else {
      // 深色模式默认基于 bgSecondary
      if (adjust < 0) {
        const pct = Math.abs(adjust) * 1.2;
        greenLight = `color-mix(in srgb, var(--accent-green, #22c55e) ${8 + pct}%, ${bgSecondary})`;
        redLight = `color-mix(in srgb, var(--accent-red, #ef4444) ${8 + pct}%, ${bgSecondary})`;
      } else {
        greenLight = `color-mix(in srgb, var(--accent-green, #22c55e) 8%, ${bgPrimary})`;
        redLight = `color-mix(in srgb, var(--accent-red, #ef4444) 8%, ${bgPrimary})`;
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
    
    // --- 🌟 完美同步“反馈跟随”：采用高阶半透明混合色，在任何皮肤下都保证完美的灰度、对比度差值与层级区分 🌟 ---
    root.style.setProperty('--bg-hover', 'color-mix(in srgb, var(--text-primary) 3.5%, transparent)');
    root.style.setProperty('--bg-active', 'color-mix(in srgb, var(--text-primary) 8.0%, transparent)');
    
    // --- 🌟 完美的 Opaque 输入框/按钮背景跟随：在浅色模式下采用高饱黄色调作为混色基底，让按钮与 prompt 卡片 hover 时极其轻柔温润，彻底消灭重黑脏色！ 🌟 ---
    const controlSoftBase = isDarkPreset ? mixColor : vibrantTint;
    const softBgPct = isDarkPreset ? '6.5%' : '6.0%';
    const softHoverPct = isDarkPreset ? '9.5%' : '11.0%';
    const softActivePct = isDarkPreset ? '13.5%' : '17.0%';
    root.style.setProperty('--control-soft-bg', `color-mix(in srgb, ${controlSoftBase} ${softBgPct}, ${bgSecondary})`);
    root.style.setProperty('--control-soft-bg-hover', `color-mix(in srgb, ${controlSoftBase} ${softHoverPct}, ${bgSecondary})`);
    root.style.setProperty('--control-soft-bg-active', `color-mix(in srgb, ${controlSoftBase} ${softActivePct}, ${bgSecondary})`);
    
    // --- 🌟 完美的对话输入框背景跟随：浅色模式下让背景基准点使用已经过亮度微调的 bgPrimary，从而令输入框完美随滑动条改变亮度 🌟 ---
    let composerBg = skinConfig.composerBg;
    if (!isDarkPreset) {
      if (!composerBg) {
        composerBg = `color-mix(in srgb, ${vibrantTint} 15.0%, ${bgPrimary})`;
      } else {
        if (adjust !== 0) {
          const pSec = adjust > 0 ? adjust * 3.5 : Math.abs(adjust) * 4.0;
          const target = adjust > 0 ? '#ffffff' : twilightTarget;
          composerBg = `color-mix(in srgb, ${composerBg} ${100 - pSec}%, ${target})`;
        }
      }
    } else {
      if (composerBg) {
        if (adjust !== 0) {
          const pSec = adjust > 0 ? adjust * 2.8 : Math.abs(adjust) * 2.3;
          const mixTarget = adjust > 0 
            ? (p.themeBrightnessVibrant ? `color-mix(in srgb, ${mixColor} 8%, #ffffff)` : '#ffffff') 
            : (p.themeBrightnessVibrant ? `color-mix(in srgb, ${mixColor} 14%, #000000)` : '#000000');
          composerBg = `color-mix(in srgb, ${composerBg} ${100 - pSec}%, ${mixTarget})`;
        }
      } else {
        composerBg = bgSecondary;
      }
    }
    root.style.setProperty('--composer-bg', composerBg);

    // Dynamic OKLCH contrast guard to automatically enforce WCAG AA contrast ratios
    applyTextContrastGuard(bgPrimary, isDarkPreset);
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
    root.style.removeProperty('--bg-hover');
    root.style.removeProperty('--bg-active');
    root.style.removeProperty('--control-mix-color');
    root.style.removeProperty('--control-soft-bg');
    root.style.removeProperty('--control-soft-bg-hover');
    root.style.removeProperty('--control-soft-bg-active');
    root.style.removeProperty('--composer-bg');
  }
}

let solarIntervalMounted = false;

/** 读本地并应用；返回生效主题 */
export function bootstrapTheme(): UiTheme {
  const t = readStoredTheme();
  applyTheme(t);
  const p = readStoredPersonalization();
  applyPersonalization(p, t);

  // ⏰ 开启时光过渡的后台 60 秒轮询 Tick 守护定时器，确保无感平滑自愈 ⏰
  if (typeof window !== 'undefined' && !solarIntervalMounted) {
    solarIntervalMounted = true;
    setInterval(() => {
      const activeP = readStoredPersonalization();
      if (activeP.themeAutoTimeTransition) {
        const activeT = readStoredTheme();
        applyPersonalization(activeP, activeT);
      }
    }, 60000);
  }

  return t;
}

/** 切换并持久化 */
export function setTheme(theme: UiTheme | string): UiTheme {
  const t = applyTheme(theme);
  persistTheme(t);
  const p = readStoredPersonalization();
  applyPersonalization(p, t);
  try {
    window.dispatchEvent(new CustomEvent('crish-theme-changed', { detail: { theme: t } }));
  } catch {
    /* ignore */
  }
  return t;
}
