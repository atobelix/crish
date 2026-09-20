/**
 * ui/Button 原子按钮组件（PE-05 / RED-DETAILED-02）
 *
 * 遵循同心几何标尺与四档标准化尺寸矩阵（24/28/32/40px），
 * 落实伪元素 ::before 0-重绘悬浮遮罩与柔和 Focus Ring。
 * 普通按钮禁止 9999px 药丸圆角，仅使用 --radius-sm(4px)/--radius-md(6px)/--radius-lg(8px)。
 *
 * 分层契约：本组件只依赖 react 与 tokens CSS 变量，不依赖任何业务模块。
 */
import React from 'react';
import styles from './Button.module.css';

export type ButtonVariant =
  'primary' | 'secondary' | 'plain' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉变体：primary 主操作 / secondary 次操作 / plain 极简文字 / ghost 轻量 / danger 危险操作 */
  variant?: ButtonVariant;
  /** 尺寸：xs(24px) / sm(28px) / md(32px) / lg(40px) */
  size?: ButtonSize;
  /** 图标位（置于文字前/后，aria-hidden 由组件内部保证） */
  icon?: React.ReactNode;
  /** 图标位置：left（默认）或 right */
  iconPosition?: 'left' | 'right';
  /** 加载态：自动 disabled + aria-busy，内容前置旋转指示 */
  loading?: boolean;
  /** 通栏按钮（宽度 100%） */
  block?: boolean;
  /** 激活态 */
  active?: boolean;
  /**
   * 裸核心模式（剥离 padding/border/background/shadow 等视觉包装，保留语义与无障碍）。
   * 选型决策树：
   * 1. 常规操作触点（带背景、边框、标准规格）→ 使用标准 Button（variant: primary/secondary/ghost/danger）；
   * 2. 纯图标按钮 → 使用 IconButton（强制 aria-label + 编译期约束）；
   * 3. 复杂列表项、下拉菜单条目、树行展开/折叠 twisty、代码行内行号按钮等完全由外层 CSS 自定义布局的场景 → 使用 Button bare。
   */
  bare?: boolean;
  /** 对齐方式：center（默认居中）| start（靠左对齐，专供通栏导航条目等） */
  align?: 'center' | 'start';
  /** 静态模式：禁用 :active 按压缩放微触感 */
  static?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  primary: styles.buttonPrimary,
  secondary: styles.buttonSecondary,
  plain: styles.buttonPlain,
  ghost: styles.buttonGhost,
  danger: styles.buttonDanger,
};

const SIZE_CLASS: Record<ButtonSize, string | undefined> = {
  xs: styles.buttonXs,
  sm: styles.buttonSm,
  md: styles.buttonMd,
  lg: styles.buttonLg,
};

/**
 * 原子按钮。class 拼接遵循 CSS Modules camelCase 约定，
 * 尺寸与变体严格正交；disabled 由组件内部合并 loading 态。
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'secondary',
      size = 'md',
      icon,
      iconPosition = 'left',
      loading = false,
      block = false,
      active = false,
      bare = false,
      align,
      static: staticProp,
      disabled,
      className,
      children,
      type = 'button',
      ...restProps
    },
    ref
  ) {
    if (bare) {
      return (
        <button
          ref={ref}
          type={type}
          className={className}
          data-align={align}
          data-static={staticProp ? 'true' : undefined}
          disabled={disabled || loading}
          aria-busy={loading || undefined}
          {...restProps}
        >
          {children}
        </button>
      );
    }

    const classNames = [
      styles.button,
      VARIANT_CLASS[variant],
      SIZE_CLASS[size],
      block ? styles.buttonBlock : null,
      active ? styles.buttonActive : null,
      loading ? styles.buttonLoading : null,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const iconNode =
      icon != null ? (
        <span className={styles.buttonIcon} aria-hidden="true">
          {icon}
        </span>
      ) : null;

    return (
      <button
        ref={ref}
        type={type}
        className={classNames}
        data-size={size}
        data-variant={variant}
        data-active={active || undefined}
        data-align={align}
        data-static={staticProp ? 'true' : undefined}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...restProps}
      >
        {loading ? (
          <span className={styles.spinner} aria-hidden="true" />
        ) : iconPosition === 'left' ? (
          iconNode
        ) : null}
        {children != null ? (
          typeof children === 'string' || typeof children === 'number' ? (
            <span className={styles.buttonLabel}>{children}</span>
          ) : (
            children
          )
        ) : null}
        {!loading && iconPosition === 'right' ? iconNode : null}
      </button>
    );
  }
);
Button.displayName = 'Button';
