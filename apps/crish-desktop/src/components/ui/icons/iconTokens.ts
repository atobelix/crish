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
 */
export const ICON_STROKE = {
  chrome: 1.75,
  ui: 1.75,
  fine: 1.5,
} as const;

export type IconStrokeKey = keyof typeof ICON_STROKE;

export const DEFAULT_ICON_SIZE: number = ICON_SIZE.md;
export const DEFAULT_ICON_STROKE: number = ICON_STROKE.ui;

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
