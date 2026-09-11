/**
 * 图标尺寸 / 描边契约（SSOT）
 * 面板内统一：基准 16，最小 14；禁止 10–13 / 15 等杂散档。
 */

export const ICON_SIZE = {
  /** 紧凑行内（最小档） */
  sm: 14,
  /** 面板 / 导航 / 工具栏基准 */
  md: 16,
  /** 空态强调 */
  lg: 20,
  xl: 24,
} as const;

export type IconSizeKey = keyof typeof ICON_SIZE;

/**
 * 描边：全应用 24 网格统一。
 * chrome 与 ui 同值，侧栏开关与其它图标线宽/灰度一致。
 *
 * 【线宽 SSOT 铁律】图标描边的唯一合法取值来源即本表。
 * 业务自定义 SVG（fontIcons / SelectIcons / animated-icons 等）禁止裸写 strokeWidth 数字，
 * 必须 import 本表或在 props 上以 ICON_STROKE 派生；由 scripts/check-line-width-ssot.mjs 强制。
 *
 * 档位语义（禁止新增档位，新增须先改本表并同步门禁）：
 * - chrome / ui：面板、导航、工具栏、表单控件内图标的基准粗细（全应用主力档）
 * - fine：仅在图标尺寸明显偏小或信号密集（密集列表、微型 chip）时用于减细
 * - heavy：需要更强存在感的强调图标
 *
 * 【2026-09-11 用户裁决 · 图标加粗，与 UI 线条降调区分】
 * 图标描边**不加细**——存在感不足会显得糊；主力档上调至 2（原 1.75）。
 * 注意这与「UI 线条/按钮边框弱化」是相互独立的两条线：
 *   · 图标 strokeWidth → 本表，走"更清晰、更实"的方向；
 *   · 边框/分隔线 → tokens.css 的 --hairline* / --border-*，走"更轻、更弱"的方向。
 */
export const ICON_STROKE = {
  chrome: 2,
  ui: 2,
  fine: 1.75,
  heavy: 2.25,
} as const;

export type IconStrokeKey = keyof typeof ICON_STROKE;

export const DEFAULT_ICON_SIZE: number = ICON_SIZE.md;
export const DEFAULT_ICON_STROKE: number = ICON_STROKE.ui;

/**
 * 线宽契约快照（供门禁脚本与测试消费，单一出处）。
 * 任何新增/调整档位只改这里，门禁自动跟随。
 */
export const STROKE_CONTRACT = {
  /** 图标描边合法值集合 */
  allowed: [ICON_STROKE.chrome, ICON_STROKE.fine, ICON_STROKE.heavy] as number[],
  /** UI 线条（border / outline / 分隔线）合法值 */
  uiLineAllowed: [1, 2] as number[],
  /** 焦点环合法值（focus-visible.css 契约） */
  focusRing: 1.5,
} as const;

/**
 * 尺寸吸附：<15 → 14；15–19 → 16；≥20 保持（空态/强调）。
 * 业务可写任意数字，最终由 AppIcon 统一到合法档。
 */
export function snapIconSize(size: number | string | undefined): number {
  if (size === undefined || size === null || size === '') {
    return DEFAULT_ICON_SIZE;
  }
  const n = typeof size === 'number' ? size : Number.parseInt(String(size), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ICON_SIZE;
  if (n >= 20) return Math.round(n);
  if (n >= 15) return ICON_SIZE.md;
  return ICON_SIZE.sm;
}
