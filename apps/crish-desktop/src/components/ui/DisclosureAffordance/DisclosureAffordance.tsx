/**
 * ui/DisclosureAffordance 展开指示原子基元（P4 T-P4-05）
 *
 * 用于收敛工具调用折叠、思考块折叠、侧栏分组等处的常驻 chevron 尖角。
 * 默认静止态低权，hover/展开状态平滑淡入并旋转 90 度。
 *
 * 分层契约：本组件只依赖 react 与 CSS 变量，严禁反向依赖任何业务模块。
 */
import React from 'react';
import styles from './DisclosureAffordance.module.css';

export interface DisclosureAffordanceProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 当前展开状态：true(已展开，顺时针旋转 90deg) | false(收起，0deg) */
  expanded: boolean;
  /** 控制的目标容器 DOM id，注入 aria-controls */
  ariaControls?: string;
  /** 是否禁用折叠 */
  disabled?: boolean;
  /** 是否常显（跳过 hover 隐式淡入，始终显示） */
  alwaysVisible?: boolean;
}

export const DisclosureAffordance = React.forwardRef<
  HTMLSpanElement,
  DisclosureAffordanceProps
>(function DisclosureAffordance(
  {
    expanded,
    ariaControls,
    disabled = false,
    alwaysVisible = false,
    className,
    ...restProps
  },
  ref
) {
  const classNames = [
    styles.affordanceSlot,
    expanded && styles.expanded,
    disabled && styles.disabled,
    alwaysVisible && styles.alwaysVisible,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      ref={ref}
      className={classNames}
      aria-expanded={expanded}
      aria-controls={ariaControls}
      aria-disabled={disabled ? 'true' : undefined}
      data-expanded={expanded ? 'true' : 'false'}
      data-disabled={disabled ? 'true' : undefined}
      {...restProps}
    >
      <svg
        className={styles.chevronIcon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </span>
  );
});

DisclosureAffordance.displayName = 'DisclosureAffordance';
