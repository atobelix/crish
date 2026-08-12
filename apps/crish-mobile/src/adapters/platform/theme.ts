// 设计 token（M4 §3.2：语义名逐项对齐桌面 tokens.css；浅色暖灰 / 深色炭灰双色板）
// - 深色 token 独立定义，不得引用浅色值取反（M4 §7.4 分支纪律）；
// - 键集合完整性由类型强制：darkTokens 标注 ThemeTokens，缺键/多键编译期报错（R2UX-06-05）；
// - 组件禁止硬编码色值/间距，一律经 useTheme() 取 token（M4 §3.8）。
import { useColorScheme } from 'react-native';

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
  colorSuccess: 'hsl(142,35%,42%)',
  colorWarning: 'hsl(38,92%,50%)',
  colorError: 'hsl(0,55%,55%)',
  colorInfo: 'hsl(217,91%,60%)',
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
  colorSuccess: 'hsl(142,35%,42%)',
  colorWarning: 'hsl(38,92%,50%)',
  colorError: 'hsl(0,55%,55%)',
  colorInfo: 'hsl(217,91%,60%)',
  colorSuccessBg: 'hsl(142,35%,16%)',
  colorErrorBg: 'hsl(0,55%,16%)',
  colorWarningBg: 'hsl(21,92%,14%)',
  // M4 §3.2：深色 textOnAccent = bgPrimary（炭灰），绿底深字对比度优于白字
  textOnAccent: 'hsl(0,0%,5%)',
  textOnDanger: '#ffffff',
  backdrop: 'rgba(0,0,0,0.45)',
};

// 主题消费入口（M4 §3.8）：当前仅跟随系统外观；设置域三选（跟随/浅/深）随 R2-06 落地
export function useTheme(): ThemeTokens {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkTokens : lightTokens;
}
