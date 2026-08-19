/**
 * ui/Switch 原子开关组件（T-C 批次 5.2 · T11）
 *
 * 收敛 settings 域手写开关（settings-switch 全局类 checkbox 与 aria-pressed
 * 切换按钮）的统一落点：role="switch" + aria-checked + 键盘 Space/Enter 切换。
 *
 * 分层契约：只依赖 react 与 tokens CSS 变量；thumb 平移走 --easing-enter（无过冲），
 * 圆角走 --radius-full，不写死数值（对齐 ui/ 原子层样式规范）。
 *
 * 受控/非受控双模（对齐 ui/Menu、ui/Select 惯例）：
 * - 传 checked 即受控：状态由父层持有，变更经 onCheckedChange 上报；
 * - 不传 checked 传 defaultChecked 即非受控：内部自管初始值，变更仍上报。
 *
 * 扩展点：
 * - 新增形态：先扩 SwitchSize 联合类型，再全量对齐 CSS Modules（穷举而非开放字符串）；
 * - className 覆盖只允许布局类（间距/尺寸微调），颜色/背景语义归 tokens；
 * - label 插槽承载前缀说明文案（点击 label 亦切换，内部以 htmlFor 关联）。
 *
 * 不支持的场景：
 * - 三段式/多态开关：用 Radio 组或 Select，不扩 prop；
 * - 开关组整体校验：表单层职责（error 展示在表单域组件）；
 * - 视觉皮肤变体：颜色语义归 tokens，不做 variant 皮肤。
 */
import React, { forwardRef, useCallback, useId, useState } from 'react';
import styles from './Switch.module.css';

export type SwitchSize = 'sm' | 'md';

export interface SwitchProps {
  /** 受控选中态（与 defaultChecked 互斥使用） */
  checked?: boolean;
  /** 非受控初始选中态（与 checked 互斥使用） */
  defaultChecked?: boolean;
  /** 选中变更回调（受控/非受控双模统一出口） */
  onCheckedChange?: (checked: boolean) => void;
  /** 前缀说明文案（渲染于开关左侧，点击可切换） */
  label?: React.ReactNode;
  /** 无 label 时的无障碍命名（Screen Reader 播报名） */
  'aria-label'?: string;
  /** 禁用态：不可聚焦、不响应切换 */
  disabled?: boolean;
  /** 尺寸：sm 对齐 control-height-sm，md 对齐 control-height */
  size?: SwitchSize;
  /** 开关控件 id（供外部 <label htmlFor> 关联，如设置行标题） */
  id?: string;
  /** 布局微调类（只允许间距/尺寸类，禁止颜色语义覆盖） */
  className?: string;
}

/**
 * 开关控件本体：button + role="switch"（原生按钮自带聚焦环与激活语义；
 * Space/Enter 显式接管并 preventDefault，避免 jsdom 无原生激活导致的双通道差异）。
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    checked: externalChecked,
    defaultChecked = false,
    onCheckedChange,
    label,
    disabled = false,
    size = 'md',
    id,
    className,
    'aria-label': ariaLabel,
    ...restProps
  },
  ref
) {
  const autoId = useId();
  const switchId = id ?? `ui-switch-${autoId}`;
  const [internalChecked, setInternalChecked] = useState(defaultChecked);
  const isControlled = externalChecked !== undefined;
  const checked = isControlled ? Boolean(externalChecked) : internalChecked;

  const handleToggle = useCallback(() => {
    if (disabled) return;
    const next = !checked;
    if (!isControlled) setInternalChecked(next);
    onCheckedChange?.(next);
  }, [checked, disabled, isControlled, onCheckedChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      handleToggle();
    },
    [handleToggle]
  );

  const trackClasses = [
    styles.track,
    size === 'sm' ? styles.trackSm : null,
    disabled ? styles.trackDisabled : null,
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
      aria-label={ariaLabel}
      disabled={disabled}
      className={trackClasses}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      data-size={size}
      {...restProps}
    >
      <span className={styles.thumb} aria-hidden />
    </button>
  );

  if (label == null) return control;

  return (
    <span className={styles.labelWrap}>
      <label htmlFor={switchId} className={styles.label}>
        {label}
      </label>
      {control}
    </span>
  );
});

Switch.displayName = 'Switch';
