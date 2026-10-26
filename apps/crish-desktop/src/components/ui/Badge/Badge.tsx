/**
 * ui/Badge 原子徽标组件（P4 T-P4-03 就地升级）
 *
 * 遵循展示型容器 0 描边铁律（border: none），
 * 圆角采用角色圆角 --radius-row (6px)，
 * 提供 neutral / accent / warning / danger / success 5 类受限语义 tone，
 * 同时向后兼容旧 brand / info / error 别名。
 *
 * 分层契约：本组件只依赖 react 与 CSS 变量，严禁反向依赖任何业务模块。
 */
import React from 'react';
import styles from './Badge.module.css';
import { ICON_STROKE } from '../icons/iconTokens';

export type StandardBadgeTone =
  'neutral' | 'accent' | 'warning' | 'danger' | 'success';

export type BadgeTone = StandardBadgeTone | 'brand' | 'info' | 'error';

export type BadgeSize = 'xs' | 'sm' | 'md';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 严格受限的语义 tone：neutral / accent / warning / danger / success（兼容旧 brand/info/error 别名） */
  tone?: BadgeTone;
  /** 兼容 variant 别名 */
  variant?: BadgeTone;
  /** 尺寸：xs(18px) / sm(20px) / md(24px)，默认 'sm' */
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
  accent: styles.toneAccent,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
  success: styles.toneSuccess,
  brand: styles.toneBrand ?? styles.toneAccent,
  info: styles.toneInfo ?? styles.toneNeutral,
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
    const rawTone: BadgeTone = tone ?? variant ?? 'neutral';

    const classNames = [
      styles.badge,
      TONE_CLASS_MAP[rawTone],
      SIZE_CLASS_MAP[size],
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <span
        ref={ref}
        className={classNames}
        data-tone={rawTone}
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
              strokeWidth={ICON_STROKE.ui}
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
