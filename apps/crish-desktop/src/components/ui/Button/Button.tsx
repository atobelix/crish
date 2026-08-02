/**
 * ui/Button 原子按钮组件（PE-05 T05.1.2）
 *
 * 对齐 `styles/shell/shell-polish.css` 中 `.ui-btn` 全局体系的语义
 * （primary/secondary/ghost + sm/md 尺寸 + block），并补齐审计指出的
 * danger 变体缺口（原全局危险类为死类，已删除，见 AA-04 3.3）。
 *
 * 分层契约：本组件只依赖 react 与 tokens CSS 变量，不依赖任何业务模块。
 */
import React from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉变体：primary 主操作 / secondary 次操作 / ghost 轻量 / danger 危险操作 */
  variant?: ButtonVariant;
  /** 尺寸：sm（control-height-sm 药丸形）/ md（control-height 默认圆角） */
  size?: ButtonSize;
  /** 图标位（置于文字前，aria-hidden 由调用方图标保证） */
  icon?: React.ReactNode;
  /** 加载态：自动 disabled + aria-busy，内容替换为旋转指示 */
  loading?: boolean;
  /** 通栏按钮（对齐 .ui-btn-block 语义） */
  block?: boolean;
}

// noUncheckedIndexedAccess 下 CSS Modules 取值类型为 string | undefined，
// 映射表显式声明该类型，最终由 filter(Boolean).join 过滤
const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  primary: styles.buttonPrimary,
  secondary: styles.buttonSecondary,
  ghost: styles.buttonGhost,
  danger: styles.buttonDanger,
};

const SIZE_CLASS: Record<ButtonSize, string | undefined> = {
  sm: styles.buttonSm,
  md: styles.buttonMd,
};

/**
 * 原子按钮。class 拼接遵循 CSS Modules camelCase 约定，
 * 不使用任何全局类；disabled 由组件内部合并 loading 态。
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'primary',
      size = 'md',
      icon,
      loading = false,
      block = false,
      disabled,
      className,
      children,
      type = 'button',
      ...restProps
    },
    ref
  ) {
    const classNames = [
      styles.button,
      VARIANT_CLASS[variant],
      SIZE_CLASS[size],
      block ? styles.buttonBlock : null,
      loading ? styles.buttonLoading : null,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        ref={ref}
        type={type}
        className={classNames}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...restProps}
      >
        {loading ? (
          <span className={styles.spinner} aria-hidden="true" />
        ) : icon != null ? (
          <span className={styles.buttonIcon} aria-hidden="true">
            {icon}
          </span>
        ) : null}
        {children != null ? <span className={styles.buttonLabel}>{children}</span> : null}
      </button>
    );
  }
);
Button.displayName = 'Button';
