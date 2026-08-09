/**
 * 渲染主题与数学引擎注入点（R5-C：渲染注册表 + 主题注入）
 *
 * 对应 docs/analysis/06-扩展功能-技术维度.md §5：
 * - 主题：renderTheme token 映射（颜色/字体/圆角/行高倍率）——
 *   现有 colorAdaptor 承担颜色计算，主题只是 token 选择层；
 * - 数学引擎：`mathRenderer: (formula, display) => string` 注入点——
 *   KaTeX 默认，可换 MathJax/自研。
 *
 * 形态选型：模块级单例（任务书「模块级简单优先」）——渲染器是纯展示
 * 组件，主题 token 只在渲染时读取，不需要 React Context 的订阅/重渲染
 * 机制；宿主（Conex）在挂载前调用 setRenderTheme / setMathRenderer 即可。
 *
 * 默认主题 = 现有 CSS 变量值（var(--xxx) 引用）：CSS 变量仍是唯一
 * 定义源，token 只是其具名别名，默认状态行为零变化。
 */
import katex from 'katex';

/** 主题颜色 token（均引用现有 CSS 变量，见 src/index.css :root） */
export interface RenderThemeColors {
  /** 编辑器底色 */
  bg: string;
  /** 主文字 */
  textPrimary: string;
  /** 次文字 */
  textSecondary: string;
  /** 弱化文字（占位/注释） */
  textMuted: string;
  /** 选区高亮背景 */
  selectionBg: string;
  /** 弱边框 */
  borderSubtle: string;
  /** 中边框 */
  borderMedium: string;
  /** 聚焦/交互边框 */
  borderFocus: string;
  /** 强调文字（黄色系） */
  yellowText: string;
}

/** 主题字体 token */
export interface RenderThemeFonts {
  /** 等宽字体栈（代码/表格/数学） */
  mono: string;
}

/** 主题圆角 token */
export interface RenderThemeRadius {
  /** 小圆角（滚动条/内嵌元素） */
  small: string;
  /** 中圆角（卡片/弹层） */
  medium: string;
}

/**
 * 渲染主题：token 映射集合。
 * 行高倍率 lineHeight 为无单位倍率（行内容高 = 字号 × 倍率），
 * 供宿主做主题化时整体缩放排版密度。
 */
export interface RenderTheme {
  colors: RenderThemeColors;
  fonts: RenderThemeFonts;
  radius: RenderThemeRadius;
  lineHeight: number;
}

/** 默认主题：全部引用现有 CSS 变量值，行为与未注入主题时完全一致 */
export const DEFAULT_RENDER_THEME: RenderTheme = {
  colors: {
    bg: 'var(--bg-theme)',
    textPrimary: 'var(--text-primary)',
    textSecondary: 'var(--text-secondary)',
    textMuted: 'var(--text-muted)',
    selectionBg: 'var(--selection-bg)',
    borderSubtle: 'var(--border-subtle)',
    borderMedium: 'var(--border-medium)',
    borderFocus: 'var(--border-focus)',
    yellowText: 'var(--yellow-text)',
  },
  fonts: {
    mono: 'var(--font-mono)',
  },
  radius: {
    small: '4px',
    medium: '8px',
  },
  // 行网格 28px（--grid-size）/ 默认字号 14px = 2 倍行高
  lineHeight: 2,
};

// 模块级当前主题（默认主题；setRenderTheme 整体替换）
let currentTheme: RenderTheme = DEFAULT_RENDER_THEME;

/** 注入主题（整体替换 token 映射）；传默认主题对象可恢复出厂 */
export function setRenderTheme(theme: RenderTheme): void {
  currentTheme = theme;
}

/** 读取当前主题（渲染组件在渲染期读取；模块级，无需 Context） */
export function getRenderTheme(): RenderTheme {
  return currentTheme;
}

// ============================================================
// 数学引擎注入点
// ============================================================

/**
 * 数学渲染器签名：(formula, display) => html。
 * display = true 表示块级数学（displayMode）。
 */
export type MathRenderer = (formula: string, displayMode: boolean) => string;

/** 默认数学渲染器：KaTeX（renderToString + throwOnError: false 兜底原文） */
const defaultMathRenderer: MathRenderer = (formula, displayMode) => {
  try {
    return katex.renderToString(formula, {
      throwOnError: false,
      displayMode,
    });
  } catch {
    return formula;
  }
};

// 模块级当前数学渲染器（KaTeX 默认；可换 MathJax/自研）
let currentMathRenderer: MathRenderer = defaultMathRenderer;

/** 注入数学渲染器（KaTeX 默认；传空恢复默认） */
export function setMathRenderer(renderer: MathRenderer | null): void {
  currentMathRenderer = renderer ?? defaultMathRenderer;
}

/** 读取当前数学渲染器（测试/宿主自检用） */
export function getMathRenderer(): MathRenderer {
  return currentMathRenderer;
}

/**
 * 数学渲染统一入口：BlockRenderer/InlineRenderer 的 renderMathToHtml
 * 全部改走本注入点。空公式早退语义与历史实现一致（不触发渲染器）。
 */
export function renderMathToHtml(
  formula: string,
  displayMode: boolean = false
): string {
  if (!formula) return '';
  return currentMathRenderer(formula, displayMode);
}
