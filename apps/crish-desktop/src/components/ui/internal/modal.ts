/**
 * Modal Layering Model (模态遮罩型)
 *
 * 物理分层拓扑: Portal -> Backdrop -> Viewport -> Popup
 * 适用于 Dialog, ConfirmDialog, AlertDialog, Drawer 等全屏模态遮罩组件。
 *
 * 职责分工:
 * 1. Portal: 挂载至指定根节点（如 #dialog-root 或 body）；
 * 2. Backdrop: 独立遮罩层，fixed inset-0，半透明与高斯模糊，多层嵌套时自动透明（data-nested-dialog-open）；
 * 3. Viewport: 视口定位与居中隔离层，fixed inset-0，flex items-center justify-center，控制溢出滚动；
 * 4. Popup: 弹窗实体卡片，承载尺寸、圆角、边框、卡片阴影、焦点捕获与键盘导航。
 */

/** Portal props promoted to flat props on every modal component. */
export const MODAL_PORTAL_KEYS = ['container', 'keepMounted'] as const;

export type ModalPortalKey = (typeof MODAL_PORTAL_KEYS)[number];

/**
 * Flat Portal props + typed escape hatches for Backdrop/Viewport/Portal.
 * Intersect with Popup props to build a modal component's prop type.
 */
export type ModalContentProps<Popup, Portal, Backdrop, Viewport> = Popup &
  Pick<Portal, Extract<keyof Portal, ModalPortalKey>> & {
    /** Escape hatch: extra props forwarded to Base UI Portal */
    portalProps?: Omit<Portal, ModalPortalKey | 'children'>;
    /** Escape hatch: props forwarded to Base UI Backdrop (e.g. className, style, render) */
    backdropProps?: Omit<Backdrop, 'children'>;
    /** Escape hatch: props forwarded to Base UI Viewport (e.g. className, style, render) */
    viewportProps?: Omit<Viewport, 'children'>;
  };

export interface SplitModalProps {
  portal: Record<string, unknown>;
  popup: Record<string, unknown>;
}

/**
 * 分割模态层 props:
 * - Portal 挂载属性 -> portal
 * - 其余属性 -> popup 卡片层
 */
export function splitModalProps(
  props: Record<string, unknown>
): SplitModalProps {
  const { portalProps, ...rest } = props as {
    portalProps?: Record<string, unknown>;
  } & Record<string, unknown>;

  const portal: Record<string, unknown> = { ...portalProps };
  const popup: Record<string, unknown> = {};

  for (const key of Object.keys(rest)) {
    const value = rest[key];
    if ((MODAL_PORTAL_KEYS as readonly string[]).includes(key)) {
      if (value !== undefined) portal[key] = value;
    } else {
      popup[key] = value;
    }
  }

  return { portal, popup };
}

/**
 * 模态层正交分层 Z-Index 标尺（对齐 z-index.css 与 SPEC-03）
 */
export const MODAL_Z_INDEX = {
  dialog: 1000,
  alertdialog: 1100,
  drawer: 900,
  sheet: 900,
  toast: 1000,
  tooltip: 9000,
} as const;

export type ModalZIndex = typeof MODAL_Z_INDEX;

export {
  isModalLayer,
  LAYER_TIER_MAP,
  type LayerTier,
  type LayerType,
} from './layer-stack/layerStackTypes';
