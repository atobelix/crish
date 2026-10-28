// 设计 token（M4 §3.2：语义名逐项对齐桌面 tokens.css；浅色暖灰 / 深色炭灰双色板）
// - 深色 token 独立定义，不得引用浅色值取反（M4 §7.4 分支纪律）；
// - 键集合完整性由类型强制：darkTokens 标注 ThemeTokens，缺键/多键编译期报错（R2UX-06-05）；
// - 组件禁止硬编码色值/间距，一律经 useTheme() 取 token（M4 §3.8）。
//
// 主题消费入口（M4 §7.4 / R4 批次2 单真源）：外观三选（跟随系统/浅色/深色）的唯一
// 存储面 = settingsStore.appearance.theme（F6 §9 本机偏好，settingsDao kv 持久化，
// 重启保留）。本文件只做「token 表 + 投影 + React 订阅绑定」，不再持有独立存储——
// 旧 themeModeStore 内存态（重启丢偏好）已删除，写入统一走 setThemeMode。
import { useColorScheme } from 'react-native';
import { useStore } from 'zustand';
import { settingsStore } from '@/domain/store/settingsStore';
import type { ThemeMode } from '@/domain/store/settingsReducers';

export const lightTokens = {
  bgPrimary: 'hsl(35,12%,94%)',
  bgSecondary: 'hsl(35,12%,91.5%)',
  bgTertiary: 'hsl(35,12%,88.5%)',
  bgCard: 'hsl(35,10%,98%)',
  bgElevated: 'hsl(35,8%,100%)',
  textPrimary: '#111111',
  textSecondary: '#555555',
  textTertiary: 'rgba(85,85,85,0.7)',
  hairline: 'hsl(35,8%,91%)',
  hairlineStrong: 'hsl(35,10%,86%)',
  // AGENTS.md §13 焦点态柔边：~5.8% 混入
  focusBorder: 'hsl(35,10%,81%)',
  // R2-05 部分 11（R2-16 走查 §3.3 W-6）：浅色语义色作文字压暗至对比度 ≥4.5:1（R2UX §4.2）
  colorSuccess: 'hsl(142,35%,35%)',
  colorWarning: 'hsl(38,92%,30%)',
  colorError: 'hsl(0,55%,50%)',
  colorInfo: 'hsl(217,91%,49%)',
  colorSuccessBg: 'hsl(142,35%,96.5%)',
  colorErrorBg: 'hsl(0,55%,97.5%)',
  colorWarningBg: 'hsl(38,100%,96%)',
  textOnAccent: '#ffffff',
  textOnDanger: '#ffffff',
  // 遮罩底色（确认弹窗/底部弹层通用；非 M4 表内项，作为移动端弹层统一新增）
  backdrop: 'rgba(0,0,0,0.45)',
} as const;

export type ThemeTokens = { [K in keyof typeof lightTokens]: string };

export const darkTokens: ThemeTokens = {
  bgPrimary: 'hsl(0,0%,5%)',
  bgSecondary: 'hsl(0,0%,8%)',
  bgTertiary: 'hsl(0,0%,11%)',
  bgCard: 'hsl(0,0%,11%)',
  bgElevated: 'hsl(0,0%,15%)',
  textPrimary: '#f0f0f0',
  textSecondary: '#a3a3a3',
  textTertiary: 'rgba(163,163,163,0.62)',
  hairline: 'hsl(0,0%,14%)',
  hairlineStrong: 'hsl(0,0%,18%)',
  // AGENTS.md §13 焦点态柔边：~5% 混入
  focusBorder: 'hsl(0,0%,23%)',
  // R2-05 部分 11：深色语义色作文字提亮/压深至对比度 ≥4.5:1（colorSuccess 提亮、colorError 提亮）
  colorSuccess: 'hsl(142,35%,50%)',
  colorWarning: 'hsl(38,92%,50%)',
  colorError: 'hsl(0,55%,63%)',
  colorInfo: 'hsl(217,91%,60%)',
  colorSuccessBg: 'hsl(142,35%,16%)',
  colorErrorBg: 'hsl(0,55%,16%)',
  colorWarningBg: 'hsl(21,92%,14%)',
  // M4 §3.2：深色 textOnAccent = bgPrimary（炭灰），绿底深字对比度优于白字
  textOnAccent: 'hsl(0,0%,5%)',
  // R2-05 部分 11：深色 textOnDanger 同取炭灰（红底深字优于白字，先例同上），白字红底仅 4.45:1
  textOnDanger: 'hsl(0,0%,5%)',
  backdrop: 'rgba(0,0,0,0.45)',
};

/** 三选顺序（UI 渲染顺序 = 焦点/读屏初始顺序，R2UX-06-05） */
export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

/** 模式展示名（F6 §9 外观主题行） */
export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

/**
 * token 投影纯函数（单测面，R2UX-06-05）：
 * - system → 系统方案（透传系统外观，跟随系统即时切换）；
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

/**
 * 主题 token 统一消费入口（M4 §7.4 / §3.8）：
 * 外观三选（settingsStore.appearance.theme）投影 + 系统外观（useColorScheme 订阅，
 * system 档即时跟随）。hydrate 完成前显示默认 system 档，回填后随持久化值切换。
 * 全部组件经此消费（设置/配对页与主屏同一入口）。
 */
export function useTheme(): ThemeTokens {
  const mode = useStore(settingsStore, (s) => s.groups.appearance.theme);
  const systemTokens = useColorScheme() === 'dark' ? darkTokens : lightTokens;
  return projectThemeTokens(mode, systemTokens);
}

/**
 * 外观三选写入（唯一写入口）：内存立即生效 + 经注入持久化异步落 kv
 * （settingsStore.update 语义；hydrate 前写入会随后续回填合并）。
 */
export function setThemeMode(mode: ThemeMode): void {
  settingsStore.getState().update('appearance', { theme: mode });
}

/** 测试隔离：主题偏好复位（仅测试调用） */
export function resetThemeModeForTest(): void {
  settingsStore.setState({
    groups: defaultGroupsWithTheme('system'),
    hydrated: false,
  });
}

/** 测试基座：以当前 groups 克隆 appearance 指定档（避免跨用例污染其它分组） */
function defaultGroupsWithTheme(
  theme: ThemeMode
): ReturnType<typeof settingsStore.getState>['groups'] {
  const groups = settingsStore.getState().groups;
  return { ...groups, appearance: { theme } };
}
