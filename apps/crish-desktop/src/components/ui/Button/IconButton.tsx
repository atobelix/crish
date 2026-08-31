/**
 * ui/IconButton 原子图标按钮组件（PE-05 / RED-DETAILED-02）
 *
 * 正方形图标按钮，强制要求 aria-label 属性以确保屏幕阅读器无障碍可访问性。
 * 可选支持声明式 Tooltip 绑定（内部使用 ui/Tooltip 包裹）。
 * 尺寸遵循 24/28/32/40px 四档标准化标尺。
 */
import React from 'react';
import { Button, type ButtonProps } from './Button';
import { Tooltip } from '../Tooltip/Tooltip';
import styles from './Button.module.css';

export interface IconButtonProps extends Omit<
  ButtonProps,
  'children' | 'block' | 'iconPosition'
> {
  /** 图标元素 */
  icon: React.ReactNode;
  /** 强制无障碍命名，确保无障碍屏幕阅读器可识别 */
  'aria-label': string;
  /** 声明式 Tooltip 浮层文案（可选） */
  tooltip?: React.ReactNode;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { icon, tooltip, className, variant = 'ghost', 'aria-label': ariaLabel, ...props },
    ref
  ) {
    const classNames = [styles.iconButton, className].filter(Boolean).join(' ');

    const buttonNode = (
      <Button
        ref={ref}
        icon={icon}
        variant={variant}
        aria-label={ariaLabel}
        className={classNames}
        {...props}
      />
    );

    if (tooltip != null) {
      return <Tooltip content={tooltip}>{buttonNode}</Tooltip>;
    }

    return buttonNode;
  }
);
IconButton.displayName = 'IconButton';
