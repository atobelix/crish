import type React from 'react';

export type RovingOrientation = 'vertical' | 'horizontal' | 'both';

export type RovingMode = 'dom' | 'virtual';

export type FocusRestorationReason =
  'escape' | 'select' | 'outside' | 'cancel' | 'blur';

/**
 * 漫游菜单项抽象记录（支持静态配置或声明式子项注册）
 */
export interface MenuItemRecord {
  id: string;
  ref?: React.RefObject<HTMLElement | null>;
  textValue?: string;
  disabled?: boolean;
  isSeparator?: boolean;
  hasSubmenu?: boolean;
  isSubmenuOpen?: boolean;
  role?:
    | 'menuitem'
    | 'menuitemcheckbox'
    | 'menuitemradio'
    | 'option'
    | 'tab'
    | 'button';
}

/**
 * Typeahead 字符检索基础条目结构
 */
export interface TypeaheadItem {
  id: string;
  textValue?: string;
  disabled?: boolean;
  isSeparator?: boolean;
}

/**
 * Typeahead 字符检索选项
 */
export interface TypeaheadOptions<T extends TypeaheadItem = TypeaheadItem> {
  getItems: () => readonly T[];
  getCurrentIndex: () => number;
  onMatch: (index: number, item: T) => void;
  timeoutMs?: number;
}

/**
 * 级联子菜单交互选项
 */
export interface CascadeOptions<T extends MenuItemRecord = MenuItemRecord> {
  isSubmenu?: boolean;
  onSubmenuExpand?: (item: T, index: number) => void;
  onSubmenuCollapse?: () => void;
}

/**
 * useRovingFocus 核心状态机配置选项
 */
export interface RovingFocusOptions<T extends MenuItemRecord = MenuItemRecord> {
  /** 模式 1：静态数据数组驱动（若不传，则自动从 MenuCollectionContext 中收集） */
  items?: readonly T[];
  /** 容器 Ref */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** 触发器 Ref（用于关闭时的焦点安全还原） */
  triggerRef?: React.RefObject<HTMLElement | null>;
  /** 是否处于打开态，默认 true */
  isOpen?: boolean;
  /** 漫游方向：默认 'vertical' */
  orientation?: RovingOrientation;
  /** 漫游模式：'dom'（真实改变 DOM 焦点）或 'virtual'（保持容器焦点并更新 aria-activedescendant），默认 'dom' */
  mode?: RovingMode;
  /** 是否首尾循环，默认 true */
  loop?: boolean;
  /** 打开时是否自动聚焦首个可用项，默认 true */
  autoFocus?: boolean;
  /** 默认聚焦索引，默认 -1 */
  defaultFocusedIndex?: number;
  /** 容器 role，默认 'menu' */
  role?: 'menu' | 'menubar' | 'listbox' | 'tablist' | 'toolbar';
  /** 容器 data-slot，默认 'menu-content' */
  slot?: string;
  /** 选中/激活回调 */
  onSelect?: (item: T, index: number) => void;
  /** 关闭回调 */
  onClose?: (reason: FocusRestorationReason) => void;
  /** 级联子菜单扩展配置 */
  cascade?: CascadeOptions<T>;
  /** 是否启用 Typeahead 字符检索，默认 true */
  typeahead?: boolean;
  /** Typeahead 缓冲区超时毫秒数，默认 600ms */
  typeaheadTimeoutMs?: number;
}

/**
 * 容器 A11y 属性工厂契约
 */
export interface RovingContainerProps {
  role: 'menu' | 'menubar' | 'listbox' | 'tablist' | 'toolbar';
  tabIndex: number;
  'aria-orientation': 'vertical' | 'horizontal';
  'aria-activedescendant'?: string;
  'data-floating-layer': 'true';
  'data-slot': string;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
}

/**
 * 单项 A11y 属性工厂契约
 */
export interface RovingItemProps {
  id: string;
  role: string;
  tabIndex: number;
  'aria-selected'?: boolean;
  'aria-disabled'?: boolean;
  'aria-haspopup'?: 'menu' | boolean;
  'aria-expanded'?: boolean;
  onClick: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void;
}

/**
 * useRovingFocus 核心返回值契约
 */
export interface RovingFocusResult<T extends MenuItemRecord = MenuItemRecord> {
  focusedIndex: number;
  focusedItem: T | null;
  focusedId: string | null;
  setFocusedIndex: (
    index: number,
    reason?: 'keyboard' | 'mouse' | 'manual'
  ) => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  getItemProps: (item: T, index: number) => RovingItemProps;
  getContainerProps: () => RovingContainerProps;
  typeaheadBuffer: string;
  resetFocus: () => void;
  restoreFocus: () => void;
  focusFirst: () => void;
  focusLast: () => void;
  focusNext: () => void;
  focusPrevious: () => void;
}
