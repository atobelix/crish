import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SessionState } from '../../../store/layoutStore';
import {
  groupUnpinnedByProject,
  partitionSidebarSessions,
} from '../../../store/sessionIndex';
import { getCompositionRoot } from '../../../app/compositionRoot';
import {
  SESSION_LIST_TICK_HIDDEN_MS,
  compareSessionsByActivity,
  sessionListTimeTickMs,
} from '../../../api/sessionTime';
import { sessionListDisplayTitle } from '../../../api/sessionTitle';
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
  matchSessionSearch,
  storeSessionSearchQuery,
  type SessionSearchMatch,
} from '../../../api/sessionSearch';
import styles from '../SidebarSessionList.module.css';
import { SessionRow } from './SessionRow';
import {
  buildSidebarPretextFont,
  measureSessionRowHeight,
  readSidebarContentWidth,
} from './sidebarMeasure';
import { FULL_RANGE, useSessionListWindow } from './useSessionListWindow';
import { dedupeSessionsById } from './sessionListUtils';
import type { SidebarSessionListProps } from './sessionListTypes';
import {
  applyDragPreview,
  isPreviewTargetSection,
  useSessionListDrag,
} from './useSessionListDrag';

export function useSidebarSessionList(props: SidebarSessionListProps) {
  const {
    sessions,
    activeSessionId,
    searchQuery,
    sortType,
    filterType,
    projects,
    collapsedProjects,
    generalCollapsed,
    pinnedCollapsed,
    projectsSectionCollapsed,
    renamingSessionId = null,
    onSelectSession,
    onContextMenuSession,
    onTogglePinned,
    onMoveSessionRealtime,
    onStartRename,
    onCommitRename,
    onCancelRename,
  } = props;

  const [nowTick, setNowTick] = useState(() => Date.now());
  const [renameDraft, setRenameDraft] = useState('');
  const [expandedProjectFolders, setExpandedProjectFolders] = useState<
    Record<string, boolean>
  >({});
  const [showAllGeneralSessions, setShowAllGeneralSessions] = useState(false);

  const pinnedZoneRef = useRef<HTMLDivElement>(null);
  const sessionListRef = useRef<HTMLDivElement>(null);
  const generalListRef = useRef<HTMLUListElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const {
    activeDragItem,
    dragOverPinned,
    dropIndicator,
    dragPreview,
    startSessionDrag,
  } = useSessionListDrag({
    pinnedZoneRef,
    sessionListRef,
    renamingSessionId: renamingSessionId ?? null,
    onMoveSessionRealtime,
  });

  const isSearching = searchQuery.trim().length > 0;
  const isDragging = activeDragItem?.type === 'session';

  const { visible: visibleSessions, shellHiddenCount, inputListedCount } =
    useMemo(() => {
      const unique = dedupeSessionsById(sessions);
      const nonArchivedCount = unique.reduce(
        (n, s) => n + (s.isArchived ? 0 : 1),
        0
      );
      const listedAll = partitionSidebarSessions(unique, {
        activeSessionId,
        filterType: 'all',
      }).visible;
      const visible =
        filterType === 'pinned' ? listedAll.filter((s) => s.isPinned) : listedAll;
      return {
        visible: dedupeSessionsById(visible),
        shellHiddenCount: Math.max(0, nonArchivedCount - listedAll.length),
        inputListedCount: nonArchivedCount,
      };
    }, [sessions, activeSessionId, filterType]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const schedule = () => {
      clear();
      if (cancelled) return;
      const hidden =
        typeof document !== 'undefined' && document.hidden === true;
      const ms = hidden
        ? SESSION_LIST_TICK_HIDDEN_MS
        : sessionListTimeTickMs(visibleSessions, Date.now());
      timer = setTimeout(() => {
        if (cancelled) return;
        setNowTick(Date.now());
        schedule();
      }, ms);
    };
    const onVisibility = () => {
      if (cancelled) return;
      setNowTick(Date.now());
      schedule();
    };
    schedule();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      cancelled = true;
      clear();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [visibleSessions]);

  useEffect(() => {
    if (!renamingSessionId) return;
    const s =
      getCompositionRoot().session.getState().sessionsById[renamingSessionId];
    setRenameDraft(s ? sessionListDisplayTitle(s) : '');
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [renamingSessionId, sessions]);

  const searchHits = useMemo(() => {
    const map = new Map<string, SessionSearchMatch>();
    const q = searchQuery.trim();
    if (!q) return map;
    for (const s of visibleSessions) {
      const hit = matchSessionSearch(s, q);
      if (hit.match) map.set(s.id, hit);
    }
    return map;
  }, [visibleSessions, searchQuery]);

  const sortedSessions = useMemo(() => {
    const q = searchQuery.trim();
    let list = visibleSessions;
    if (q) list = list.filter((s) => searchHits.has(s.id));
    if (sortType === 'name') {
      return [...list].sort((a, b) =>
        sessionListDisplayTitle(a).localeCompare(sessionListDisplayTitle(b))
      );
    }
    return [...list].sort(compareSessionsByActivity);
  }, [visibleSessions, searchQuery, searchHits, sortType]);

  /** Session being dragged (for cross-section preview insertion). */
  const dragSession = useMemo(() => {
    if (!dragPreview) return null;
    return (
      sessions.find((s) => s.id === dragPreview.sessionId) ||
      sortedSessions.find((s) => s.id === dragPreview.sessionId) ||
      null
    );
  }, [dragPreview, sessions, sortedSessions]);

  /** sessions[] index — pin stack free-reorder is stored here via moveSessionRealtime. */
  const sessionOrderIndex = useMemo(() => {
    const m = new Map<string, number>();
    sessions.forEach((s, i) => m.set(s.id, i));
    return m;
  }, [sessions]);

  // 分区内一律按 sessions[] 顺序展示（拖拽重排才能持久）；仅 sortType==='name' 时按标题排。
  // 拖拽中 applyDragPreview 覆盖预览顺序。
  const bySessionArrayOrder = useCallback(
    (list: SessionState[]) => {
      if (sortType === 'name') {
        return [...list].sort((a, b) =>
          sessionListDisplayTitle(a).localeCompare(sessionListDisplayTitle(b))
        );
      }
      return [...list].sort(
        (a, b) =>
          (sessionOrderIndex.get(a.id) ?? 0) -
          (sessionOrderIndex.get(b.id) ?? 0)
      );
    },
    [sortType, sessionOrderIndex]
  );

  const basePinned = useMemo(
    () => bySessionArrayOrder(sortedSessions.filter((s) => s.isPinned)),
    [sortedSessions, bySessionArrayOrder]
  );

  const baseUnpinned = useMemo(
    () => bySessionArrayOrder(sortedSessions.filter((s) => !s.isPinned)),
    [sortedSessions, bySessionArrayOrder]
  );

  const { byProjectId: baseByProjectId, general: baseGeneral } = useMemo(
    () => groupUnpinnedByProject(baseUnpinned, projects),
    [baseUnpinned, projects]
  );

  // Live drag: inject optimistic section order so rows shift in place (activity
  // sort alone cannot reflect array-position moves from moveSessionRealtime).
  const pinnedSessions = useMemo(() => {
    if (!dragPreview || !dragSession) return basePinned;
    return applyDragPreview(
      basePinned,
      dragPreview,
      dragSession,
      isPreviewTargetSection(dragPreview, 'pinned')
    );
  }, [basePinned, dragPreview, dragSession]);

  const byProjectId = useMemo(() => {
    if (!dragPreview || !dragSession) return baseByProjectId;
    const next: Record<string, SessionState[]> = {};
    for (const p of projects) {
      const list = baseByProjectId[p.id] || [];
      next[p.id] = applyDragPreview(
        list,
        dragPreview,
        dragSession,
        isPreviewTargetSection(dragPreview, 'project', p.id)
      );
    }
    // Preserve any stray keys from base
    for (const key of Object.keys(baseByProjectId)) {
      if (next[key] !== undefined) continue;
      next[key] = applyDragPreview(
        baseByProjectId[key] || [],
        dragPreview,
        dragSession,
        isPreviewTargetSection(dragPreview, 'project', key)
      );
    }
    return next;
  }, [baseByProjectId, dragPreview, dragSession, projects]);

  const generalSessions = useMemo(() => {
    if (!dragPreview || !dragSession) return baseGeneral;
    return applyDragPreview(
      baseGeneral,
      dragPreview,
      dragSession,
      isPreviewTargetSection(dragPreview, 'general')
    );
  }, [baseGeneral, dragPreview, dragSession]);

  // Auto-collapse empty pin section — skip while dragging so the drop zone stays open.
  useEffect(() => {
    if (isDragging) return;
    if (pinnedSessions.length === 0 && !pinnedCollapsed) {
      onTogglePinned();
    }
  }, [pinnedSessions.length, isDragging]); // eslint-disable-line react-hooks/exhaustive-deps

  // Expand pin zone when a drag starts so empty/collapsed 置顶 still accepts drops.
  useEffect(() => {
    if (!isDragging) return;
    if (pinnedCollapsed) onTogglePinned();
  }, [isDragging]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeGeneralIndex = useMemo(() => {
    if (!activeSessionId) return null;
    const idx = generalSessions.findIndex((s) => s.id === activeSessionId);
    return idx >= 0 ? idx : null;
  }, [generalSessions, activeSessionId]);

  const navSessionIds = useMemo(() => {
    const ids: string[] = [];
    if (!pinnedCollapsed) {
      for (const s of pinnedSessions) ids.push(s.id);
    }
    if (!projectsSectionCollapsed && filterType !== 'pinned') {
      for (const p of projects) {
        if (collapsedProjects[p.id]) continue;
        const sess = byProjectId[p.id] || [];
        for (const s of sess) ids.push(s.id);
      }
    }
    if (!generalCollapsed && filterType !== 'pinned') {
      for (const s of generalSessions) ids.push(s.id);
    }
    return ids;
  }, [
    pinnedCollapsed,
    pinnedSessions,
    projectsSectionCollapsed,
    filterType,
    projects,
    collapsedProjects,
    byProjectId,
    generalCollapsed,
    generalSessions,
  ]);

  const pretextFont = useMemo(() => buildSidebarPretextFont(), []);
  const contentWidth = useMemo(() => readSidebarContentWidth(), []);

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
    getGeneralHeight
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
      r = expandWindowToIndex(
        r,
        activeGeneralIndex,
        generalSessions.length,
        undefined,
        getGeneralHeight
      );
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
    const scrollEl = sessionListRef.current;
    if (!scrollEl) return;
    const listEl = generalListRef.current;
    const listOffsetTop = listEl
      ? measureListOffsetTop(scrollEl, listEl)
      : 0;
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
  ]);

  const navigateSession = useCallback(
    (fromId: string, delta: number) => {
      const ids = navSessionIds;
      if (ids.length === 0) return;
      let nextId: string | undefined;
      if (!Number.isFinite(delta)) {
        nextId = delta < 0 ? ids[0] : ids[ids.length - 1];
      } else {
        const idx = ids.indexOf(fromId);
        const from =
          idx >= 0 ? idx : Math.max(0, ids.indexOf(activeSessionId));
        const next = Math.max(0, Math.min(ids.length - 1, from + delta));
        nextId = ids[next];
      }
      if (!nextId || nextId === fromId) {
        const safeFrom =
          typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(fromId)
            : fromId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const row = sessionListRef.current?.querySelector(
          `[data-session-id="${safeFrom}"] .session-item`
        ) as HTMLElement | null;
        row?.focus({ preventScroll: true });
        return;
      }
      storeSessionSearchQuery(searchQuery.trim());
      onSelectSession(nextId);
      const id = nextId;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const safe =
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
              ? CSS.escape(id)
              : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const row = sessionListRef.current?.querySelector(
            `[data-session-id="${safe}"] .session-item`
          ) as HTMLElement | null;
          row?.focus({ preventScroll: true });
        });
      });
    },
    [navSessionIds, activeSessionId, searchQuery, onSelectSession]
  );

  const commitRename = useCallback(
    (sessionId: string) => {
      onCommitRename?.(sessionId, renameDraft.trim());
    },
    [onCommitRename, renameDraft]
  );

  const onRenameDraftChange = useCallback((v: string) => {
    setRenameDraft(v);
  }, []);

  const renderSessionItem = useCallback(
    (s: SessionState, isDraggable: boolean = true) => {
      const rh = rowHeightById.get(s.id) ?? defaultRowHeight;
      const dropPlace =
        dropIndicator?.sessionId === s.id ? dropIndicator.place : null;
      return (
        <SessionRow
          key={s.id}
          s={s}
          activeSessionId={activeSessionId}
          rowHeight={rh}
          searchQuery={searchQuery}
          {...(searchHits.get(s.id) !== undefined
            ? { searchHit: searchHits.get(s.id)! }
            : {})}
          isDraggingThis={
            activeDragItem?.type === 'session' &&
            activeDragItem.sessionId === s.id
          }
          isRenaming={renamingSessionId === s.id}
          isDraggable={isDraggable}
          renameDraft={renameDraft}
          renameInputRef={renameInputRef}
          onRenameDraftChange={onRenameDraftChange}
          onSelectSession={onSelectSession}
          onContextMenuSession={onContextMenuSession}
          onStartSessionDrag={startSessionDrag}
          onStartRename={onStartRename}
          onCommitRename={commitRename}
          onCancelRename={onCancelRename}
          onNavigateSession={navigateSession}
          dropPlace={dropPlace}
        />
      );
    },
    [
      activeSessionId,
      searchQuery,
      searchHits,
      activeDragItem,
      renamingSessionId,
      renameDraft,
      rowHeightById,
      defaultRowHeight,
      onRenameDraftChange,
      onSelectSession,
      onContextMenuSession,
      startSessionDrag,
      onStartRename,
      commitRename,
      onCancelRename,
      navigateSession,
      dropIndicator,
    ]
  );

  const toggleExpandedProjectFolder = useCallback((id: string) => {
    setExpandedProjectFolders((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const toggleShowAllGeneralSessions = useCallback(() => {
    setShowAllGeneralSessions((v) => !v);
  }, []);

  const isSearchEmpty = isSearching && sortedSessions.length === 0;
  const isAllEmpty = !isSearching && visibleSessions.length === 0;
  const showProjectsAndGeneral = filterType !== 'pinned';

  return {
    visibleSessions,
    shellHiddenCount,
    inputListedCount,
    sortedSessions,
    pinnedSessions,
    byProjectId,
    generalSessions,
    generalWindowEnabled,
    generalRenderRange,
    pinnedZoneRef,
    sessionListRef,
    generalListRef,
    dragOverPinned,
    dropIndicator,
    expandedProjectFolders,
    showAllGeneralSessions,
    isSearchEmpty,
    isAllEmpty,
    showProjectsAndGeneral,
    nowTick,
    renderSessionItem,
    toggleExpandedProjectFolder,
    toggleShowAllGeneralSessions,
    listClassName: isDragging ? styles.sidebarDragging : undefined,
  };
}
