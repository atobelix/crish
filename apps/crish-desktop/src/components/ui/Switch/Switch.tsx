/**
 * ui/Switch 现代化原子开关组件（0ms 乐观响应与防死锁加固）
 *
 * 特性：
 * - 100% 纯净自研，零外部 npm 动画库依赖；
 * - 0ms 乐观状态机（optimisticChecked）：点击后滑块沿轨道平移并减速落定，不做挤压形变；
 * - 受控与非受控双模严格权威收敛，外部真源更新时平滑对齐；
 * - 四层异常回滚与防死锁架构：同步捕获、Promise 异步守护、TTL 守卫定时器与双击原点快速收敛；
 * - 彻底移除 Checkmark 图标，滑块保持圆形，只做平移；
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
import { ICON_STROKE } from '../icons/iconTokens';

export type SwitchSize = 'sm' | 'md' | 'lg';

export interface SwitchProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'onClick' | 'size'
> {
  /** 受控选中状态 */
  checked?: boolean;
  /** 非受控初始选中状态 */
  defaultChecked?: boolean;
  /** 状态变更回调（支持同步回调或返回 Promise 供异常回滚） */
  onCheckedChange?: (checked: boolean) => void | Promise<unknown>;
  /** 尺寸档位（默认 'md'） */
  size?: SwitchSize;
  /** 加载中状态（展示滑块内微型 Spinner 并锁定交互） */
  loading?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否启用 0ms 乐观响应状态机（默认 true） */
  optimistic?: boolean;
  /** 乐观状态超时对齐防死锁窗口毫秒数（默认 5000ms，设为 0 可关闭超时回滚） */
  optimisticTimeout?: number;
  /** 前缀/后缀说明文案（点击可关联切换） */
  label?: React.ReactNode;
  /** 标签位置（默认 'start' 即前缀） */
  labelPlacement?: 'start' | 'end';
  /** 无 label 时的屏幕阅读器命名 */
  'aria-label'?: string;
  /** 自定义类名（仅用于外部布局与间距微调） */
  className?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  function Switch(
    {
      checked: externalChecked,
      defaultChecked = false,
      onCheckedChange,
      size = 'md',
      loading = false,
      disabled = false,
      optimistic = true,
      optimisticTimeout = 5000,
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

    // 1. 受控 / 非受控基础模式判定
    const isControlled = externalChecked !== undefined;
    const [internalChecked, setInternalChecked] = useState(defaultChecked);

    // 2. 0ms 乐观状态机：null 表示与权威真源对齐；boolean 表示处于未决乐观过渡态
    const [optimisticChecked, setOptimisticChecked] = useState<boolean | null>(
      null
    );

    // 3. 计算最终呈现状态（Effective Checked State）
    const isOptimisticActive =
      isControlled && optimistic && optimisticChecked !== null;
    const checked = isOptimisticActive
      ? optimisticChecked
      : isControlled
        ? Boolean(externalChecked)
        : internalChecked;

    // 4. 动画守卫：防止挂载初次渲染时误触发过渡动画（Zero-FOUC 铁律）
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

    // 5. 受控真源同步与超时回滚防死锁计时器
    const prevExternalCheckedRef = useRef(externalChecked);
    const rollbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearRollbackTimer = useCallback(() => {
      if (rollbackTimerRef.current !== null) {
        clearTimeout(rollbackTimerRef.current);
        rollbackTimerRef.current = null;
      }
    }, []);

    const startRollbackTimer = useCallback(() => {
      clearRollbackTimer();
      if (optimisticTimeout > 0) {
        rollbackTimerRef.current = setTimeout(() => {
          // 超时触发安全回滚，防止外部未重渲染造成永久悬空死锁
          setOptimisticChecked(null);
          rollbackTimerRef.current = null;
        }, optimisticTimeout);
      }
    }, [clearRollbackTimer, optimisticTimeout]);

    // 外部受控真源发生变更时：权威收敛，清除乐观标记与定时器
    useEffect(() => {
      if (!isControlled) return;
      if (externalChecked !== prevExternalCheckedRef.current) {
        prevExternalCheckedRef.current = externalChecked;
        clearRollbackTimer();
        setOptimisticChecked(null);
      }
    }, [externalChecked, isControlled, clearRollbackTimer]);

    // 组件卸载时释放定时器
    useEffect(() => {
      return () => {
        clearRollbackTimer();
      };
    }, [clearRollbackTimer]);

    const isInteractive = !disabled && !loading;

    // 6. 核心切换状态机算子
    const handleToggle = useCallback(() => {
      if (!isInteractive) return;

      // 激活动态拉伸动画关键帧
      setHasInteracted(true);

      const nextChecked = !checked;

      // 非受控模式：直接更新本地内部状态并上报
      if (!isControlled) {
        setInternalChecked(nextChecked);
        onCheckedChange?.(nextChecked);
        return;
      }

      // 受控模式：若显式禁用了乐观更新，退回严格受控旁路
      if (!optimistic) {
        onCheckedChange?.(nextChecked);
        return;
      }

      // 0ms 乐观响应算子：
      // 若点击后的目标值与当前外部受控值已经一致（例如偶数次狂点回原点），直接清除乐观标记
      if (nextChecked === Boolean(externalChecked)) {
        clearRollbackTimer();
        setOptimisticChecked(null);
      } else {
        setOptimisticChecked(nextChecked);
        startRollbackTimer();
      }

      // 触发外部回调，并接入同步异常与异步 Promise Rejection 回滚守护
      try {
        const maybePromise = onCheckedChange?.(nextChecked);
        if (
          maybePromise &&
          typeof (maybePromise as Promise<unknown>).then === 'function'
        ) {
          (maybePromise as Promise<unknown>).catch(() => {
            // 异步操作失败，安全回滚
            clearRollbackTimer();
            setOptimisticChecked(null);
          });
        }
      } catch {
        // 同步操作抛错，安全回滚
        clearRollbackTimer();
        setOptimisticChecked(null);
      }
    }, [
      isInteractive,
      checked,
      isControlled,
      optimistic,
      externalChecked,
      clearRollbackTimer,
      startRollbackTimer,
      onCheckedChange,
    ]);

    // 7. 键盘交互与 IME 输入法组合态守卫
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
        data-state={checked ? 'checked' : 'unchecked'}
        data-size={size}
        {...restProps}
        // 内部状态机恒为权威：置于 restProps 之后，外部注入的 onClick/onKeyDown
        // 只能叠加不可覆盖（Tooltip clone 注入曾借此路径吞掉点击链）
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
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
                strokeWidth={ICON_STROKE.ui}
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
  }
);

Switch.displayName = 'Switch';
