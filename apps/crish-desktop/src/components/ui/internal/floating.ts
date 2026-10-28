/**
 * Floating Layering Model (浮动锚定型)
 *
 * 物理分层拓扑: Portal -> Positioner -> Popup (可选 Arrow)
 * 适用于 Tooltip, Select, Menu, ContextMenu, PreviewCard 等浮动锚定组件。
 *
 * 职责分工:
 * 1. Portal: 脱离宿主上下文，挂载至指定根节点（默认全局根节点或 body），规避父级 overflow 截断；
 * 2. Positioner: 纯几何定位层，由 Base UI / Floating UI 驱动，使用 CSS 变量（--anchor-width, --transform-origin）通信，杜绝 Layout Thrashing；
 * 3. Popup: 视觉卡片层，承载圆角、阴影、背景、边框、进入退出动效。
 */

/**
 * Positioner props promoted to flat props on every floating component.
 * Mirrors Base UI's anchor positioning parameters.
 */
export const FLOATING_POSITIONER_KEYS = [
  'side',
  'sideOffset',
  'align',
  'alignOffset',
  'anchor',
  'positionMethod',
  'collisionBoundary',
  'collisionPadding',
  'collisionAvoidance',
  'sticky',
  'arrowPadding',
  'disableAnchorTracking',
] as const;

/** Portal props promoted to flat props on every floating component. */
export const FLOATING_PORTAL_KEYS = ['container', 'keepMounted'] as const;

export type FloatingPositionerKey = (typeof FLOATING_POSITIONER_KEYS)[number];
export type FloatingPortalKey = (typeof FLOATING_PORTAL_KEYS)[number];

/**
 * Flat positioning/portal props + typed escape hatches.
 * Intersect with the Popup props to build a component's prop type.
 */
export type FloatingContentProps<Positioner, Portal> = Pick<
  Positioner,
  Extract<keyof Positioner, FloatingPositionerKey>
> &
  Pick<Portal, Extract<keyof Portal, FloatingPortalKey>> & {
    /** Escape hatch: extra props forwarded to Base UI Positioner */
    positionerProps?: Omit<Positioner, FloatingPositionerKey | 'children'>;
    /** Escape hatch: extra props forwarded to Base UI Portal */
    portalProps?: Omit<Portal, FloatingPortalKey | 'children'>;
  };

export interface SplitFloatingProps {
  positioner: Record<string, unknown>;
  portal: Record<string, unknown>;
  popup: Record<string, unknown>;
}

/**
 * 分割浮动层 props:
 * - Positioner 定位属性 -> positioner
 * - Portal 挂载属性 -> portal
 * - 其余属性 -> popup 卡片层
 */
export function splitFloatingProps(
  props: Record<string, unknown>
): SplitFloatingProps {
  const { positionerProps, portalProps, ...rest } = props as {
    positionerProps?: Record<string, unknown>;
    portalProps?: Record<string, unknown>;
  } & Record<string, unknown>;

  const positioner: Record<string, unknown> = { ...positionerProps };
  const portal: Record<string, unknown> = { ...portalProps };
  const popup: Record<string, unknown> = {};

  for (const key of Object.keys(rest)) {
    const value = rest[key];
    if ((FLOATING_POSITIONER_KEYS as readonly string[]).includes(key)) {
      if (value !== undefined) positioner[key] = value;
    } else if ((FLOATING_PORTAL_KEYS as readonly string[]).includes(key)) {
      if (value !== undefined) portal[key] = value;
    } else {
      popup[key] = value;
    }
  }

  return { positioner, portal, popup };
}

export {
  isPopoverMenuLayer,
  type LayerTier,
  type LayerType,
} from './layer-stack/layerStackTypes';
