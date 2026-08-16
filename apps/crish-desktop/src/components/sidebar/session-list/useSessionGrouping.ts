import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionState } from '../../../store/types';
import { groupUnpinnedByProject } from '../../../store/storeAccess';
import type { ProjectEntry } from '../../../api/projectStore';
import { sessionListDisplayTitle } from '../../../api/sessionTitle';
import {
  applyDragPreview,
  isPreviewTargetSection,
  type SessionDragPreview,
} from './useSessionListDrag';

/**
 * 分组/折叠状态 hook（03-detail T10 拆分：useSessionGrouping）。
 * 分区排序 + 拖拽预览覆盖 + 空置顶自动折叠/拖拽展开内聚于此。
 */
export function useSessionGrouping({
  sessions,
  sortedSessions,
  projects,
  sortType,
  dragPreview,
  dragSession,
  isDragging,
  pinnedCollapsed,
  onTogglePinned,
}: {
  sessions: SessionState[];
  sortedSessions: SessionState[];
  projects: ProjectEntry[];
  sortType: 'active' | 'name';
  dragPreview: SessionDragPreview | null;
  dragSession: SessionState | null;
  isDragging: boolean;
  pinnedCollapsed: boolean;
  onTogglePinned: () => void;
}) {
  const [expandedProjectFolders, setExpandedProjectFolders] = useState<
    Record<string, boolean>
  >({});

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 原始依赖面保留
  }, [pinnedSessions.length, isDragging]);

  // Expand pin zone when a drag starts so empty/collapsed 置顶 still accepts drops.
  useEffect(() => {
    if (!isDragging) return;
    if (pinnedCollapsed) onTogglePinned();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 原始依赖面保留
  }, [isDragging]);

  const toggleExpandedProjectFolder = useCallback((id: string) => {
    setExpandedProjectFolders((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  return {
    pinnedSessions,
    byProjectId,
    generalSessions,
    expandedProjectFolders,
    toggleExpandedProjectFolder,
  };
}
