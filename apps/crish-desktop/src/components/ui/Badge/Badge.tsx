/**
 * ui/Badge 原子徽标组件（RED-DETAILED-02 / T-ATOM-07）
 *
 * 遵循 4px 微圆角矩形设计（--radius-sm），严禁 9999px 药丸圆角，
 * 提供 neutral / info (brand) / success / warning / danger 5 种微透明度 tone。
 *
 * 分层契约：本组件只依赖 react 与 tokens CSS 变量，不依赖任何业务模块。
 */
import React from 'react';
import styles from './Badge.module.css';

export type BadgeTone =
  'neutral' | 'brand' | 'info' | 'success' | 'warning' | 'danger' | 'error';

export type BadgeSize = 'xs' | 'sm' | 'md';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 语义色调：neutral / brand / info / success / warning / danger(error) */
  tone?: BadgeTone;
  /** 兼容 variant 别名 */
  variant?: BadgeTone;
  /** 尺寸：xs(18px) / sm(20px) / md(24px) */
  size?: BadgeSize;
  /** 是否展示前置微圆点状态指示 */
  dot?: boolean;
  /** 图标位 */
  icon?: React.ReactNode;
  /** 移除按钮回调（传入时渲染右侧 × 按钮，作为 Chip/Tag 语义） */
  onRemove?: () => void;
  /** 移除按钮无障碍标签 */
  removeAriaLabel?: string;
}

const TONE_CLASS_MAP: Record<BadgeTone, string | undefined> = {
  neutral: styles.toneNeutral,
  brand: styles.toneBrand,
  info: styles.toneInfo,
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
  error: styles.toneDanger,
};

const SIZE_CLASS_MAP: Record<BadgeSize, string | undefined> = {
  xs: styles.sizeXs,
  sm: styles.sizeSm,
  md: styles.sizeMd,
};

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  function Badge(
    {
      tone,
      variant,
      size = 'sm',
      dot = false,
      icon,
      onRemove,
      removeAriaLabel = '移除',
      className,
      children,
      ...restProps
    },
    ref
  ) {
    const resolvedTone: BadgeTone = tone ?? variant ?? 'neutral';

    const classNames = [
      styles.badge,
      TONE_CLASS_MAP[resolvedTone],
      SIZE_CLASS_MAP[size],
      onRemove ? styles.badgeInteractive : null,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <span
        ref={ref}
        className={classNames}
        data-tone={resolvedTone}
        data-size={size}
        {...restProps}
      >
        {dot && <span className={styles.dot} aria-hidden="true" />}
        {icon && (
          <span className={styles.icon} aria-hidden="true">
            {icon}
          </span>
        )}
        {children != null && <span className={styles.label}>{children}</span>}
        {onRemove && (
          <button
            type="button"
            className={styles.removeButton}
            aria-label={removeAriaLabel}
            onClick={() => {
              onRemove();
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </span>
    );
  }
);
Badge.displayName = 'Badge';
