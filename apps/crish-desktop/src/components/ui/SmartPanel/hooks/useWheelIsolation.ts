import { useEffect } from 'react';
import type { RefObject } from 'react';

/** Non-passive wheel event isolation to prevent background scroll chaining */
export function useWheelIsolation(listRef: RefObject<HTMLElement | null>, isOpen: boolean): void {
  useEffect(() => {
    const listEl = listRef.current;
    if (!listEl || !isOpen) return;

    const handleWheel = (e: WheelEvent) => {
      const { scrollTop, scrollHeight, clientHeight } = listEl;
      const atTop = scrollTop <= 0 && e.deltaY < 0;
      const atBottom = scrollTop + clientHeight >= scrollHeight - 1 && e.deltaY > 0;
      if (atTop || atBottom) {
        e.preventDefault();
      }
    };

    listEl.addEventListener('wheel', handleWheel, { passive: false });
    return () => listEl.removeEventListener('wheel', handleWheel);
  }, [listRef, isOpen]);
}
