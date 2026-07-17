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
  return t;
}

export interface PersonalizationSettings {
  skin: string;
  customBg: string;
  customFg: string;
  fontSizeAdjust: number;
}

export function readStoredPersonalization(): PersonalizationSettings {
  try {
    const skin = localStorage.getItem('crish_theme_skin') || 'warm-gray';
    const customBg = localStorage.getItem('crish_theme_custom_bg') || '#f4f3f0';
    const customFg = localStorage.getItem('crish_theme_custom_fg') || '#111111';
    const fsAdjustRaw = localStorage.getItem('crish_font_size_adjust');
    const fontSizeAdjust = fsAdjustRaw ? parseInt(fsAdjustRaw, 10) : 0;
    return { skin, customBg, customFg, fontSizeAdjust };
  } catch {
    return { skin: 'warm-gray', customBg: '#f4f3f0', customFg: '#111111', fontSizeAdjust: 0 };
  }
}

export function writeStoredPersonalization(p: PersonalizationSettings): void {
  try {
    localStorage.setItem('crish_theme_skin', p.skin);
    localStorage.setItem('crish_theme_custom_bg', p.customBg);
    localStorage.setItem('crish_theme_custom_fg', p.customFg);
    localStorage.setItem('crish_font_size_adjust', String(p.fontSizeAdjust));
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
}> = {
  'warm-gray': {
    name: '护眼暖灰',
    bgPrimary: 'hsl(35, 4%, 92.5%)',
    bgSecondary: 'hsl(35, 4%, 94.5%)',
    bgTertiary: 'hsl(35, 4%, 93%)',
    bgCard: 'hsl(35, 4%, 95.5%)',
    bgElevated: 'hsl(35, 4%, 95.5%)',
    shellChromeBg: 'color-mix(in srgb, hsl(35, 4%, 94.5%) 78%, #b8b4ac 22%)',
    textPrimary: '#111111',
    textSecondary: '#555555',
    borderColor: 'hsl(35, 4%, 89%)',
    borderSubtle: 'hsl(35, 4%, 93%)',
  },
  'cream': {
    name: '杏仁奶油',
    bgPrimary: '#faf6eb',
    bgSecondary: '#fdfbf7',
    bgTertiary: '#f6f1e3',
    bgCard: '#fdfbf7',
    bgElevated: '#fdfbf7',
    shellChromeBg: 'color-mix(in srgb, #fdfbf7 82%, #d2c8b0 18%)',
    textPrimary: '#2a2415',
    textSecondary: '#6b5f45',
    borderColor: '#e5dac2',
    borderSubtle: '#efe6d3',
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
  },
  'dark-forest': {
    name: '森林绿影',
    bgPrimary: '#111814',
    bgSecondary: '#18231c',
    bgTertiary: '#141d18',
    bgCard: '#18231c',
    bgElevated: '#18231c',
    shellChromeBg: '#0a0f0c',
    textPrimary: '#ecfdf5',
    textSecondary: '#6ee7b7',
    borderColor: '#243329',
    borderSubtle: '#1a261f',
  },
};

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

  // 校验皮肤是否与激活的黑夜/白天模式契合，若预设冲突则做回落
  if (skinConfig && p.skin !== 'custom') {
    const isPresetDark = p.skin.startsWith('dark-') || p.skin === 'deep-night';
    if (activeTheme === 'dark' && !isPresetDark) {
      skinConfig = SKIN_PRESETS['dark-cozy'];
    } else if (activeTheme === 'default' && isPresetDark) {
      skinConfig = SKIN_PRESETS['warm-gray'];
    }
  }

  if (skinConfig) {
    root.style.setProperty('--bg-primary', skinConfig.bgPrimary);
    root.style.setProperty('--bg-secondary', skinConfig.bgSecondary);
    root.style.setProperty('--bg-tertiary', skinConfig.bgTertiary);
    root.style.setProperty('--bg-card', skinConfig.bgCard);
    root.style.setProperty('--bg-elevated', skinConfig.bgElevated);
    root.style.setProperty('--shell-chrome-bg', skinConfig.shellChromeBg);
    root.style.setProperty('--text-primary', skinConfig.textPrimary);
    root.style.setProperty('--text-secondary', skinConfig.textSecondary);
    root.style.setProperty('--border-color', skinConfig.borderColor);
    root.style.setProperty('--border-subtle', skinConfig.borderSubtle);
    
    // 派生属性，确保面板统一
    root.style.setProperty('--bg-workspace', skinConfig.bgPrimary);
    root.style.setProperty('--shell-inset-bg', skinConfig.bgPrimary);
    root.style.setProperty('--bg-hover', `color-mix(in srgb, ${skinConfig.bgPrimary} 93.5%, ${skinConfig.textPrimary} 6.5%)`);
    root.style.setProperty('--bg-active', `color-mix(in srgb, ${skinConfig.bgPrimary} 91.5%, ${skinConfig.textPrimary} 8.5%)`);
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
    root.style.removeProperty('--border-color');
    root.style.removeProperty('--border-subtle');
    root.style.removeProperty('--bg-workspace');
    root.style.removeProperty('--shell-inset-bg');
    root.style.removeProperty('--bg-hover');
    root.style.removeProperty('--bg-active');
  }
}

/** 读本地并应用；返回生效主题 */
export function bootstrapTheme(): UiTheme {
  const t = readStoredTheme();
  applyTheme(t);
  const p = readStoredPersonalization();
  applyPersonalization(p, t);
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
