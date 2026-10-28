/**
 * apps/crish-desktop/src/components/ui/DropdownMenu/types.ts
 *
 * ui/DropdownMenu 统一类型契约
 * 覆盖 Base UI Headless 复合原语模式与扁平配置 Props 模式。
 */

import type React from 'react';
import type { Menu as BaseMenu } from '@base-ui/react/menu';
import type { SelectOptionItem } from '../Menu/types';

export type { SelectOptionItem, SelectOptionItem as DropdownMenuItemOption };

/** 菜单定位配置（对齐/方向/偏移/最大高度） */
export interface DropdownMenuPositionConfig {
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  sideOffset?: number;
  alignOffset?: number;
  maxHeight?: number | string;
}

/** 菜单开关状态（受控/非受控双模） */
export interface DropdownMenuOpenState {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** 面板外观配置（标题/类名/样式） */
export interface DropdownMenuPanelConfig {
  title?: string;
  contentClassName?: string;
  contentStyle?: React.CSSProperties;
}

/** 面板外侧/键盘交互回调 */
export interface DropdownMenuOutsideHandlers {
  onInteractOutside?: (event: Event) => void;
  onPointerDownOutside?: (
    event: CustomEvent<{ originalEvent: PointerEvent }>
  ) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

/** 顶层 DropdownMenu 复合组件 + 扁平 Sugar Props 契约 */
export interface DropdownMenuProps {
  // ── 扁平 Sugar Props 模式 ──
  /** 触发器元素 */
  trigger?: React.ReactNode;
  /** 外部显式锚点 */
  anchor?: React.RefObject<HTMLElement | null> | HTMLElement | null;
  /** 选项列表（扁平模式） */
  options?: SelectOptionItem[];
  /** 自定义条目渲染 */
  renderItem?: (
    option: SelectOptionItem,
    index: number,
    isFocused: boolean
  ) => React.ReactNode;
  /** 选项选择回调 */
  onSelect?: (id: string, option: SelectOptionItem) => void;
  /** 是否可搜索（保留扩展字段） */
  searchable?: boolean;
  /** 定位配置 */
  position?: DropdownMenuPositionConfig;
  /** 开关状态对象 */
  openState?: DropdownMenuOpenState;
  /** 面板样式配置 */
  panel?: DropdownMenuPanelConfig;
  /** 外侧交互回调 */
  outsideHandlers?: DropdownMenuOutsideHandlers;
  /** 级联子菜单展开/收起钩子 */
  cascade?: {
    onSubmenuExpand?: (index: number, optionOrElement: unknown) => void;
    onSubmenuCollapse?: () => void;
  };
  /** 键盘事件透传 */
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;

  // ── 复合组件模式与 Base UI 原语透传 ──
  /** 子节点（复合组件模式） */
  children?: React.ReactNode;
  /** 受控开关 */
  open?: boolean;
  /** 默认非受控开关 */
  defaultOpen?: boolean;
  /** 开关状态变化回调 */
  onOpenChange?: (
    open: boolean,
    eventDetails?: BaseMenu.Root.ChangeEventDetails
  ) => void;
  /** 是否模态（默认 false，桌面端不锁死外部滚动与点击） */
  modal?: boolean;
  /** 键盘漫游循环 */
  loopFocus?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
  /** Portal 挂载容器（默认为 #popover-root ?? document.body） */
  portalContainer?: HTMLElement | null;
}

/** DropdownMenu.Root Props */
export type DropdownMenuRootProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseMenu.Root>,
  'children'
> & {
  children?: React.ReactNode;
  portalContainer?: HTMLElement | null;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onPointerDownOutside?: (event: PointerEvent) => void;
};

/** DropdownMenu.Trigger Props */
export interface DropdownMenuTriggerProps extends React.ComponentPropsWithoutRef<
  typeof BaseMenu.Trigger
> {
  asChild?: boolean;
}

/** DropdownMenu.Portal Props */
export interface DropdownMenuPortalProps extends Omit<
  React.ComponentPropsWithoutRef<typeof BaseMenu.Portal>,
  'container'
> {
  container?:
    | HTMLElement
    | ShadowRoot
    | React.RefObject<HTMLElement | ShadowRoot | null>
    | null;
  children?: React.ReactNode;
}

/** DropdownMenu.Positioner Props */
export type DropdownMenuPositionerProps = React.ComponentPropsWithoutRef<
  typeof BaseMenu.Positioner
>;

/** DropdownMenu.Content / Popup Props */
export interface DropdownMenuContentProps extends React.ComponentPropsWithoutRef<
  typeof BaseMenu.Popup
> {
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  alignOffset?: number;
  container?: HTMLElement | null;
  positionerClassName?: string;
  maxHeight?: number | string;
}

/** DropdownMenu.Item Props */
export interface DropdownMenuItemProps extends React.ComponentPropsWithoutRef<
  typeof BaseMenu.Item
> {
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  description?: React.ReactNode;
  danger?: boolean;
  selected?: boolean;
  asChild?: boolean;
}

/** DropdownMenu.Group Props */
export type DropdownMenuGroupProps = React.ComponentPropsWithoutRef<
  typeof BaseMenu.Group
>;

/** DropdownMenu.GroupLabel / Label Props */
export type DropdownMenuGroupLabelProps = React.ComponentPropsWithoutRef<
  typeof BaseMenu.GroupLabel
>;

export type DropdownMenuLabelProps = DropdownMenuGroupLabelProps;

/** DropdownMenu.CheckboxItem Props */
export interface DropdownMenuCheckboxItemProps extends React.ComponentPropsWithoutRef<
  typeof BaseMenu.CheckboxItem
> {
  icon?: React.ReactNode;
  shortcut?: string;
}

/** DropdownMenu.RadioGroup Props */
export type DropdownMenuRadioGroupProps = React.ComponentPropsWithoutRef<
  typeof BaseMenu.RadioGroup
>;

/** DropdownMenu.RadioItem Props */
export type DropdownMenuRadioItemProps = React.ComponentPropsWithoutRef<
  typeof BaseMenu.RadioItem
>;

/** DropdownMenu.Separator Props */
export type DropdownMenuSeparatorProps = React.ComponentPropsWithoutRef<
  typeof BaseMenu.Separator
>;

/** DropdownMenu.Sub / Submenu Props */
export type DropdownMenuSubProps = React.ComponentPropsWithoutRef<
  typeof BaseMenu.SubmenuRoot
>;

/** DropdownMenu.SubTrigger Props */
export interface DropdownMenuSubTriggerProps extends React.ComponentPropsWithoutRef<
  typeof BaseMenu.SubmenuTrigger
> {
  asChild?: boolean;
}

/** DropdownMenu.SubContent Props */
export interface DropdownMenuSubContentProps extends React.ComponentPropsWithoutRef<
  typeof BaseMenu.Popup
> {
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  alignOffset?: number;
  container?: HTMLElement | null;
  positionerClassName?: string;
  maxHeight?: number | string;
}

/** DropdownMenu.Shortcut Props */
export type DropdownMenuShortcutProps = React.HTMLAttributes<HTMLSpanElement>;

/** DropdownMenu.Arrow Props */
export type DropdownMenuArrowProps = React.ComponentPropsWithoutRef<
  typeof BaseMenu.Arrow
>;
