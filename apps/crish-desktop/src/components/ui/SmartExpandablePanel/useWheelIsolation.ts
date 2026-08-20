import { useEffect, type RefObject } from 'react';

/**
 * useWheelIsolation - 滚轮事件穿透隔离 Hook
 * 在滚动容器上挂载非 passive wheel 监听器，
 * 当滚动到达顶部或底部边界且继续向外滚动时阻止默认行为，
 * 彻底防止外部宿主窗口与 WebView2 页面晃动。
 */
export function useWheelIsolation(
  elementRef: RefObject<HTMLElement | null>,
  enabled = true
): void {
  useEffect(() => {
    const el = elementRef.current;
    if (!el || !enabled) return;

    const handleWheel = (e: WheelEvent) => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const deltaY = e.deltaY;

      const isAtTop = scrollTop <= 0;
      const isAtBottom = Math.ceil(scrollTop + clientHeight) >= scrollHeight - 1;

      if ((isAtTop && deltaY < 0) || (isAtBottom && deltaY > 0)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', handleWheel);
    };
  }, [elementRef, enabled]);
}
