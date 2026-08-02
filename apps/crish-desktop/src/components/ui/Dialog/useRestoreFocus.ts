/**
 * ui/Dialog 目录内私有焦点还原基元（PE-05 T05.1.3）
 *
 * 从 `hooks/useRestoreFocus.ts` 提炼：弹窗关闭后把焦点还原到触发打开的元素。
 */
import { useEffect, useRef } from 'react';

/**
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
