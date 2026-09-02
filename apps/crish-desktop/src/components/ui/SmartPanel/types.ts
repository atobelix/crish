import type { ReactNode, MouseEvent, KeyboardEvent, CSSProperties, RefObject } from 'react';

/** 2D coordinate point */
export interface Point2D {
  x: number;
  y: number;
}

/** Menu item types */
export type MenuItemType =
  | 'item'
  | 'selectable'
  | 'group'
  | 'sub-group'
  | 'divider'
  | 'submenu'
  | 'collapsible';

/** Single menu item contract */
export interface MenuItem {
  id: string;
  type?: MenuItemType;
  label?: string;
  sublabel?: string;
  icon?: ReactNode;
  shortcut?: string;
  badge?: string;
  badgeClassName?: string;
  tooltip?: string;
  danger?: boolean;
  disabled?: boolean;
  selected?: boolean;
  collapsible?: boolean;
  expanded?: boolean;
  searchKeywords?: string;
  children?: MenuItem[];
  trailingAction?: ReactNode;
  onSelect?: (item: MenuItem, event?: MouseEvent | KeyboardEvent) => void;
  onClick?: () => void;
  onToggle?: (expanded: boolean, item: MenuItem) => void;
  [key: string]: unknown;
}

/** Menu group contract */
export interface MenuGroup {
  id?: string;
  title?: string;
  isSelectableList?: boolean;
  items: MenuItem[];
}

/** Bounding box rectangle for viewport and containers */
export interface BoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Positioning options */
export interface PositionOptions {
  hysteresisY?: number;
  maxHeight?: number;
  sideOffset?: number;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
}

export type SmartPanelPositionConfig = PositionOptions;

/** Positioning calculation result */
export interface PositionResult {
  x: number;
  y: number;
  origin: string;
  allowedListHeight: number | null;
  directionY?: 'up' | 'down';
  directionX?: 'left' | 'right';
  triggerWidth?: number;
}

/** Cascading submenu positioning result */
export interface SubmenuPositionResult {
  x: number;
  y: number;
  isFlipLeft: boolean;
}

/** Safe-Aim configuration options */
export interface SafeAimOptions {
  enabled?: boolean;
  debug?: boolean;
  safetyTimeoutMs?: number;
  timeoutMs?: number;
}

/** useSmartPanel controller hook return contract */
export interface UseSmartPanelReturn {
  isOpen: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  anchorRef?: RefObject<HTMLElement | null>;
  open: () => void;
  close: () => void;
  toggle: () => void;
  openAtPoint: (point: Point2D) => void;
  point: Point2D | null;
  onOpenChange?: (open: boolean) => void;
  setOpen?: (open: boolean) => void;
}

/** SmartPanel props */
export interface SmartPanelProps {
  items: Array<MenuItem | MenuGroup>;
  open: boolean;
  trigger?: ReactNode;
  triggerRef?: RefObject<HTMLElement | null>;
  anchor?: RefObject<HTMLElement | null>;
  point?: Point2D | null;
  searchPlaceholder?: string;
  enableSearch?: boolean;
  searchRightActions?: ReactNode;
  enableDivider?: boolean;
  enableTriangleAim?: boolean;
  position?: PositionOptions;
  maxPanelHeight?: number | string;
  useContainerBoundary?: boolean;
  containerBoundaryRef?: RefObject<HTMLElement | null>;
  container?: HTMLElement | null;
  title?: string;
  header?: ReactNode;
  footer?: ReactNode;
  ariaLabel?: string;
  role?: string;
  className?: string;
  style?: CSSProperties;
  panelRef?: RefObject<HTMLDivElement | null>;
  dataTestId?: string;
  'data-testid'?: string;
  onSelect?: (item: MenuItem, event?: MouseEvent | KeyboardEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onOpenChange?: (open: boolean) => void;
  renderItem?: (item: MenuItem, index: number, isFocused: boolean) => ReactNode;
  children?: ReactNode;
}
