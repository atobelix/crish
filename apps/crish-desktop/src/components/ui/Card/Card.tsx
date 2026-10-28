/**
 * ui/Card 内容容器原子基元（CVA 架构升级版 / React 19 纯函数）
 *
 * 承载报告卡、Diff 卡片、文件卡片、终端卡片与设置卡片等内容容器。
 * 严格遵循展示型容器 0 描边铁律（border: none），以表面明度差（--surface-card）建立层级，
 * 圆角固化为角色圆角 --radius-card (12px)。
 *
 * 分层契约：本组件只依赖 react 与 CSS 变量，严禁反向依赖任何业务模块。
 */
import React from 'react';
import { cva, cn, type VariantProps } from '../internal/cn';
import styles from './Card.module.css';

export const cardVariants = cva(styles.card, {
  variants: {
    padding: {
      none: styles.padNone,
      sm: styles.padSm,
      md: styles.padMd,
      lg: styles.padLg,
    },
    rim: {
      true: styles.rim,
    },
    interactive: {
      true: styles.interactive,
    },
  },
  defaultVariants: {
    padding: 'md',
  },
});

export type CardPadding = NonNullable<
  VariantProps<typeof cardVariants>['padding']
>;

export interface CardProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {
  ref?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
  /** 内边距档位：none(0) | sm(8px) | md(12px) | lg(16px)，默认 'md' */
  padding?: CardPadding;
  /** 是否需要极弱边缘轮廓光（仅在复杂背景/低反差环境下兜底） */
  rim?: boolean;
  /** 可选点击交互 */
  interactive?: boolean;
}

export function Card({
  ref,
  padding = 'md',
  rim = false,
  interactive,
  onClick,
  onKeyDown,
  role,
  tabIndex,
  className,
  children,
  ...restProps
}: CardProps) {
  const isInteractive = Boolean(interactive || onClick);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    if (onClick && (event.key === 'Enter' || event.key === ' ')) {
      if (event.key === ' ') {
        event.preventDefault();
      }
      onClick(event as unknown as React.MouseEvent<HTMLDivElement>);
    }
  };

  const resolvedRole = role ?? (isInteractive ? 'button' : undefined);
  const resolvedTabIndex = tabIndex ?? (isInteractive ? 0 : undefined);

  const resolvedClassName = cn(
    cardVariants({ padding, rim, interactive: isInteractive }),
    className
  );

  return (
    <div
      ref={ref}
      className={resolvedClassName}
      role={resolvedRole}
      tabIndex={resolvedTabIndex}
      data-padding={padding}
      data-rim={rim ? 'true' : undefined}
      data-interactive={isInteractive ? 'true' : undefined}
      onClick={onClick}
      onKeyDown={isInteractive ? handleKeyDown : onKeyDown}
      {...restProps}
    >
      {children}
    </div>
  );
}
