/**
 * ui/Select/types.ts — Select 与 Combobox 复合组件类型契约
 * 
 * 规范标准：对齐 Appica UI 物理参数、WAI-ARIA 1.2、Zero-Blue 墨阶设计令牌
 */
import type React from 'react';

export type SelectSize = 'sm' | 'md' | 'lg';
export type SelectVariant = 'outline' | 'soft';

// ── Select 复合组件 Props ──

export interface SelectRootProps {
  /** 当前选值（受控）；单选为 string | null，多选为 string[] */
  value?: string | string[] | null;
  /** 初始默认选值（非受控） */
  defaultValue?: string | string[] | null;
  /** 选值变更回调 */
  onValueChange?: (value: any) => void;
  /** 浮层展开状态（受控） */
  open?: boolean;
  /** 初始展开状态（非受控） */
  defaultOpen?: boolean;
  /** 浮层展开状态变更回调 */
  onOpenChange?: (open: boolean) => void;
  /** 尺寸档位 */
  size?: SelectSize;
  /** 外观风格 */
  variant?: SelectVariant;
  /** 是否开启多选 */
  multiple?: boolean;
  /** 是否开启一键清除 */
  clearable?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
  /** 复合子节点，或传 options 开启快捷单组件声明 */
  children?: React.ReactNode;
  /** 快捷 options 模式（可选） */
  options?: SelectOption[];
  /** 快捷 placeholder 模式（可选） */
  placeholder?: string;
  /** 快捷 id（可选） */
  id?: string;
  /** 快捷 className（可选） */
  className?: string;
  /** 快捷 align（可选） */
  align?: 'start' | 'center' | 'end';
  /** 快捷 side（可选） */
  side?: 'top' | 'bottom';
  /** 浮层传送门容器（可选） */
  portalContainer?: HTMLElement | null;
  /** 快捷 onChange 别名 */
  onChange?: (value: string) => void;
}

export interface SelectTriggerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'size'> {
  /** 前置自定义插槽（如图标） */
  startSlot?: React.ReactNode;
  /** 后置自定义插槽 */
  endSlot?: React.ReactNode;
  /** 是否覆盖父级的 clearable */
  clearable?: boolean;
  /** 子节点（如 <SelectValue />） */
  children?: React.ReactNode;
}

export interface SelectValueProps {
  /** 未选择时的占位文案 */
  placeholder?: string;
  /** 自定义类名 */
  className?: string;
  /** 自定义值渲染函数或静态内容 */
  children?:
    | React.ReactNode
    | ((value: string | string[] | null) => React.ReactNode);
}

export interface SelectContentProps {
  /** 自定义类名 */
  className?: string;
  /** 浮层水平对齐方式 */
  align?: 'start' | 'center' | 'end';
  /** 浮层垂直弹出方向 */
  side?: 'bottom' | 'top';
  /** 与触发器的间距偏移量 (px) */
  sideOffset?: number;
  /** 与视口边界的安全距离 (px) */
  edgePadding?: number;
  /** 自定义 Portal 挂载容器 */
  portalContainer?: HTMLElement | null;
  /** 是否开启原位对齐模式（Appica / Base UI 规范，默认 true） */
  alignItemWithTrigger?: boolean;
  /** 子节点 */
  children?: React.ReactNode;
}

export interface SelectItemProps {
  /** 项唯一标识值 */
  value: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 前置图标 */
  icon?: React.ReactNode;
  /** 辅助说明文案（次级文本） */
  hint?: React.ReactNode;
  /** 快捷键提示（如 ⌘K） */
  shortcut?: string;
  /** 自定义类名 */
  className?: string;
  /** 选项内容 */
  children?: React.ReactNode;
  /** 点击回调 */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export interface SelectGroupProps {
  className?: string;
  children?: React.ReactNode;
}

export interface SelectGroupLabelProps {
  className?: string;
  children?: React.ReactNode;
}

export interface SelectSeparatorProps {
  className?: string;
}

export interface SelectClearButtonProps {
  className?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export interface SelectIconProps {
  className?: string;
  children?: React.ReactNode;
}

// ── Select 选项与 Props ──

export interface SelectOption {
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  hint?: string;
}

export type SelectProps = SelectRootProps;

// ── Item 注册元数据 ──

export interface RegisteredItemData {
  id: string;
  value: string;
  disabled?: boolean;
  label?: string;
  index: number;
}

// ── Context 上下文契约 ──

export interface SelectContextValue {
  value: string | string[] | null;
  onValueChange: (val: string | string[] | null) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  size: SelectSize;
  variant: SelectVariant;
  multiple: boolean;
  clearable: boolean;
  disabled?: boolean;
  highlightedIndex: number;
  setHighlightedIndex: React.Dispatch<React.SetStateAction<number>>;
  triggerRef: React.RefObject<HTMLElement | null>;
  contentRef: React.RefObject<HTMLElement | null>;
  registerItem: (
    id: string,
    value: string,
    disabled?: boolean,
    label?: string
  ) => () => void;
  items: RegisteredItemData[];
  itemMap: Map<string, RegisteredItemData>;
  clear: (e?: React.SyntheticEvent) => void;
  listboxId: string;
  triggerId: string;
  activeDescendantId: string | undefined;
  selectValue: (val: string) => void;
  error?: string;
}

// ── Combobox 复合组件 Props ──

export interface ComboboxRootProps<T = any> {
  /** 待检索过滤的项目原始列表 */
  items?: T[];
  /** 当前选值（受控）；单选为 string | null，多选为 string[] */
  value?: string | string[] | null;
  /** 初始默认选值（非受控） */
  defaultValue?: string | string[] | null;
  /** 选值变更回调 */
  onValueChange?: (value: any) => void;
  /** 搜索过滤词（受控） */
  query?: string;
  /** 初始搜索过滤词（非受控） */
  defaultQuery?: string;
  /** 搜索过滤词变更回调 */
  onQueryChange?: (query: string) => void;
  /** 自定义单项过滤函数 */
  filter?: (item: T, query: string) => boolean;
  /** 项提取文本函数（用于默认模糊匹配） */
  itemToString?: (item: T) => string;
  /** 项提取 Value 函数 */
  itemToValue?: (item: T) => string;
  /** 浮层展开状态（受控） */
  open?: boolean;
  /** 初始展开状态（非受控） */
  defaultOpen?: boolean;
  /** 浮层展开状态变更回调 */
  onOpenChange?: (open: boolean) => void;
  /** 尺寸档位 */
  size?: SelectSize;
  /** 外观风格 */
  variant?: SelectVariant;
  /** 是否开启多选 */
  multiple?: boolean;
  /** 是否开启一键清除 */
  clearable?: boolean;
  /** 是否为多列网格布局 */
  grid?: boolean;
  /** 网格列数 (默认 1) */
  cols?: number;
  /** 是否禁用 */
  disabled?: boolean;
  /** 子节点 */
  children?: React.ReactNode;
}

export interface ComboboxInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** 前置自定义插槽（如放大镜搜索图标） */
  startSlot?: React.ReactNode;
  /** 后置自定义插槽 */
  endSlot?: React.ReactNode;
  /** 是否开启内嵌清除按钮 */
  clearable?: boolean;
  /** 是否展示后置展开指示箭头 */
  icon?: boolean | React.ReactNode;
  /** 外层容器自定义类名 */
  wrapperClassName?: string;
}

export interface ComboboxChipsProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** 空白时的占位文案 */
  placeholder?: string;
  /** 透传给内联原生 input 的属性 */
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
  /** 是否开启一键清除所有选值 */
  clearable?: boolean;
  /** 前置自定义插槽 */
  startSlot?: React.ReactNode;
  /** 子节点 */
  children?: React.ReactNode;
}

export interface ComboboxChipProps {
  /** 胶囊对应选值 */
  value: string;
  /** 胶囊文案（缺省从 itemMap/label 解析） */
  label?: React.ReactNode;
  /** 点击删除回调（缺省自动调用 removeChip） */
  onRemove?: () => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 子节点 */
  children?: React.ReactNode;
}

export interface ComboboxContentProps {
  /** 自定义类名 */
  className?: string;
  /** 浮层水平对齐方式 */
  align?: 'start' | 'center' | 'end';
  /** 浮层垂直弹出方向 */
  side?: 'bottom' | 'top';
  /** 与输入框的间距偏移量 (px) */
  sideOffset?: number;
  /** 与视口边界的安全距离 (px) */
  edgePadding?: number;
  /** 自定义 Portal 挂载容器 */
  portalContainer?: HTMLElement | null;
  /** 子节点 */
  children?: React.ReactNode;
}

export interface ComboboxListProps<T = any> {
  /** 网格列数 (默认 1) */
  cols?: number;
  /** 自定义类名 */
  className?: string;
  /** 子节点或渲染函数 */
  children?:
    | React.ReactNode
    | ((item: T, index: number) => React.ReactNode);
}

export interface ComboboxItemProps {
  /** 唯一标识值 */
  value: string;
  /** 文本标签（用于高亮匹配与 aria） */
  label?: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 前置图标 */
  icon?: React.ReactNode;
  /** 辅助说明文案 */
  hint?: React.ReactNode;
  /** 快捷键提示 */
  shortcut?: string;
  /** 是否自动高亮匹配文本 (默认 true) */
  autoHighlight?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 子节点 */
  children?: React.ReactNode;
  /** 点击回调 */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export interface ComboboxEmptyProps {
  className?: string;
  children?: React.ReactNode;
}

export interface ComboboxGroupProps {
  className?: string;
  children?: React.ReactNode;
}

export interface ComboboxLabelProps {
  className?: string;
  children?: React.ReactNode;
}

export interface ComboboxSeparatorProps {
  className?: string;
}

export interface ComboboxContextValue extends Omit<SelectContextValue, 'registerItem' | 'itemMap' | 'items'> {
  query: string;
  setQuery: (q: string) => void;
  filteredItems: unknown[];
  grid: boolean;
  cols: number;
  registerItem: (
    id: string,
    value: string,
    disabled?: boolean,
    label?: string
  ) => () => void;
  items: RegisteredItemData[];
  itemMap: Map<string, RegisteredItemData>;
  removeChip: (val: string) => void;
  isComposingRef: React.MutableRefObject<boolean>;
  activeChipIndex: number;
  setActiveChipIndex: React.Dispatch<React.SetStateAction<number>>;
  inputRef: React.RefObject<HTMLInputElement | null>;
}
