/**
 * Base UI 现代化标准 Headless 原语与正交物理分层架构基座
 *
 * 方案依据: docs/ui-infra-evolution/plans/03-headless-primitives-and-stability.md
 * 单一真理源: @base-ui/react (v1.9+)
 *
 * 两大正交物理分层模型:
 * 1. 模态遮罩型 (Modal Layering Model):
 *    Portal -> Backdrop -> Viewport -> Popup
 *    适用于全屏模态遮罩组件（Dialog, ConfirmDialog, AlertDialog）
 *
 * 2. 浮动锚定型 (Floating Layering Model):
 *    Portal -> Positioner -> Popup (可选 Arrow)
 *    适用于锚定触发器的浮层组件（Tooltip, Select, Menu, ContextMenu, Popover）
 */

import type * as React from 'react';

// ============================================================================
// 1. Base UI 原语单点导出 (Direct Primitive Re-exports)
// ============================================================================
export { Dialog as BaseDialog } from '@base-ui/react/dialog';
export { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
export { Select as BaseSelect } from '@base-ui/react/select';
export { Menu as BaseMenu } from '@base-ui/react/menu';
export { Popover as BasePopover } from '@base-ui/react/popover';

// ============================================================================
// 2. 模式 A: 模态遮罩型分层模型 (Modal Layering Model)
// ============================================================================
export {
  MODAL_PORTAL_KEYS,
  MODAL_Z_INDEX,
  type ModalPortalKey,
  type ModalZIndex,
  type ModalContentProps,
  type SplitModalProps,
  splitModalProps,
} from '../modal';

/**
 * 模态遮罩型四层物理拓扑契约
 */
export interface ModalLayeringTopology {
  /** 1. 挂载脱离层: 挂载至指定根节点（#dialog-root 或 body），隔离 DOM 树截断 */
  Portal: React.ComponentType<{
    container?: HTMLElement | null;
    keepMounted?: boolean;
    children?: React.ReactNode;
  }>;
  /** 2. 独立背景遮罩层: fixed inset-0，半透明与高斯模糊；嵌套弹窗自动获得 data-nested-dialog-open 并透明 */
  Backdrop: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
    children?: React.ReactNode;
  }>;
  /** 3. 视口定位层: fixed inset-0 flex items-center justify-center，负责屏幕居中与安全视口滚动隔离 */
  Viewport: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
    children?: React.ReactNode;
  }>;
  /** 4. 弹窗实体卡片: 承载尺寸、圆角、边框、阴影与动画，键盘 Esc 与焦点捕获作用于此 */
  Popup: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
    children?: React.ReactNode;
  }>;
}

/**
 * 模态遮罩配置契约
 */
export interface ModalOptions {
  open: boolean;
  onOpenChange?: (
    open: boolean,
    eventDetails?: { reason?: string; event?: Event }
  ) => void;
  role?: 'dialog' | 'alertdialog';
  dismissible?: boolean;
  closeOnBackdropClick?: boolean;
  portalContainer?: HTMLElement | null;
}

// ============================================================================
// 3. 模式 B: 浮动锚定型分层模型 (Floating Layering Model)
// ============================================================================
export {
  FLOATING_POSITIONER_KEYS,
  FLOATING_PORTAL_KEYS,
  type FloatingPositionerKey,
  type FloatingPortalKey,
  type FloatingContentProps,
  type SplitFloatingProps,
  splitFloatingProps,
} from '../floating';

export type FloatingSide = 'top' | 'bottom' | 'left' | 'right';
export type FloatingAlign = 'start' | 'center' | 'end';

/**
 * 浮动锚定型三层物理拓扑契约
 */
export interface FloatingLayeringTopology {
  /** 1. 脱离宿主挂载层: 挂载至全局浮动根节点或 body，不受父级 overflow: hidden 截断 */
  Portal: React.ComponentType<{
    container?: HTMLElement | null;
    keepMounted?: boolean;
    children?: React.ReactNode;
  }>;
  /** 2. 纯几何定位层: 由 Base UI 高性能定位核心托管，通过 transform 驱动并注入 CSS 变量，0 次 JS 测量 */
  Positioner: React.ComponentType<{
    side?: FloatingSide;
    align?: FloatingAlign;
    sideOffset?: number;
    alignOffset?: number;
    className?: string;
    style?: React.CSSProperties;
    children?: React.ReactNode;
  }>;
  /** 3. 浮层卡片层: 纯粹的样式宿主容器，接收 CSS 变量（--anchor-width）实现同宽与展开动画 */
  Popup: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
    children?: React.ReactNode;
  }>;
  /** 可选指示箭头: 自动对齐三角 */
  Arrow?: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
  }>;
}

/**
 * 浮动定位上下文注入的 CSS 变量契约
 */
export const FLOATING_CSS_VARIABLES = {
  /** 触发器锚点宽度（如 160px），下拉菜单与 Combobox 由此对齐宽度 */
  anchorWidth: '--anchor-width',
  /** 可用最大高度（边界防碰撞自适应） */
  availableHeight: '--available-height',
  /** 可用最大宽度 */
  availableWidth: '--available-width',
  /** 定位原点（自适应向上或向下展开动效） */
  transformOrigin: '--transform-origin',
} as const;

// ============================================================================
// 4. 原生 DOM 属性与动效契约 (Data Attributes & Motion Tokens)
// ============================================================================
export const BASE_UI_DATA_ATTRS = {
  /** 子弹窗开启时，底层遮罩自动获得此属性，CSS 中声明 opacity: 0 彻底消除发黑叠加 */
  nestedDialogOpen: 'data-nested-dialog-open',
  /** 现代 CSS @starting-style 挂载动画入口属性 */
  startingStyle: 'data-starting-style',
  /** 离散过渡退场退出状态属性 */
  endingStyle: 'data-ending-style',
  /** 浮层是否允许指针交互 */
  interactive: 'data-interactive',
} as const;

/**
 * 全仓锁定的标准微动效时长与缓动参数（对齐 P03 §4.2）
 */
export const BASE_UI_MOTION_TOKENS = {
  /** 进场动效时长: 150ms */
  enterDurationMs: 150,
  /** 退场动效时长: 100ms */
  exitDurationMs: 100,
  /** Tooltip 意图停留延时: 350ms */
  tooltipDelayShowMs: 350,
  /** 进场缓动曲线 */
  enterEasing: 'cubic-bezier(0.16, 1, 0.3, 1)',
  /** 退场缓动曲线 */
  exitEasing: 'ease-out',
} as const;
