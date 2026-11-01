// 抽屉会话列表视图模型：在 useSessionsVm 之上加搜索与「今天 / 更早」分组。
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { useSessionsVm } from '@/adapters/viewmodels/useSessionsVm';
import { lastPreviewOfWindow } from '@/domain/pure/sessionPreview';
import {
  filterSessions,
  groupSessionsByDay,
  type SessionDayGroups,
} from '@/domain/pure/sessionList';
import type { EventWindow } from '@/domain/store/eventReducers';

export interface SessionListVm extends SessionDayGroups {
  query: string;
  setQuery: (query: string) => void;
  windows: Record<string, EventWindow>;
  /** 本地还没有任何会话（与「搜索无结果」区分） */
  hasSessions: boolean;
  connected: boolean;
  refresh: () => Promise<void>;
}

export function useSessionListVm(nowMs: number): SessionListVm {
  const { sessions, windows, connected, refresh } = useSessionsVm();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  // 归档会话不进主列表（与主屏 homeScreen 的 isArchived 过滤同口径——
  // G3 前抽屉未过滤，归档后行在此残留与主屏不一致，一并对齐）
  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.isArchived !== true),
    [sessions]
  );

  const previewOf = useCallback(
    (sessionId: string) => lastPreviewOfWindow(windows[sessionId]),
    [windows]
  );

  const groups = useMemo(
    () =>
      groupSessionsByDay(
        filterSessions(visibleSessions, deferredQuery, previewOf),
        nowMs
      ),
    [visibleSessions, deferredQuery, previewOf, nowMs]
  );

  return {
    ...groups,
    query,
    setQuery,
    windows,
    hasSessions: visibleSessions.length > 0,
    connected,
    refresh,
  };
}
