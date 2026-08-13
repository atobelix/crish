// 深色模式三选投影（R2-06 设置域接线，R2UX-06-05）：
// - 主题偏好三选（跟随系统/浅色/深色，F6 §9 外观；M4 §3.2「跟随系统 + 可手动三选」），
//   适配层持有（vanilla store，模块单例，测试可隔离复位）；
// - useAppTheme：mode=system → 现有 useTheme()（useColorScheme 系统外观）；
//   mode=light/dark → 对应 token 表（深色 token 独立定义不取反，M4 §7.4 分支纪律）；
// - token 完整性：darkTokens 类型标注 ThemeTokens（缺键/多键编译期报错），
//   projectThemeTokens 单测断言两套 token 键集合一致（R2UX-06-05 验收）；
// - 接线注记：R2-14b settingsStore（appearance 分片，F6 §4.2）落地后，本模块存储面
//   替换为 settingsStore 订阅（useAppStore 增绑定 + 本机持久化），对外接口
//   （useThemeMode / useAppTheme / setThemeMode / projectThemeTokens）保持不变。
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import {
  darkTokens,
  lightTokens,
  useTheme,
  type ThemeTokens,
} from '@/adapters/platform/theme';

/** 主题模式三选（F6 §9：跟随系统/浅色/深色，默认跟随系统） */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 三选顺序（UI 渲染顺序 = 焦点/读屏初始顺序，R2UX-06-05） */
export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

/** 模式展示名（F6 §9 外观主题行） */
export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

interface ThemeModeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

/** 主题偏好存储（适配层单例；R2-14b 迁入 settingsStore 前为内存态） */
export const themeModeStore = createStore<ThemeModeState>()((set) => ({
  mode: 'system',
  setMode: (mode) => set({ mode }),
}));

/** 主题模式订阅绑定（对齐 useAppStore 模式；selector 经 useShallow 稳定引用） */
export const useThemeMode = <T>(selector: (s: ThemeModeState) => T): T =>
  useStore(themeModeStore, useShallow(selector));

/**
 * token 投影纯函数（单测面，R2UX-06-05）：
 * - system → 系统方案（透传 useTheme 结果，跟随系统外观即时切换）；
 * - light/dark → 对应完整 token 表（不引用另一套取反，M4 §7.4）。
 */
export function projectThemeTokens(
  mode: ThemeMode,
  systemTokens: ThemeTokens
): ThemeTokens {
  if (mode === 'light') return lightTokens;
  if (mode === 'dark') return darkTokens;
  return systemTokens;
}

/** 主题 token 消费入口（设置页与后续全局统一经此取 token） */
export function useAppTheme(): ThemeTokens {
  const mode = useThemeMode((s) => s.mode);
  const systemTokens = useTheme();
  return projectThemeTokens(mode, systemTokens);
}

/** 测试隔离：主题偏好复位（仅测试调用） */
export function resetThemeModeForTest(): void {
  themeModeStore.setState({ mode: 'system' });
}
