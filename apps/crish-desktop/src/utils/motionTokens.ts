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

/** 快速几何时长（对应 --duration-fast） */
export const DURATION_FAST_MS = 150;

/** 常规时长（对应 --duration-normal） */
export const DURATION_NORMAL_MS = 200;

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
  const durations = cs.transitionDuration
    .split(',')
    .map((s) => {
      const trimmed = s.trim();
      const val = Number.parseFloat(trimmed) || 0;
      return trimmed.endsWith('ms') ? val : Math.round(val * 1000);
    });
  const idx = props.indexOf(propertyName);
  return idx >= 0 ? durations[idx] ?? 0 : durations[0] ?? 0;
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
