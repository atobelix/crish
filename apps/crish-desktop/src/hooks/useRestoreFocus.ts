import { useEffect, useRef } from 'react';

/**
 * useRestoreFocus：弹窗/浮层关闭后还原焦点到触发打开的元素。
 * @param active - true 时保存当前焦点元素，false 时还原
 */
function useRestoreFocus(active: boolean) {
  const savedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (active) {
      savedRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    } else if (savedRef.current) {
      if (document.body.contains(savedRef.current)) {
        savedRef.current.focus();
      }
      savedRef.current = null;
    }
  }, [active]);
}

export { useRestoreFocus };
