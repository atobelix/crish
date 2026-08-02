import React, { useCallback, useRef, useState } from 'react';

export interface VirtualListProps<T> {
  items: readonly T[];
  itemHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  overscan?: number;
  className?: string;
  onScroll?: (scrollTop: number) => void;
}

export function computeVisibleRange<T>(
  items: readonly T[],
  scrollTop: number,
  containerHeight: number,
  itemHeight: number,
  overscan: number,
): [start: number, end: number] {
  if (items.length === 0 || containerHeight <= 0) return [0, 0];
  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const end = Math.min(
    items.length,
    Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan,
  );
  return [start, end];
}

export function VirtualList<T>({
  items,
  itemHeight,
  renderItem,
  overscan = 10,
  className,
  onScroll,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const st = el.scrollTop;
    setScrollTop(st);
    onScroll?.(st);
  }, [onScroll]);

  const handleRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      if (!node) return;
      const h = node.clientHeight;
      if (h !== containerHeight) setContainerHeight(h);
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const ch = entry.contentBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          if (ch !== containerHeight) setContainerHeight(ch);
        }
      });
      ro.observe(node);
      return () => ro.disconnect();
    },
    [containerHeight],
  );

  const totalHeight = items.length * itemHeight;
  const [start, end] = computeVisibleRange(items, scrollTop, containerHeight, itemHeight, overscan);
  const visibleItems: React.ReactNode[] = [];

  for (let i = start; i < end; i++) {
    visibleItems.push(
      <div
        key={i}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: itemHeight,
          transform: `translateY(${i * itemHeight}px)`,
        }}
      >
        {renderItem(items[i]!, i)}
      </div>,
    );
  }

  return (
    <div
      ref={handleRef}
      className={className}
      onScroll={handleScroll}
      style={{
        overflowY: 'auto',
        overflowX: 'hidden',
        position: 'relative',
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        style={{
          height: totalHeight,
          position: 'relative',
          minHeight: '100%',
        }}
      >
        {visibleItems}
      </div>
    </div>
  );
}
