/**
 * apps/crish-desktop/src/components/ui/Divider/Divider.tsx
 *
 * ui/Divider 统一装饰分隔线（分割线统一组件方案 · 波次 1 组件本体）。
 *
 * 蓝本：Select / Combobox 的 Separator（全仓唯一既有组件化装饰分隔）——
 * role="separator" + aria-orientation，1px 线走 --border-subtle 令牌。
 * 本组件把散落十余处的装饰线收敛为一个入口：横/竖两向，边距收敛为
 * compact / regular 两档组件内令牌；可拖拽分栏归 SplitResizer，不归本组件。
 */

import React, { type CSSProperties } from 'react';
import styles from './Divider.module.css';

export type DividerOrientation = 'horizontal' | 'vertical';
export type DividerSpacing = 'compact' | 'regular';

/**
 * 横向 compact 档分割线在布局流中的占高（px）：线体 1px
 * （height: 0 + border-top: 1px）+ 上下边距 2 × 4px
 * （--divider-space-compact）。布局估算（如级联菜单高度预估）引用
 * 此常量，禁止再写死数字；与 Divider.module.css 令牌的同源关系
 * 由 Divider.test 的棘轮钉住。
 */
export const DIVIDER_COMPACT_BLOCK_SIZE_PX = 1 + 2 * 4;

export interface DividerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** horizontal（默认）：横线分隔上下；vertical：竖线分隔左右 */
  orientation?: DividerOrientation;
  /** 边距档位：compact（默认）/ regular，见 Divider.module.css 令牌 */
  spacing?: DividerSpacing;
  /** 仅 horizontal：线两端内缩（菜单语境，Select 蓝本的 6px） */
  inset?: boolean;
  /** 仅 vertical：线长（px 或 CSS 长度），默认 14px（现行竖分隔 12–16px 的中值收敛） */
  length?: number | string;
}

export function Divider({
  orientation = 'horizontal',
  spacing = 'compact',
  inset = false,
  length,
  className,
  style,
  ...restProps
}: DividerProps) {
  const classNames = [
    styles.divider,
    orientation === 'vertical' ? styles.vertical : styles.horizontal,
    spacing === 'regular' ? styles.regular : styles.compact,
    inset && orientation === 'horizontal' ? styles.inset : '',
    className ?? '',
  ]
    .join(' ')
    .trim();

  const mergedStyle: CSSProperties | undefined =
    orientation === 'vertical' && length !== undefined
      ? ({
          ...(style ?? {}),
          ['--divider-length' as string]:
            typeof length === 'number' ? `${length}px` : length,
        } as CSSProperties)
      : style;

  return (
    <div
      {...restProps}
      role="separator"
      aria-orientation={orientation}
      data-slot="divider"
      className={classNames}
      style={mergedStyle}
    />
  );
}
