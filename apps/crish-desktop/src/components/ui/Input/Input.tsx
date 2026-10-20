/**
 * ui/Input 原子输入组件（PE-05 / RED-DETAILED-02）
 *
 * 遵循同心几何标尺与四档标准化尺寸矩阵（24/28/32/40px），
 * 装配 IME 组合输入守卫状态机（拦截拼音/日文回车提前提交），
 * 落实柔和 Focus Ring（加深混入严格控制在 3%~10%）。
 *
 * 分层契约：本组件只依赖 react 与 tokens CSS 变量，不依赖任何业务模块。
 */
import React, { useId, useRef, useState } from 'react';
import styles from './Input.module.css';
import { ICON_STROKE } from '../icons/iconTokens';

export type InputVariant = 'text' | 'search' | 'password' | 'default';
export type InputSize = 'xs' | 'sm' | 'md' | 'lg';

export interface InputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'size' | 'prefix'
> {
  /** 视觉型别：search 增加放大镜前缀位；password 内置明文切换；default/text 普通输入 */
  variant?: InputVariant;
  /** 尺寸：xs(24px) / sm(28px) / md(32px) / lg(40px) */
  size?: InputSize;
  /** 字段标签（渲染 <label>，自动关联 input id） */
  label?: React.ReactNode;
  /** 辅助说明文案（aria-describedby 关联） */
  hint?: React.ReactNode;
  /** 校验错误文案（aria-invalid + aria-describedby 关联） */
  error?: React.ReactNode;
  /** 可清空：受控 value 非空时显示清空按钮，触发原生 input 事件或 onClear 回调 */
  clearable?: boolean;
  /** 清空回调 */
  onClear?: () => void;
  /** 前缀图标位（置于输入框左侧） */
  prefixIcon?: React.ReactNode;
  /** 后缀插槽（置于右侧，清空/密码切换之前） */
  suffix?: React.ReactNode;
  /** 回车提交回调（受 IME 组合输入锁保护，拼音选词回车不触发） */
  onEnter?: (value: string) => void;
  /** 裸核心模式（不应用外部 wrapper/container，专供隐藏文件输入框或就地编辑场景） */
  bare?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input(
    {
      variant = 'text',
      size = 'md',
      label,
      hint,
      error,
      clearable = false,
      bare = false,
      onClear,
      prefixIcon,
      suffix,
      id,
      className,
      value,
      defaultValue,
      disabled,
      readOnly,
      onChange,
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
      onEnter,
      'aria-describedby': ariaDescribedBy,
      role,
      ...restProps
    },
    ref
  ) {
    const autoId = useId();
    const inputId = id ?? `ui-input-${autoId}`;
    const errorId = `ui-input-error-${autoId}`;
    const hintId = `ui-input-hint-${autoId}`;

    const internalInputRef = useRef<HTMLInputElement | null>(null);

    const setCombinedRef = (node: HTMLInputElement | null) => {
      internalInputRef.current = node;
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref && 'current' in ref) {
        (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
      }
    };

    // IME 输入法合成状态锁
    const isComposingRef = useRef(false);

    const handleCompositionStart = (
      e: React.CompositionEvent<HTMLInputElement>
    ) => {
      isComposingRef.current = true;
      onCompositionStart?.(e);
    };

    const handleCompositionEnd = (
      e: React.CompositionEvent<HTMLInputElement>
    ) => {
      isComposingRef.current = false;
      onCompositionEnd?.(e);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      // 关键拦截：输入法合成中、原生 isComposing 为真、或 keyCode 为 229 / Key 为 Process 时，丢弃回车提交
      if (
        isComposingRef.current ||
        e.nativeEvent.isComposing ||
        e.keyCode === 229 ||
        e.key === 'Process'
      ) {
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        onEnter?.((e.currentTarget as HTMLInputElement).value);
      }
    };

    // 受控/非受控值形态与 password 明文切换状态：必须声明在任何 early return 之前，
    // 保证同一实例的 bare 由 false→true→false 切换时 Hook 调用数量与顺序恒定（RUN-01）。
    const [uncontrolledHasValue, setUncontrolledHasValue] = useState<boolean>(
      () => {
        if (defaultValue !== undefined && defaultValue !== null) {
          return String(defaultValue).length > 0;
        }
        return false;
      }
    );
    const [showPassword, setShowPassword] = useState(false);

    if (bare) {
      return (
        <input
          ref={setCombinedRef}
          id={id}
          className={className}
          value={value}
          defaultValue={defaultValue}
          disabled={disabled}
          readOnly={readOnly}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          role={role}
          {...restProps}
        />
      );
    }

    const isControlled = value !== undefined;

    const hasValue = isControlled
      ? value !== null && String(value).length > 0
      : uncontrolledHasValue;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!isControlled) {
        setUncontrolledHasValue(e.target.value.length > 0);
      }
      onChange?.(e);
    };

    const handleClear = () => {
      onClear?.();
      const inputEl = internalInputRef.current;
      if (inputEl) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )?.set;
        valueSetter?.call(inputEl, '');
        const event = new InputEvent('input', {
          bubbles: true,
          cancelable: true,
        });
        inputEl.dispatchEvent(event);
        const changeEvent = new Event('change', { bubbles: true });
        inputEl.dispatchEvent(changeEvent);
      }
      if (!isControlled) {
        setUncontrolledHasValue(false);
      }
    };

    // search 不用 type=search：WebView2 会画 Windows 原生白框/清除钮。
    // 语义改走 role=searchbox；外观由 Input.module.css appearance:none 接管。
    const inputType =
      variant === 'password'
        ? showPassword
          ? 'text'
          : 'password'
        : variant === 'search'
          ? 'text'
          : (restProps.type ?? 'text');
    const inputRole = variant === 'search' ? 'searchbox' : role;

    const describedBy =
      [error ? errorId : null, hint ? hintId : null, ariaDescribedBy ?? null]
        .filter(Boolean)
        .join(' ') || undefined;

    const sizeClassMap: Record<InputSize, string | undefined> = {
      xs: styles.inputWrapXs,
      sm: styles.inputWrapSm,
      md: styles.inputWrapMd,
      lg: styles.inputWrapLg,
    };

    const inputSizeClassMap: Record<InputSize, string | undefined> = {
      xs: styles.inputXs,
      sm: styles.inputSm,
      md: styles.inputMd,
      lg: styles.inputLg,
    };

    const wrapClasses = [
      styles.inputWrap,
      sizeClassMap[size],
      error ? styles.inputWrapError : null,
      disabled ? styles.inputWrapDisabled : null,
    ]
      .filter(Boolean)
      .join(' ');

    const inputClasses = [
      styles.input,
      inputSizeClassMap[size],
      variant === 'search' ? styles.inputSearch : null,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div className={wrapClasses} data-size={size} data-variant={variant}>
        {label != null ? (
          <label className={styles.inputLabel} htmlFor={inputId}>
            {label}
          </label>
        ) : null}

        <div className={styles.inputShell}>
          {prefixIcon != null ? (
            <span className={styles.inputPrefix} aria-hidden="true">
              {prefixIcon}
            </span>
          ) : null}

          <input
            ref={setCombinedRef}
            id={inputId}
            className={`${inputClasses}${className ? ` ${className}` : ''}`}
            value={value}
            defaultValue={defaultValue}
            disabled={disabled}
            readOnly={readOnly}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            {...restProps}
            type={inputType}
            role={inputRole}
          />

          {suffix != null ? (
            <span className={styles.inputSuffix}>{suffix}</span>
          ) : null}

          {variant === 'password' && !disabled && !readOnly ? (
            <button
              type="button"
              className={styles.inputAction}
              aria-label={showPassword ? '隐藏密码' : '显示密码'}
              aria-pressed={showPassword}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setShowPassword((prev) => !prev)}
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          ) : null}

          {clearable && hasValue && !disabled && !readOnly ? (
            <button
              type="button"
              className={styles.inputAction}
              aria-label="清空输入"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleClear}
            >
              <ClearIcon />
            </button>
          ) : null}
        </div>

        {error != null ? (
          <p className={styles.inputError} id={errorId}>
            {error}
          </p>
        ) : null}
        {hint != null ? (
          <p className={styles.inputHint} id={hintId}>
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);
Input.displayName = 'Input';

/* 内联 SVG 图标：ui 层不引入额外依赖 */
function EyeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE.ui}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE.ui}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 8 10 8a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg
      width="12"
      height="12"
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
  );
}
