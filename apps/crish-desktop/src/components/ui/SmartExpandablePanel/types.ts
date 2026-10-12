import type { ReactNode, MouseEvent, CSSProperties, RefObject } from 'react';

/** 2D 平面坐标点 */
export interface Point2D {
  x: number;
  y: number;
}

/** 菜单项类型分类 */
export type MenuItemType =
  | 'item'
  | 'selectable'
  | 'group'
  | 'sub-group'
  | 'divider'
  | 'submenu'
  | 'collapsible';

/** 单个菜单项契约 */
export interface MenuItem {
  /** 唯一标识符 */
  id: string;
  /** 菜单项形态类型 */
  type?: MenuItemType;
  /** 主标题 */
  label?: string;
  /** 副标题 / 描述 */
  sublabel?: string;
  /** 图标位（ReactNode 或 SVG 组件） */
  icon?: ReactNode;
  /** 键盘快捷键文本（如 '⌘K', 'Ctrl+P'） */
  shortcut?: string;
  /** 状态徽章文本（如 'Beta', 'Pro'） */
  badge?: string;
  /** 徽章类名 */
  badgeClassName?: string;
  /** 悬停提示 Tooltip 文案 */
  tooltip?: string;
  /** 危险操作标红 */
  danger?: boolean;
  /** 禁用状态 */
  disabled?: boolean;
  /** 选中状态（针对 selectable 类型） */
  selected?: boolean;
  /** 是否为折叠手风琴项 */
  collapsible?: boolean;
  /** 手风琴初始展开状态 */
  expanded?: boolean;
  /** 搜索匹配关键字列表（空格分隔） */
  searchKeywords?: string;
  /** 级联子菜单或折叠项子元素 */
  children?: MenuItem[];
  /** 尾部操作按钮（如删除、重命名） */
  trailingAction?: ReactNode;
  /** 点击回调 */
  onSelect?: (item: MenuItem, event?: MouseEvent) => void;
  /** 独立点击回调 */
  onClick?: () => void;
  /** 折叠展开回调 */
  onToggle?: (expanded: boolean, item: MenuItem) => void;
  /** 业务自定义扩展字段 */
  [key: string]: unknown;
}

/** 分组区块契约 */
export interface MenuGroup {
  /** 分组唯一标识 */
  id?: string;
  /** 分组标题 */
  title?: string;
  /** 是否为内嵌自滚动选择列表（最大高度限制为 160px） */
  isSelectableList?: boolean;
  /** 分组内子菜单项 */
  items: MenuItem[];
}

/** 视口与定位边界矩形 */
export interface BoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 智能定位配置选项 */
export interface PositionOptions {
  hysteresisY?: number;
  maxHeight?: number;
  sideOffset?: number;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
}

/** 智能定位解算结果 */
export interface PositionResult {
  x: number;
  y: number;
  origin: string;
  allowedListHeight: number | null;
  directionY?: 'up' | 'down';
  directionX?: 'left' | 'right';
  triggerWidth?: number;
}

/** 二级子菜单定位解算结果 */
export interface SubmenuPositionResult {
  x: number;
  y: number;
  isFlipLeft: boolean;
}

/** Safe-Aim 安全三角区配置选项 */
export interface SafeAimOptions {
  enabled?: boolean;
  debug?: boolean;
  safetyTimeoutMs?: number;
  timeoutMs?: number;
}

/** useSmartPanel 控制 Hook 返回值 */
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

/** 兼容性定位配置别名 */
export type SmartPanelPositionConfig = PositionOptions;

/** SmartExpandablePanel 主组件 Props */
export interface SmartPanelProps {
  /** 菜单项列表（支持普通数组或分组数组） */
  items?: Array<MenuItem | MenuGroup>;
  /** 触发节点（cloneElement 注入打开/防冒泡事件） */
  trigger?: ReactNode;
  /** 触发模式：'click' | 'hover' | 'both'（默认 'both'） */
  triggerMode?: 'click' | 'hover' | 'both';
  /** 锚定触发器元素 Ref */
  triggerRef?: RefObject<HTMLElement | null>;
  /** 外部浮动锚点（虚拟锚点） */
  anchor?: RefObject<HTMLElement | null>;
  /** 面板是否处于展开状态 */
  open?: boolean;
  /** 受控开关变更回调 */
  onOpenChange?: (open: boolean) => void;
  /** 绝对坐标弹出点（右键菜单或光标位置） */
  point?: Point2D | null;
  /** 搜索输入框 Placeholder */
  searchPlaceholder?: string;
  /** 是否开启内嵌搜索功能 */
  enableSearch?: boolean;
  /** 是否在分组间渲染发丝分割线 */
  enableDivider?: boolean;
  /** 是否开启 Safe-Aim 安全三角区保护 */
  enableTriangleAim?: boolean;
  /** 定位配置 */
  position?: PositionOptions;
  /** 碰撞翻转/平移（默认 true）；false = 调用方已锁定 side，打开后方向固定 */
  avoidCollisions?: boolean;
  /** 关闭后焦点去向（Radix onCloseAutoFocus；preventDefault 后自行聚焦） */
  onCloseAutoFocus?: (event: Event) => void;
  /** 面板最大高度限制（默认 760px 或 min(70vh, 360px)） */
  maxPanelHeight?: number | string;
  /** 是否使用局部容器作为边界约束（而非全局 window） */
  useContainerBoundary?: boolean;
  /** 局部容器 Boundary 元素 Ref */
  containerBoundaryRef?: RefObject<HTMLElement | null>;
  /** 项选中事件回调 */
  onSelect?: (item: MenuItem, event?: MouseEvent) => void;
  /** 面板打开时回调 */
  onOpen?: () => void;
  /** 面板关闭时回调 */
  onClose?: () => void;
  /** 鼠标移入/移出回调 */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  /** 挂载的 Dialog / Portal 容器 */
  container?: HTMLElement | null;
  /** 自定义外层 CSS 类名 */
  className?: string;
  /** 自定义行内样式 */
  style?: CSSProperties;
  /** 自定义头部内容（可选） */
  header?: ReactNode;
  /** 自定义底部内容（可选） */
  footer?: ReactNode;
  /** 面板标题（兼容 Menu title） */
  title?: string;
  /** 自定义无障碍标签 */
  ariaLabel?: string;
  /** 自定义项渲染器（兼容 Menu renderItem） */
  renderItem?: (item: MenuItem, index: number, isFocused: boolean) => ReactNode;
  /** 子元素（与 items 模式二选一，兼容 Menu children） */
  children?: ReactNode;
  /** 自定义无障碍容器 role（默认 'menu'） */
  role?: string;
}
