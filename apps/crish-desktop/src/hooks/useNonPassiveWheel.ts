/**
 * useNonPassiveWheel — 以原生非被动监听接管横向滚轮重定向。
 *
 * React 合成 onWheel 内调用 preventDefault 会触发「被动监听告警」类控制台噪音；
 * 本 hook 以 { passive: false } 原生挂载，事件回调拿到原生 WheelEvent，
 * 调用方在同一条路径里完成「判断方向 → 重定向 → preventDefault」。
 */

import { useEffect, type RefObject } from 'react';

export function useNonPassiveWheel(
  ref: RefObject<HTMLElement | null>,
  handler: (e: WheelEvent) => void
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener('wheel', handler, { passive: false });
    return () => {
      el.removeEventListener('wheel', handler);
    };
  }, [ref, handler]);
}
