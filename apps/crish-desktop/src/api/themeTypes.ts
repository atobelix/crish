/**
 * 外观主题：类型与常量定义。
 * 主题模式（UiTheme）、个性化设置接口、localStorage 键名常量。
 * 调色板数据文件例外声明见 themeStore.ts hub 顶部。
 */

export type UiTheme = 'default' | 'dark';

/** 本地存储键 */
export const THEME_KEY = 'crish_theme';
export const SETTINGS_KEY = 'crish_settings';

export interface PersonalizationSettings {
  skin: string;
  customBg: string;
  customFg: string;
  fontSizeAdjust: number;
  themeBrightnessAdjust?: number; // 范围从 -5 到 +5
  themeBrightnessVibrant?: boolean; // 是否开启氛围色彩融合模式（有色高光/暗影）
  themeAutoTimeTransition?: boolean; // 新增：是否开启智能时光温感过渡模式
}
