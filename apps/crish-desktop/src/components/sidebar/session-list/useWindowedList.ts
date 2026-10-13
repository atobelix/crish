import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { SessionState } from '../../../store/types';
import {
  SIDEBAR_SESSION_ROW_HEIGHT,
  clampSessionListWindowRange,
  expandWindowToIndex,
  measureListOffsetTop,
  scrollTopToRevealIndex,
  shouldWindowSessionList,
  windowContainsIndex,
  type HeightGetter,
} from '../../../api/sessionListWindow';
import {
  FULL_RANGE,
  MAX_SIDEBAR_WINDOW_ROWS,
  resolveActualScrollHost,
  useSessionListWindow,
} from './useSessionListWindow';

/**
 * 列表窗口化 hook（03-detail T10 拆分：useWindowedList）。
 * 固定行高 + 窗口 range 切片 + 活跃项滚入视口。
 */
export function useWindowedList({
  visibleSessions,
  generalSessions,
  generalCollapsed,
  filterType,
  isSearching,
  isDragging,
  activeSessionId,
  activeGeneralIndex,
  sessionListRef,
  generalListRef,
  scrollHostRef,
}: {
  visibleSessions: SessionState[];
  generalSessions: SessionState[];
  generalCollapsed: boolean;
  filterType: 'all' | 'pinned';
  isSearching: boolean;
  isDragging: boolean;
  activeSessionId: string | null;
  activeGeneralIndex: number | null;
  sessionListRef: React.RefObject<HTMLDivElement | null>;
  generalListRef: React.RefObject<HTMLUListElement | null>;
  scrollHostRef?: React.RefObject<HTMLElement | null>;
}) {
  // 固定单行高度，禁止按标题测量成两行
  const rowHeightById = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of visibleSessions) {
      map.set(s.id, SIDEBAR_SESSION_ROW_HEIGHT);
    }
    return map;
  }, [visibleSessions]);

  const defaultRowHeight = SIDEBAR_SESSION_ROW_HEIGHT;

  const getGeneralHeight: HeightGetter = useCallback(
    (index: number) => {
      const s = generalSessions[index];
      if (!s) return defaultRowHeight;
      return rowHeightById.get(s.id) ?? defaultRowHeight;
    },
    [generalSessions, rowHeightById, defaultRowHeight]
  );

  const generalWindowEnabled =
    !generalCollapsed &&
    filterType !== 'pinned' &&
    shouldWindowSessionList(generalSessions.length, {
      searching: isSearching,
      dragging: isDragging,
    });

  const generalWindowRange = useSessionListWindow(
    generalSessions.length,
    sessionListRef,
    generalListRef,
    generalWindowEnabled,
    activeGeneralIndex,
    getGeneralHeight,
    scrollHostRef
  );

  const generalRenderRange = useMemo(() => {
    const base = generalWindowEnabled
      ? generalWindowRange
      : FULL_RANGE(generalSessions.length);
    let r = clampSessionListWindowRange(
      base,
      generalSessions.length,
      undefined,
      getGeneralHeight
    );
    if (
      activeGeneralIndex != null &&
      !windowContainsIndex(r, activeGeneralIndex)
    ) {
      const expanded = expandWindowToIndex(
        r,
        activeGeneralIndex,
        generalSessions.length,
        undefined,
        getGeneralHeight
      );
      if (
        !generalWindowEnabled ||
        expanded.end - expanded.start <= MAX_SIDEBAR_WINDOW_ROWS
      ) {
        r = expanded;
      }
    }
    return r;
  }, [
    generalWindowEnabled,
    generalWindowRange,
    generalSessions.length,
    activeGeneralIndex,
    getGeneralHeight,
  ]);

  const lastRevealedActiveRef = useRef<string | null>(null);
  useEffect(() => {
    if (generalCollapsed || filterType === 'pinned') return;
    if (activeGeneralIndex == null || !activeSessionId) return;
    const revealKey = `${activeSessionId}@${activeGeneralIndex}`;
    if (lastRevealedActiveRef.current === revealKey) return;
    const rawEl = scrollHostRef?.current || sessionListRef.current;
    const scrollEl =
      resolveActualScrollHost(rawEl, generalListRef.current) ||
      sessionListRef.current;
    if (!scrollEl) return;
    const listEl = generalListRef.current;
    const listOffsetTop = listEl ? measureListOffsetTop(scrollEl, listEl) : 0;
    const nextTop = scrollTopToRevealIndex({
      index: activeGeneralIndex,
      count: generalSessions.length,
      viewportHeight: scrollEl.clientHeight || 400,
      listOffsetTop,
      scrollTop: scrollEl.scrollTop,
      align: 'nearest',
      getHeight: getGeneralHeight,
    });
    if (Math.abs(nextTop - scrollEl.scrollTop) > 1) {
      scrollEl.scrollTop = nextTop;
      scrollEl.dispatchEvent(new Event('scroll'));
    }
    lastRevealedActiveRef.current = revealKey;
  }, [
    activeSessionId,
    activeGeneralIndex,
    generalCollapsed,
    generalSessions.length,
    filterType,
    getGeneralHeight,
    sessionListRef,
    generalListRef,
    scrollHostRef,
  ]);

  return {
    generalWindowEnabled,
    generalRenderRange,
    getGeneralHeight,
    rowHeightById,
    defaultRowHeight,
  };
}
