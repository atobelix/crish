/**
 * ui/Textarea 原子多行文本输入组件（PE-05 / RED-DETAILED-02）
 *
 * 接入现代 CSS `field-sizing: content` 零 JS 回流自适应高度，
 * 装配 IME 组合输入守卫状态机（彻底拦截拼音/日文回车提前提交），
 * 落实柔和 Focus Ring（加深混入严格控制在 3%~10%）。
 *
 * 分层契约：本组件只依赖 react 与 tokens CSS 变量，不依赖任何业务模块。
 */
import React, { useId, useRef } from 'react';
import styles from './Textarea.module.css';

export type TextareaSize = 'sm' | 'md' | 'lg';

export interface TextareaProps extends Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'size'
> {
  /** 尺寸：sm(紧凑) / md(标准) / lg(突出) */
  size?: TextareaSize;
  /** 字段标签（渲染 <label>，自动关联 textarea id） */
  label?: React.ReactNode;
  /** 辅助说明文案（aria-describedby 关联） */
  hint?: React.ReactNode;
  /** 校验错误文案（aria-invalid + aria-describedby 关联） */
  error?: React.ReactNode;
  /** 回车提交回调（受 IME 组合输入锁保护，拼音选词回车不触发；按 Enter 且不按 Shift 时触发） */
  onEnter?: (value: string) => void;
  /** 自定义最大高度（超出滚动） */
  maxHeight?: number | string;
  /** 裸核心模式（不渲染外层 wrap/shell/label/hint 装饰，保留 IME 守卫与属性透传，专供代码编辑器等复杂舞台） */
  bare?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    {
      size = 'md',
      label,
      hint,
      error,
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
      maxHeight,
      bare = false,
      style,
      'aria-describedby': ariaDescribedBy,
      ...restProps
    },
    ref
  ) {
    const autoId = useId();
    const textareaId = id ?? `ui-textarea-${autoId}`;
    const errorId = `ui-textarea-error-${autoId}`;
    const hintId = `ui-textarea-hint-${autoId}`;

    // IME 输入法合成状态锁
    const isComposingRef = useRef(false);

    const handleCompositionStart = (
      e: React.CompositionEvent<HTMLTextAreaElement>
    ) => {
      isComposingRef.current = true;
      onCompositionStart?.(e);
    };

    const handleCompositionEnd = (
      e: React.CompositionEvent<HTMLTextAreaElement>
    ) => {
      isComposingRef.current = false;
      onCompositionEnd?.(e);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(e);
      // 关键拦截：输入法合成中、原生 isComposing 为真、或 keyCode 为 229 / Key 为 Process 时，丢弃回车提交
      if (
        isComposingRef.current ||
        e.nativeEvent.isComposing ||
        e.keyCode === 229 ||
        e.key === 'Process'
      ) {
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && onEnter) {
        e.preventDefault();
        onEnter((e.currentTarget as HTMLTextAreaElement).value);
      }
    };

    const describedBy =
      [error ? errorId : null, hint ? hintId : null, ariaDescribedBy ?? null]
        .filter(Boolean)
        .join(' ') || undefined;

    const wrapClasses = [
      styles.textareaWrap,
      size === 'sm' ? styles.textareaWrapSm : null,
      size === 'lg' ? styles.textareaWrapLg : null,
      error ? styles.textareaWrapError : null,
      disabled ? styles.textareaWrapDisabled : null,
    ]
      .filter(Boolean)
      .join(' ');

    const textareaClasses = [
      styles.nativeTextarea,
      size === 'sm' ? styles.textareaSm : null,
      size === 'lg' ? styles.textareaLg : null,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const resolvedStyle: React.CSSProperties = {
      ...(maxHeight != null
        ? {
            maxHeight:
              typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight,
          }
        : {}),
      ...style,
    };

    if (bare) {
      return (
        <textarea
          ref={ref}
          id={id ?? textareaId}
          className={className}
          value={value}
          defaultValue={defaultValue}
          disabled={disabled}
          readOnly={readOnly}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          style={resolvedStyle}
          {...restProps}
        />
      );
    }

    return (
      <div className={wrapClasses} data-size={size}>
        {label != null ? (
          <label className={styles.textareaLabel} htmlFor={textareaId}>
            {label}
          </label>
        ) : null}

        <div className={styles.textareaShell}>
          <textarea
            ref={ref}
            id={textareaId}
            className={textareaClasses}
            value={value}
            defaultValue={defaultValue}
            disabled={disabled}
            readOnly={readOnly}
            onChange={onChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            style={resolvedStyle}
            {...restProps}
          />
        </div>

        {error != null ? (
          <p className={styles.textareaError} id={errorId}>
            {error}
          </p>
        ) : null}
        {hint != null ? (
          <p className={styles.textareaHint} id={hintId}>
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);
Textarea.displayName = 'Textarea';
