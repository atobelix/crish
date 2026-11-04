// 移动端设计 Token 单一真源（v3.1 原型对齐：浅色逐值以 reference/crish-mobile-drawer
// 为真源——双层中性灰底 / 恒白字段 / 绿色主操作 / 琥珀待审批；大圆角 / 抽屉式导航）。
// 组件只消费语义 token，禁止裸色值、裸圆角、裸阴影、裸字号。
// 浅色 / 深色两套独立定义，不做取反。原型无深色真源：深色只承接共享尺度与角色
// 修正（裁决 J1)，色值保持现深色体系的明度关系，推导值在各定义处注明。
// 第三套「纯净中性灰」（裁决 J5/J8)：原型主题面板只有选项名、没有任何色值——
// 整套均为推导值（在原型灰阶上去除一切色相残留、功能色收敛为墨/灰阶、状态色
// 降饱和向灰靠），待用户验收确认后转正；定义见 neutralBase 处注释。
// 标记弃用的键是迁移期别名（指向新键的值），改版收尾时统一删除。
import { Platform, useColorScheme } from 'react-native';
import type { TextStyle } from 'react-native';
import { useStore } from 'zustand';
import { settingsStore } from '@/domain/store/settingsStore';
import type {
  FontScale,
  MonoFont,
  ThemeMode,
} from '@/domain/store/settingsReducers';
import { FONT_SCALE_FACTOR } from '@/domain/store/settingsReducers';

export interface ThemeColors {
  // 背景层
  canvas: string;
  canvasGrouped: string;
  /** 抽屉与返回台阶盘（A2）共用台阶底（比主屏深一档，底色提升至 #f0f0f0；M2 抽屉消费） */
  canvasDrawer: string;
  surface: string;
  surfaceGrouped: string;
  surfaceRaised: string;
  fillSubtle: string;
  /** 按压面（alpha 叠色档，替代实色深灰；原型 0.035) */
  fillPressed: string;
  /** 选中面（alpha 叠色档；原型 0.03,M2 起各列表行消费） */
  fillSelected: string;
  bubbleUser: string;
  /** 用户气泡文字（墨底反色白，与 bubbleUser 成对消费） */
  bubbleUserText: string;
  // 文字
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textDisabled: string;
  // 线
  hairline: string;
  borderStrong: string;
  // 主操作（绿，裁决 J4：提交 / 审批允许 / 创建的角色色）
  actionPrimary: string;
  actionPrimaryText: string;
  actionDisabled: string;
  // 品牌（只做小面积点缀）
  brand: string;
  /** 深绿档：带文字主按钮的底色真源（白字对比 5.48:1，D3 审计修订）兼品牌点缀 */
  brandStrong: string;
  brandSoft: string;
  // 状态
  success: string;
  successSoft: string;
  danger: string;
  dangerForeground: string;
  dangerSoft: string;
  /** 待审批点 / 徽标 / 图标档（琥珀 #f59e0b；仅图形角色，勿作正文文字） */
  warning: string;
  /** 待审批文字档（深棕，保证正文对比度；与 warning 图形档分工） */
  warningText: string;
  warningSoft: string;
  info: string;
  infoSoft: string;
  /** 离线状态点（原型 device pip 离线档 #9ca3af；在线走 success，M8 收口补档） */
  dotOffline: string;
  // 媒体之上 / 遮罩（阴影色令牌已随去阴影裁决退役，2026-11-02)
  onMedia: string;
  onMediaDanger: string;
  /** Sheet 遮罩（原型 0.28 + blur;blur 由消费方 BlurView 承担，M4 接入） */
  scrim: string;
  /** 居中弹窗遮罩（原型 0.35 + blur，强于 scrim 一档） */
  scrimStrong: string;
  // —— v3 输入面与玻璃 ——
  /** 输入框底色与聚焦底色（原型口径：恒白，两档同值） */
  field: string;
  fieldFocus: string;
  /** 主按钮按下（绿深一档） */
  actionPrimaryPressed: string;
  /** 浮动圆钮与底部 sheet 的磨砂玻璃底色（叠在 BlurView 上） */
  glass: string;
  glassSheet: string;
  // —— 半透明表面（裁决 J7：悬浮元素通透档，供 M2/M3/M4 消费） ——
  /** 悬浮主档：浮动按钮 / Composer 等悬浮元素的半透明底（叠 BlurView 或纯色使用）。
   * 浅色纯白基 0.78——介于本端 glass 0.72 与桌面壳层 Mica 0.80 之间；深色以 surface 为基。 */
  surfaceTranslucent: string;
  /** 悬浮强档：展开面板等需更实底保可读性（与 glassSheet 0.86 / 桌面 Acrylic 0.85 同带）。
   * 按压态不另设色档：沿用 fillPressed alpha 叠层 / motion.pressOpacity 既有口径。 */
  surfaceTranslucentStrong: string;
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
  /** 主屏平铺列表行间距（原型 chat-list gap 24；时间线消息间距走 space.lg=16） */
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
  /** 胶囊专用（宽 > 高）；正方形圆盘禁用，圆盘圆角用 直径/2 实值 */
  pill: number;
  /** 按钮以外的小控件：输入框、行内块、工具输出块 */
  control: number;
  /** 卡片、设置分组 */
  card: number;
  /** 用户消息气泡 */
  bubble: number;
  /** 用户气泡尾角（朝向发言侧的收窄角） */
  bubbleTail: number;
  /** 账号 v3 输入框 */
  field: number;
  /** 账号 v3 验证码格 */
  codeCell: number;
  /** Sheet / 工具抽屉顶部圆角 */
  sheet: number;
  /** 审批弹窗 Sheet 圆角（原型专档 24，区别于通用 sheet 28) */
  sheetApproval: number;
  /** Composer 输入胶囊（单行/多行恒定，与高度解耦） */
  composer: number;
  /** 下拉菜单 / 通知横幅等浅浮层容器 */
  menu: number;
  /** 居中确认弹窗卡片 */
  dialog: number;
  /** 悬浮审批卡等强调浮层 */
  overlay: number;
}

/** 字阶变体样式：buildType 逐档恒给 fontSize/lineHeight（数值派生点遍布组件，
 * 如「自 caption 派生 −2」），以必填字段收口类型，消费方不再需要非空断言
 * 或 ?? 兜底（TS18048 根治，M8 收口） */
export interface ThemeTextStyle extends TextStyle {
  fontSize: number;
  lineHeight: number;
}

export interface ThemeType {
  largeTitle: ThemeTextStyle;
  title: ThemeTextStyle;
  title2: ThemeTextStyle;
  headline: ThemeTextStyle;
  /** Markdown h2 专用档（批 E 跨端排版收敛，2026-11-03)：与桌面
   * markdown-typography 的 h2 18px 对齐；headline(16）是 UI 页头档、
   * 消费面遍布全 App，不随 Markdown 口径动，故另立本档只供 MarkdownText */
  mdHeading2: ThemeTextStyle;
  body: ThemeTextStyle;
  bodyStrong: ThemeTextStyle;
  chat: ThemeTextStyle;
  callout: ThemeTextStyle;
  footnote: ThemeTextStyle;
  caption: ThemeTextStyle;
  sectionLabel: ThemeTextStyle;
  mono: ThemeTextStyle;
  /** 账号 v3 页面大标题 28/36 */
  bigTitle: ThemeTextStyle;
  /** 账号 v3 账号名 20/26 */
  accountName: ThemeTextStyle;
  /** 验证码数字 24/30 等宽 */
  codeDigit: ThemeTextStyle;
  /** 顶栏小胶囊按钮文字 14/600 */
  barAction: ThemeTextStyle;
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
  /** Sheet 关闭圆钮直径（圆角取其一半实值） */
  sheetClose: number;
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
  /** 代码块滚动视口高度封顶（批 E，2026-11-03)：介于 Cherry 192（偏紧）
   * 与桌面 min(480px,50vh）之间取 320；头栏与容器内衬另计，总高仍 < 480 */
  codeBlockMaxHeight: number;
  /** markdown / 消息级图片高度封顶（批 E；Cherry 同值 320，contain 保全图） */
  imageMaxHeight: number;
}

// 阴影体系已整体退役（2026-11-02 用户裁决）：Android 只认 elevation、由系统
// Material 光照模型合成，灰度远重于原型 CSS 软阴影且无从调校——按钮与浮动
// 表面改走亮度台阶区分（surfaceRaised 档）。Theme 不再有 shadow 字段，
// 消费面零 elevation / shadow*，由 noShadow.guard.test.ts 钉住防回潮。

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
    /** 菜单升起（原型 dropdown-menu 0.18s emphasized；DropdownMenu /
     * 横幅退场消费） */
    menu: number;
    normal: number;
    sheet: number;
    settle: number;
    /** 旋转指示周期（原型 spinner-ring-gray 1.5s 线性；ChatFlatItem 运行环） */
    spin: number;
    /** 光标呼吸半周期（CodeCells 验证码光标 0.4s 往返） */
    blink: number;
    /** 抽屉开合（原型 0.35s emphasized 定时；M2 消费，替代弹簧口径） */
    drawer: number;
    /** 搜索展开 / 键盘联动（原型 0.28s emphasized 定时；M2/M3 消费） */
    expand: number;
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

/** 代码高亮色板（批 E，2026-11-03)：封口代码块的词法角色色，角色划分对
 * 齐 Cherry 的 11 角色思路（参数级借鉴），色值按本端底色（代码块底 =
 * surfaceGrouped）自建：浅色在白底、深色在 #1c1c1c 底上均保足可读对比；
 * comment 不入板，呈现层直用 colors.textTertiary（跟随主题文字阶梯）。
 * 中性灰档按其推导规则 3 同法降饱和（见 neutralSyntax 注记）。 */
export interface ThemeSyntaxPalette {
  keyword: string;
  string: string;
  number: string;
  function: string;
  type: string;
  constant: string;
  property: string;
  tag: string;
  inserted: string;
  deleted: string;
}

export interface Theme {
  dark: boolean;
  colors: ThemeColors;
  space: ThemeSpace;
  radius: ThemeRadius;
  type: ThemeType;
  size: ThemeSize;
  layout: ThemeLayout;
  motion: ThemeMotion;
  avatarTones: readonly AvatarTone[];
  syntax: ThemeSyntaxPalette;
}

// 浅色全值 = 参考原型（reference/crish-mobile-drawer/css/variables.css 及组件稿），
// 由 styleTokens.guard.test.ts 的原型同值 fixture 逐项锁定，改值先改原型再改此处。
const lightBase: BaseColors = {
  canvas: '#f4f4f4',
  canvasGrouped: '#f4f4f4',
  canvasDrawer: '#f0f0f0',
  surface: '#ffffff',
  surfaceGrouped: '#ffffff',
  surfaceRaised: '#ffffff',
  fillSubtle: '#f4f4f4',
  fillPressed: 'rgba(0,0,0,0.035)',
  fillSelected: 'rgba(0,0,0,0.03)',
  bubbleUser: '#171717',
  bubbleUserText: '#ffffff',
  textPrimary: '#171717',
  textSecondary: '#555555',
  textTertiary: '#6e6e6e',
  textDisabled: '#aaaaaa',
  hairline: 'rgba(0,0,0,0.045)',
  borderStrong: '#e5e5e5',
  actionPrimary: '#10b981',
  actionPrimaryText: '#ffffff',
  actionDisabled: '#ececec',
  brand: '#10b981',
  brandStrong: '#047857',
  brandSoft: '#e7f6ec',
  success: '#10b981',
  successSoft: '#e7f6ec',
  danger: '#ef4444',
  dangerForeground: '#ffffff',
  dangerSoft: '#fef2f2',
  warning: '#f59e0b',
  warningText: '#9a5200',
  warningSoft: '#fdf3e1',
  info: '#0b66d6',
  infoSoft: '#e8f1fd',
  dotOffline: '#9ca3af',
  onMedia: '#ffffff',
  onMediaDanger: '#fecaca',
  scrim: 'rgba(0,0,0,0.28)',
  scrimStrong: 'rgba(0,0,0,0.35)',
  field: '#ffffff',
  fieldFocus: '#ffffff',
  // 按下绿：原型无此值；主按钮填充恢复 actionPrimary 亮绿（用户裁决
  // 2026-11-02，推翻 D3 的 brandStrong 深绿填充），按下档取同族深一档
  // emerald 600（推导值）
  actionPrimaryPressed: '#059669',
  glass: 'rgba(244,244,244,0.72)',
  glassSheet: 'rgba(244,244,244,0.86)',
  surfaceTranslucent: 'rgba(255,255,255,0.78)',
  surfaceTranslucentStrong: 'rgba(255,255,255,0.88)',
};

// 深色：原型无真源（裁决 J1)。共享尺度随浅色同步；颜色只做角色修正——
// 主操作绿、待审批琥珀系、危险亮红系、气泡深底亮字、success 与 brand 统一；
// 其余色值保持现深色体系明度关系，新增档均为推导值（逐项注明）。
const darkBase: BaseColors = {
  canvas: '#121212',
  canvasGrouped: '#121212',
  // 推导：与浅色同关系（抽屉比主屏深一档），在 canvas 之下取一档
  canvasDrawer: '#0e0e0e',
  surface: '#171717',
  surfaceGrouped: '#1c1c1c',
  surfaceRaised: '#1e1e1e',
  fillSubtle: '#202020',
  fillPressed: '#262626',
  // 推导：选中面取白 alpha 微步（深底上的同角色叠色）
  fillSelected: 'rgba(255,255,255,0.05)',
  bubbleUser: '#262626',
  bubbleUserText: '#ececec',
  textPrimary: '#ececec',
  textSecondary: '#b4b4b4',
  textTertiary: '#8e8e8e',
  textDisabled: '#5a5a5a',
  hairline: '#1b1b1b',
  borderStrong: '#2e2e2e',
  // 角色修正（J1)：主操作由近白改绿，与 brand 同值；文字随之反白
  actionPrimary: '#10b981',
  actionPrimaryText: '#ffffff',
  actionDisabled: '#202020',
  brand: '#10b981',
  // brandStrong：深绿档，保留作浅底深绿文字/点缀用途（三套同值 #047857，
  // 作文字对浅底 ≈5.48:1）；带文字主按钮的填充已按用户裁决（2026-11-02）
  // 恢复 actionPrimary 亮绿，不再走本档（深色按下提亮走 actionPrimaryPressed #34d399）
  brandStrong: '#047857',
  brandSoft: '#17301f',
  // 角色修正（J1)：success 与 brand 统一（原 #3fb950 并入 #10b981)
  success: '#10b981',
  successSoft: '#17301f',
  danger: '#f87171',
  dangerForeground: '#0f0f0f',
  dangerSoft: '#251818',
  warning: '#e3a33b',
  warningText: '#e3a33b',
  warningSoft: '#3a2a12',
  info: '#58a6ff',
  infoSoft: '#14263d',
  // 推导：与浅色同值（中灰在深底同样可辨，离线语义靠灰阶本身）
  dotOffline: '#9ca3af',
  onMedia: '#ffffff',
  onMediaDanger: '#fecaca',
  scrim: 'rgba(0,0,0,0.5)',
  // 推导：弹窗遮罩比 Sheet 遮罩深一档（与浅色 0.28→0.35 同关系）
  scrimStrong: 'rgba(0,0,0,0.6)',
  field: '#1b1b1b',
  fieldFocus: '#222222',
  // 推导：按下绿取同族亮绿（深底按下提亮口径）
  actionPrimaryPressed: '#34d399',
  glass: 'rgba(32,32,32,0.68)',
  glassSheet: 'rgba(22,22,22,0.84)',
  // J7 深色档：以 surface(#171717）为基，alpha 与浅色主/强两档对应（推导值）
  surfaceTranslucent: 'rgba(23,23,23,0.72)',
  surfaceTranslucentStrong: 'rgba(23,23,23,0.86)',
};

// 纯净中性灰（裁决 J5/J8，第四档）：【整套为推导值，原型未给任何色值，待用户
// 验收确认】。推导规则（源：原型灰阶 #171717/#555555/#6e6e6e/#aaaaaa 文字四阶、
// #f4f4f4/#f0f0f0 底、#e5e5e5 线 + J8 彩色克制原则）：
// 1) 结构层（底/面/线/文字/alpha 档/玻璃档）本就是纯中性灰（R=G=B 或纯黑
//    alpha)，与浅色同值——本档的「纯净」与浅色共用同一灰阶骨架；
// 2) 功能色（绿：brand/actionPrimary/success/info 蓝）全部收敛为中性墨/灰阶
//    等值——语义改靠形态（填充按钮+白字、点+文案、开关钮位）与文字承载；
// 3) 状态语义色（红/琥珀）保留功能色相但降饱和向灰靠（HSL 饱和度各降约
//    25–35 个百分点），仍可一眼辨义、但不跳色；此处置待用户验收时裁定；
// 4) 本档为浅色语境单档（dark=false)，不设深色变体（结构位见 projectTheme
//    的 mode 分发，日后推导深色中性灰时在此并列新增一表即可）。
const neutralBase: BaseColors = {
  // —— 结构层：与浅色同值（原型灰阶直给） ——
  canvas: '#f4f4f4',
  canvasGrouped: '#f4f4f4',
  canvasDrawer: '#f0f0f0',
  surface: '#ffffff',
  surfaceGrouped: '#ffffff',
  surfaceRaised: '#ffffff',
  fillSubtle: '#f4f4f4',
  fillPressed: 'rgba(0,0,0,0.035)',
  fillSelected: 'rgba(0,0,0,0.03)',
  bubbleUser: '#171717',
  bubbleUserText: '#ffffff',
  textPrimary: '#171717',
  textSecondary: '#555555',
  textTertiary: '#6e6e6e',
  textDisabled: '#aaaaaa',
  hairline: 'rgba(0,0,0,0.045)',
  borderStrong: '#e5e5e5',
  // —— 功能色收敛（规则 2) ——
  // 主操作：品牌绿 → 原型墨 text-1（按钮形态+白字承载主操作语义）
  actionPrimary: '#171717',
  actionPrimaryText: '#ffffff',
  actionDisabled: '#ececec',
  // 品牌点缀收敛为墨；brandStrong 同值（原型灰阶最深即 #171717，无更深一档）
  brand: '#171717',
  brandStrong: '#171717',
  // 软底：绿软底 → 原型中性浅灰（设置头像底 #f0f0f0 同源）
  brandSoft: '#f0f0f0',
  // 完成/在线：绿 → 墨（点形态+文案承载语义；离线仍走 textTertiary，明度可分）
  success: '#171717',
  successSoft: '#f0f0f0',
  // —— 状态色降饱和（规则 3) ——
  // 红：纯红相不变，HSL 饱和 84%→62%、明度 60%→48%（砖红向灰靠）
  danger: '#c62f2f',
  dangerForeground: '#ffffff',
  // 危险软底：近中性的微暖浅灰（与 danger 文字配对对比 ≈4.8)
  dangerSoft: '#f7eeee',
  // 琥珀：色相守原型 38° 一带，HSL 饱和 92%→68%（赭黄向灰靠；仅图形档）
  warning: '#bd8324',
  // 待审批文字档：灰棕橄榄（饱和 100%→63%)，正文对比 ≥4.5 守住
  warningText: '#876a1e',
  warningSoft: '#f6f1e6',
  // 信息蓝退役：收敛 text-2 中性灰（语义靠图标/文案），软底纯灰
  info: '#555555',
  infoSoft: '#eeeeee',
  // 离线点：原型 #9ca3af 同明度去色相（纯中性灰，色相残留清零）
  dotOffline: '#a5a5a5',
  onMedia: '#ffffff',
  // 媒体上危险字：粉红 → 微暖灰白（色相残留压至近无）
  onMediaDanger: '#e9dede',
  // —— 遮罩/字段/玻璃：本就无色相，与浅色同值 ——
  scrim: 'rgba(0,0,0,0.28)',
  scrimStrong: 'rgba(0,0,0,0.35)',
  field: '#ffffff',
  fieldFocus: '#ffffff',
  // 按下档：墨主操作按下提亮一档（沿用 App 墨主操作时代的 #2a2a2a 先例）
  actionPrimaryPressed: '#2a2a2a',
  glass: 'rgba(244,244,244,0.72)',
  glassSheet: 'rgba(244,244,244,0.86)',
  surfaceTranslucent: 'rgba(255,255,255,0.78)',
  surfaceTranslucentStrong: 'rgba(255,255,255,0.88)',
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
  // pill 仅限胶囊（宽 > 高）使用；正方形圆盘禁用——9999 与 elevation 同节点在 Android
  // 会让填充/阴影轮廓分裂出八角（圆形按钮缺陷审计定案），圆盘圆角一律用 直径/2 实值。
  pill: 9999,
  control: 12,
  card: 20,
  bubble: 18,
  bubbleTail: 4,
  sheet: 28,
  sheetApproval: 24,
  field: 18,
  codeCell: 16,
  // composer 卡圆角：原型 26；单行 52px 严格胶囊半圆 R=26；展开 98px 保持稳定 R=26
  composer: 26,
  menu: 18,
  dialog: 36,
  overlay: 30,
};

const systemMonoFont = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

/** 等宽字体族注册（W-A 字体设置真源；family 名 = expo-font 加载名，未加载时平台回落） */
export const MONO_FONT_FAMILY: Record<MonoFont, string> = {
  system: systemMonoFont,
  jetbrains: 'JetBrainsMono_400Regular',
  fira: 'FiraCode_400Regular',
};

/** 等宽 600 字重族（codeDigit 等加粗等宽场景专用：RN 里 family+fontWeight 不会自动选
 * 到随包的 600 字体文件，必须按族名显式指向 *_600SemiBold，否则只是合成假粗。
 * 注：@expo-google-fonts 的 600 字重导出名是 SemiBold，不存在 *_600Regular） */
export const MONO_FONT_FAMILY_600: Record<MonoFont, string> = {
  system: systemMonoFont,
  jetbrains: 'JetBrainsMono_600SemiBold',
  fira: 'FiraCode_600SemiBold',
};

/** 随包等宽字体加载清单（根布局 expo-font 预载；400/600 双字重覆盖 mono 与加粗场景） */
export const BUNDLED_MONO_FONT_FAMILIES = [
  'JetBrainsMono_400Regular',
  'JetBrainsMono_600SemiBold',
  'FiraCode_400Regular',
  'FiraCode_600SemiBold',
] as const;

/** 字阶生成：所有档位统一乘 fontScale（同层级同乘，保持节奏；字号与行高同步取整） */
function scaled(
  style: ThemeTextStyle,
  scale: number,
  monoFamily: string
): ThemeTextStyle {
  const out: ThemeTextStyle = { ...style };
  if (typeof style.fontSize === 'number') {
    out.fontSize = Math.round(style.fontSize * scale * 10) / 10;
  }
  if (typeof style.lineHeight === 'number') {
    out.lineHeight = Math.round(style.lineHeight * scale * 10) / 10;
  }
  if (style.fontFamily === systemMonoFont) {
    out.fontFamily = monoFamily;
  }
  return out;
}

// 字阶（原型 14 中心制）：body/chat 14、行文 14、标题按原型逐项——
// 弹窗标题 16.5/600(title2)、Sheet/页头标题 16/600(headline)、分组标签 12/600、
// 元信息 13/400、时间 12.5/400(caption，字重回 400)、代码 12(mono)。
// 标题/名称/标签类普遍带 -0.01em 等价 letterSpacing（按字号折算取整到 0.01)。
// bodyStrong 保留 16/600：平铺会话行标题原型即 16/600（§3.2 #17 同值项），
// 其余误用点（抽屉名字 14/600 等）由 M2/M5 在组件侧改选 variant。
//
// 跨端排版口径（批 E 收敛定案，2026-11-03；与桌面 markdown-typography /
// tokens-components 对照后的裁决全集，防再漂移）：
// - h2：双端收敛 18/600——桌面既有值 18 为准，本端立 mdHeading2 专用档
//   （headline 16 是 UI 页头档，不动）；h1/h3–h6 非分歧项，维持现行映射
//   （h1 title 20、h3 bodyStrong 16、h4 chat+700、h5 footnote+700、
//   h6 caption+700；桌面梯 22/16/15/14/13，移动标题整体克制一档为既定形态）；
// - 正文行高比：收敛 1.55——chat 行高 21 → 21.7(= 14 × 1.55，与桌面
//   --lh-prose 同值）；body(UI 正文）维持 21 的界面密度，不随阅读口径；
// - 表格 cell padding：有意保留平台差异——桌面 10×14，本端横 8 / 纵 4
//   （窄屏横滑表格的密度口径；字号双端同为 14 已收敛），不强行对齐；
// - 段距：双端同为单边距——本端块间 gap(space.md）无 margin 概念、天然
//   单边；桌面标题 margin 已同步改 bottom-only(tokens-components.css)。
function buildType(
  scale: number,
  monoFamily: string,
  monoFamily600: string = monoFamily
): ThemeType {
  const largeTitle: ThemeTextStyle = {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '700',
    letterSpacing: -0.3,
  };
  const title2: ThemeTextStyle = {
    fontSize: 16.5,
    lineHeight: 22,
    fontWeight: '600',
    letterSpacing: -0.17,
  };
  const headline: ThemeTextStyle = {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '600',
    letterSpacing: -0.16,
  };
  const footnote: ThemeTextStyle = {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400',
    fontVariant: ['tabular-nums'],
  };
  const type: ThemeType = {
    largeTitle: scaled(largeTitle, scale, monoFamily),
    title: scaled(
      { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.2 },
      scale,
      monoFamily
    ),
    title2: scaled(title2, scale, monoFamily),
    headline: scaled(headline, scale, monoFamily),
    mdHeading2: scaled(
      { fontSize: 18, lineHeight: 24, fontWeight: '600', letterSpacing: -0.18 },
      scale,
      monoFamily
    ),
    body: scaled(
      { fontSize: 14, lineHeight: 21, fontWeight: '400' },
      scale,
      monoFamily
    ),
    bodyStrong: scaled(
      { fontSize: 16, lineHeight: 24, fontWeight: '600', letterSpacing: -0.16 },
      scale,
      monoFamily
    ),
    chat: scaled(
      // 行高 21.7 = 14 × 1.55：与桌面 markdown 正文行高比收敛（批 E，见上）
      { fontSize: 14, lineHeight: 21.7, fontWeight: '400' },
      scale,
      monoFamily
    ),
    callout: scaled(
      { fontSize: 14, lineHeight: 20, fontWeight: '400' },
      scale,
      monoFamily
    ),
    footnote: scaled(footnote, scale, monoFamily),
    caption: scaled(
      {
        fontSize: 12.5,
        lineHeight: 16,
        fontWeight: '400',
        fontVariant: ['tabular-nums'],
      },
      scale,
      monoFamily
    ),
    sectionLabel: scaled(
      { fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: -0.12 },
      scale,
      monoFamily
    ),
    mono: scaled(
      {
        fontSize: 12,
        lineHeight: 18,
        fontWeight: '400',
        fontFamily: systemMonoFont,
      },
      scale,
      monoFamily
    ),
    bigTitle: scaled(
      {
        fontSize: 28,
        lineHeight: 36,
        fontWeight: '700',
        letterSpacing: -0.4,
      },
      scale,
      monoFamily
    ),
    accountName: scaled(
      { fontSize: 16, lineHeight: 22, fontWeight: '600', letterSpacing: -0.16 },
      scale,
      monoFamily
    ),
    codeDigit: scaled(
      {
        fontSize: 24,
        lineHeight: 30,
        fontWeight: '600',
        fontVariant: ['tabular-nums'],
        // 配对码大数字同样走所选等宽字体（Q2 裁决）：以 systemMonoFont 为锚点被
        // scaled() 换成目标族，且指向 600 字重族（与自身 fontWeight 600 对齐）
        fontFamily: systemMonoFont,
      },
      scale,
      monoFamily600
    ),
    barAction: scaled(
      { fontSize: 14, lineHeight: 20, fontWeight: '600' },
      scale,
      monoFamily
    ),
  };
  return type;
}

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
  sheetHandleHeight: 4,
  sheetClose: 30,
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
  drawerMaxWidth: 320,
  // 64dp：避开 Android 全面屏系统返回手势的 0~32dp 感应带（实现波总方案 D8）
  drawerSwipeEdgeWidth: 64,
  /** 底层抽屉内容随开合的视差位移（负值 = 向左退让） */
  drawerParallaxOffset: -60,
  composerInputMaxHeight: 120,
  toolSheetDetents: [0.45, 0.92],
  approvalSheetDetents: [0.6, 0.92],
  dialogMaxWidth: 320,
  brandMarkCorner: 0.3,
  fieldPadding: 18,
  accountPageX: 24,
  /** 图标全局唯一标准线宽（24 网格；原型主档 1.8，对号等例外由 Icon 按名覆盖） */
  iconStroke: 1.8,
  codeBlockMaxHeight: 320,
  imageMaxHeight: 320,
};

// 键盘单时钟源正典（2026-11-03 批 A 成文；源出 Cherry 深比 01-1/2 的
// 参数级对照与本仓 M-B/M-C/M-D 落地形态，防新浮层再犯同屏多节奏）：
// 1) 凡随键盘动的运动，只准消费 react-native-keyboard-controller 的
//    逐帧 height/progress（KeyboardStickyView /
//    useReanimatedKeyboardAnimation / useKeyboardHandler），禁止自配
//    时长/曲线；离散键盘高度（useKeyboardHeight）不得驱动定位，只许
//    用于时序门（如 Sheet 呈现交接的 settle 等待，见 ui/Sheet.tsx）。
// 2) 聚焦触发的状态过渡预算 ≤120ms（snappy 档），须在键盘行程前
//    1/3 内完成：本仓 composer 恒两行（用户裁决），聚焦不切换形态，
//    此预算的现行落点是焦点/按压反馈过渡（pressFeedback 的 snappy）。
// 3) 打字引起的输入框增高直达落值、零补间（ui/Composer.tsx 的
//    handleContentSizeChange 现行实现）：逐字补间 = 框体追赶文字，
//    是输入卡顿源，已废止；duration.expand 的现行消费面只有抽屉搜索
//    展开与 Sheet 面板程式化开合等非打字节奏，不得挪回打字路径。
// 与桌面 apps/crish-desktop/src/utils/motionTokens.ts 同值
const motion: ThemeMotion = {
  duration: {
    micro: 100,
    snappy: 120,
    fast: 150,
    menu: 180,
    normal: 200,
    sheet: 220,
    settle: 260,
    spin: 1500,
    blink: 400,
    drawer: 350,
    expand: 280,
  },
  easing: {
    standard: [0.4, 0, 0.2, 1],
    emphasized: [0.16, 1, 0.3, 1],
    // decelerate 与桌面 motionTokens.EASE_DECELERATE 同值（cubic-bezier(0.2,0,0,1)
    // 快出减速）——2026-11-02 跨端漂移比对修正：旧值 [0,0,0.2,1] 是慢起变体、
    // 与「decelerate」语义不符；消费面仅 Toast 进出场，曲线更贴合滑入减速。
    decelerate: [0.2, 0, 0, 1],
  },
  // enter = 审批浮卡进场专用档（唯一消费 ApprovalFloat，translateY 6 = 浮卡
  // 上移进场）：原型 conv-approval-floating-popup transition transform 0.22s /
  // opacity 0.18s（conversation-view.css）——2026-11-02 对齐原型取 transform
  // 主导 220（旧 150 为未溯源近似值）。
  enter: { duration: 220, translateY: 6 },
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

// 头像兜底：原型为统一中性灰（抽屉 #e4e4e4 底 + 中性字），粉彩色板退役；
// 数组形态保留（avatarToneFor 按 id 取模），浅色各档同值即视觉统一。
// 深色为推导：同中性口径，按深色体系明度取深灰底 + 中灰字。
const lightAvatarTones: readonly AvatarTone[] = [
  { bg: '#e4e4e4', fg: '#555555' },
  { bg: '#e4e4e4', fg: '#555555' },
  { bg: '#e4e4e4', fg: '#555555' },
  { bg: '#e4e4e4', fg: '#555555' },
  { bg: '#e4e4e4', fg: '#555555' },
  { bg: '#e4e4e4', fg: '#555555' },
];

const darkAvatarTones: readonly AvatarTone[] = [
  { bg: '#2c2c2c', fg: '#b4b4b4' },
  { bg: '#2c2c2c', fg: '#b4b4b4' },
  { bg: '#2c2c2c', fg: '#b4b4b4' },
  { bg: '#2c2c2c', fg: '#b4b4b4' },
  { bg: '#2c2c2c', fg: '#b4b4b4' },
  { bg: '#2c2c2c', fg: '#b4b4b4' },
];

// 高亮色板三档（批 E)：浅色 = 白底（surfaceGrouped #ffffff）上的克制色
// 阶（紫 / 深绿 / 蓝 / 赭 / 青 / 砖红，均压过 4.5:1)；深色 = #1c1c1c 底上
// 的同色相提亮档；中性灰按其推导规则 3 降饱和向灰靠（推导值，随中性灰
// 整档待用户验收）。
const lightSyntax: ThemeSyntaxPalette = {
  keyword: '#a626a4',
  string: '#2f7d32',
  number: '#b76b01',
  function: '#2a5fd7',
  type: '#0e7c86',
  constant: '#b23a48',
  property: '#6f42c1',
  tag: '#22863a',
  inserted: '#2f7d32',
  deleted: '#cf222e',
};

const darkSyntax: ThemeSyntaxPalette = {
  keyword: '#c792ea',
  string: '#a8cc8c',
  number: '#f0a35e',
  function: '#82aaff',
  type: '#6fd3d6',
  constant: '#f78c9c',
  property: '#c3a6f2',
  tag: '#7ee0a3',
  inserted: '#a8cc8c',
  deleted: '#f78c9c',
};

const neutralSyntax: ThemeSyntaxPalette = {
  keyword: '#8a5a96',
  string: '#4a7247',
  number: '#a06a28',
  function: '#4a6db3',
  type: '#3f7d84',
  constant: '#a34a55',
  property: '#71589c',
  tag: '#527a54',
  inserted: '#4a7247',
  deleted: '#b04040',
};

function buildTheme(
  base: BaseColors,
  dark: boolean,
  avatarTones: readonly AvatarTone[],
  type: ThemeType,
  syntax: ThemeSyntaxPalette
): Theme {
  return {
    dark,
    colors: base,
    space,
    radius,
    type,
    size,
    layout,
    motion,
    avatarTones,
    syntax,
  };
}

export const lightTheme: Theme = buildTheme(
  lightBase,
  false,
  lightAvatarTones,
  buildType(1, systemMonoFont),
  lightSyntax
);

export const darkTheme: Theme = buildTheme(
  darkBase,
  true,
  darkAvatarTones,
  buildType(1, systemMonoFont),
  darkSyntax
);

/** 纯净中性灰主题（推导档，J5/J8)：浅色语境（dark=false)，头像兜底与
 * 浅色共享——头像兜底本就是统一中性灰，正合本档定义；几何/字阶全档共享。 */
export const neutralTheme: Theme = buildTheme(
  neutralBase,
  false,
  lightAvatarTones,
  buildType(1, systemMonoFont),
  neutralSyntax
);

/** 按 id 稳定取头像色（字符串哈希取模，同一会话恒定同色） */
export function avatarToneFor(id: string, theme: Theme): AvatarTone {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return theme.avatarTones[hash % theme.avatarTones.length]!;
}

/** 四选顺序（UI 渲染顺序 = 读屏顺序；第四档为纯净中性灰推导档，J5) */
export const THEME_MODES: readonly ThemeMode[] = [
  'system',
  'light',
  'dark',
  'neutral',
];

export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
  neutral: '纯净中性灰',
};

/** 外观偏好快照（主题 + 字号 + 等宽字体；useTheme 唯一消费） */
export interface ThemePrefs {
  fontScale: FontScale;
  monoFont: MonoFont;
}

const DEFAULT_PREFS: ThemePrefs = { fontScale: 'standard', monoFont: 'system' };

/** 变体主题缓存：键 = base 主题 + 偏好；standard/system 命中基座单例（身份稳定） */
const variantThemeCache = new Map<string, Theme>();

/** 基座主题缓存键：中性灰与浅色同为 dark=false，不能只按 dark 布尔分键
 * （会与浅色变体串键），故按基座单例身份登记短键，未登记者回退布尔键。 */
const baseThemeKeys = new WeakMap<Theme, string>([
  [lightTheme, 'l'],
  [darkTheme, 'd'],
  [neutralTheme, 'n'],
]);

function cachedVariant(
  base: Theme,
  prefs: ThemePrefs,
  build: () => Theme
): Theme {
  if (prefs.fontScale === 'standard' && prefs.monoFont === 'system') {
    return base;
  }
  const baseKey = baseThemeKeys.get(base) ?? (base.dark ? 'd' : 'l');
  const key = `${baseKey}|${prefs.fontScale}|${prefs.monoFont}`;
  const hit = variantThemeCache.get(key);
  if (hit) return hit;
  const built = build();
  variantThemeCache.set(key, built);
  return built;
}

/** 字号/等宽字体变体构建：色板与几何不动，仅 type 阶梯按乘数重建 */
function buildVariant(base: Theme, prefs: ThemePrefs): Theme {
  const type = buildType(
    FONT_SCALE_FACTOR[prefs.fontScale],
    MONO_FONT_FAMILY[prefs.monoFont],
    MONO_FONT_FAMILY_600[prefs.monoFont]
  );
  return { ...base, type };
}

export function projectTheme(
  mode: ThemeMode,
  systemTheme: Theme,
  prefs: ThemePrefs = DEFAULT_PREFS
): Theme {
  const base =
    mode === 'light'
      ? lightTheme
      : mode === 'dark'
        ? darkTheme
        : mode === 'neutral'
          ? neutralTheme
          : systemTheme;
  return cachedVariant(base, prefs, () => buildVariant(base, prefs));
}

/** 主题唯一消费入口（外观四选 + 字号/等宽来自 settingsStore.appearance） */
export function useTheme(): Theme {
  const appearance = useStore(settingsStore, (s) => s.groups.appearance);
  const systemTheme = useColorScheme() === 'dark' ? darkTheme : lightTheme;
  return projectTheme(appearance.theme, systemTheme, {
    fontScale: appearance.fontScale,
    monoFont: appearance.monoFont,
  });
}

/** 外观四选写入（唯一写入口） */
export function setThemeMode(mode: ThemeMode): void {
  settingsStore.getState().update('appearance', { theme: mode });
}

/** 测试隔离：主题偏好复位（含字号/等宽，保持缺省身份） */
export function resetThemeModeForTest(): void {
  settingsStore.setState((state) => ({
    groups: {
      ...state.groups,
      appearance: {
        theme: 'system',
        fontScale: 'standard',
        monoFont: 'system',
      },
    },
    hydrated: false,
  }));
}
