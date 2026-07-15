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

/** 读本地并应用；返回生效主题 */
export function bootstrapTheme(): UiTheme {
  const t = readStoredTheme();
  return applyTheme(t);
}

/** 切换并持久化 */
export function setTheme(theme: UiTheme | string): UiTheme {
  const t = applyTheme(theme);
  persistTheme(t);
  try {
    window.dispatchEvent(new CustomEvent('crish-theme-changed', { detail: { theme: t } }));
  } catch {
    /* ignore */
  }
  return t;
}
