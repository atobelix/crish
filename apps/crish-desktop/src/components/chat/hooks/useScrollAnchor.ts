import { useEffect, useLayoutEffect, useRef } from 'react';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';

export function useScrollAnchor(
  enableVirtualization: boolean,
  visibleMessages: unknown[],
  containerRef: React.RefObject<HTMLDivElement | null>,
  manager: VirtualScrollManager,
  setActual: (index: number, height: number) => void,
  clearHeights: () => void,
  messageWindowStartIndex: number,
) {
  useLayoutEffect(() => {
    clearHeights();
  }, [messageWindowStartIndex, clearHeights]);

  const roRef = useRef<ResizeObserver | null>(null);
  const observedRowsRef = useRef<Set<Element>>(new Set());
  useLayoutEffect(() => {
    if (!enableVirtualization) {
      observedRowsRef.current.clear();
      roRef.current?.disconnect();
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    if (!roRef.current) {
      roRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const vindex = el.dataset.vindex;
          if (vindex != null && entry.contentRect.height > 0) {
            setActual(Number(vindex), entry.contentRect.height);
          }
        }
      });
    }
    const ro = roRef.current;
    const observed = observedRowsRef.current;
    const current = new Set<Element>(
      Array.from(container.querySelectorAll('[data-vindex]'))
    );
    for (const row of current) {
      if (!observed.has(row)) {
        ro.observe(row);
        observed.add(row);
      }
    }
    for (const row of observed) {
      if (!current.has(row)) {
        ro.unobserve(row);
        observed.delete(row);
      }
    }
  }, [enableVirtualization, visibleMessages, containerRef, setActual]);

  useEffect(() => {
    return () => {
      roRef.current?.disconnect();
      roRef.current = null;
      observedRowsRef.current.clear();
    };
  }, []);
}
