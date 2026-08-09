import { useMemo } from 'react';
import type { SessionState } from '../../../store/types';
import { compareSessionsByActivity } from '../../../api/sessionTime';
import { sessionListDisplayTitle } from '../../../api/sessionTitle';
import {
  matchSessionSearch,
  type SessionSearchMatch,
} from '../../../api/sessionSearch';

/**
 * 会话搜索/排序状态 hook（03-detail T10 拆分：搜索面）。
 * 关键词命中表 + 排序后的可见会话列表。
 */
export function useSessionSearch({
  visibleSessions,
  searchQuery,
  sortType,
}: {
  visibleSessions: SessionState[];
  searchQuery: string;
  sortType: 'active' | 'name';
}) {
  const isSearching = searchQuery.trim().length > 0;

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

  const isSearchEmpty = isSearching && sortedSessions.length === 0;

  return { isSearching, searchHits, sortedSessions, isSearchEmpty };
}
