/**
 * ui/Button 原子按钮组件（React 19 纯函数范式升级版）
 *
 * 遵循同心几何标尺与四档标准化尺寸矩阵（24/28/32/40px），
 * 落实伪元素 ::before 0-重绘悬浮遮罩与柔和 Focus Ring。
 * 普通按钮禁止 9999px 药丸圆角，仅使用 --radius-sm(4px)/--radius-md(6px)/--radius-lg(8px)。
 *
 * 底层架构升级：
 * 1. 采用 React 19 纯函数组件契约：Ref-as-prop，移除 forwardRef 与 displayName；
 * 2. 引入 useMergedRefs 统一处理内部与外部 ref，遵照 React 19 Cleanup 规范；
 * 3. 提取并导出 buttonVariants 纯函数对象，以 CVA + 统一 cn 函数驱动样式组装；
 * 4. 彻底废除 bare 临时逃逸口，正式引入第一公民变体 variant="unstyled"；
 * 5. 样式整体封闭于 @layer components，确保外部覆盖具备 W3C 规范级确定性胜出权。
 *
 * 分层契约：本组件只依赖 react、internal/cn 与 tokens CSS 变量，不依赖任何业务模块。
 */
import React, { useRef } from 'react';
import { cva, cn, type VariantProps } from '../internal/cn';
import { useMergedRefs } from '../utils/mergeRefs';
import styles from './Button.module.css';

/**
 * CVA 按钮样式矩阵定义（单一真理源 SSOT）
 * 完全复用原生 CSS Modules 导出类名，通过 class-variance-authority 驱动矩阵计算
 */
export const buttonVariants = cva(styles.button, {
  variants: {
    variant: {
      default: styles.buttonSecondary,
      primary: styles.buttonPrimary,
      secondary: styles.buttonSecondary,
      danger: styles.buttonDanger,
      ghost: styles.buttonGhost,
      outline: styles.buttonOutline,
      plain: styles.buttonPlain,
    },
    size: {
      xs: styles.buttonXs,
      sm: styles.buttonSm,
      md: styles.buttonMd,
      lg: styles.buttonLg,
      icon: styles.buttonSizeIcon,
    },
    block: {
      true: styles.buttonBlock,
    },
    active: {
      true: styles.buttonActive,
    },
    loading: {
      true: styles.buttonLoading,
    },
  },
  defaultVariants: {
    variant: 'secondary',
    size: 'md',
  },
});

export type ButtonVariant =
  NonNullable<VariantProps<typeof buttonVariants>['variant']> | 'unstyled';
export type ButtonSize = NonNullable<
  VariantProps<typeof buttonVariants>['size']
>;
export type ButtonVariantProps = VariantProps<typeof buttonVariants>;

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    Omit<
      VariantProps<typeof buttonVariants>,
      'variant' | 'block' | 'active' | 'loading'
    > {
  ref?: React.Ref<HTMLButtonElement>;
  /** 视觉变体：default | primary | secondary | danger | ghost | outline | plain | unstyled */
  variant?: ButtonVariant;
  /** 尺寸：xs(24px) | sm(28px) | md(32px) | lg(40px) | icon */
  size?: ButtonSize;
  /** 图标位（置于文字前/后，aria-hidden 由组件内部保证） */
  icon?: React.ReactNode;
  /** 图标位置：left（默认）或 right */
  iconPosition?: 'left' | 'right';
  /** 加载态：自动 disabled + aria-busy，内容前置旋转指示 */
  loading?: boolean;
  /** 加载态别名（对齐标准 UI 契约） */
  isLoading?: boolean;
  /** 通栏按钮（宽度 100%） */
  block?: boolean;
  /** 激活态 */
  active?: boolean;
  /**
   * @deprecated 裸核心模式已废弃，请使用 variant="unstyled"。
   * @see variant="unstyled"
   * 为向后兼容存量未完成迁移的代码，传入 bare=true 时内部自动收敛映射至 'unstyled' 变体。
   */
  bare?: boolean;
  /** 对齐方式：center（默认居中）| start（靠左对齐，专供通栏导航条目等） */
  align?: 'center' | 'start';
  /** 静态模式：禁用 :active 按压缩放微触感 */
  static?: boolean;
}

/**
 * 原子按钮（React 19 纯函数实现）
 * 彻底废除 bare 临时逃逸口，正式引入第一公民变体 variant="unstyled"；
 * 当且仅当 variant="unstyled" 时，剥离一切内置尺寸与动效类，仅保留原生 a11y 与纯语义化交互；
 * 接入 CVA + cn 工具函数，确保外部 className 具备确定性覆盖优先级。
 */
export function Button({
  ref,
  variant = 'secondary',
  size = 'md',
  icon,
  iconPosition = 'left',
  loading = false,
  isLoading = false,
  block = false,
  active = false,
  bare,
  align,
  static: staticProp,
  disabled,
  className,
  children,
  type = 'button',
  ...restProps
}: ButtonProps) {
  const internalRef = useRef<HTMLButtonElement | null>(null);
  const combinedRef = useMergedRefs(internalRef, ref);

  const effectiveLoading = Boolean(loading || isLoading);
  // 废除裸逃逸口，正式收敛至 variant="unstyled"；兼容存量 bare 属性
  const effectiveVariant = bare ? 'unstyled' : variant;

  // 1. 无样式纯净模式：剥离 .button 基础类、内置尺寸、边框、背景及伪元素，仅保留 reset 与 a11y 基础行为
  if (effectiveVariant === 'unstyled') {
    return (
      <button
        ref={combinedRef}
        type={type}
        className={cn(styles.buttonUnstyled, className)}
        data-variant="unstyled"
        data-align={align}
        data-static={staticProp ? 'true' : undefined}
        data-active={active || undefined}
        disabled={disabled || effectiveLoading}
        aria-busy={effectiveLoading || undefined}
        {...restProps}
      >
        {children}
      </button>
    );
  }

  // 2. 常规标准按钮渲染流程（继承标准同心标尺与几何状态）
  const resolvedClassName = cn(
    buttonVariants({
      variant: effectiveVariant,
      size,
      block,
      active,
      loading: effectiveLoading,
    }),
    className
  );

  const iconNode =
    icon != null ? (
      <span className={styles.buttonIcon} aria-hidden="true">
        {icon}
      </span>
    ) : null;

  return (
    <button
      ref={combinedRef}
      type={type}
      className={resolvedClassName}
      data-size={size}
      data-variant={effectiveVariant}
      data-active={active || undefined}
      data-align={align}
      data-static={staticProp ? 'true' : undefined}
      disabled={disabled || effectiveLoading}
      aria-busy={effectiveLoading || undefined}
      {...restProps}
    >
      {effectiveLoading ? (
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
      {!effectiveLoading && iconPosition === 'right' ? iconNode : null}
    </button>
  );
}
