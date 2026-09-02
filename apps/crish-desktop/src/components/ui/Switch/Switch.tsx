/**
 * ui/Switch 现代化原子开关组件 (v2.0.0 架构升级版)
 *
 * 特性：
 * - 100% 纯净自研，零外部 npm 动画库依赖；
 * - 彻底移除 Checkmark 图标，回归纯粹流体果冻拉伸与极简纯白球体；
 * - GPU 硬件垂直中轴定位（top: 50%; translateY(-50%)），彻底消除“上宽下窄”下坠阴影视错觉；
 * - 0 0 0 0.5px 发丝微收边 + 各向同性柔和漫反射环境光影；
 * - 纯净状态锁门闩（hasInteracted），保证首屏绝对 Zero-FOUC；
 * - 3 档严格对称尺寸（sm: 28x16, md: 36x20, lg: 44x24，上下左右四向均等 2px 留白）；
 * - 支持 loading 加载锁定态与 label 关联；
 * - 补齐 html[data-perf-tier='eco'] 节能降级与 IME 输入法防穿透；
 * - 严格遵循 AGENTS.md §13 焦点环规范与 §14 现代色彩空间。
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import styles from './Switch.module.css';

export type SwitchSize = 'sm' | 'md' | 'lg';

export interface SwitchProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'onChange' | 'onClick' | 'size'
  > {
  /** 受控选中状态 */
  checked?: boolean;
  /** 非受控初始选中状态 */
  defaultChecked?: boolean;
  /** 状态变更回调 */
  onCheckedChange?: (checked: boolean) => void;
  /** 尺寸档位（默认 'md'） */
  size?: SwitchSize;
  /** 加载中状态（展示滑块内微型 Spinner 并锁定交互） */
  loading?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
  /** 前缀/后缀说明文案（点击可关联切换） */
  label?: React.ReactNode;
  /** 标签位置（默认 'start' 即前缀） */
  labelPlacement?: 'start' | 'end';
  /** 无 label 时的屏幕阅读器命名 */
  'aria-label'?: string;
  /** 自定义类名（仅用于外部布局与间距微调） */
  className?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    checked: externalChecked,
    defaultChecked = false,
    onCheckedChange,
    size = 'md',
    loading = false,
    disabled = false,
    label,
    labelPlacement = 'start',
    id,
    className,
    'aria-label': ariaLabel,
    onKeyDown,
    ...restProps
  },
  ref
) {
  const autoId = useId();
  const switchId = id ?? `conex-switch-${autoId}`;

  // 受控 / 非受控状态归一化
  const isControlled = externalChecked !== undefined;
  const [internalChecked, setInternalChecked] = useState(defaultChecked);
  const checked = isControlled ? Boolean(externalChecked) : internalChecked;

  // 动画守卫：防止挂载初次渲染时误触发过渡动画（Zero-FOUC）
  const [hasInteracted, setHasInteracted] = useState(false);
  const isFirstRender = useRef(true);
  const prevCheckedRef = useRef(checked);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (prevCheckedRef.current !== checked) {
      setHasInteracted(true);
      prevCheckedRef.current = checked;
    }
  }, [checked]);

  const isInteractive = !disabled && !loading;

  const handleToggle = useCallback(() => {
    if (!isInteractive) return;
    setHasInteracted(true);
    const nextChecked = !checked;
    if (!isControlled) {
      setInternalChecked(nextChecked);
    }
    onCheckedChange?.(nextChecked);
  }, [checked, isControlled, isInteractive, onCheckedChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented || e.nativeEvent.isComposing) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleToggle();
      }
    },
    [handleToggle, onKeyDown]
  );

  const trackClasses = [
    styles.track,
    styles[`size-${size}`],
    hasInteracted ? styles.hasInteracted : null,
    loading ? styles.loading : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const control = (
    <button
      ref={ref}
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      aria-label={ariaLabel}
      disabled={disabled}
      className={trackClasses}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      data-state={checked ? 'checked' : 'unchecked'}
      data-size={size}
      {...restProps}
    >
      <span className={styles.thumb} aria-hidden="true">
        {loading && (
          <svg
            className={styles.spinner}
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="28"
              strokeDashoffset="18"
            />
          </svg>
        )}
      </span>
    </button>
  );

  if (label == null) {
    return control;
  }

  const labelElement = (
    <label htmlFor={switchId} className={styles.label}>
      {label}
    </label>
  );

  return (
    <span
      className={`${styles.container} ${styles[`align-${labelPlacement}`]}`}
      data-disabled={disabled || undefined}
    >
      {labelPlacement === 'start' && labelElement}
      {control}
      {labelPlacement === 'end' && labelElement}
    </span>
  );
});

Switch.displayName = 'Switch';
