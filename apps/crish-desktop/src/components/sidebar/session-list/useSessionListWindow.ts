import { useEffect, useState } from 'react';
import {
  computeSessionListWindow,
  measureListOffsetTop,
  sessionListWindowRangeEqual,
  type HeightGetter,
  type SessionListWindowRange,
} from '../../../api/sessionListWindow';

export const FULL_RANGE = (count: number): SessionListWindowRange => ({
  start: 0,
  end: count,
  topPad: 0,
  bottomPad: 0,
  windowed: false,
});

/**
 * 轻量窗口化 hook：监听 scroll/resize，用 measureListOffsetTop 修正
 * 置顶/项目区占位导致的 scroll 偏移（否则 100+ 对话区错位）。
 * ensureIndex：活动会话下标始终挂载，避免窗口裁掉当前项。
 * getHeight：可变行高回调（Pretext 集成）。
 * 首帧 rAF 再测一次：listRef 可能在 count 变化后才挂到 DOM。
 */
export function useSessionListWindow(
  count: number,
  scrollParentRef: React.RefObject<HTMLElement | null>,
  listRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  ensureIndex: number | null = null,
  getHeight?: HeightGetter
): SessionListWindowRange {
  const [range, setRange] = useState<SessionListWindowRange>(() =>
    FULL_RANGE(count)
  );

  useEffect(() => {
    if (!enabled) {
      setRange(FULL_RANGE(count));
      return;
    }
    const scrollEl = scrollParentRef.current;
    if (!scrollEl) {
      setRange(
        computeSessionListWindow({
          count,
          scrollTop: 0,
          viewportHeight: 400,
          listOffsetTop: 0,
          ...(ensureIndex !== null ? { ensureIndex } : {}),
          ...(getHeight !== undefined ? { getHeight } : {}),
        })
      );
      return;
    }

    let raf = 0;
    const update = () => {
      const listEl = listRef.current;
      const listOffsetTop = listEl ? measureListOffsetTop(scrollEl, listEl) : 0;
      const next = computeSessionListWindow({
        count,
        scrollTop: scrollEl.scrollTop,
        viewportHeight: scrollEl.clientHeight || 400,
        listOffsetTop,
        ...(ensureIndex !== null ? { ensureIndex } : {}),
        ...(getHeight !== undefined ? { getHeight } : {}),
      });
      setRange((prev) =>
        sessionListWindowRangeEqual(prev, next) ? prev : next
      );
    };

    update();
    raf = requestAnimationFrame(() => {
      update();
    });
    scrollEl.addEventListener('scroll', update, { passive: true });
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(scrollEl);
    const listEl = listRef.current;
    if (listEl) ro?.observe(listEl);
    return () => {
      cancelAnimationFrame(raf);
      scrollEl.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [count, enabled, ensureIndex, scrollParentRef, listRef, getHeight]);

  return range;
}
