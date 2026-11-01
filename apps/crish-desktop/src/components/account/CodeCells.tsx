/**
 * 6 位验证码格：一个透明的数字输入框覆盖在 6 个视觉格上，
 * 天然支持键盘输入、退格、粘贴与系统一次性验证码自动填充；填满即回调 onComplete。
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Input } from '../ui';
import { ACCOUNT_CODE_LENGTH, normalizeCode } from './accountRules';
import styles from './accountControls.module.css';

interface CodeCellsProps {
  value: string;
  onChange: (code: string) => void;
  /** 填满 6 位时触发（输入或粘贴） */
  onComplete?: (code: string) => void;
  ariaLabel: string;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}

const CELL_INDEXES = Array.from({ length: ACCOUNT_CODE_LENGTH }, (_, i) => i);

export function CodeCells({
  value,
  onChange,
  onComplete,
  ariaLabel,
  invalid = false,
  disabled = false,
  autoFocus = false,
}: CodeCellsProps) {
  const [focused, setFocused] = useState(false);
  const activeIndex = value.length < ACCOUNT_CODE_LENGTH ? value.length : -1;
  const inputRef = useRef<HTMLInputElement>(null);

  // 自动聚焦补正：原生 autoFocus 只在挂载瞬间生效；若组件在挂载前后被置
  // disabled（如提交保存期间），浏览器会把已聚焦的 input 焦点丢回 body，
  // disabled 解除后也不会自己恢复。故在 disabled 解除时用 rAF 补一次 focus：
  // input 拿到焦点后 onFocus 置 focused，activeIndex（= value.length）
  // 对应的格子随即亮起并显示品牌色光标。
  // 注：改密页的自动发码不禁用本组件（禁用会把进页聚焦绑架给发码时序），
  // 进页聚焦走原生 autoFocus + 本 effect 的挂载首跑即可稳定落焦。
  useEffect(() => {
    if (!autoFocus || disabled) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [autoFocus, disabled]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = normalizeCode(event.target.value);
    if (next === value) return;
    onChange(next);
    if (next.length === ACCOUNT_CODE_LENGTH) onComplete?.(next);
  };

  const handleContainerClick = () => {
    inputRef.current?.focus();
  };

  return (
    <div
      className={styles.cells}
      data-invalid={invalid ? 'true' : undefined}
      onClick={handleContainerClick}
    >
      {CELL_INDEXES.map((index) => {
        const char = value[index] ?? '';
        const active = focused && index === activeIndex;
        const state = active ? 'active' : char ? 'filled' : 'empty';
        return (
          <div
            key={index}
            className={styles.cell}
            data-state={state}
            aria-hidden="true"
          >
            {char}
            {active ? <span className={styles.caret} /> : null}
          </div>
        );
      })}
      <Input
        ref={inputRef}
        bare
        className={styles.cellsInput}
        value={value}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={ACCOUNT_CODE_LENGTH}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        autoFocus={autoFocus}
        spellCheck={false}
      />
    </div>
  );
}
