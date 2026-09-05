import { applyPersonalization } from './themePersonalization';
import { withThemeTransitionFreeze } from './themeTransitionLatch';
import {
  SETTINGS_KEY,
  SETTINGS_KEY_LEGACY,
  THEME_KEY,
  type PersonalizationSettings,
  type UiTheme,
} from './themeTypes';

/**
 * 外观主题：应用 DOM + 本地记忆。
 * - 独立 key `crish_theme`，启动时立刻读，不依赖 settings 异步
 * - 同步写入 settings.theme，设置页与其它入口一致
 *
 * 例外声明（T05.5.1 tokens 唯一源）：
 * 皮肤色板常量已迁移至 themePresets.ts（调色板数据文件，约 225 处 hex/hsl），
 * 个性化应用逻辑（脸色注入 / 时光过渡）已迁移至 themePersonalization.ts。
 * 运行时通过 root.style.setProperty 注入 CSS 变量，天然构成 tokens 的运行时数据源。
 * 按 PE-05 T05.5.1 约定不做逐处 token 化，仅保留本例外标注。
 */

// re-export 类型与皮肤预设，保持消费方 import 路径不变
export type { UiTheme, PersonalizationSettings } from './themeTypes';
export { SKIN_PRESETS, type SkinPreset } from './themePresets';
export {
  getDynamicSolarAdjustments,
  applyPersonalization,
} from './themePersonalization';
export { withThemeTransitionFreeze } from './themeTransitionLatch';

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
    /* swallow-ok: 主题键读取失败时回退默认主题 */
  }
  // 只读回退：兼容旧版 crish_settings JSON 中的 theme 字段，不再有写入方更新此字段；
  // @deprecated 删除日期 2027-01-01
  try {
    const raw =
      localStorage.getItem(SETTINGS_KEY) || localStorage.getItem(SETTINGS_KEY_LEGACY);
    if (raw) {
      const parsed = JSON.parse(raw) as { theme?: string };
      if (parsed?.theme) return normalizeTheme(parsed.theme);
    }
  } catch {
    /* swallow-ok: 旧版 settings 结构解析失败时跳过该来源 */
  }
  return 'default';
}

/** 写独立 key crish_theme（唯一写面；维度 2 收敛：已删除 crish_settings JSON 合并写入） */
export function persistTheme(theme: UiTheme): void {
  const t = normalizeTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* swallow-ok: quota/隐私模式写主题尽力而为，失败回退内存态 */
  }
}

/**
 * 应用到 html（变量源）+ body（兼容旧选择器）。
 * 必须在首屏 paint 前或切换时同步调用。
 */
export function applyTheme(theme: UiTheme | string): UiTheme {
  return withThemeTransitionFreeze(() => {
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
      /* swallow-ok: early boot 或 SSR 环境无 DOM 时跳过个性化应用 */
    }

    return t;
  });
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
    /* swallow-ok: 亮度偏好写失败仅影响下次启动还原 */
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

/** 切换并持久化（单真源写端入口） */
export function setTheme(theme: UiTheme | string): UiTheme {
  return withThemeTransitionFreeze(() => {
    const t = applyTheme(theme);
    persistTheme(t);
    const p = readStoredPersonalization();
    applyPersonalization(p, t);
    try {
      window.dispatchEvent(
        new CustomEvent('crish-theme-changed', { detail: { theme: t } })
      );
    } catch {
      /* swallow-ok: 主题变更事件分发失败不影响已应用样式 */
    }

    // 异步同步至 settingsStore 与磁盘持久化，保证全局单真源一致，消除旧值覆盖
    try {
      void import('../store/settingsStore').then(({ useSettingsStore }) => {
        const current = useSettingsStore.getState().appSettings;
        if (current && current.theme !== t) {
          useSettingsStore.getState().setAppSettings({ ...current, theme: t });
        }
      });
      void import('./clientApi').then(({ clientApi }) => {
        void clientApi.saveSettingsEx('__global__', 'global', { theme: t });
      });
    } catch {
      /* swallow-ok: 异步持久化尽力而为 */
    }

    return t;
  });
}

/** 卸载时光守护定时器 */
export function disposeSolarTimer(): void {
  /* no-op when static interval */
}
