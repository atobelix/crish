/**
 * ui/Input 原子输入组件（PE-05 T05.1.6）
 *
 * 收敛全局 `.settings-field-input` 与各 module 私有输入类的语义：
 * text/search/password 三型、label/hint/error 三文案位、clearable 清空。
 * 供 FirstRunWizard/SettingsRulesTab 等首批迁移（T05.1.6 动作 2）。
 *
 * 分层契约：本组件只依赖 react 与 tokens CSS 变量，不依赖任何业务模块。
 */
import React, { useId, useState } from 'react';
import styles from './Input.module.css';

export type InputVariant = 'text' | 'search' | 'password';
export type InputSize = 'sm' | 'md';

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  /** 视觉型别：search 增加放大镜前缀位；password 内置明文切换 */
  variant?: InputVariant;
  /** 尺寸：sm 对齐 control-height-sm，md 对齐 control-height */
  size?: InputSize;
  /** 字段标签（渲染 <label>，自动关联 input id） */
  label?: React.ReactNode;
  /** 辅助说明文案（aria-describedby 关联） */
  hint?: React.ReactNode;
  /** 校验错误文案（aria-invalid + aria-describedby 关联） */
  error?: React.ReactNode;
  /** 可清空：受控 value 非空时显示清空按钮，触发 onChange('') */
  clearable?: boolean;
  /** 前缀图标位（置于输入框左侧） */
  prefixIcon?: React.ReactNode;
  /** 后缀插槽（置于右侧，清空/密码切换之前） */
  suffix?: React.ReactNode;
}

/**
 * 受控清空：以合成 ChangeEvent 调 onChange('')，
 * 与 React 受控组件语义一致（value 由父层持有）。
 */
function clearValueEvent(): React.ChangeEvent<HTMLInputElement> {
  return {
    target: { value: '' },
    currentTarget: { value: '' },
  } as unknown as React.ChangeEvent<HTMLInputElement>;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    variant = 'text',
    size = 'md',
    label,
    hint,
    error,
    clearable = false,
    prefixIcon,
    suffix,
    id,
    className,
    value,
    defaultValue,
    disabled,
    readOnly,
    onChange,
    'aria-describedby': ariaDescribedBy,
    ...restProps
  },
  ref
) {
  const autoId = useId();
  const inputId = id ?? `ui-input-${autoId}`;
  const errorId = `ui-input-error-${autoId}`;
  const hintId = `ui-input-hint-${autoId}`;

  // password 型别的明文切换状态
  const [showPassword, setShowPassword] = useState(false);
  const inputType =
    variant === 'password' ? (showPassword ? 'text' : 'password') : variant === 'search' ? 'search' : 'text';

  // clearable 需要受控 value 才能判断是否显示清空按钮
  const isControlled = value !== undefined;
  const hasValue = isControlled ? String(value).length > 0 : defaultValue !== undefined && String(defaultValue).length > 0;

  const describedBy = [error ? errorId : null, hint ? hintId : null, ariaDescribedBy ?? null]
    .filter(Boolean)
    .join(' ') || undefined;

  const wrapClasses = [
    styles.inputWrap,
    size === 'sm' ? styles.inputWrapSm : null,
    error ? styles.inputWrapError : null,
    disabled ? styles.inputWrapDisabled : null,
  ]
    .filter(Boolean)
    .join(' ');

  const inputClasses = [
    styles.input,
    size === 'sm' ? styles.inputSm : null,
    variant === 'search' ? styles.inputSearch : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapClasses}>
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
          ref={ref}
          id={inputId}
          className={`${inputClasses}${className ? ` ${className}` : ''}`}
          type={inputType}
          value={value}
          defaultValue={defaultValue}
          disabled={disabled}
          readOnly={readOnly}
          onChange={onChange}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...restProps}
        />

        {suffix != null ? <span className={styles.inputSuffix}>{suffix}</span> : null}

        {variant === 'password' && !disabled && !readOnly ? (
          <button
            type="button"
            className={styles.inputAction}
            aria-label={showPassword ? '隐藏密码' : '显示密码'}
            aria-pressed={showPassword}
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
            onClick={() => onChange?.(clearValueEvent())}
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
});
Input.displayName = 'Input';

/* 内联 SVG 图标：ui 层不引入额外依赖（lucide 不属原子层白名单） */
function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 8 10 8a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
