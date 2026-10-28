import type { CSSProperties } from 'react';

export type FormattedPart =
  | { type: 'digit'; key: string; digit: number; order: number }
  | { type: 'symbol'; key: string; text: string };

export interface AnimatedCounterProps {
  /** 目标数值 */
  value: number;
  /** 可选顶部标签（切换时伴随微动效） */
  label?: string;
  /** 前缀符号（如 "¥", "$", "+"） */
  prefix?: string;
  /** 后缀符号（如 "tokens", "%", "CNY"） */
  suffix?: string;
  /** 小数保留位数，默认 0 */
  decimals?: number;
  /** 格式化区域，默认 'en-US' */
  locale?: string;
  /** 是否在滚动进入视口时才触发滚轮入场动效，默认 false */
  animateOnView?: boolean;
  /** 是否为流式模式（自动配合轻量更新） */
  isStreaming?: boolean;
  /** 是否强制直接显示终值，跳过滚轮（适用于极端省电档） */
  disabled?: boolean;
  /** 自定义样式类名 */
  className?: string;
  /** 内联样式 */
  style?: CSSProperties;
}

export interface SlotTextProps {
  /** 待展示的文本或数值 */
  value: string | number;
  /** 数值格式化函数，默认 toLocaleString('en-US') */
  format?: (value: number) => string;
  /** 基础转动持续时间（秒），默认 0.8 */
  duration?: number;
  /** 逐列停止交错步长（秒），默认 0.04 */
  stagger?: number;
  /** 额外空转圈数，默认 0 */
  spins?: number;
  /** 增减位数对齐基准（'start' | 'end'），数字默认 'end' */
  align?: 'start' | 'end';
  /** 无障碍屏幕阅读器朗读，默认 false */
  announce?: boolean;
  className?: string;
  style?: CSSProperties;
}
