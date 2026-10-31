// 移动端设计 Token 单一真源（v3：浅灰底 + 亮一档输入面 / 墨色主操作 / 大圆角 / 抽屉式导航）。
// 组件只消费语义 token，禁止裸色值、裸圆角、裸阴影、裸字号。
// 浅色 / 深色两套独立定义，不做取反。
// 标记弃用的键是迁移期别名（指向新键的值），改版收尾时统一删除。
import { Platform, useColorScheme } from 'react-native';
import type { TextStyle, ViewStyle } from 'react-native';
import { useStore } from 'zustand';
import { settingsStore } from '@/domain/store/settingsStore';
import type { ThemeMode } from '@/domain/store/settingsReducers';

export interface ThemeColors {
  // 背景层
  canvas: string;
  canvasGrouped: string;
  surface: string;
  surfaceGrouped: string;
  surfaceRaised: string;
  fillSubtle: string;
  fillPressed: string;
  bubbleUser: string;
  // 文字
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textDisabled: string;
  // 线
  hairline: string;
  borderStrong: string;
  // 主操作（墨色）
  actionPrimary: string;
  actionPrimaryText: string;
  actionDisabled: string;
  // 品牌（只做小面积点缀）
  brand: string;
  brandStrong: string;
  brandSoft: string;
  // 状态
  success: string;
  successSoft: string;
  danger: string;
  dangerForeground: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  info: string;
  infoSoft: string;
  // 媒体之上 / 遮罩 / 阴影
  onMedia: string;
  onMediaDanger: string;
  scrim: string;
  shadow: string;
  // —— v3 输入面与玻璃 ——
  /** 输入框底色（比底色亮一档）与聚焦底色 */
  field: string;
  fieldFocus: string;
  /** 墨色主按钮按下 */
  actionPrimaryPressed: string;
  /** 浮动圆钮与底部 sheet 的磨砂玻璃底色（叠在 BlurView 上） */
  glass: string;
  glassSheet: string;
}

type BaseColors = ThemeColors;

export interface ThemeSpace {
  xxs: number;
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
  section: number;
  xxxl: number;
  /** 页面水平内衬 */
  screenX: number;
  /** 时间线消息间距 */
  messageGap: number;
  /** 列表行垂直内衬 */
  rowY: number;
}

export interface ThemeRadius {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
  pill: number;
  /** 按钮以外的小控件：输入框、行内块、工具输出块 */
  control: number;
  /** 卡片、设置分组、悬浮审批卡 */
  card: number;
  /** 用户消息气泡 */
  bubble: number;
  /** 账号 v3 输入框 */
  field: number;
  /** 账号 v3 验证码格 */
  codeCell: number;
  /** Sheet / 工具抽屉顶部圆角 */
  sheet: number;
}

export interface ThemeType {
  largeTitle: TextStyle;
  title: TextStyle;
  title2: TextStyle;
  headline: TextStyle;
  body: TextStyle;
  bodyStrong: TextStyle;
  chat: TextStyle;
  callout: TextStyle;
  footnote: TextStyle;
  caption: TextStyle;
  sectionLabel: TextStyle;
  mono: TextStyle;
  /** 账号 v3 页面大标题 28/36 */
  bigTitle: TextStyle;
  /** 账号 v3 账号名 20/26 */
  accountName: TextStyle;
  /** 验证码数字 24/30 等宽 */
  codeDigit: TextStyle;
  /** 顶栏小胶囊按钮文字 14/600 */
  barAction: TextStyle;
  /** @deprecated 迁移期别名 @see largeTitle */
  display: TextStyle;
  /** @deprecated 迁移期别名 @see title2 */
  heading: TextStyle;
  /** @deprecated 迁移期别名 @see headline */
  subhead: TextStyle;
  /** @deprecated 迁移期别名 @see footnote */
  meta: TextStyle;
}

export interface ThemeSize {
  touch: number;
  touchLarge: number;
  icon: number;
  iconSmall: number;
  iconLarge: number;
  row: number;
  rowTall: number;
  header: number;
  avatar: number;
  avatarSmall: number;
  iconButton: number;
  composerMin: number;
  sendButton: number;
  /** 时间线工具摘要行高度 */
  summaryRow: number;
  /** 数字角标直径 */
  badge: number;
  /** 状态点直径 */
  dot: number;
  /** Sheet 拖拽把手 */
  sheetHandleWidth: number;
  sheetHandleHeight: number;
  /** 多行表单输入框最小高度 */
  inputMultilineMin: number;
  /** 账号 v3：输入框 / 验证码格高度、多行输入框高度 */
  field: number;
  fieldTall: number;
  /** 账号 v3：主次按钮高度 */
  button: number;
  /** 账号 v3：导航行与登录设备行高度 */
  navRow: number;
  sessionRow: number;
  /** 账号 v3：账号页头像与资料页头像 */
  avatarProfile: number;
  avatarEdit: number;
  /** 账号 v3：顶栏小胶囊按钮（保存）与头像相机钮 */
  barAction: number;
  cameraButton: number;
}

export interface ThemeLayout {
  /** 抽屉宽度 = min(屏宽 × ratio, maxWidth) */
  drawerWidthRatio: number;
  drawerMaxWidth: number;
  /** 抽屉边缘滑出手势热区宽度（64dp：避开 Android 全面屏返回手势 0~32dp 感应带） */
  drawerSwipeEdgeWidth: number;
  /** 抽屉完全展开时主界面卡片微缩放（景深） */
  drawerCardScale: number;
  /** 底层抽屉内容视差位移（负值 = 向左退让） */
  drawerParallaxOffset: number;
  /** Composer 输入区最大高度（超出后内部滚动） */
  composerInputMaxHeight: number;
  /** 工具调用抽屉停靠点（屏高比例，升序） */
  toolSheetDetents: number[];
  /** 待审批队列 sheet 停靠点 */
  approvalSheetDetents: number[];
  /** 居中确认弹窗最大宽度 */
  dialogMaxWidth: number;
  /** 品牌标圆角占边长比例 */
  brandMarkCorner: number;
  /** 账号 v3 输入框内边距、页面水平边距 */
  fieldPadding: number;
  accountPageX: number;
  /** 图标全局唯一标准线宽（24 网格） */
  iconStroke: number;
}

export interface ThemeShadow {
  none: ViewStyle;
  xs: ViewStyle;
  sm: ViewStyle;
  md: ViewStyle;
  lg: ViewStyle;
  /** @deprecated 迁移期别名 @see lg */
  sheet: ViewStyle;
  /** @deprecated 迁移期别名：圆钮 @see sm ；composer @see md */
  floating: ViewStyle;
}

export type Bezier = readonly [number, number, number, number];

/** 物理弹簧参数（Reanimated withSpring 消费；实现波总方案 F1 单一真源） */
export interface SpringParams {
  damping: number;
  stiffness: number;
  mass: number;
}

export interface ThemeMotion {
  duration: {
    micro: number;
    snappy: number;
    fast: number;
    normal: number;
    sheet: number;
    settle: number;
  };
  easing: { standard: Bezier; emphasized: Bezier; decelerate: Bezier };
  enter: { duration: number; translateY: number };
  /** 物理弹簧族：胶囊回弹 / 轻提示 / 面板 / 抽屉层叠 / 滑动确认回弹 */
  spring: {
    snappy: SpringParams;
    bouncy: SpringParams;
    sheet: SpringParams;
    drawer: SpringParams;
    slideThumb: SpringParams;
  };
  /** 验证码出错抖动（Reanimated withSequence 消费） */
  shake: { duration: number; distance: number; cycles: number };
  /** 全局 Toast 展示时长 */
  toast: { displayMs: number };
  pressScale: number;
  pressOpacity: number;
}

export interface AvatarTone {
  bg: string;
  fg: string;
}

export interface Theme {
  dark: boolean;
  colors: ThemeColors;
  space: ThemeSpace;
  radius: ThemeRadius;
  type: ThemeType;
  size: ThemeSize;
  layout: ThemeLayout;
  shadow: ThemeShadow;
  motion: ThemeMotion;
  avatarTones: readonly AvatarTone[];
}

const lightBase: BaseColors = {
  canvas: '#f2f2f2',
  canvasGrouped: '#f2f2f2',
  surface: '#ffffff',
  surfaceGrouped: '#ffffff',
  surfaceRaised: '#ffffff',
  fillSubtle: '#ececec',
  fillPressed: '#e7e7e7',
  bubbleUser: '#f9f9f9',
  textPrimary: '#0d0d0d',
  textSecondary: '#5c5c5c',
  textTertiary: '#868686',
  textDisabled: '#b5b5b5',
  hairline: '#ebebeb',
  borderStrong: '#e1e1e1',
  actionPrimary: '#0d0d0d',
  actionPrimaryText: '#ffffff',
  actionDisabled: '#ececec',
  brand: '#10b981',
  brandStrong: '#047857',
  brandSoft: '#e7f6ec',
  success: '#1a7f37',
  successSoft: '#e7f6ec',
  danger: '#c81e1e',
  dangerForeground: '#ffffff',
  dangerSoft: '#f9eded',
  warning: '#9a5200',
  warningSoft: '#fdf3e1',
  info: '#0b66d6',
  infoSoft: '#e8f1fd',
  onMedia: '#ffffff',
  onMediaDanger: '#fecaca',
  scrim: 'rgba(0,0,0,0.24)',
  shadow: '#000000',
  field: '#f9f9f9',
  fieldFocus: '#ffffff',
  actionPrimaryPressed: '#2a2a2a',
  glass: 'rgba(249,249,249,0.72)',
  glassSheet: 'rgba(242,242,242,0.86)',
};

const darkBase: BaseColors = {
  canvas: '#121212',
  canvasGrouped: '#121212',
  surface: '#171717',
  surfaceGrouped: '#1c1c1c',
  surfaceRaised: '#1e1e1e',
  fillSubtle: '#202020',
  fillPressed: '#262626',
  bubbleUser: '#262626',
  textPrimary: '#ececec',
  textSecondary: '#b4b4b4',
  textTertiary: '#8e8e8e',
  textDisabled: '#5a5a5a',
  hairline: '#1b1b1b',
  borderStrong: '#2e2e2e',
  actionPrimary: '#f2f2f2',
  actionPrimaryText: '#0d0d0d',
  actionDisabled: '#202020',
  brand: '#10b981',
  brandStrong: '#34d399',
  brandSoft: '#17301f',
  success: '#3fb950',
  successSoft: '#17301f',
  danger: '#f87171',
  dangerForeground: '#0f0f0f',
  dangerSoft: '#251818',
  warning: '#e3a33b',
  warningSoft: '#3a2a12',
  info: '#58a6ff',
  infoSoft: '#14263d',
  onMedia: '#ffffff',
  onMediaDanger: '#fecaca',
  scrim: 'rgba(0,0,0,0.5)',
  shadow: '#000000',
  field: '#1b1b1b',
  fieldFocus: '#222222',
  actionPrimaryPressed: '#d6d6d6',
  glass: 'rgba(32,32,32,0.68)',
  glassSheet: 'rgba(22,22,22,0.84)',
};

const space: ThemeSpace = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  section: 32,
  xxxl: 40,
  screenX: 20,
  messageGap: 24,
  rowY: 12,
};

const radius: ThemeRadius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 24,
  xxl: 28,
  pill: 9999,
  control: 12,
  card: 20,
  bubble: 22,
  sheet: 28,
  field: 18,
  codeCell: 16,
};

const monoFont = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

// 不写 fontFamily：iOS 自动落到 SF / PingFang SC，Android 落到 Roboto / 思源黑体。
const largeTitle: TextStyle = {
  fontSize: 30,
  lineHeight: 36,
  fontWeight: '700',
  letterSpacing: -0.3,
};
const title2: TextStyle = { fontSize: 20, lineHeight: 26, fontWeight: '600' };
const headline: TextStyle = { fontSize: 17, lineHeight: 22, fontWeight: '600' };
const footnote: TextStyle = {
  fontSize: 13,
  lineHeight: 18,
  fontWeight: '400',
  fontVariant: ['tabular-nums'],
};

const type: ThemeType = {
  largeTitle,
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  title2,
  headline,
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  chat: { fontSize: 17, lineHeight: 27, fontWeight: '400' },
  callout: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  footnote,
  caption: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  sectionLabel: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  mono: {
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '400',
    fontFamily: monoFont,
  },
  bigTitle: {
    fontSize: 28,
    lineHeight: 36,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  accountName: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  codeDigit: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  barAction: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  display: largeTitle,
  heading: title2,
  subhead: headline,
  meta: footnote,
};

const size: ThemeSize = {
  touch: 44,
  touchLarge: 48,
  icon: 20,
  iconSmall: 16,
  iconLarge: 24,
  row: 52,
  rowTall: 72,
  header: 52,
  avatar: 40,
  avatarSmall: 32,
  iconButton: 40,
  composerMin: 52,
  sendButton: 36,
  summaryRow: 40,
  badge: 18,
  dot: 8,
  sheetHandleWidth: 36,
  sheetHandleHeight: 5,
  inputMultilineMin: 96,
  field: 56,
  fieldTall: 104,
  button: 52,
  navRow: 56,
  sessionRow: 68,
  avatarProfile: 76,
  avatarEdit: 96,
  barAction: 34,
  cameraButton: 34,
};

const layout: ThemeLayout = {
  drawerWidthRatio: 0.84,
  drawerMaxWidth: 340,
  // 64dp：避开 Android 全面屏系统返回手势的 0~32dp 感应带（实现波总方案 D8）
  drawerSwipeEdgeWidth: 64,
  /** 抽屉完全展开时主界面卡片的微缩放景深比例 */
  drawerCardScale: 0.94,
  /** 底层抽屉内容随开合的视差位移（负值 = 向左退让） */
  drawerParallaxOffset: -36,
  composerInputMaxHeight: 120,
  toolSheetDetents: [0.45, 0.92],
  approvalSheetDetents: [0.6, 0.92],
  dialogMaxWidth: 340,
  brandMarkCorner: 0.3,
  fieldPadding: 18,
  accountPageX: 24,
  /** 图标全局唯一标准线宽（24 网格） */
  iconStroke: 2,
};

function makeShadow(
  color: string,
  opacity: readonly [number, number, number, number]
): ThemeShadow {
  const [xs, sm, md, lg] = opacity;
  const none: ViewStyle = { shadowOpacity: 0, elevation: 0 };
  const shadowXs: ViewStyle = {
    shadowColor: color,
    shadowOpacity: xs,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  };
  const shadowSm: ViewStyle = {
    shadowColor: color,
    shadowOpacity: sm,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  };
  const shadowMd: ViewStyle = {
    shadowColor: color,
    shadowOpacity: md,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  };
  const shadowLg: ViewStyle = {
    shadowColor: color,
    shadowOpacity: lg,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  };
  return {
    none,
    xs: shadowXs,
    sm: shadowSm,
    md: shadowMd,
    lg: shadowLg,
    sheet: shadowLg,
    floating: shadowSm,
  };
}

const lightShadow = makeShadow(lightBase.shadow, [0.05, 0.08, 0.1, 0.14]);
const darkShadow = makeShadow(darkBase.shadow, [0.4, 0.5, 0.55, 0.6]);

// 与桌面 apps/crish-desktop/src/utils/motionTokens.ts 同值
const motion: ThemeMotion = {
  duration: {
    micro: 100,
    snappy: 120,
    fast: 150,
    normal: 200,
    sheet: 220,
    settle: 260,
  },
  easing: {
    standard: [0.4, 0, 0.2, 1],
    emphasized: [0.16, 1, 0.3, 1],
    decelerate: [0, 0, 0.2, 1],
  },
  enter: { duration: 150, translateY: 6 },
  spring: {
    snappy: { damping: 20, stiffness: 350, mass: 0.8 },
    bouncy: { damping: 15, stiffness: 200, mass: 1 },
    sheet: { damping: 28, stiffness: 300, mass: 1 },
    drawer: { damping: 30, stiffness: 260, mass: 1 },
    slideThumb: { damping: 25, stiffness: 320, mass: 0.9 },
  },
  shake: { duration: 240, distance: 6, cycles: 3 },
  toast: { displayMs: 2500 },
  pressScale: 0.98,
  pressOpacity: 0.7,
};

const lightAvatarTones: readonly AvatarTone[] = [
  { bg: '#eef6f1', fg: '#2f6f4f' },
  { bg: '#eef2fa', fg: '#3b5b92' },
  { bg: '#faf2e8', fg: '#8a5a1f' },
  { bg: '#f4effa', fg: '#6b4c9a' },
  { bg: '#faeef2', fg: '#9a4766' },
  { bg: '#f1f1f1', fg: '#4a4a4a' },
];

const darkAvatarTones: readonly AvatarTone[] = [
  { bg: '#1c2a23', fg: '#7cc4a0' },
  { bg: '#1d2433', fg: '#8faee0' },
  { bg: '#2e2519', fg: '#e0b47a' },
  { bg: '#271f33', fg: '#b9a0e0' },
  { bg: '#2e1f25', fg: '#e09ab5' },
  { bg: '#242424', fg: '#bdbdbd' },
];

function buildTheme(
  base: BaseColors,
  dark: boolean,
  shadow: ThemeShadow,
  avatarTones: readonly AvatarTone[]
): Theme {
  return {
    dark,
    colors: base,
    space,
    radius,
    type,
    size,
    layout,
    shadow,
    motion,
    avatarTones,
  };
}

export const lightTheme: Theme = buildTheme(
  lightBase,
  false,
  lightShadow,
  lightAvatarTones
);

export const darkTheme: Theme = buildTheme(
  darkBase,
  true,
  darkShadow,
  darkAvatarTones
);

/** 按 id 稳定取头像色（字符串哈希取模，同一会话恒定同色） */
export function avatarToneFor(id: string, theme: Theme): AvatarTone {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return theme.avatarTones[hash % theme.avatarTones.length]!;
}

/** 三选顺序（UI 渲染顺序 = 读屏顺序） */
export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

export function projectTheme(mode: ThemeMode, systemTheme: Theme): Theme {
  if (mode === 'light') return lightTheme;
  if (mode === 'dark') return darkTheme;
  return systemTheme;
}

/** 主题唯一消费入口（外观三选来自 settingsStore.appearance.theme） */
export function useTheme(): Theme {
  const mode = useStore(settingsStore, (s) => s.groups.appearance.theme);
  const systemTheme = useColorScheme() === 'dark' ? darkTheme : lightTheme;
  return projectTheme(mode, systemTheme);
}

/** 外观三选写入（唯一写入口） */
export function setThemeMode(mode: ThemeMode): void {
  settingsStore.getState().update('appearance', { theme: mode });
}

/** 测试隔离：主题偏好复位 */
export function resetThemeModeForTest(): void {
  settingsStore.setState((state) => ({
    groups: { ...state.groups, appearance: { theme: 'system' } },
    hydrated: false,
  }));
}
