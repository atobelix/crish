/**
 * apps/crish-desktop/src/api/themeTransitionLatch.ts
 *
 * 生产级主题无感切换门闩 (Hardened Zero-Smear Transition Latch)
 * 解决重入竞争、启动空指针、异步 Promise 逃逸与全页面 Reflow 性能损耗。
 */

const LATCH_STYLE_ID = 'crish-theme-transition-freeze-latch';
const LATCH_CSS_RULE = `
  *,
  *::before,
  *::after {
    transition: none !important;
    animation-duration: 0s !important;
  }
`;

const DEADLOCK_TIMEOUT_MS = 1000;

let activeLatchCount = 0;
let rafHandle1: number | null = null;
let rafHandle2: number | null = null;
let deadlockTimeout: ReturnType<typeof setTimeout> | null = null;

function ensureLatchInjected(): void {
  if (typeof document === 'undefined') return;
  let styleEl = document.getElementById(LATCH_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = LATCH_STYLE_ID;
    styleEl.setAttribute('data-latch', 'theme-freeze');
    styleEl.appendChild(document.createTextNode(LATCH_CSS_RULE));
    (document.head || document.documentElement).appendChild(styleEl);
  }
}

function removeLatchElement(): void {
  if (typeof document === 'undefined') return;
  const latch = document.getElementById(LATCH_STYLE_ID);
  if (latch) {
    latch.remove();
  }
}

function clearDeadlockTimeout(): void {
  if (deadlockTimeout !== null) {
    clearTimeout(deadlockTimeout);
    deadlockTimeout = null;
  }
}

function scheduleLatchRemoval(): void {
  if (typeof window === 'undefined') return;

  if (typeof requestAnimationFrame !== 'function') {
    if (activeLatchCount <= 0) {
      removeLatchElement();
      activeLatchCount = 0;
      clearDeadlockTimeout();
    }
    return;
  }

  // 取消上一轮未完成的卸载定时器，防抖合并
  if (typeof cancelAnimationFrame === 'function') {
    if (rafHandle1 !== null) cancelAnimationFrame(rafHandle1);
    if (rafHandle2 !== null) cancelAnimationFrame(rafHandle2);
  }

  rafHandle1 = requestAnimationFrame(() => {
    rafHandle2 = requestAnimationFrame(() => {
      if (activeLatchCount <= 0) {
        removeLatchElement();
        activeLatchCount = 0;
        clearDeadlockTimeout();
      }
      rafHandle1 = null;
      rafHandle2 = null;
    });
  });
}

function flushComputedStyles(): void {
  if (typeof document === 'undefined') return;
  // 1. 安全回流：优先使用 documentElement，规避早期 document.body 为 null 的 NPE
  const root = document.documentElement || document.body;
  if (!root) return;

  // 2. 避免昂贵的全树几何 Reflow，仅触发计算样式重算 (Recalc Style)
  if (typeof window !== 'undefined' && window.getComputedStyle) {
    try {
      const _ = window.getComputedStyle(root).backgroundColor;
    } catch {
      /* swallow-ok: jsdom or mock context */
    }
  } else if ('offsetHeight' in root) {
    const _ = (root as HTMLElement).offsetHeight;
  }
}

export function withThemeTransitionFreeze<T>(fn: () => T): T {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return fn();
  }

  activeLatchCount++;
  ensureLatchInjected();

  // 设定防死锁超时保护：若异常或挂起超过 DEADLOCK_TIMEOUT_MS，强制安全拔除门闩
  if (deadlockTimeout === null) {
    deadlockTimeout = setTimeout(() => {
      activeLatchCount = 0;
      removeLatchElement();
      deadlockTimeout = null;
    }, DEADLOCK_TIMEOUT_MS);
  }

  let result: T;
  try {
    result = fn();
  } catch (error) {
    activeLatchCount--;
    scheduleLatchRemoval();
    throw error;
  }

  // 兼容异步 Promise 函数
  if (result instanceof Promise) {
    return (result as Promise<unknown>)
      .then((res) => {
        flushComputedStyles();
        return res;
      })
      .finally(() => {
        activeLatchCount--;
        scheduleLatchRemoval();
      }) as unknown as T;
  }

  flushComputedStyles();
  activeLatchCount--;
  scheduleLatchRemoval();

  return result;
}
