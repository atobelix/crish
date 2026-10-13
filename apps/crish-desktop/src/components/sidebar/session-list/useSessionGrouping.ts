import { useEffect, useMemo } from 'react';
import type { SessionState } from '../../../store/types';
import { groupUnpinnedByProject } from '../../../store/storeAccess';
import type { ProjectEntry } from '../../../api/projectStore';
import {
  applyDragPreview,
  isPreviewTargetSection,
  type SessionDragPreview,
} from './useSessionListDrag';

/**
 * 分组/折叠状态 hook（03-detail T10 拆分：useSessionGrouping）。
 * 分区排序 + 分组方式（folder/none）+ 拖拽预览覆盖 + 空置顶自动折叠/拖拽展开内聚于此。
 */
export function useSessionGrouping({
  sortedSessions,
  projects,
  groupType = 'folder',
  filterType = 'all',
  dragPreview,
  dragSession,
  isDragging,
  pinnedCollapsed,
  onTogglePinned,
}: {
  sessions?: SessionState[];
  sortedSessions: SessionState[];
  projects: ProjectEntry[];
  sortType?: 'active' | 'name';
  groupType?: 'folder' | 'none';
  filterType?: 'all' | 'pinned';
  dragPreview: SessionDragPreview | null;
  dragSession: SessionState | null;
  isDragging: boolean;
  pinnedCollapsed: boolean;
  onTogglePinned: () => void;
}) {
  // sortedSessions 已在 useSessionSearch 中按 sortType ('active' 最近活跃 / 'name' 名称) 完成排序
  const basePinned = useMemo(
    () => sortedSessions.filter((s) => s.isPinned),
    [sortedSessions]
  );

  const baseUnpinned = useMemo(
    () => sortedSessions.filter((s) => !s.isPinned),
    [sortedSessions]
  );

  const { byProjectId: baseByProjectId, general: baseGeneral } = useMemo(() => {
    if (groupType === 'none') {
      const emptyByProj: Record<string, SessionState[]> = Object.create(null);
      for (const p of projects) emptyByProj[p.id] = [];
      return { byProjectId: emptyByProj, general: baseUnpinned };
    }
    return groupUnpinnedByProject(baseUnpinned, projects);
  }, [baseUnpinned, projects, groupType]);

  // Live drag: inject optimistic section order so rows shift in place
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
    if (groupType === 'none' || !dragPreview || !dragSession) {
      return baseByProjectId;
    }
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
  }, [baseByProjectId, dragPreview, dragSession, projects, groupType]);

  const generalSessions = useMemo(() => {
    if (!dragPreview || !dragSession) return baseGeneral;
    const isTarget =
      groupType === 'none'
        ? !dragPreview.isPinned
        : isPreviewTargetSection(dragPreview, 'general');
    return applyDragPreview(baseGeneral, dragPreview, dragSession, isTarget);
  }, [baseGeneral, dragPreview, dragSession, groupType]);

  // Auto-collapse empty pin section — skip while dragging or when filterType === 'pinned'.
  useEffect(() => {
    if (isDragging || filterType === 'pinned') return;
    if (pinnedSessions.length === 0 && !pinnedCollapsed) {
      onTogglePinned();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 原始依赖面保留
  }, [pinnedSessions.length, isDragging, filterType]);

  // Expand pin zone when a drag starts so empty/collapsed 置顶 still accepts drops.
  useEffect(() => {
    if (!isDragging) return;
    if (pinnedCollapsed) onTogglePinned();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 原始依赖面保留
  }, [isDragging]);

  return {
    pinnedSessions,
    byProjectId,
    generalSessions,
  };
}
