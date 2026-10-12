import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SessionState } from '../../../store/types';
import { partitionSidebarSessions } from '../../../store/storeAccess';
import { getCompositionRoot } from '../../../app/compositionRoot';
import {
  SESSION_LIST_TICK_HIDDEN_MS,
  sessionListTimeTickMs,
} from '../../../api/sessionTime';
import { sessionListDisplayTitle } from '../../../api/sessionTitle';
import { buildSectionTitleHints } from '../../../api/sessionListTitleHint';
import { storeSessionSearchQuery } from '../../../api/sessionSearch';
import styles from '../SidebarSessionList.module.css';
import { SessionRow } from './SessionRow';
import { dedupeSessionsById } from './sessionListUtils';
import type { SidebarSessionListProps } from './sessionListTypes';
import { useSessionListDrag } from './useSessionListDrag';
import { useSessionGrouping } from './useSessionGrouping';
import { useSessionSearch } from './useSessionSearch';
import { useWindowedList } from './useWindowedList';

/**
 * 会话列表容器 hook（03-detail T10 拆分）：
 * 窗口化 → useWindowedList；分组/折叠 → useSessionGrouping；
 * 搜索/排序 → useSessionSearch；拖拽 → 既有 useSessionListDrag。
 */
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
    onDeleteSession,
    onBranchSession,
  } = props;

  const [nowTick, setNowTick] = useState(() => Date.now());
  const [renameDraft, setRenameDraft] = useState('');

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

  const isDragging = activeDragItem?.type === 'session';

  const {
    visible: visibleSessions,
    shellHiddenCount,
    inputListedCount,
  } = useMemo(() => {
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

  const { isSearching, searchHits, sortedSessions, isSearchEmpty } =
    useSessionSearch({ visibleSessions, searchQuery, sortType });

  /** Session being dragged (for cross-section preview insertion). */
  const dragSession = useMemo(() => {
    if (!dragPreview) return null;
    return (
      sessions.find((s) => s.id === dragPreview.sessionId) ||
      sortedSessions.find((s) => s.id === dragPreview.sessionId) ||
      null
    );
  }, [dragPreview, sessions, sortedSessions]);

  const { pinnedSessions, byProjectId, generalSessions } = useSessionGrouping({
    sessions,
    sortedSessions,
    projects,
    sortType,
    dragPreview,
    dragSession,
    isDragging,
    pinnedCollapsed,
    onTogglePinned,
  });

  const titleHints = useMemo(
    () =>
      buildSectionTitleHints([
        pinnedSessions,
        ...Object.values(byProjectId),
        generalSessions,
      ]),
    [pinnedSessions, byProjectId, generalSessions]
  );

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

  const {
    generalWindowEnabled,
    generalRenderRange,
    rowHeightById,
    defaultRowHeight,
  } = useWindowedList({
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
  });

  const navigateSession = useCallback(
    (fromId: string, delta: number) => {
      const ids = navSessionIds;
      if (ids.length === 0) return;
      let nextId: string | undefined;
      if (!Number.isFinite(delta)) {
        nextId = delta < 0 ? ids[0] : ids[ids.length - 1];
      } else {
        const idx = ids.indexOf(fromId);
        const from = idx >= 0 ? idx : Math.max(0, ids.indexOf(activeSessionId));
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
          rowHeight={rh}
          session={{
            s,
            activeSessionId,
            searchQuery,
            ...(searchHits.get(s.id) !== undefined
              ? { searchHit: searchHits.get(s.id)! }
              : {}),
            isDraggingThis:
              activeDragItem?.type === 'session' &&
              activeDragItem.sessionId === s.id,
            isRenaming: renamingSessionId === s.id,
            isDraggable,
            dropPlace,
            titleHint: titleHints.get(s.id) ?? '',
          }}
          rename={{
            renameDraft,
            renameInputRef,
            onRenameDraftChange,
            onStartRename,
            onCommitRename: commitRename,
            onCancelRename,
          }}
          actions={{
            onSelectSession,
            onContextMenuSession,
            onStartSessionDrag: startSessionDrag,
            onNavigateSession: navigateSession,
            onDeleteSession,
            onBranchSession,
          }}
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
      onDeleteSession,
      onBranchSession,
      navigateSession,
      dropIndicator,
      titleHints,
    ]
  );

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
    isSearchEmpty,
    isAllEmpty,
    showProjectsAndGeneral,
    nowTick,
    renderSessionItem,
    listClassName: isDragging ? styles.sidebarDragging : undefined,
  };
}
