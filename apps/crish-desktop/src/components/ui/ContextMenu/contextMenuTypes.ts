/**
 * apps/crish-desktop/src/components/ui/ContextMenu/contextMenuTypes.ts
 *
 * 现代化声明式 ContextMenu 复合组件体系类型契约规范
 * 零外部重型依赖，完全基于自研 positioner / roving-focus / presence 基础设施
 */

import type React from 'react';
import type {
  PositionSide,
  PositionAlign,
  PositionerAnchor,
} from '../internal/positioner/types';

/** 菜单尺寸档位 */
export type ContextMenuSize = 'sm' | 'md' | 'lg';

/** 菜单项语义变体 */
export type ContextMenuItemVariant = 'default' | 'danger' | 'destructive';

/** 根组件属性 */
export interface ContextMenuProps {
  children: React.ReactNode;
  /** 外部受控打开状态 */
  open?: boolean;
  /** 打开状态变更回调 */
  onOpenChange?: (open: boolean) => void;
  /** 外部传入锚点 */
  anchor?: PositionerAnchor;
  /** 尺寸档位，默认 'md' */
  size?: ContextMenuSize;
  /** 是否模态（锁定背景交互），默认 false */
  modal?: boolean;
}

/** 触发器组件属性 */
export interface ContextMenuTriggerProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
  /** 是否禁用右键上下文菜单唤起 */
  disabled?: boolean;
  /** 是否透传给唯一的子元素渲染 */
  asChild?: boolean;
}

/** 内容浮层组件属性 */
export interface ContextMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  /** 显式指定定位锚点（优先于 Trigger 捕获的 VirtualPoint 虚拟光标） */
  anchor?: PositionerAnchor;
  /** 自定义挂载 Portal 容器（默认为 document.body） */
  portalContainer?: HTMLElement | null;
  /** 偏好主轴方向，默认 'bottom' */
  side?: PositionSide;
  /** 偏好次轴对齐方向，默认 'start' */
  align?: PositionAlign;
  /** 与光标主轴的微量间隙 (px)，默认 2 */
  sideOffset?: number;
  /** 沿次轴的次级偏移 (px)，默认 0 */
  alignOffset?: number;
  /** 是否启用视口边界碰撞自动翻转，默认 true */
  avoidCollisions?: boolean;
  /** 键盘漫游是否首尾循环，默认 true */
  loop?: boolean;
  /** 打开时是否自动将焦点移入首个可用项，默认 true */
  autoFocus?: boolean;
  /** 关闭后是否自动还原焦点，默认 true */
  restoreFocus?: boolean;
  /** 点击浮层外部时的回调 */
  onPointerDownOutside?: (event: PointerEvent) => void;
  /** 按下 Escape 键时的回调 */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}

/** 菜单项组件属性 */
export interface ContextMenuItemProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'onSelect'
> {
  children: React.ReactNode;
  /** 是否禁用 */
  disabled?: boolean;
  /** 视觉变体：默认或危险 */
  variant?: ContextMenuItemVariant;
  /** 是否保留左侧对齐缩进（与 checkbox / radio 项平齐） */
  inset?: boolean;
  /** 快捷键展示文本（如 '⌘C', 'Ctrl+V'） */
  shortcut?: string;
  /** 文本值（用于 600ms Typeahead 字符检索，未传时自动提取 children 纯文本） */
  textValue?: string;
  /** 选择动作触发回调（点击或 Enter 触发） */
  onSelect?: (event: Event) => void;
  /** 是否在选中后阻止菜单自动关闭，默认 false */
  preventCloseOnSelect?: boolean;
}

/** 多选勾选菜单项属性 */
export interface ContextMenuCheckboxItemProps extends Omit<
  ContextMenuItemProps,
  'onChange'
> {
  /** 选中状态，支持半选态 'indeterminate' */
  checked?: boolean | 'indeterminate';
  /** 勾选状态变更回调 */
  onCheckedChange?: (checked: boolean) => void;
}

/** 单选菜单项属性 */
export interface ContextMenuRadioItemProps extends ContextMenuItemProps {
  /** 单选项对应的值 */
  value: string;
}

/** 单选组属性 */
export interface ContextMenuRadioGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  /** 当前选中的单选值 */
  value?: string;
  /** 单选值变更回调 */
  onValueChange?: (value: string) => void;
}

/** 分组容器属性 */
export interface ContextMenuGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

/** 分组标题属性 */
export interface ContextMenuLabelProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  /** 是否保留左侧缩进 */
  inset?: boolean;
}

/** 分割线属性 */
export type ContextMenuSeparatorProps = React.HTMLAttributes<HTMLDivElement>;

/** 快捷键徽标属性 */
export interface ContextMenuShortcutProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
}

/** 二级子菜单根组件属性 */
export interface ContextMenuSubProps {
  children: React.ReactNode;
  /** 外部受控子菜单打开状态 */
  open?: boolean;
  /** 子菜单打开状态变更回调 */
  onOpenChange?: (open: boolean) => void;
}

/** 二级子菜单触发项属性 */
export interface ContextMenuSubTriggerProps extends Omit<
  ContextMenuItemProps,
  'onSelect'
> {
  children: React.ReactNode;
}

/** 二级子菜单内容浮层属性 */
export interface ContextMenuSubContentProps extends Omit<
  ContextMenuContentProps,
  'sideOffset'
> {
  children: React.ReactNode;
  /** 与父菜单的水平重叠偏移量 (px)，遵循负 5px 重叠规范，默认 -5 */
  sideOffset?: number;
  /** 偏好弹出方位，默认 'right' */
  side?: PositionSide;
  /** 偏好对齐方位，默认 'start' */
  align?: PositionAlign;
}
