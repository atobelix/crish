/**
 * ui/IconButton 原子图标按钮组件（P4 T-P4-04 就地升级）
 *
 * 正方形图标按钮，强制要求 aria-label 属性以确保屏幕阅读器无障碍可访问性。
 * 可选支持声明式 Tooltip 绑定（内部使用 ui/Tooltip 包裹）。
 * 尺寸遵循 dense(24) / list(28) / control(32) / chrome(36px) 四档标准化行高对齐标尺，
 * 同时向后兼容旧 xs / sm / md / lg 别名（默认 'list'）。
 * 状态统一走 --state-*（单层 ::before 物理微光交互，杜绝双层叠合发黑），焦点态遵循混入 ≤10% 规范。
 */
import React from 'react';
import { Button, type ButtonProps, type ButtonSize } from './Button';
import { Tooltip } from '../Tooltip/Tooltip';
import styles from './Button.module.css';

export type StandardIconButtonSize = 'dense' | 'list' | 'control' | 'chrome';
export type IconButtonSize = StandardIconButtonSize | 'xs' | 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<
  ButtonProps,
  'children' | 'block' | 'iconPosition' | 'size'
> {
  /** 图标元素 */
  icon: React.ReactNode;
  /** 强制无障碍命名，确保无障碍屏幕阅读器可识别 */
  'aria-label': string;
  /** 尺寸档位：dense(24) | list(28) | control(32) | chrome(36)，兼容 xs/sm/md/lg，默认 'list' */
  size?: IconButtonSize;
  /** 声明式 Tooltip 浮层文案（可选） */
  tooltip?: React.ReactNode;
  /** 快捷键组合：单个字符串（如 '?'）或按键数组 */
  shortcut?: string | string[];
}

const SIZE_MAPPING: Record<
  IconButtonSize,
  { buttonSize: ButtonSize; semanticSize: StandardIconButtonSize }
> = {
  dense: { buttonSize: 'xs', semanticSize: 'dense' },
  list: { buttonSize: 'sm', semanticSize: 'list' },
  control: { buttonSize: 'md', semanticSize: 'control' },
  chrome: { buttonSize: 'lg', semanticSize: 'chrome' },
  xs: { buttonSize: 'xs', semanticSize: 'dense' },
  sm: { buttonSize: 'sm', semanticSize: 'list' },
  md: { buttonSize: 'md', semanticSize: 'control' },
  lg: { buttonSize: 'lg', semanticSize: 'chrome' },
};

const SIZE_CLASS_MAP: Record<StandardIconButtonSize, string | undefined> = {
  dense: styles.dense,
  list: styles.list,
  control: styles.control,
  chrome: styles.chrome,
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      icon,
      tooltip,
      shortcut,
      className,
      size = 'list',
      variant = 'ghost',
      'aria-label': ariaLabel,
      ...props
    },
    ref
  ) {
    const mapping = SIZE_MAPPING[size] ?? SIZE_MAPPING.list;
    const sizeClass = SIZE_CLASS_MAP[mapping.semanticSize];

    const classNames = [styles.iconButton, sizeClass, className]
      .filter(Boolean)
      .join(' ');

    const buttonNode = (
      <Button
        ref={ref}
        icon={icon}
        variant={variant}
        size={mapping.buttonSize}
        aria-label={ariaLabel}
        className={classNames}
        data-size={size}
        {...props}
      />
    );

    if (tooltip != null) {
      return (
        <Tooltip content={tooltip} shortcut={shortcut}>
          {buttonNode}
        </Tooltip>
      );
    }

    return buttonNode;
  }
);
IconButton.displayName = 'IconButton';
