/**
 * 动效 token 的 TS 侧镜像 —— 与 tokens.css 的 --duration-* / --ease-* 一一对应。
 *
 * 单一真理路径约束：
 * - 全仓组件禁止内联毫秒时长与 cubic-bezier 曲线字面量；JS 需要动效值时只允许
 *   从本模块取用，CSS 只允许从 tokens.css 取用；
 * - 两侧同步由 tabStripMotionContract 守卫测试锁定，改值必须两处同改（测试会拦截漂移）。
 */

/** 标准缓动：色彩 / 透明度 / 常规过渡（对应 --ease-standard） */
export const EASE_STANDARD = 'cubic-bezier(0.4, 0, 0.2, 1)';

/** 强调缓动：几何位移（flex-basis / transform / margin），快出型，服务光标追踪（对应 --ease-emphasized） */
export const EASE_EMPHASIZED = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** 微交互时长（对应 --duration-micro） */
export const DURATION_MICRO_MS = 100;

/** 爽快微交互时长（毫秒，对应 tokens.css 中的 --duration-snappy） */
export const DURATION_SNAPPY_MS = 120;

/** 快速几何时长（对应 --duration-fast） */
export const DURATION_FAST_MS = 150;

/** 常规时长（对应 --duration-normal） */
export const DURATION_NORMAL_MS = 200;

/** 手风琴折叠展开平滑过渡时长（对应 tokens.css 中 --transition-accordion 220ms） */
export const DURATION_ACCORDION_MS = 220;

/** 手风琴内部插槽渐隐/渐显时长（对应 tokens.css 中 --duration-accordion-fade 180ms） */
export const DURATION_ACCORDION_FADE_MS = 180;

/** 新对话落地框平滑变形过渡时长（对应 tokens.css 中 --transition-landing-settle 360ms） */
export const DURATION_LANDING_SETTLE_MS = 360;

/** 新对话落地品牌渐隐时长（对应 tokens.css 中 --duration-landing-fade 240ms） */
export const DURATION_LANDING_FADE_MS = 240;

/** 减速入场曲线（对应 tokens.css 中的 --ease-decelerate） */
export const EASE_DECELERATE = 'cubic-bezier(0.2, 0, 0, 1)';

/** 加速退场曲线（对应 tokens.css 中的 --ease-accelerate） */
export const EASE_ACCELERATE = 'cubic-bezier(0.4, 0, 1, 1)';

/** 消息发送入场时效守卫窗口常量（Batch 3 消息发送入场飞行专用） */
export const BUBBLE_ENTRANCE_WINDOW_MS = 2000;
export const BUBBLE_ENTRANCE_CLOCK_SKEW_TOLERANCE_MS = 500;

/** 动效时长常量单一真相源（与 tokens.css 严格同步） */
export const MOTION_DURATION = {
  MICRO_MS: DURATION_MICRO_MS,
  SNAPPY_MS: DURATION_SNAPPY_MS,
  FAST_MS: DURATION_FAST_MS,
  NORMAL_MS: DURATION_NORMAL_MS,
  ACCORDION_MS: DURATION_ACCORDION_MS,
  ACCORDION_FADE_MS: DURATION_ACCORDION_FADE_MS,
  LANDING_SETTLE_MS: DURATION_LANDING_SETTLE_MS,
  LANDING_FADE_MS: DURATION_LANDING_FADE_MS,
} as const;

/** 消息气泡入场时效配置单一真理源 */
export const BUBBLE_ENTRANCE_CONFIG = {
  MAX_AGE_MS: BUBBLE_ENTRANCE_WINDOW_MS,
  CLOCK_SKEW_TOLERANCE_MS: BUBBLE_ENTRANCE_CLOCK_SKEW_TOLERANCE_MS,
} as const;

/**
 * 读取元素上指定 transition 属性的真实时长（毫秒）。
 * 返回的是 computed 值，已包含 reduced-motion 全局覆盖后的实际效果；
 * 解析不到时返回 0，由调用方决定兜底。
 */
export function readTransitionMs(
  el: HTMLElement,
  propertyName: string
): number {
  const cs = getComputedStyle(el);
  const props = cs.transitionProperty.split(',').map((s) => s.trim());
  const durations = cs.transitionDuration.split(',').map((s) => {
    const trimmed = s.trim();
    const val = Number.parseFloat(trimmed) || 0;
    return trimmed.endsWith('ms') ? val : Math.round(val * 1000);
  });
  const idx = props.indexOf(propertyName);
  return idx >= 0 ? (durations[idx] ?? 0) : (durations[0] ?? 0);
}

/**
 * 读取 :root 上形如 "150ms cubic-bezier(...)" 的组合 token 的时长部分（毫秒）。
 * 解析不到返回 fallback。
 */
export function readTokenMs(varName: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  const m = /([\d.]+)(ms|s)\b/.exec(raw);
  if (!m) return fallback;
  const numStr = m[1];
  if (!numStr) return fallback;
  const n = Number.parseFloat(numStr);
  return m[2] === 's' ? n * 1000 : n;
}
