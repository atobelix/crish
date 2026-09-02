import React from 'react';

export type TabsVariant = 'pill' | 'line';
export type TabsSize = 'xs' | 'sm' | 'md' | 'lg';
export type TabsOrientation = 'horizontal' | 'vertical';

export interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  variant: TabsVariant;
  size: TabsSize;
  orientation: TabsOrientation;
  block: boolean;
  registerTrigger: (value: string, element: HTMLElement | null) => void;
  unregisterTrigger: (value: string) => void;
}

export interface TabsProps {
  /** 受控选中值 */
  value?: string;
  /** 非受控默认选中值 */
  defaultValue?: string;
  /** 选中变更回调 */
  onValueChange?: (value: string) => void;
  /** 外观变体：pill(胶囊卡片) | line(下划线指示条) */
  variant?: TabsVariant;
  /** 尺寸档位 */
  size?: TabsSize;
  /** 排布方向 */
  orientation?: TabsOrientation;
  /** 撑满父容器 */
  block?: boolean;
  /** 自定义外层类名 */
  className?: string;
  /** 自定义行内样式 */
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 无障碍标签 */
  'aria-label'?: string;
  /** 自定义类名 */
  className?: string;
  /** 自定义行内样式 */
  style?: React.CSSProperties;
  /** 自定义无障碍角色（默认 role="tablist"） */
  role?: string;
  children: React.ReactNode;
}

export interface TabsTriggerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  /** 选项值唯一标识 */
  value: string;
  /** 可选前置图标 */
  icon?: React.ReactNode;
  /** 可选尾部徽标/数量 */
  badge?: React.ReactNode;
  /** 禁用态 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 自定义行内样式 */
  style?: React.CSSProperties;
  /** 自定义无障碍角色（默认 role="tab"） */
  role?: string;
  /** 显式无障碍标签 */
  'aria-label'?: string;
  children: React.ReactNode;
}

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 对应 Tab 触发器的唯一标识 */
  value: string;
  /** 是否在未激活时保留 DOM 节点（通过 hidden 隐藏而非卸载） */
  keepMounted?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 自定义行内样式 */
  style?: React.CSSProperties;
  children: React.ReactNode;
}

/* 兼容现有 SegmentedControl 的配置式接口 */
export interface SegmentedControlOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
  'aria-label'?: string;
}

export type SegmentedControlSize = 'xs' | 'sm' | 'md' | 'lg';

export interface SegmentedControlProps<T extends string = string> {
  options: (SegmentedControlOption<T> | T)[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  variant?: TabsVariant;
  size?: SegmentedControlSize;
  orientation?: TabsOrientation;
  block?: boolean;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
}
