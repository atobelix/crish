/**
 * ui/ContextMenu 类型契约（Base UI 收敛版）
 *
 * 全应用唯一的上下文菜单实现：与 ui/Menu 共用同一套 Base UI menu 引擎、
 * LayerStack 浮层中枢与 Menu.module.css 视觉词汇，区别仅在调用形态——
 * 本组件为受控 open + 锚点（坐标/元素）驱动，无 Trigger 元素，
 * 供右键菜单与程序化弹出场景使用。
 */
import type React from 'react';

/** 锚点输入：视口坐标点（右键点位）、真实元素、或元素 Ref */
export type ContextMenuAnchor =
  { x: number; y: number } | HTMLElement | React.RefObject<HTMLElement | null>;

export type ContextMenuSide = 'top' | 'bottom' | 'left' | 'right';
export type ContextMenuAlign = 'start' | 'center' | 'end';

export interface ContextMenuProps {
  /** 受控打开态（调用方状态即唯一真源，基座不会自行翻转） */
  open: boolean;
  /** 打开态变更回调；基座的锚点误报关闭（点在触发元素上等）会被吞掉，不透传 */
  onOpenChange?: (open: boolean) => void;
  /** 定位锚点：右键坐标点 / 触发元素 / 元素 Ref */
  anchor?: ContextMenuAnchor;
  /**
   * 锚点为坐标点时，关联的触发元素（行/按钮节点）：
   * 用于 LayerStack 外点豁免与关闭后焦点还原。
   */
  anchorElement?: HTMLElement | null;
  /** 弹出方向（默认 bottom；碰撞时 Base UI 自动翻转） */
  side?: ContextMenuSide;
  align?: ContextMenuAlign;
  sideOffset?: number;
  alignOffset?: number;
  /** LayerStack 登记 id；不传则内部生成。需与其它系统按 id 协作者显式传 */
  layerId?: string;
  /** 外部 Popup 元素 Ref（与内部 Ref 合并写回） */
  popupRef?: React.RefObject<HTMLDivElement | null>;
  /** 追加到 Positioner 与 Popup 的 z-index（内联样式，与既有菜单的层级契约对齐） */
  zIndex?: string;
  popupClassName?: string;
  popupStyle?: React.CSSProperties;
  'data-testid'?: string;
  'aria-label'?: string;
  children?: React.ReactNode;
}

export interface ContextMenuItemProps {
  icon?: React.ReactNode;
  /** 右侧快捷键提示（如 'F2'、'Ctrl+Shift+F'） */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** 选中回调（点击 / Enter / Space 激活时触发，触发后默认关闭菜单） */
  onSelect?: () => void;
  /** 点击后是否关闭菜单（默认 true） */
  closeOnClick?: boolean;
  className?: string;
  title?: string;
  children?: React.ReactNode;
}

export interface ContextMenuSubProps {
  /** 受控打开态（可选；不传为内部自管） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}

export interface ContextMenuSubTriggerProps {
  icon?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  /** 是否渲染右侧 chevron（默认 true） */
  chevron?: boolean;
  children?: React.ReactNode;
}

export interface ContextMenuSubContentProps {
  className?: string;
  sideOffset?: number;
  children?: React.ReactNode;
}

export interface ContextMenuRadioItemProps {
  value: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** 当前是否选中（由消费方按 RadioGroup 的 value 派生，控制勾选图标呈现） */
  checked?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export interface ContextMenuCheckboxItemProps {
  checked?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
  children?: React.ReactNode;
}
